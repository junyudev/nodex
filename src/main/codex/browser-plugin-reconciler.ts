import fs from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import type { BrowserRuntimeAvailability } from "./browser-runtime-bundle";
import { resolveAvailableBrowserUseBackends } from "./browser-use-backends";
import {
  materializeBundledDesktopToolMarketplace,
  nodexDesktopToolMarketplaceName,
  type MaterializedDesktopToolPlugin,
} from "./bundled-desktop-tool-marketplace";

type BrowserPluginRequestMethod =
  | "marketplace/add"
  | "marketplace/remove"
  | "config/batchWrite"
  | "plugin/install"
  | "plugin/list"
  | "plugin/uninstall"
  | "skills/list";

export class BrowserPluginReconcileError extends Schema.TaggedError<BrowserPluginReconcileError>()(
  "BrowserPluginReconcileError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserPluginRequestPort {
  readonly request: <M extends BrowserPluginRequestMethod>(
    method: M,
    params: ClientRequestParamsByMethod[M],
  ) => Effect.Effect<ClientRequestResponsesByMethod[M], BrowserPluginReconcileError>;
}

export type ComputerUsePluginReconcileResult =
  | {
      enabled: boolean;
      installedVersion: string;
      pluginRoot: string;
      status: "ready";
    }
  | {
      message: string;
      reason: "capability-unavailable" | "reconciliation-failed";
      status: "unavailable";
    };

export type ChromePluginReconcileResult =
  | {
      enabled: boolean;
      installedVersion: string;
      pluginRoot: string;
      status: "ready";
    }
  | {
      message: string;
      reason: "backend-unavailable" | "capability-unavailable" | "reconciliation-failed";
      status: "unavailable";
    };

export type BrowserPluginReconcileResult =
  | {
      chrome: ChromePluginReconcileResult;
      computerUse: ComputerUsePluginReconcileResult;
      enabled: boolean;
      installedVersion: string | null;
      marketplaceRoot: string;
      status: "ready";
    }
  | {
      message: string;
      reason: "backend-unavailable" | "reconciliation-failed" | "runtime-unavailable";
      status: "unavailable";
    };

export interface BrowserPluginReconciler {
  readonly result: Effect.Effect<BrowserPluginReconcileResult | null>;
  readonly ensureInstalled: Effect.Effect<BrowserPluginReconcileResult>;
}

export interface BrowserPluginReconcilerOptions {
  readonly availableBackends?: () => readonly BrowserRuntimeBackend[];
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly client: BrowserPluginRequestPort;
  readonly computerUseAvailable?: () => boolean;
  readonly codexHome: string;
  readonly runtimeStateHome: string;
}

type BrowserPluginDesiredState =
  | {
      browserAvailable: boolean;
      chromeAvailable: boolean;
      computerUseAvailable: boolean;
      key: string;
      status: "available";
    }
  | {
      key: string;
      message: string;
      reason: "backend-unavailable" | "runtime-unavailable";
      status: "unavailable";
    };

type MarketplacePlugin =
  ClientRequestResponsesByMethod["plugin/list"]["marketplaces"][number]["plugins"][number];

type DesktopToolPluginName = "browser" | "chrome" | "computer-use";

type BundledMarketplaceSnapshot = {
  marketplacePath: string;
  plugins: readonly MarketplacePlugin[];
};

type ReconcileEnvironment = {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly client: BrowserPluginRequestPort;
  readonly codexHome: string;
  readonly runtimeStateHome: string;
  readonly marketplaceName: string;
};

function resolveDesiredState(
  browserRuntime: BrowserRuntimeAvailability,
  availableBackends: () => readonly BrowserRuntimeBackend[],
  computerUseAvailable: () => boolean,
): BrowserPluginDesiredState {
  if (browserRuntime.status === "unavailable") {
    return {
      key: "runtime-unavailable",
      message: browserRuntime.message,
      reason: "runtime-unavailable",
      status: "unavailable",
    };
  }
  let requestedBackends: readonly BrowserRuntimeBackend[];
  let computerUseReady: boolean;
  try {
    requestedBackends = availableBackends();
    computerUseReady =
      computerUseAvailable() &&
      browserRuntime.bundle.manifest.capabilities.computerUse.status === "available";
  } catch (error) {
    const message =
      error instanceof Error
        ? `Desktop tool availability failed: ${error.message}`
        : "Desktop tool availability failed";
    return {
      key: `backend-unavailable:${message}`,
      message,
      reason: "backend-unavailable",
      status: "unavailable",
    };
  }
  const resolvedBackends = resolveAvailableBrowserUseBackends(
    browserRuntime.bundle.manifest.supportedBackends,
    requestedBackends,
  );
  const browserAvailable = resolvedBackends.length > 0;
  const chromeAvailable = resolvedBackends.includes("chrome");
  if (!browserAvailable && !computerUseReady) {
    return {
      key: "backend-unavailable",
      message: "Desktop tool host backends are unavailable",
      reason: "backend-unavailable",
      status: "unavailable",
    };
  }
  return {
    browserAvailable,
    chromeAvailable,
    computerUseAvailable: computerUseReady,
    key: `available:browser=${String(browserAvailable)};chrome=${String(chromeAvailable)};computer-use=${String(computerUseReady)}`,
    status: "available",
  };
}

const reconciliationFailure = (message: string): BrowserPluginReconcileResult => ({
  message,
  reason: "reconciliation-failed",
  status: "unavailable",
});

function errorMessage(error: BrowserPluginReconcileError): string {
  return error.cause instanceof Error
    ? `Desktop tool plugin reconciliation failed: ${error.cause.message}`
    : "Desktop tool plugin reconciliation failed";
}

const reconcileError = (operation: string, cause: unknown) =>
  new BrowserPluginReconcileError({ operation, cause });

const findPlugin = (
  marketplace: BundledMarketplaceSnapshot,
  pluginName: DesktopToolPluginName,
): MarketplacePlugin | null =>
  marketplace.plugins.find((candidate) => candidate.name === pluginName) ?? null;

const isPluginReady = (plugin: MarketplacePlugin | null, version: string): boolean =>
  Boolean(
    plugin?.installed && !plugin.enabled && (plugin.localVersion ?? plugin.version) === version,
  );

function canonicalPath(value: string): string {
  try {
    const resolved = fs.realpathSync(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

const pathsReferToSameLocation = (left: string, right: string): boolean =>
  canonicalPath(left) === canonicalPath(right);

function readBundledMarketplace(
  environment: ReconcileEnvironment,
): Effect.Effect<BundledMarketplaceSnapshot | null, BrowserPluginReconcileError> {
  return environment.client.request("plugin/list", { cwds: [], marketplaceKinds: ["local"] }).pipe(
    Effect.map((response) => {
      for (const marketplace of response.marketplaces) {
        if (marketplace.name !== environment.marketplaceName || !marketplace.path) continue;
        return {
          marketplacePath: marketplace.path,
          plugins: marketplace.plugins,
        };
      }
      return null;
    }),
  );
}

function reconcilePlugin(
  environment: ReconcileEnvironment,
  input: {
    current: MarketplacePlugin | null;
    desired: boolean;
    materialized: MaterializedDesktopToolPlugin | null;
    marketplacePath: string;
    pluginName: DesktopToolPluginName;
  },
): Effect.Effect<boolean, BrowserPluginReconcileError> {
  if (!input.desired) {
    if (!input.current?.installed && !input.current?.enabled) return Effect.succeed(false);
    return environment.client
      .request("plugin/uninstall", { pluginId: input.current.id })
      .pipe(Effect.as(true));
  }
  const { current, materialized, pluginName } = input;
  if (!materialized) {
    return Effect.fail(
      reconcileError(
        "resolve-plugin-version",
        new Error(`${input.pluginName} plugin version is unavailable`),
      ),
    );
  }
  if (!current) {
    return Effect.fail(
      reconcileError(
        "resolve-plugin",
        new Error(`Bundled marketplace did not expose ${input.pluginName}`),
      ),
    );
  }
  return Effect.gen(function* () {
    const installedVersion = current.localVersion ?? current.version;
    const refreshInstall =
      !current.installed ||
      installedVersion !== materialized.version ||
      !(yield* revisedSkillIsInstalled(environment, pluginName, materialized));
    if (!refreshInstall && !current.enabled) return false;
    if (refreshInstall) {
      yield* environment.client.request("plugin/install", {
        marketplacePath: input.marketplacePath,
        pluginName: input.pluginName,
      });
    }
    // Installation persists only this Profile's namespace. Native clients leave these
    // desktop peers off; Nodex activates them in each Thread's own runtime config.
    yield* environment.client.request("config/batchWrite", {
      edits: [
        {
          keyPath: `plugins.${input.pluginName}@${environment.marketplaceName}.enabled`,
          value: false,
          mergeStrategy: "replace",
        },
      ],
      expectedVersion: null,
      filePath: null,
      reloadUserConfig: true,
    });
    return true;
  });
}

function revisedSkillIsInstalled(
  environment: ReconcileEnvironment,
  pluginName: DesktopToolPluginName,
  { rootPath, version, revisedSkillPath }: MaterializedDesktopToolPlugin,
): Effect.Effect<boolean> {
  if (!revisedSkillPath) return Effect.succeed(true);
  const installed = path.join(
    environment.codexHome,
    "plugins",
    "cache",
    environment.marketplaceName,
    pluginName,
    version,
    revisedSkillPath,
  );
  // Plugin/list describes the marketplace version even when the installed cache is older.
  return Effect.tryPromise(async () => {
    const [expected, actual] = await Promise.all([
      fs.promises.readFile(path.join(rootPath, revisedSkillPath)),
      fs.promises.readFile(installed),
    ]);
    return expected.equals(actual);
  }).pipe(Effect.orElseSucceed(() => false));
}

function isReconciledPluginReady(
  environment: ReconcileEnvironment,
  pluginName: DesktopToolPluginName,
  current: MarketplacePlugin | null,
  materialized: MaterializedDesktopToolPlugin | null,
): Effect.Effect<boolean> {
  if (!materialized || !isPluginReady(current, materialized.version)) return Effect.succeed(false);
  return revisedSkillIsInstalled(environment, pluginName, materialized);
}

function removeInstalledPlugins(
  environment: ReconcileEnvironment,
): Effect.Effect<void, BrowserPluginReconcileError> {
  return Effect.gen(function* () {
    const current = yield* readBundledMarketplace(environment);
    if (!current) return;
    let changed = false;
    for (const pluginName of ["browser", "chrome", "computer-use"] as const) {
      const plugin = findPlugin(current, pluginName);
      if (!plugin?.installed && !plugin?.enabled) continue;
      yield* environment.client.request("plugin/uninstall", { pluginId: plugin.id });
      changed = true;
    }
    if (!changed) return;
    yield* environment.client.request("skills/list", { forceReload: true });
    const reconciled = yield* readBundledMarketplace(environment);
    if (!reconciled) return;
    const retained = ["browser", "chrome", "computer-use"].some((pluginName) => {
      const plugin = findPlugin(reconciled, pluginName as DesktopToolPluginName);
      return plugin?.installed || plugin?.enabled;
    });
    if (retained) {
      return yield* Effect.fail(
        reconcileError(
          "verify-plugin-removal",
          new Error("Desktop tool plugin remained enabled after uninstall"),
        ),
      );
    }
  });
}

function resolveChromeResult(input: {
  desired: boolean;
  materialized: MaterializedDesktopToolPlugin | null;
  ready: boolean;
}): ChromePluginReconcileResult {
  const { materialized } = input;
  if (!materialized) {
    return {
      message: "Chrome runtime capability is unavailable",
      reason: "capability-unavailable",
      status: "unavailable",
    };
  }
  if (!input.desired) {
    return {
      message: "Chrome provider backend is unavailable",
      reason: "backend-unavailable",
      status: "unavailable",
    };
  }
  if (!input.ready) {
    return {
      message: "Chrome plugin reconciliation did not produce the verified Thread-scoped version",
      reason: "reconciliation-failed",
      status: "unavailable",
    };
  }
  return {
    enabled: true,
    installedVersion: materialized.version,
    pluginRoot: materialized.rootPath,
    status: "ready",
  };
}

function resolveComputerUseResult(input: {
  desired: boolean;
  materialized: MaterializedDesktopToolPlugin | null;
  ready: boolean;
}): ComputerUsePluginReconcileResult {
  const { materialized } = input;
  if (!input.desired || !materialized) {
    return {
      message: "Computer Use runtime capability is unavailable",
      reason: "capability-unavailable",
      status: "unavailable",
    };
  }
  if (!input.ready) {
    return {
      message:
        "Computer Use plugin reconciliation did not produce the verified Thread-scoped version",
      reason: "reconciliation-failed",
      status: "unavailable",
    };
  }
  return {
    enabled: true,
    installedVersion: materialized.version,
    pluginRoot: materialized.rootPath,
    status: "ready",
  };
}

/** Host Agent adapters load verified plugin roots directly. No Codex catalog registers these. */
export const materializeHostDesktopToolPlugins = Effect.fn("DesktopTools.materializeHostPlugins")(
  function* (input: {
    readonly browserRuntime: BrowserRuntimeAvailability;
    readonly availableBackends: () => readonly BrowserRuntimeBackend[];
    readonly computerUseAvailable: boolean;
    readonly runtimeStateHome: string;
  }): Effect.fn.Return<BrowserPluginReconcileResult, BrowserPluginReconcileError> {
    const desired = resolveDesiredState(
      input.browserRuntime,
      input.availableBackends,
      () => input.computerUseAvailable,
    );
    if (desired.status === "unavailable") return desired;
    if (input.browserRuntime.status === "unavailable") {
      return {
        status: "unavailable",
        message: input.browserRuntime.message,
        reason: "runtime-unavailable",
      };
    }
    const { bundle } = input.browserRuntime;
    const materialized = yield* Effect.tryPromise({
      try: () =>
        materializeBundledDesktopToolMarketplace({
          bundle,
          includeComputerUse: desired.computerUseAvailable,
          // Host agents and Codex can materialize at the same time.
          runtimeStateHome: path.join(input.runtimeStateHome, "host-desktop-tools"),
        }),
      catch: (cause) => reconcileError("materialize-host-marketplace", cause),
    });
    const { browser, chrome, computerUse } = materialized;
    return {
      status: "ready",
      marketplaceRoot: materialized.rootPath,
      enabled: desired.browserAvailable,
      installedVersion: desired.browserAvailable ? browser.version : null,
      chrome:
        desired.chromeAvailable && chrome
          ? {
              status: "ready",
              enabled: true,
              installedVersion: chrome.version,
              pluginRoot: chrome.rootPath,
            }
          : {
              status: "unavailable",
              reason: "backend-unavailable",
              message: "Chrome is unavailable.",
            },
      computerUse:
        desired.computerUseAvailable && computerUse
          ? {
              status: "ready",
              enabled: true,
              installedVersion: computerUse.version,
              pluginRoot: computerUse.rootPath,
            }
          : {
              status: "unavailable",
              reason: "capability-unavailable",
              message: "Computer Use is unavailable.",
            },
    };
  },
);

function reconcile(
  environment: ReconcileEnvironment,
  desiredState: BrowserPluginDesiredState,
): Effect.Effect<BrowserPluginReconcileResult> {
  return Effect.gen(function* () {
    if (desiredState.status === "unavailable") {
      yield* removeInstalledPlugins(environment);
      return {
        message: desiredState.message,
        reason: desiredState.reason,
        status: "unavailable" as const,
      };
    }
    if (environment.browserRuntime.status === "unavailable") {
      return {
        message: environment.browserRuntime.message,
        reason: "runtime-unavailable" as const,
        status: "unavailable" as const,
      };
    }
    const bundle = environment.browserRuntime.bundle;
    const materialized = yield* Effect.tryPromise({
      try: () =>
        materializeBundledDesktopToolMarketplace({
          bundle,
          includeComputerUse: desiredState.computerUseAvailable,
          runtimeStateHome: environment.runtimeStateHome,
        }),
      catch: (cause) => reconcileError("materialize-marketplace", cause),
    });
    let marketplace = yield* readBundledMarketplace(environment);
    if (
      marketplace &&
      !pathsReferToSameLocation(
        marketplace.marketplacePath,
        path.join(materialized.rootPath, ".agents", "plugins", "marketplace.json"),
      )
    ) {
      yield* environment.client.request("marketplace/remove", {
        marketplaceName: environment.marketplaceName,
      });
      marketplace = null;
    }
    if (!marketplace) {
      yield* environment.client.request("marketplace/add", { source: materialized.rootPath });
      marketplace = yield* readBundledMarketplace(environment);
    }
    if (!marketplace) {
      return reconciliationFailure(
        "Verified bundled marketplace was not available after registration",
      );
    }

    const tools = [
      ["browser", materialized.browser, desiredState.browserAvailable],
      ["chrome", materialized.chrome, desiredState.chromeAvailable],
      ["computer-use", materialized.computerUse, desiredState.computerUseAvailable],
    ] as const;
    let changed = false;
    for (const [pluginName, plugin, desired] of tools) {
      changed =
        (yield* reconcilePlugin(environment, {
          current: findPlugin(marketplace, pluginName),
          desired,
          materialized: plugin,
          marketplacePath: marketplace.marketplacePath,
          pluginName,
        })) || changed;
    }
    if (changed) {
      yield* environment.client.request("skills/list", { forceReload: true });
      marketplace = yield* readBundledMarketplace(environment);
    }
    if (!marketplace) {
      return reconciliationFailure("Bundled marketplace disappeared during reconciliation");
    }

    const browserPlugin = findPlugin(marketplace, "browser");
    const browserReady = desiredState.browserAvailable
      ? yield* isReconciledPluginReady(environment, "browser", browserPlugin, materialized.browser)
      : !browserPlugin?.installed && !browserPlugin?.enabled;
    if (!browserReady) {
      return reconciliationFailure(
        "Browser plugin reconciliation did not produce the requested state",
      );
    }

    const chrome = resolveChromeResult({
      desired: desiredState.chromeAvailable,
      materialized: materialized.chrome,
      ready: yield* isReconciledPluginReady(
        environment,
        "chrome",
        findPlugin(marketplace, "chrome"),
        materialized.chrome,
      ),
    });
    if (desiredState.chromeAvailable && chrome.status === "unavailable") {
      return reconciliationFailure(chrome.message);
    }

    const computerUse = resolveComputerUseResult({
      desired: desiredState.computerUseAvailable,
      materialized: materialized.computerUse,
      ready: yield* isReconciledPluginReady(
        environment,
        "computer-use",
        findPlugin(marketplace, "computer-use"),
        materialized.computerUse,
      ),
    });
    if (
      !desiredState.browserAvailable &&
      desiredState.computerUseAvailable &&
      computerUse.status === "unavailable"
    ) {
      return reconciliationFailure(computerUse.message);
    }

    return {
      chrome,
      computerUse,
      enabled: desiredState.browserAvailable,
      installedVersion: desiredState.browserAvailable ? materialized.browser.version : null,
      marketplaceRoot: materialized.rootPath,
      status: "ready" as const,
    };
  }).pipe(Effect.catch((error) => Effect.succeed(reconciliationFailure(errorMessage(error)))));
}

export const makeBrowserPluginReconciler = (
  options: BrowserPluginReconcilerOptions,
): Effect.Effect<BrowserPluginReconciler> =>
  Effect.gen(function* () {
    const availableBackends = options.availableBackends ?? (() => ["iab"] as const);
    const computerUseAvailable = options.computerUseAvailable ?? (() => false);
    const runtimeStateHome = path.resolve(options.runtimeStateHome);
    const environment: Omit<ReconcileEnvironment, "browserRuntime"> = {
      client: options.client,
      codexHome: options.codexHome,
      runtimeStateHome,
      marketplaceName: nodexDesktopToolMarketplaceName(runtimeStateHome),
    };
    const cached = yield* Ref.make<{
      readonly key: string;
      readonly runtime: BrowserRuntimeAvailability;
      readonly value: BrowserPluginReconcileResult;
    } | null>(null);
    const lock = yield* Semaphore.make(1);
    const ensureInstalled = lock.withPermits(1)(
      Effect.gen(function* () {
        const runtime = options.browserRuntime;
        const desiredState = resolveDesiredState(runtime, availableBackends, computerUseAvailable);
        const current = yield* Ref.get(cached);
        const computerUse = current?.value.status === "ready" ? current.value.computerUse : null;
        const retryComputerUse =
          computerUse?.status === "unavailable" && computerUse.reason === "reconciliation-failed";
        if (current?.runtime === runtime && current.key === desiredState.key && !retryComputerUse) {
          return current.value;
        }
        const result = yield* reconcile({ ...environment, browserRuntime: runtime }, desiredState);
        yield* Ref.set(
          cached,
          result.status === "unavailable" && result.reason === "reconciliation-failed"
            ? null
            : { key: desiredState.key, runtime, value: result },
        );
        return result;
      }),
    );
    return {
      result: Ref.get(cached).pipe(
        Effect.map((current) =>
          current?.runtime === options.browserRuntime ? current.value : null,
        ),
      ),
      ensureInstalled,
    };
  });

/** Promise conversion is reserved for script/test adapters that already expose a Promise callback. */
export const browserPluginRequestPortFromPromise = (client: {
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
}): BrowserPluginRequestPort => ({
  request: (method, params) =>
    Effect.tryPromise({
      try: () => client.request(method, params),
      catch: (cause) => reconcileError(`request.${method}`, cause),
    }) as Effect.Effect<ClientRequestResponsesByMethod[typeof method], BrowserPluginReconcileError>,
});
