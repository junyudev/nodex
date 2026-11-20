import { codexCliAppServerArgs } from "../../../shared/codex-app-server-launch";
import { withoutDesktopToolHostBindings } from "../../codex/desktop-tool-environment";
import type { CodexLocalLaunch } from "../../../host/ProviderPlatform";
import type { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import {
  assertCodexAccountHomeIdentity,
  codexAccountHomeEnvironment,
  type CodexAccountHome,
} from "./CodexAccountHome";
import type { CodexSessionLaunch } from "./CodexSessionTransport";
import * as Effect from "effect/Effect";
import { codexRuntimeError, type CodexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import { childProcessEnvironment, mergeProcessEnvironments } from "./child-process-environment";

export const resolveCodexProcessEnvironment = (input: {
  readonly additionalSearchPaths: readonly string[];
  readonly pathDelimiter: string;
  readonly codexHome: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<Readonly<NodeJS.ProcessEnv>, CodexRuntimeError> =>
  Effect.try({
    try: () => {
      const windows = input.pathDelimiter === ";";
      const platform = windows ? "win32" : "posix";
      const environment = withoutDesktopToolHostBindings(
        childProcessEnvironment(input.environment, platform),
        platform,
      );
      const inheritedPath = environment.PATH ?? "";
      return {
        ...mergeProcessEnvironments(windows ? "win32" : "posix", environment, {
          CODEX_HOME: input.codexHome,
        }),
        PATH: [...input.additionalSearchPaths, inheritedPath]
          .filter(Boolean)
          .join(input.pathDelimiter),
      };
    },
    catch: (cause) =>
      codexRuntimeError({
        operation: "session.resolve-environment",
        reason: "spawn",
        retryable: false,
        hostId: "local",
        cause,
      }),
  });

/** Resolve argv and env from the same host snapshot at each physical launch. */
export const resolveLocalCodexLaunch = Effect.fn("CodexProcessEnvironment.resolveLocalLaunch")(
  function* (input: {
    readonly accountHome: CodexAccountHome;
    readonly profileHome: string;
    readonly platform: string;
    readonly additionalSearchPaths: readonly string[];
    readonly shell: Pick<HostShellEnvironment["Service"], "load">;
    readonly localLaunch: Pick<CodexLocalLaunch["Service"], "resolveOverrides">;
    readonly pending: CodexSessionLaunch;
  }): Effect.fn.Return<CodexSessionLaunch, CodexRuntimeError> {
    const { accountHome, platform, pending } = input;
    const host = yield* input.shell.load;
    const inherited = Object.keys(pending.env).length
      ? mergeProcessEnvironments(platform, host, pending.env)
      : host;
    const configOverrides = yield* input.localLaunch.resolveOverrides(inherited).pipe(
      Effect.mapError((cause) =>
        codexRuntimeError({
          operation: "session.resolve-launch-arguments",
          reason: "spawn",
          retryable: false,
          hostId: "local",
          cause,
        }),
      ),
    );
    yield* Effect.try({
      try: () => assertCodexAccountHomeIdentity(accountHome, platform),
      catch: (cause) =>
        codexRuntimeError({
          operation: "session.validate-account-home",
          reason: "spawn",
          retryable: false,
          hostId: "local",
          cause,
        }),
    });
    const env = yield* resolveCodexProcessEnvironment({
      additionalSearchPaths: input.additionalSearchPaths,
      pathDelimiter: platform === "win32" ? ";" : ":",
      codexHome: accountHome.effectiveHome,
      environment: codexAccountHomeEnvironment(
        accountHome,
        mergeProcessEnvironments(platform, inherited, { NODEX_HOME: input.profileHome }),
      ),
    });
    return {
      args: [...codexCliAppServerArgs(env), ...configOverrides, ...pending.args],
      env,
      ...(pending.localDaemon ? { localDaemon: { ...pending.localDaemon, configOverrides } } : {}),
    };
  },
);
