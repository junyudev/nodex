import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HostAgentPolicy } from "./HostAgentPolicy";
import { MainConfig } from "../main/app/MainConfig";
import { MainApplicationError } from "../main/app/MainExit";
import { ApplicationSettings } from "../main/settings/ApplicationSettings";
import { resolveCodexRuntimeEffect } from "../main/codex/codex-runtime";
import { codexFeatureDefaultLaunchArgs } from "../main/codex/codex-feature-defaults";
import {
  createCodexHomeDirectory,
  writeCodexHomeReceipt,
} from "../main/platform/node/CodexHomeReceipt";
import {
  codexAccountHomeLaunchArgs,
  inspectCodexAccountHome,
} from "../main/platform/node/CodexAccountHome";
import { nodexCliShellLaunchArgs, prepareNodexCliShell } from "../main/platform/node/NodexCliShell";
import { scenarioAgentRuntimeProjectRoot } from "../main/platform/node/AgentRuntimeEntrypoint";
import { CodexPlatform, CodexLocalLaunch } from "./ProviderPlatform";

export const platform: Layer.Layer<
  CodexPlatform,
  MainApplicationError,
  MainConfig | ApplicationSettings
> = Layer.effect(
  CodexPlatform,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const settings = yield* ApplicationSettings;
    const snapshot = yield* settings.snapshot().pipe(
      Effect.mapError(
        (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "resolve-codex-home",
            cause,
          }),
      ),
    );
    const scenarioRuntimeProjectRoot = scenarioAgentRuntimeProjectRoot(config);
    const runtime = yield* resolveCodexRuntimeEffect({
      platform: config.platform,
      architecture: config.arch,
      isPackaged: config.isPackaged,
      projectRootPath: scenarioRuntimeProjectRoot || config.projectRootPath,
      resourcesPath: config.resourcesPath,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "resolve-codex-runtime",
            cause,
          }),
      ),
    );
    const accountHome = yield* Effect.try({
      try: () =>
        inspectCodexAccountHome({
          sharedHome: snapshot.codexHome.activeHomePath,
          accountHome: snapshot.codexHome.activeAccountHomePath,
          platform: config.platform,
        }),
      catch: (cause) =>
        new MainApplicationError({ phase: "startup", operation: "resolve-codex-account", cause }),
    });
    yield* Effect.try({
      try: () => {
        createCodexHomeDirectory(accountHome.sharedHome);
        writeCodexHomeReceipt({
          profileHome: config.nodexHome,
          codexHome: accountHome.sharedHome,
        });
      },
      catch: (cause) =>
        new MainApplicationError({ phase: "startup", operation: "prepare-codex-home", cause }),
    });
    return CodexPlatform.of({
      runtime,
      codexHome: accountHome.sharedHome,
      accountHome,
      runtimeStateHome: `${config.nodexHome}/runtime/agent`,
    });
  }),
);

/**
 * Every local Codex process uses the Space's feature defaults, task-bound CLI,
 * selected provider credentials and shared history.
 */
/** Prepared once per Host process: preparing again would drop every live task binding. */
export const localLaunch = Layer.effect(
  CodexLocalLaunch,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const policy = yield* Effect.serviceOption(HostAgentPolicy);
    const featureArgs = yield* Effect.tryPromise(() =>
      codexFeatureDefaultLaunchArgs(codex.codexHome),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MainApplicationError({ phase: "startup", operation: "read-codex-defaults", cause }),
      ),
    );
    const accountArgs = codexAccountHomeLaunchArgs(codex.accountHome);
    const cliArgs = yield* Effect.tryPromise(() =>
      prepareNodexCliShell(config.nodexHome, config.platform),
    ).pipe(
      Effect.andThen(
        Effect.tryPromise(() =>
          nodexCliShellLaunchArgs({
            platform: config.platform,
            nodexHome: config.nodexHome,
            codexHome: codex.codexHome,
            ...(Option.isSome(policy) ? { privateCoreHome: policy.value.coreHome } : {}),
            searchPaths: codex.runtime.additionalSearchPaths,
            homeDirectory: config.homeDirectory,
            inheritedEnvironment: {
              ...config.environment,
              PATH: config.environmentPath ?? config.environment.PATH,
            },
          }),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "prepare-cli-shell",
            cause,
          }),
      ),
    );
    return CodexLocalLaunch.of({ configOverrides: [...featureArgs, ...cliArgs, ...accountArgs] });
  }),
);

export const live = localLaunch.pipe(Layer.provideMerge(platform));
