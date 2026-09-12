/* oxlint-disable effecttsgo/async-function -- Child-process command capture is the Node adapter boundary; Effect owns interruption and transport scopes. */
import {
  parseCodexCliVersion,
  isSupportedCodexAppServerVersion,
} from "../../../shared/codex-app-server-version";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import * as Fiber from "effect/Fiber";
import { loadCodexLocalShellEnvironment } from "../../codex/codex-worktree-shell-environment";
import { codexSshProxyDependency } from "./CodexSshProxyDependency";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import WebSocket from "ws";
import { codexRuntimeError, type CodexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import type { CodexSessionTransportHandle } from "./CodexSessionTransport";
import {
  codexRemoteLoginCommand,
  codexSshConnectionArguments,
  createCodexSshProxy,
  forwardedAgentCommand,
  type CodexSshConnection,
} from "./CodexSshProxy";
import { openCodexWebSocket } from "./CodexWebSocketTransport";

export interface CodexSshSessionConfig {
  readonly connection: CodexSshConnection;
  readonly binary?: string;
  readonly codexBinary?: string;
  readonly codexHome?: string | null;
  readonly connectTimeoutSeconds?: number;
}
export interface CodexSshCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface CodexSshSessionDependencies {
  readonly prepareEnvironment?: (
    config: CodexSshSessionConfig,
  ) => Effect.Effect<NodeJS.ProcessEnv, never, Scope.Scope>;
  readonly runCommand?: (
    config: CodexSshSessionConfig,
    command: string,
  ) => Effect.Effect<CodexSshCommandResult, CodexRuntimeError>;
  readonly connect?: (
    config: CodexSshSessionConfig,
    hostId: string,
    generation: number,
  ) => Effect.Effect<CodexSessionTransportHandle, CodexRuntimeError, Scope.Scope>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const execute = promisify(execFile);
export const codexSshStartupKey = (connection: CodexSshConnection): string =>
  connection.alias?.trim()
    ? `alias:${connection.alias.trim()}`
    : [
        "direct",
        connection.host,
        String(connection.port ?? ""),
        connection.identity?.trim() ?? "",
      ].join("\n");
export function codexSshBootstrapCommand(binary: string): string {
  const root = '"${CODEX_HOME:-$HOME/.codex}/app-server-control"';
  const log = '"${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server.log"';
  const agent = '"${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"';
  return `if [ "\${CODEX_SSH_SKIP_APP_SERVER_BOOT:-}" = "true" ]; then exit 0; fi; (umask 077; mkdir -p -- ${root} && (pkill -9 -U "$(id -u)" -f ${quote(`${binary}.*[d]esktop-ssh-websocket-v0.sock`)} || true) && ${forwardedAgentCommand} && : >${log}) && SSH_AUTH_SOCK=${agent} nohup ${quote(binary)} -c features.code_mode_host=true app-server --listen 'unix://' >${log} 2>&1 &`;
}
const runCommand = (config: CodexSshSessionConfig, command: string, env: NodeJS.ProcessEnv) =>
  Effect.tryPromise({
    try: async (signal) => {
      const sentinel = randomBytes(8);
      const home = config.codexHome
        ? `CODEX_HOME=${quote(config.codexHome)}; export CODEX_HOME; `
        : "";
      const args = [
        ...codexSshConnectionArguments(config.connection, config.connectTimeoutSeconds),
        codexRemoteLoginCommand(home + command, sentinel),
      ];
      const strip = (stdout: unknown) => {
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        const index = bytes.indexOf(sentinel);
        return (index === -1 ? bytes : bytes.subarray(index + sentinel.length)).toString("utf8");
      };
      try {
        const result = await execute(config.binary ?? "ssh", args, {
          signal,
          env,
          timeout: Math.max(60_000, (config.connectTimeoutSeconds ?? 0) * 1000),
          maxBuffer: Infinity,
          encoding: "buffer",
        });
        const index = result.stdout.indexOf(sentinel);
        return {
          code: 0,
          stdout: (index === -1
            ? result.stdout
            : result.stdout.subarray(index + sentinel.length)
          ).toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number" &&
          "stdout" in error &&
          "stderr" in error
        )
          return {
            code: error.code,
            stdout: strip(error.stdout),
            stderr: String(error.stderr),
          };
        throw error;
      }
    },
    catch: (cause) =>
      codexRuntimeError({
        operation: "session.ssh-command",
        reason: "spawn",
        retryable: true,
        cause,
      }),
  });

/** Shared startup serialization ends at the handshake; established sessions retain independent scopes. */
export function makeCodexSshSessionRuntime(dependencies: CodexSshSessionDependencies = {}) {
  const gates = new Map<string, { semaphore: Semaphore.Semaphore; references: number }>();
  const connected = new WeakSet<CodexSshSessionConfig>();
  const environments = new WeakMap<CodexSshSessionConfig, NodeJS.ProcessEnv>();
  const gated = <A, E, R>(
    config: CodexSshSessionConfig,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const key = codexSshStartupKey(config.connection);
        const gate = gates.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), references: 0 };
        gate.references += 1;
        gates.set(key, gate);
        return { key, gate };
      }),
      ({ gate }) => gate.semaphore.withPermits(1)(effect),
      ({ key, gate }) =>
        Effect.sync(() => {
          gate.references -= 1;
          if (gate.references === 0) gates.delete(key);
        }),
    );
  const command = (config: CodexSshSessionConfig, input: string) =>
    gated(
      config,
      dependencies.runCommand
        ? dependencies.runCommand(config, input)
        : runCommand(config, input, environments.get(config) ?? process.env),
    );
  const connect = (config: CodexSshSessionConfig, hostId: string, generation: number) =>
    gated(
      config,
      Effect.gen(function* () {
        const parent = yield* Effect.scope;
        const attemptScope = yield* Scope.fork(parent);
        const result = yield* (
          dependencies.connect
            ? dependencies.connect(config, hostId, generation)
            : openCodexWebSocket({
                hostId,
                generation,
                createSocket: () =>
                  new WebSocket("ws://codex-app-server/rpc", {
                    perMessageDeflate: false,
                    createConnection: () =>
                      createCodexSshProxy({
                        ...config,
                        env: environments.get(config) ?? process.env,
                      }),
                  }),
              })
        ).pipe(Effect.provideService(Scope.Scope, attemptScope), Effect.exit);
        if (Exit.isFailure(result)) {
          yield* Scope.close(attemptScope, result);
          return yield* Effect.failCause(result.cause);
        }
        connected.add(config);
        return result.value;
      }),
    );
  const bootstrap = (config: CodexSshSessionConfig) =>
    Effect.gen(function* () {
      const binary = config.codexBinary ?? "codex";
      const path = yield* command(
        config,
        `if command -v ${quote(binary)} >/dev/null 2>&1; then exit 0; fi; exit 86`,
      );
      if (path.code !== 0)
        return yield* codexRuntimeError({
          operation: "session.ssh-path",
          reason: "spawn",
          retryable: false,
          cause: new Error(
            path.code === 86
              ? "No codex found in remote PATH. Install the Codex CLI on the remote machine."
              : path.stderr || path.stdout,
          ),
        });
      const versionResult = yield* command(config, `${quote(binary)} --version`);
      const version =
        versionResult.code === 0
          ? parseCodexCliVersion(versionResult.stdout || versionResult.stderr)
          : null;
      if (version !== null && !isSupportedCodexAppServerVersion(version))
        return yield* codexRuntimeError({
          operation: "session.ssh-version",
          reason: "initialize",
          retryable: false,
          cause: new Error(`codex-app-server-version-unsupported:${version}`),
        });
      const result = yield* command(config, codexSshBootstrapCommand(binary));
      if (result.code !== 0)
        return yield* codexRuntimeError({
          operation: "session.ssh-bootstrap",
          reason: "spawn",
          retryable: true,
          cause: new Error(
            result.stderr || result.stdout || `Remote SSH failed with exit code ${result.code}`,
          ),
        });
    });
  return {
    open: (config: CodexSshSessionConfig, hostId: string, generation: number) =>
      Effect.gen(function* () {
        const env = yield* dependencies.prepareEnvironment
          ? dependencies.prepareEnvironment(config)
          : prepareSshEnvironment(config, (environment) => {
              environments.set(config, environment);
            });
        environments.set(config, env);
        let handle: CodexSessionTransportHandle | undefined;
        if (connected.has(config))
          handle = yield* connect(config, hostId, generation).pipe(
            Effect.orElseSucceed(() => undefined),
          );
        if (!handle) {
          yield* bootstrap(config);
          handle = yield* connect(config, hostId, generation);
        }
        return {
          ...handle,
          onInitializationFailed: () => {
            connected.delete(config);
          },
        };
      }),
  };
}

const prepareSshEnvironment = (
  config: CodexSshSessionConfig,
  publish: (environment: NodeJS.ProcessEnv) => void,
) =>
  Effect.gen(function* () {
    let loading = true;
    let environment = process.env;
    const load = yield* Effect.tryPromise({
      try: (signal) => loadCodexLocalShellEnvironment({ signal }),
      catch: () => undefined,
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => process.env),
      Effect.tap((result) =>
        Effect.sync(() => {
          environment = result;
          publish(result);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          loading = false;
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    if (!loading) return environment;
    const connection = config.connection;
    const args = connection.alias?.trim()
      ? [connection.alias.trim()]
      : [
          ...(connection.identity?.trim() ? ["-i", connection.identity.trim()] : []),
          ...(connection.port == null ? [] : ["-p", String(connection.port)]),
          connection.host,
        ];
    const configText = yield* Effect.tryPromise({
      try: (signal) =>
        execute(config.binary ?? "ssh", ["-G", ...args], {
          signal,
          env: environment,
          maxBuffer: Infinity,
          timeout: 5000,
          encoding: "utf8",
        }),
      catch: () => undefined,
    }).pipe(
      Effect.map((result) => result.stdout),
      Effect.orElseSucceed(() => ""),
    );
    const dependency = codexSshProxyDependency(
      configText,
      environment.PATH ?? null,
      (command, path) =>
        (path ?? "").split(delimiter).some((directory) => {
          try {
            accessSync(join(directory, command), constants.X_OK);
            return true;
          } catch {
            return false;
          }
        }),
    );
    if (dependency.needsShellEnv) return yield* Fiber.join(load);
    return environment;
  });
