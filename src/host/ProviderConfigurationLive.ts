import { checkCodexExecutable } from "../main/codex/CodexExecutableProbe";
import { HostShellEnvironment } from "../main/host-runtime/HostShellEnvironment";
/* @effect-diagnostics processEnv:off -- Native tool admission binds the current host process. */
import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { windowsDesktopToolCodexHome } from "../main/codex/desktop-tool-environment";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import { resolveCoreExecutable } from "../main/core-client/core-launcher";
import {
  makeWindowsDesktopTools,
  type WindowsProcessIdentity,
} from "../main/platform/node/WindowsDesktopTools";
import {
  makeWindowsBrowserRuntimeVerifier,
  probeWindowsBrowserTransport,
} from "../main/platform/node/WindowsBrowserRuntimeVerifier";
import { getLogger } from "../main/logging/logger";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HostAgentPolicy } from "./HostAgentPolicy";
import { MainConfig } from "../main/app/MainConfig";
import { MainApplicationError } from "../main/app/MainExit";
import { ApplicationSettings } from "../main/settings/ApplicationSettings";
import { appComponentHome } from "../main/app-components/AppComponentCatalog";
import {
  appComponentStoreRoot,
  prepareAppComponentStoreSweep,
} from "../main/app-components/AppComponentStore";
import { reconcileDisabledAppComponents } from "../main/app-components/AppComponents";
import { codexPackageLocation, resolveDesktopToolsEffect } from "../main/codex/codex-runtime";
import {
  externalCodexPackage,
  makeCodexPackage,
  skipsBundledCodexActivation,
} from "../main/codex/CodexPackage";
import * as ExecutionNode from "./ExecutionNodeLive";
import { codexFeatureDefaultLaunchArgs } from "../main/codex/codex-feature-defaults";
import {
  createCodexHomeDirectory,
  writeCodexHomeReceipt,
} from "../main/platform/node/CodexHomeReceipt";
import {
  codexAccountHomeLaunchArgs,
  inspectCodexAccountHome,
  hasCodexAccountFile,
  prepareCodexAccountHome,
} from "../main/platform/node/CodexAccountHome";
import { nodexCliPaths } from "../main/platform/node/NodexCliBootstrap";
import { nodexCliShellLaunchArgs, prepareNodexCliShell } from "../main/platform/node/NodexCliShell";
import { scenarioAgentRuntimeProjectRoot } from "../main/platform/node/AgentRuntimeEntrypoint";
import { CodexPlatform, CodexLocalLaunch } from "./ProviderPlatform";

export const platform: Layer.Layer<
  CodexPlatform,
  MainApplicationError,
  MainConfig | ApplicationSettings | HostShellEnvironment
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
    const componentStore = { home: appComponentHome(config), target: config };
    const sweepComponents = yield* reconcileDisabledAppComponents(
      config,
      snapshot.disabledAppComponents,
    ).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: (signal) =>
            prepareAppComponentStoreSweep({
              ...componentStore,
              appBuildVersion: config.appBuildVersion,
              signal,
            }),
          catch: (cause) =>
            new MainApplicationError({
              phase: "startup",
              operation: "prepare-component-store",
              cause,
            }),
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Component store preparation failed", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (sweepComponents) yield* Effect.promise(sweepComponents).pipe(Effect.forkScoped);
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
                componentVerifier: makeWindowsBrowserRuntimeVerifier(
                  native,
                  appComponentStoreRoot(appComponentHome(config)),
                  runNative,
                  "component-store",
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
    const runtimeOptions = {
      platform: config.platform,
      architecture: config.arch,
      isPackaged: config.isPackaged,
      headless: config.headless,
      nodexHome: config.headless ? undefined : config.nodexHome,
      appBuildVersion: config.appBuildVersion,
      environment: config.environment,
      projectRootPath: scenarioRuntimeProjectRoot || config.projectRootPath,
      resourcesPath: config.resourcesPath,
      windowsBrowserRuntimeVerifier: windows?.verifier,
      windowsComponentBrowserRuntimeVerifier: windows?.componentVerifier,
      deferWindowsBrowserRuntime: windows
        ? {
            verifyTransport: async (signal?: AbortSignal) => {
              await mkdir(windowsDesktopToolCodexHome(runtimeStateHome), { recursive: true });
              hostIdentity = await runNative(
                probeWindowsBrowserTransport(windows.native, process.pid),
                { signal },
              );
            },
          }
        : undefined,
    };
    const location = codexPackageLocation({
      ...runtimeOptions,
      nodexHome: config.nodexHome,
      headless: config.headless,
    });
    const codexPackage = makeCodexPackage(location, runtimeOptions);
    const bundled = location.source !== "component";
    const startupCheck = bundled
      ? !skipsBundledCodexActivation(config)
      : !snapshot.disabledAppComponents.includes("codex");
    const startup = startupCheck
      ? yield* codexPackage.activate().pipe(Effect.forkScoped({ startImmediately: true }))
      : undefined;
    if (bundled && !startup && config.environment.NODE_ENV === "test" && config.isolatedRunId) {
      yield* Effect.tryPromise(() =>
        access(path.join(config.nodexHome, "run", "activate-codex")),
      ).pipe(
        Effect.retry(Schedule.spaced("100 millis")),
        Effect.andThen(codexPackage.activate()),
        Effect.forkScoped,
      );
    }
    const packageAfterStartupCheck = (startup ? Fiber.join(startup) : Effect.void).pipe(
      Effect.andThen(Effect.sync(() => codexPackage.current)),
    );
    const { activeExecutable } = snapshot.codexExecutable;
    const shell = yield* HostShellEnvironment;
    const ordinaryPackageAfterStartupCheck = activeExecutable
      ? yield* Effect.cached(
          checkCodexExecutable(activeExecutable, config, shell).pipe(
            Effect.map(externalCodexPackage),
            Effect.tap((result) =>
              result.status === "available"
                ? Effect.logInfo("Using a configured Codex executable").pipe(
                    Effect.annotateLogs({
                      source: result.package.source,
                      version: result.package.version,
                    }),
                  )
                : Effect.logWarning("Configured Codex executable is unavailable", {
                    reason: result.reason,
                  }),
            ),
          ),
        )
      : packageAfterStartupCheck;
    const desktopTools = yield* resolveDesktopToolsEffect(runtimeOptions).pipe(
      Effect.mapError(
        (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "resolve-desktop-tools",
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
    const activation = desktopTools.browserRuntimeActivation;
    const prepare = activation?.source === "runtime-root" ? activation.activate : undefined;
    const verification = prepare
      ? yield* prepare.pipe(
          Effect.ignore,
          Effect.tap(() =>
            Effect.sync(() => {
              const result = desktopTools.browserRuntime;
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
      desktopTools,
      package: codexPackage,
      packageAfterStartupCheck,
      ordinaryPackageAfterStartupCheck,
      usesExternalExecutable: Boolean(activeExecutable),
      windowsDesktopTools:
        windows && activation
          ? {
              coreExecutable: windows.coreExecutable,
              native: windows.native,
              hostIdentity: () => hostIdentity,
              // Component users can inspect missing readiness while an install is pending.
              ready: verification ? Fiber.join(verification) : Effect.void,
            }
          : undefined,
      accountPresent: Effect.try(() => hasCodexAccountFile(accountHome)).pipe(
        Effect.orElseSucceed(() => false),
      ),
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
    const featureArgs = Effect.tryPromise(() =>
      codexFeatureDefaultLaunchArgs(codex.codexHome),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MainApplicationError({ phase: "startup", operation: "read-codex-defaults", cause }),
      ),
    );
    const accountArgs = codexAccountHomeLaunchArgs(codex.accountHome);
    const prepareAccount = yield* Effect.cached(
      Effect.try({
        try: () =>
          prepareCodexAccountHome({
            sharedHome: codex.codexHome,
            accountHome:
              codex.accountHome.mode === "overlay" ? codex.accountHome.effectiveHome : null,
            platform: config.platform,
          }),
        catch: (cause) =>
          new MainApplicationError({
            phase: "startup",
            operation: "prepare-codex-account",
            cause,
          }),
      }),
    );
    const cliError = (cause: unknown) =>
      new MainApplicationError({ phase: "startup", operation: "prepare-cli-shell", cause });
    yield* Effect.tryPromise({
      try: () =>
        prepareNodexCliShell(config.nodexHome, config.platform, nodexCliPaths(config).executable),
      catch: cliError,
    });
    const overrides = yield* Cache.makeWith(
      ([environment, ...searchPaths]: readonly [Readonly<NodeJS.ProcessEnv>, ...string[]]) =>
        Effect.tryPromise({
          try: () =>
            nodexCliShellLaunchArgs({
              platform: config.platform,
              nodexHome: config.nodexHome,
              codexHome: codex.codexHome,
              ...(Option.isSome(policy) ? { privateCoreHome: policy.value.coreHome } : {}),
              searchPaths,
              homeDirectory: config.homeDirectory,
              inheritedEnvironment: environment,
            }),
          catch: cliError,
        }).pipe(
          Effect.flatMap((cliArgs) =>
            featureArgs.pipe(Effect.map((defaults) => [...defaults, ...cliArgs, ...accountArgs])),
          ),
        ),
      {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );
    return CodexLocalLaunch.of({
      prepareAccount,
      declaration: accountArgs,
      resolveOverrides: (environment, searchPaths) =>
        Cache.get(overrides, [environment, ...searchPaths]),
    });
  }),
);

export const live = localLaunch.pipe(Layer.provideMerge(Layer.merge(platform, ExecutionNode.live)));
