import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../../app/MainConfig";
import { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import { execFileAsync } from "./child-stdio-errors";
import { childProcessEnvironment } from "./child-process-environment";
import { makeHostExecutableSearch } from "./HostExecutableSearch";

export class LocalAgentDiscoveryPlatform extends Context.Service<
  LocalAgentDiscoveryPlatform,
  {
    readonly select: ReturnType<typeof makeHostExecutableSearch>["select"];
    readonly readVersion: (
      executable: string,
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<string | null>;
  }
>()("nodex/main/platform/node/LocalAgentDiscoveryPlatform") {}

export const live = Layer.effect(
  LocalAgentDiscoveryPlatform,
  Effect.gen(function* () {
    const host = yield* MainConfig;
    const shell = yield* HostShellEnvironment;
    return LocalAgentDiscoveryPlatform.of({
      select: makeHostExecutableSearch(host, shell).select,
      readVersion: (executable, environment) =>
        Effect.tryPromise((signal) =>
          execFileAsync(executable, ["--version"], {
            signal,
            cwd: host.homeDirectory,
            env: childProcessEnvironment(environment, host.platform),
            encoding: "utf8",
            shell: false,
            windowsHide: true,
            killSignal: "SIGKILL",
            timeout: 20_000,
            maxBuffer: 8_192,
          }),
        ).pipe(
          Effect.map(({ stdout, stderr }) => (stdout.trim() ? stdout : stderr)),
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);
