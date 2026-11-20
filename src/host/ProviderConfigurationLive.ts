/* @effect-diagnostics processEnv:off -- Native tool admission binds the current host process. */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { windowsDesktopToolCodexHome } from "../main/codex/desktop-tool-environment";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import { resolveCoreExecutable } from "../main/core-client/core-launcher";
import {
  makeWindowsDesktopTools,
  type WindowsProcessIdentity,
} from "../main/platform/node/WindowsDesktopTools";
import { makeWindowsBrowserRuntimeVerifier } from "../main/platform/node/WindowsBrowserRuntimeVerifier";
import { getLogger } from "../main/logging/logger";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HostAgentPolicy } from "./HostAgentPolicy";
import { MainConfig } from "../main/app/MainConfig";
import { MainApplicationError } from "../main/app/MainExit";
import { ApplicationSettings } from "../main/settings/ApplicationSettings";
import { appComponentHome } from "../main/app-components/AppComponentCatalog";
import { prepareAppComponentStore } from "../main/app-components/AppComponentStore";
import { reconcileDisabledAppComponents } from "../main/app-components/AppComponents";
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
import { nodexCliPaths } from "../main/platform/node/NodexCliBootstrap";
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
    yield* reconcileDisabledAppComponents(config, snapshot.disabledAppComponents).pipe(
      Effect.mapError(
        (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "reconcile-component-preferences",
            cause,
          }),
      ),
    );
    if (config.headless) {
      yield* Effect.tryPromise({
        try: (signal) =>
          prepareAppComponentStore({ home: appComponentHome(config), target: config, signal }),
        catch: (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "prepare-component-store",
            cause,
          }),
      });
    }
    const scenarioRuntimeProjectRoot = scenarioAgentRuntimeProjectRoot(config);
    const runNative = yield* FiberSet.makeRuntimePromise();
    const windows =
      config.platform === "win32"
        ? yield* Effect.try({
            try: () => {
              const coreExecutable = resolveCoreExecutable({
                isPackaged: config.isPackaged,
                appResourcesPath: config.resourcesPath,
                repositoryRoot: config.projectRootPath,
                environment: config.environment,
              });
              const native = makeWindowsDesktopTools(coreExecutable);
              return {
                coreExecutable,
                native,
                verifier: makeWindowsBrowserRuntimeVerifier(
                  native,
                  config.isPackaged
                    ? path.dirname(config.resourcesPath)
                    : path.join(
                        scenarioRuntimeProjectRoot || config.projectRootPath,
                        ".generated",
                        "codex-runtime",
                      ),
                  runNative,
                ),
              };
            },
            catch: (cause) =>
              new MainApplicationError({
                phase: "startup",
                operation: "resolve-desktop-tools-native",
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Windows Desktop Tools provider unavailable", {
                cause: String(error.cause),
              }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined;
    const runtimeStateHome = path.join(config.nodexHome, "runtime", "agent");
    let hostIdentity: WindowsProcessIdentity | undefined;
    const runtime = yield* resolveCodexRuntimeEffect({
      platform: config.platform,
      architecture: config.arch,
      isPackaged: config.isPackaged,
      nodexHome: config.headless ? undefined : config.nodexHome,
      appBuildVersion: config.appBuildVersion,
      environment: config.environment,
      projectRootPath: scenarioRuntimeProjectRoot || config.projectRootPath,
      resourcesPath: config.resourcesPath,
      windowsBrowserRuntimeVerifier: windows?.verifier,
      deferWindowsBrowserRuntime: windows
        ? {
            verifyTransport: async (signal) => {
              await mkdir(windowsDesktopToolCodexHome(runtimeStateHome), { recursive: true });
              return runNative(
                Effect.scoped(
                  Effect.gen(function* () {
                    const host = yield* windows.native.processIdentity(process.pid);
                    yield* windows.native.listenPipe("nodex-desktop-tools-probe");
                    hostIdentity = host;
                  }),
                ),
                { signal },
              );
            },
          }
        : undefined,
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
    const activation = runtime.browserRuntimeActivation;
    const prepare = activation?.source === "runtime-root" ? activation.activate : undefined;
    const verification = prepare
      ? yield* prepare.pipe(
          Effect.ignore,
          Effect.tap(() =>
            Effect.sync(() => {
              const result = runtime.browserRuntime;
              if (result.status === "unavailable")
                getLogger({ component: "desktop-tools" }).warn(
                  "Windows Desktop Tools unavailable",
                  {
                    reason: result.reason,
                    message: result.message,
                  },
                );
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
      : undefined;
    return CodexPlatform.of({
      runtime,
      windowsDesktopTools:
        windows && verification
          ? {
              coreExecutable: windows.coreExecutable,
              native: windows.native,
              hostIdentity: () => hostIdentity,
              ready: Fiber.join(verification),
            }
          : undefined,
      codexHome: accountHome.sharedHome,
      accountHome,
      runtimeStateHome,
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
    const cliError = (cause: unknown) =>
      new MainApplicationError({ phase: "startup", operation: "prepare-cli-shell", cause });
    yield* Effect.tryPromise({
      try: () =>
        prepareNodexCliShell(config.nodexHome, config.platform, nodexCliPaths(config).executable),
      catch: cliError,
    });
    const overrides = yield* Cache.makeWith(
      (environment: Readonly<NodeJS.ProcessEnv>) =>
        Effect.tryPromise({
          try: () =>
            nodexCliShellLaunchArgs({
              platform: config.platform,
              nodexHome: config.nodexHome,
              codexHome: codex.codexHome,
              ...(Option.isSome(policy) ? { privateCoreHome: policy.value.coreHome } : {}),
              searchPaths: codex.runtime.additionalSearchPaths,
              homeDirectory: config.homeDirectory,
              inheritedEnvironment: environment,
            }),
          catch: cliError,
        }).pipe(Effect.map((cliArgs) => [...featureArgs, ...cliArgs, ...accountArgs])),
      {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );
    return CodexLocalLaunch.of({
      declaration: [...featureArgs, ...accountArgs],
      resolveOverrides: (environment) => Cache.get(overrides, environment),
    });
  }),
);

export const live = localLaunch.pipe(Layer.provideMerge(platform));
