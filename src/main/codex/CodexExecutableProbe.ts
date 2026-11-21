import * as Effect from "effect/Effect";
import type { CodexExecutableProbe } from "../../shared/codex-executable-settings";
import type { MainConfig } from "../app/MainConfig";
import type { HostShellEnvironment } from "../host-runtime/HostShellEnvironment";
import { probeCodexExecutable } from "../platform/node/CodexExecutable";

export const checkCodexExecutable = (
  executable: string,
  config: MainConfig["Service"],
  shell: HostShellEnvironment["Service"] | undefined,
): Effect.Effect<CodexExecutableProbe> =>
  Effect.gen(function* () {
    const environment =
      shell && config.platform !== "win32" ? yield* shell.load : config.environment;
    return yield* Effect.tryPromise((signal) =>
      probeCodexExecutable({
        executable,
        environment,
        home: config.homeDirectory,
        platform: config.platform,
        signal,
      }),
    ).pipe(Effect.orElseSucceed(() => ({ status: "probe-failed" }) as const));
  });
