import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { LocalAgentDefinition } from "../../../shared/local-agents";
import { MainConfig, type MainConfigValue } from "../../app/MainConfig";
import { loadCodexLocalShellEnvironment } from "../../codex/codex-worktree-shell-environment";
import { execFileAsync } from "./child-stdio-errors";
import { claudeExecutableCandidates, claudeHostEnvironmentValue } from "./ClaudeExecutable";

export class LocalAgentDiscoveryPlatform extends Context.Service<
  LocalAgentDiscoveryPlatform,
  {
    readonly findExecutable: (
      agent: Pick<LocalAgentDefinition, "commands" | "homeLocations">,
    ) => Effect.Effect<string | undefined>;
    readonly readVersion: (executable: string) => Effect.Effect<string | null>;
  }
>()("nodex/main/platform/node/LocalAgentDiscoveryPlatform") {}

type Host = Pick<MainConfigValue, "environment" | "homeDirectory" | "platform">;

export const make = (
  host: Host,
  io: {
    readonly isExecutable: (path: string) => Effect.Effect<boolean>;
    readonly loadLoginPath: Effect.Effect<string | undefined>;
    readonly readVersion: LocalAgentDiscoveryPlatform["Service"]["readVersion"];
  },
) => {
  const windows = host.platform === "win32";
  const path = windows ? win32 : posix;
  const candidates = (commands: readonly string[], environment: NodeJS.ProcessEnv) =>
    commands
      .flatMap((command) =>
        claudeExecutableCandidates(command, environment, host.platform, host.homeDirectory),
      )
      .filter(
        (candidate) =>
          // Local ACP executables are launched directly, so shell-only shims do not qualify.
          path.isAbsolute(candidate) && (!windows || /\.(exe|com)$/iu.test(candidate)),
      );

  const find = (paths: readonly string[]) =>
    Effect.findFirst(paths, io.isExecutable).pipe(Effect.map(Option.getOrUndefined));

  const searchPath = (commands: readonly string[], environment: NodeJS.ProcessEnv) =>
    claudeHostEnvironmentValue(environment, "PATH", host.platform)?.trim()
      ? find(candidates(commands, environment))
      : Effect.succeed(undefined);

  return LocalAgentDiscoveryPlatform.of({
    findExecutable: Effect.fn("LocalAgentDiscoveryPlatform.findExecutable")(function* (agent) {
      const desktop = yield* searchPath(agent.commands, host.environment);
      if (desktop) return desktop;

      if (!windows) {
        const loginPath = yield* io.loadLoginPath;
        const login = yield* searchPath(agent.commands, { ...host.environment, PATH: loginPath });
        if (login) return login;
      }

      return yield* find(
        candidates(
          agent.homeLocations.map((location) => path.join(host.homeDirectory, location)),
          host.environment,
        ),
      );
    }),
    readVersion: io.readVersion,
  });
};

export const live = Layer.effect(
  LocalAgentDiscoveryPlatform,
  Effect.gen(function* () {
    const host = yield* MainConfig;
    return make(host, {
      isExecutable: (path) =>
        Effect.tryPromise(() =>
          access(path, host.platform === "win32" ? constants.F_OK : constants.X_OK).then(() =>
            stat(path),
          ),
        ).pipe(
          Effect.map((info) => info.isFile()),
          Effect.orElseSucceed(() => false),
        ),
      loadLoginPath: Effect.tryPromise((signal) =>
        loadCodexLocalShellEnvironment({
          baseEnvironment: host.environment,
          platform: host.platform as NodeJS.Platform,
          signal,
        }),
      ).pipe(
        Effect.map((environment) => claudeHostEnvironmentValue(environment, "PATH", host.platform)),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => undefined),
      ),
      readVersion: (executable) =>
        Effect.tryPromise((signal) =>
          execFileAsync(executable, ["--version"], {
            signal,
            cwd: host.homeDirectory,
            env: host.environment,
            encoding: "utf8",
            shell: false,
            windowsHide: true,
            killSignal: "SIGKILL",
            timeout: 5_000,
            maxBuffer: 8_192,
          }),
        ).pipe(
          Effect.map(({ stdout }) => stdout),
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);
