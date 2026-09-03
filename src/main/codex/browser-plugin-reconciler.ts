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
  type MaterializedDesktopToolMarketplace,
} from "./bundled-desktop-tool-marketplace";

type BrowserPluginRequestMethod =
  | "marketplace/add"
  | "marketplace/remove"
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
  readonly runtimeStateHome?: string;
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
  readonly runtimeStateHome: string;
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
    plugin?.installed && plugin.enabled && (plugin.localVersion ?? plugin.version) === version,
  );

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
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
        if (marketplace.name !== "openai-bundled" || !marketplace.path) continue;
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
    marketplacePath: string;
    pluginName: DesktopToolPluginName;
    version: string | null;
  },
): Effect.Effect<boolean, BrowserPluginReconcileError> {
  if (!input.desired) {
    if (!input.current?.installed && !input.current?.enabled) return Effect.succeed(false);
    return environment.client
      .request("plugin/uninstall", { pluginId: input.current.id })
      .pipe(Effect.as(true));
  }
  if (!input.version) {
    return Effect.fail(
      reconcileError(
        "resolve-plugin-version",
        new Error(`${input.pluginName} plugin version is unavailable`),
      ),
    );
  }
  if (isPluginReady(input.current, input.version)) return Effect.succeed(false);
  if (!input.current) {
    return Effect.fail(
      reconcileError(
        "resolve-plugin",
        new Error(`Bundled marketplace did not expose ${input.pluginName}`),
      ),
    );
  }
  return environment.client
    .request("plugin/install", {
      marketplacePath: input.marketplacePath,
      pluginName: input.pluginName,
    })
    .pipe(Effect.as(true));
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
  capabilityAvailable: boolean;
  desired: boolean;
  materialized: MaterializedDesktopToolMarketplace;
  plugin: MarketplacePlugin | null;
  version: string | null;
}): ChromePluginReconcileResult {
  if (!input.capabilityAvailable || !input.materialized.chromePluginRoot || !input.version) {
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
  if (!isPluginReady(input.plugin, input.version)) {
    return {
      message: "Chrome plugin reconciliation did not produce the verified enabled version",
      reason: "reconciliation-failed",
      status: "unavailable",
    };
  }
  return {
    enabled: true,
    installedVersion: input.version,
    pluginRoot: input.materialized.chromePluginRoot,
    status: "ready",
  };
}

function resolveComputerUseResult(input: {
  desired: boolean;
  materialized: MaterializedDesktopToolMarketplace;
  plugin: MarketplacePlugin | null;
  version: string | null;
}): ComputerUsePluginReconcileResult {
  if (!input.desired || !input.materialized.computerUsePluginRoot || !input.version) {
    return {
      message: "Computer Use runtime capability is unavailable",
      reason: "capability-unavailable",
      status: "unavailable",
    };
  }
  if (!isPluginReady(input.plugin, input.version)) {
    return {
      message: "Computer Use plugin reconciliation did not produce the verified enabled version",
      reason: "reconciliation-failed",
      status: "unavailable",
    };
  }
  return {
    enabled: true,
    installedVersion: input.version,
    pluginRoot: input.materialized.computerUsePluginRoot,
    status: "ready",
  };
}

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
      !pathsReferToSameLocation(marketplace.marketplacePath, materialized.rootPath)
    ) {
      yield* environment.client.request("marketplace/remove", {
        marketplaceName: "openai-bundled",
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

    let changed = false;
    changed =
      (yield* reconcilePlugin(environment, {
        current: findPlugin(marketplace, "browser"),
        desired: desiredState.browserAvailable,
        marketplacePath: marketplace.marketplacePath,
        pluginName: "browser",
        version: bundle.manifest.browserPlugin.version,
      })) || changed;
    const chromeCapability = bundle.manifest.capabilities.browserUse.backends.chrome;
    changed =
      (yield* reconcilePlugin(environment, {
        current: findPlugin(marketplace, "chrome"),
        desired: desiredState.chromeAvailable,
        marketplacePath: marketplace.marketplacePath,
        pluginName: "chrome",
        version: chromeCapability.status === "available" ? chromeCapability.plugin.version : null,
      })) || changed;
    const computerUseCapability = bundle.manifest.capabilities.computerUse;
    changed =
      (yield* reconcilePlugin(environment, {
        current: findPlugin(marketplace, "computer-use"),
        desired: desiredState.computerUseAvailable,
        marketplacePath: marketplace.marketplacePath,
        pluginName: "computer-use",
        version:
          computerUseCapability.status === "available"
            ? computerUseCapability.plugin.version
            : null,
      })) || changed;
    if (changed) {
      yield* environment.client.request("skills/list", { forceReload: true });
      marketplace = yield* readBundledMarketplace(environment);
    }
    if (!marketplace) {
      return reconciliationFailure("Bundled marketplace disappeared during reconciliation");
    }

    const browserPlugin = findPlugin(marketplace, "browser");
    const browserReady = desiredState.browserAvailable
      ? isPluginReady(browserPlugin, bundle.manifest.browserPlugin.version)
      : !browserPlugin?.installed && !browserPlugin?.enabled;
    if (!browserReady) {
      return reconciliationFailure(
        "Browser plugin reconciliation did not produce the requested state",
      );
    }

    const chrome = resolveChromeResult({
      capabilityAvailable: chromeCapability.status === "available",
      desired: desiredState.chromeAvailable,
      materialized,
      plugin: findPlugin(marketplace, "chrome"),
      version: chromeCapability.status === "available" ? chromeCapability.plugin.version : null,
    });
    if (desiredState.chromeAvailable && chrome.status === "unavailable") {
      return reconciliationFailure(chrome.message);
    }

    const computerUse = resolveComputerUseResult({
      desired: desiredState.computerUseAvailable,
      materialized,
      plugin: findPlugin(marketplace, "computer-use"),
      version:
        computerUseCapability.status === "available" ? computerUseCapability.plugin.version : null,
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
      installedVersion: desiredState.browserAvailable
        ? bundle.manifest.browserPlugin.version
        : null,
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
    const runtimeStateHome = path.resolve(
      options.runtimeStateHome ??
        path.join(
          options.browserRuntime.status === "available"
            ? options.browserRuntime.bundle.rootPath
            : process.cwd(),
          ".state",
        ),
    );
    const environment: ReconcileEnvironment = {
      browserRuntime: options.browserRuntime,
      client: options.client,
      runtimeStateHome,
    };
    const cached = yield* Ref.make<{
      readonly key: string;
      readonly value: BrowserPluginReconcileResult;
    } | null>(null);
    const lock = yield* Semaphore.make(1);
    const ensureInstalled = lock.withPermits(1)(
      Effect.gen(function* () {
        const desiredState = resolveDesiredState(
          options.browserRuntime,
          availableBackends,
          computerUseAvailable,
        );
        const current = yield* Ref.get(cached);
        if (current?.key === desiredState.key) return current.value;
        const result = yield* reconcile(environment, desiredState);
        yield* Ref.set(
          cached,
          result.status === "unavailable" && result.reason === "reconciliation-failed"
            ? null
            : { key: desiredState.key, value: result },
        );
        return result;
      }),
    );
    return {
      result: Ref.get(cached).pipe(Effect.map((current) => current?.value ?? null)),
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
