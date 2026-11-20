import { codexJsonLineTransport } from "./CodexJsonLineStream";
import { CodexHostRequestMetrics } from "../../codex-runtime/CodexHostRequestMetrics";
import { openCodexLocalDaemon, type CodexLocalDaemonConfig } from "./CodexLocalDaemon";
import * as Context from "effect/Context";
import { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import { makeCodexSshSessionRuntime, type CodexSshSessionConfig } from "./CodexSshSession";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "./NodeServices";
import { CodexAppServerClient, layerChildProcess } from "@nodex/effect-codex-app-server/client";
import {
  classifyCodexClientError,
  codexRuntimeError,
  type CodexRuntimeError,
} from "../../codex-runtime/CodexRuntimeError";

export interface CodexSessionLaunch {
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly localDaemon?: CodexLocalDaemonConfig;
}

export interface CodexSessionProcessConfig extends CodexSessionLaunch {
  readonly hostId: string;
  readonly generation: number;
  readonly ssh?: CodexSshSessionConfig;
  readonly command: string;
  readonly cwd?: string;
  readonly resolveLaunch?: (
    pending: CodexSessionLaunch,
  ) => Effect.Effect<CodexSessionLaunch, CodexRuntimeError>;
  readonly forceTermination: Duration.Input;
}

export interface CodexSessionTransportHandle {
  readonly pid: number;
  readonly transportKind: "stdio" | "websocket";
  readonly onInitializationFailed?: () => void;
  readonly client: CodexAppServerClient["Service"];
  readonly termination: Effect.Effect<never, CodexRuntimeError>;
}

export class CodexSessionTransport extends Context.Service<
  CodexSessionTransport,
  {
    readonly open: (
      config: CodexSessionProcessConfig,
    ) => Effect.Effect<CodexSessionTransportHandle, CodexRuntimeError, Scope.Scope>;
    readonly canonicalPath: (path: string) => Effect.Effect<string, CodexRuntimeError>;
  }
>()("nodex/main/platform/node/CodexSessionTransport") {}

export const live: Layer.Layer<
  CodexSessionTransport,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HostShellEnvironment
> = Layer.effect(
  CodexSessionTransport,
  Effect.gen(function* () {
    const shell = yield* HostShellEnvironment;
    const ssh = makeCodexSshSessionRuntime({ loadEnvironment: shell.load });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    return CodexSessionTransport.of({
      open: Effect.fn("CodexSessionTransport.open")(function* (config) {
        const hostMetrics = yield* CodexHostRequestMetrics;
        if (config.ssh) return yield* ssh.open(config.ssh, config.hostId, config.generation);
        const launch = config.resolveLaunch ? yield* config.resolveLaunch(config) : config;
        if (launch.localDaemon) {
          const daemon = yield* openCodexLocalDaemon({
            config: launch.localDaemon,
            command: config.command,
            env: launch.env,
            hostId: config.hostId,
            generation: config.generation,
          });
          if (daemon) return daemon;
        }
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(config.command, launch.args, {
              ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
              env: { ...launch.env },
              extendEnv: false,
              shell: false,
              killSignal: "SIGTERM",
              forceKillAfter: config.forceTermination,
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              codexRuntimeError({
                operation: "session.spawn",
                reason: "spawn",
                retryable: true,
                hostId: config.hostId,
                generation: config.generation,
                cause,
              }),
            ),
          );
        const clientContext = yield* Layer.build(
          layerChildProcess(handle, codexJsonLineTransport(handle.stdout, hostMetrics)),
        );
        const client = Context.get(clientContext, CodexAppServerClient);
        const pid = Number(handle.pid);
        const childTermination = handle.exitCode.pipe(
          Effect.mapError((cause) =>
            codexRuntimeError({
              operation: "session.wait",
              reason: "session-lost",
              retryable: true,
              hostId: config.hostId,
              generation: config.generation,
              pid,
              cause,
            }),
          ),
          Effect.flatMap((exitCode) =>
            Effect.fail(
              codexRuntimeError({
                operation: "session.exit",
                reason: "session-lost",
                retryable: true,
                hostId: config.hostId,
                generation: config.generation,
                pid,
                cause: new Error(`Codex app-server exited with code ${exitCode}`),
              }),
            ),
          ),
        );
        const protocolTermination = client.termination.pipe(
          Effect.mapError((cause) =>
            classifyCodexClientError({
              operation: "session.protocol",
              cause,
              hostId: config.hostId,
              generation: config.generation,
              pid,
            }),
          ),
        );
        const termination = Effect.raceFirst(childTermination, protocolTermination);
        return { pid, transportKind: "stdio", client, termination };
      }),
      canonicalPath: Effect.fn("CodexSessionTransport.canonicalPath")((path) =>
        fileSystem.realPath(path).pipe(
          Effect.mapError((cause) =>
            codexRuntimeError({
              operation: "session.canonical-path",
              reason: "initialize",
              retryable: false,
              cause,
            }),
          ),
        ),
      ),
    });
  }),
);

/** Complete Node adapter Layer for application composition outside the unstable platform seam. */
export const nodeLive: Layer.Layer<CodexSessionTransport, never, HostShellEnvironment> = live.pipe(
  Layer.provide(NodeServices.layer),
);
