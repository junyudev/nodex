import { describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "./browser-runtime-test-fixture";
import {
  resolveBrowserRuntimeBundle,
  type BrowserRuntimeAvailability,
} from "./browser-runtime-bundle";
import { nodexDesktopToolMarketplaceName } from "./bundled-desktop-tool-marketplace";
import {
  browserPluginRequestPortFromPromise,
  makeBrowserPluginReconciler,
  materializeHostDesktopToolPlugins,
  type BrowserPluginReconcilerOptions,
} from "./browser-plugin-reconciler";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTestBrowserPluginReconciler(
  options: Omit<BrowserPluginReconcilerOptions, "client" | "codexHome"> & {
    readonly staleCache?: RevisedPluginName;
    readonly shouldPublishInstalledSkill?: () => boolean;
    readonly client: {
      readonly request: (method: string, params?: unknown) => Promise<unknown>;
    };
  },
) {
  const codexHome = path.join(options.runtimeStateHome, "fixture-codex");
  const marketplaceName = nodexDesktopToolMarketplaceName(options.runtimeStateHome);
  const browserSkill =
    options.browserRuntime.status === "available"
      ? path.relative(
          options.browserRuntime.bundle.browserPluginRoot,
          options.browserRuntime.bundle.paths.browserPluginDocs,
        )
      : "docs/SKILL.md";
  const skills = {
    browser: browserSkill,
    "computer-use": "skills/computer-use/SKILL.md",
  };
  const cachedSkill = (pluginName: RevisedPluginName, version: string) =>
    path.join(codexHome, "plugins/cache", marketplaceName, pluginName, version, skills[pluginName]);
  if (options.staleCache) {
    const stalePath = cachedSkill(options.staleCache, "1.0.0-test");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, "Vendor skill before Nodex guidance\n");
  }
  const publishSkill = (pluginName: RevisedPluginName) => {
    const source = path.join(
      options.runtimeStateHome,
      ".tmp",
      "bundled-marketplaces",
      marketplaceName,
      "plugins",
      pluginName,
      skills[pluginName],
    );
    if (!fs.existsSync(source)) return;
    const cachePath = cachedSkill(pluginName, MATERIALIZED_VERSIONS[pluginName]);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.copyFileSync(source, cachePath);
  };
  return makeBrowserPluginReconciler({
    ...options,
    codexHome,
    get browserRuntime() {
      return options.browserRuntime;
    },
    client: browserPluginRequestPortFromPromise({
      request: async (method, params) => {
        if (method === "plugin/list") {
          for (const pluginName of ["browser", "computer-use"] as const) {
            if (pluginName !== options.staleCache) publishSkill(pluginName);
          }
        }
        const result = await options.client.request(method, params);
        if (method === "plugin/install" && (options.shouldPublishInstalledSkill?.() ?? true)) {
          const { pluginName } = params as { pluginName: string };
          if (pluginName === "browser" || pluginName === "computer-use") publishSkill(pluginName);
        }
        return result;
      },
    }),
  });
}

async function makeRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-plugin-"));
  const bundleRoot = path.join(root, "browser-runtime");
  const manifest = writeBrowserRuntimeFixture(bundleRoot);
  const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
  const browserRuntime = await resolveBrowserRuntimeBundle({
    appServerIdentity: testedPair.appServer,
    runtimeRoot: root,
    targetArch: "arm64",
    targetPlatform: "darwin",
    testedPairs: [testedPair],
  });
  if (browserRuntime.status === "unavailable") throw new Error(browserRuntime.message);
  const runtimeStateHome = path.join(root, "state");
  const marketplaceName = nodexDesktopToolMarketplaceName(runtimeStateHome);
  const marketplaceRoot = path.join(
    runtimeStateHome,
    ".tmp",
    "bundled-marketplaces",
    marketplaceName,
  );
  const marketplacePath = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
  return {
    browserRuntime,
    marketplaceName,
    marketplacePath,
    marketplaceRoot,
    root,
    runtimeStateHome,
  };
}

const MATERIALIZED_BROWSER_VERSION = "1.0.0-test+nodex.6";
const MATERIALIZED_COMPUTER_USE_VERSION = "1.0.0-test+nodex.1";
const MATERIALIZED_VERSIONS = {
  browser: MATERIALIZED_BROWSER_VERSION,
  "computer-use": MATERIALIZED_COMPUTER_USE_VERSION,
};
type RevisedPluginName = keyof typeof MATERIALIZED_VERSIONS;

function plugin(input: {
  enabled: boolean;
  installed: boolean;
  name?: "browser" | "chrome" | "computer-use";
  marketplaceName?: string;
  version: string;
}) {
  const name = input.name ?? "browser";
  return {
    authPolicy: "ON_INSTALL",
    availability: "AVAILABLE",
    enabled: input.enabled,
    id: `${name}@${input.marketplaceName ?? "openai-bundled"}`,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    installed: input.installed,
    interface: null,
    keywords: [],
    localVersion: input.version,
    name,
    remotePluginId: null,
    shareContext: null,
    source: { type: "local", path: `/tmp/${name}` },
    version: input.version,
  };
}

describe("BrowserPluginReconciler", () => {
  it.effect(
    "leaves external and other Profile plugins intact while reconciling its own tools",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => makeRuntime());
        let availableBackends: Array<"iab"> = ["iab"];
        let registered = false;
        let installed = false;
        let globallyEnabled = false;
        const externalMarketplaces = ["openai-bundled", "nodex-desktop-other-profile"].map(
          (marketplaceName) => ({
            interface: null,
            name: marketplaceName,
            path: `/external/${marketplaceName}`,
            plugins: ["browser", "chrome", "computer-use"].map((name) =>
              plugin({
                enabled: true,
                installed: true,
                marketplaceName,
                name: name as "browser" | "chrome" | "computer-use",
                version: "external-version",
              }),
            ),
          }),
        );
        const externalBefore = structuredClone(externalMarketplaces);
        const request = vi.fn(async (method: string, params?: unknown) => {
          if (method === "plugin/list") {
            return {
              featuredPluginIds: [],
              marketplaceLoadErrors: [],
              marketplaces: [
                ...externalMarketplaces,
                ...(registered
                  ? [
                      {
                        interface: null,
                        name: fixture.marketplaceName,
                        path: fixture.marketplacePath,
                        plugins: [
                          plugin({
                            enabled: globallyEnabled,
                            installed,
                            marketplaceName: fixture.marketplaceName,
                            version: MATERIALIZED_BROWSER_VERSION,
                          }),
                        ],
                      },
                    ]
                  : []),
              ],
            };
          }
          if (method === "marketplace/add") {
            expect(params).toEqual({ source: fixture.marketplaceRoot });
            registered = true;
            return {
              marketplaceName: fixture.marketplaceName,
              installedRoot: fixture.marketplaceRoot,
              alreadyAdded: false,
            };
          }
          if (method === "plugin/install") {
            expect(params).toEqual({
              marketplacePath: fixture.marketplacePath,
              pluginName: "browser",
            });
            installed = true;
            globallyEnabled = true;
            return { appsNeedingAuth: [], authPolicy: "ON_INSTALL" };
          }
          if (method === "plugin/uninstall") {
            expect(params).toEqual({ pluginId: `browser@${fixture.marketplaceName}` });
            installed = false;
            return {};
          }
          if (method === "config/batchWrite") {
            expect(params).toEqual({
              edits: [
                {
                  keyPath: `plugins.browser@${fixture.marketplaceName}.enabled`,
                  value: false,
                  mergeStrategy: "replace",
                },
              ],
              expectedVersion: null,
              filePath: null,
              reloadUserConfig: true,
            });
            globallyEnabled = false;
            return {
              status: "ok",
              version: "test",
              filePath: "/fixture/config.toml",
              overriddenMetadata: null,
            };
          }
          if (method === "skills/list") return { data: [] };
          throw new Error(`Unexpected request: ${method}`);
        });

        try {
          let runtime: BrowserRuntimeAvailability = {
            status: "unavailable",
            reason: "not-installed",
            message: "Desktop Tools are not installed.",
          };
          const reconciler = yield* makeTestBrowserPluginReconciler({
            availableBackends: () => availableBackends,
            get browserRuntime() {
              return runtime;
            },
            client: { request },
            runtimeStateHome: fixture.runtimeStateHome,
          });
          expect(yield* reconciler.ensureInstalled).toMatchObject({
            status: "unavailable",
            reason: "runtime-unavailable",
          });
          runtime = fixture.browserRuntime;
          expect(yield* reconciler.result).toBeNull();
          expect(yield* reconciler.ensureInstalled).toMatchObject({
            status: "ready",
            enabled: true,
          });
          expect(installed).toBe(true);
          expect(globallyEnabled).toBe(false);
          availableBackends = [];
          expect(yield* reconciler.ensureInstalled).toMatchObject({
            status: "unavailable",
            reason: "backend-unavailable",
          });
          expect(installed).toBe(false);
          expect(externalMarketplaces).toEqual(externalBefore);
          expect(request.mock.calls.some(([method]) => method === "marketplace/remove")).toBe(
            false,
          );
        } finally {
          fs.rmSync(fixture.root, { force: true, recursive: true });
        }
      }),
  );

  it.effect("reuses the exact installed bundled plugin without reinstalling", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      const request = vi.fn(async (method: string) => {
        if (method === "plugin/list") {
          return {
            featuredPluginIds: [],
            marketplaceLoadErrors: [],
            marketplaces: [
              {
                interface: null,
                name: fixture.marketplaceName,
                path: fixture.marketplacePath,
                plugins: [
                  plugin({
                    marketplaceName: fixture.marketplaceName,
                    enabled: false,
                    installed: true,
                    version: MATERIALIZED_BROWSER_VERSION,
                  }),
                ],
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      try {
        const reconciler = yield* makeTestBrowserPluginReconciler({
          browserRuntime: fixture.browserRuntime,
          client: { request },
          runtimeStateHome: fixture.runtimeStateHome,
        });
        expect(yield* reconciler.ensureInstalled).toEqual({
          chrome: {
            message: "Chrome provider backend is unavailable",
            reason: "backend-unavailable",
            status: "unavailable",
          },
          computerUse: {
            message: "Computer Use runtime capability is unavailable",
            reason: "capability-unavailable",
            status: "unavailable",
          },
          enabled: true,
          installedVersion: MATERIALIZED_BROWSER_VERSION,
          marketplaceRoot: fixture.marketplaceRoot,
          status: "ready",
        });
        yield* reconciler.ensureInstalled;
        expect(request.mock.calls.filter(([method]) => method === "plugin/install")).toHaveLength(
          0,
        );
        expect(request.mock.calls.filter(([method]) => method === "marketplace/add")).toHaveLength(
          0,
        );
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect("coalesces concurrent reconciliation through one serialized state transition", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      const request = vi.fn(async (method: string) => {
        if (method === "plugin/list") {
          return {
            featuredPluginIds: [],
            marketplaceLoadErrors: [],
            marketplaces: [
              {
                interface: null,
                name: fixture.marketplaceName,
                path: fixture.marketplacePath,
                plugins: [
                  plugin({
                    marketplaceName: fixture.marketplaceName,
                    enabled: false,
                    installed: true,
                    version: MATERIALIZED_BROWSER_VERSION,
                  }),
                ],
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      try {
        const reconciler = yield* makeTestBrowserPluginReconciler({
          browserRuntime: fixture.browserRuntime,
          client: { request },
          runtimeStateHome: fixture.runtimeStateHome,
        });
        const results = yield* Effect.all(
          [reconciler.ensureInstalled, reconciler.ensureInstalled],
          { concurrency: "unbounded" },
        );

        expect(results.map((result) => result.status)).toEqual(["ready", "ready"]);
        expect(request.mock.calls.filter(([method]) => method === "plugin/list")).toHaveLength(1);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect.each(["browser", "computer-use"] as const)(
    "refreshes a stale %s skill even when the marketplace reports the new version",
    (staleCache) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => makeRuntime());
        let shouldPublishInstalledSkill = false;
        const request = vi.fn(async (method: string) => {
          if (method === "plugin/list") {
            return {
              featuredPluginIds: [],
              marketplaceLoadErrors: [],
              marketplaces: [
                {
                  interface: null,
                  name: fixture.marketplaceName,
                  path: fixture.marketplacePath,
                  plugins: [
                    plugin({
                      marketplaceName: fixture.marketplaceName,
                      enabled: false,
                      installed: true,
                      version: MATERIALIZED_BROWSER_VERSION,
                    }),
                    ...(staleCache === "computer-use"
                      ? [
                          plugin({
                            marketplaceName: fixture.marketplaceName,
                            enabled: false,
                            installed: true,
                            name: "computer-use",
                            version: MATERIALIZED_COMPUTER_USE_VERSION,
                          }),
                        ]
                      : []),
                  ],
                },
              ],
            };
          }
          if (method === "plugin/install") {
            return { appsNeedingAuth: [], authPolicy: "ON_INSTALL" };
          }
          if (method === "config/batchWrite")
            return {
              status: "ok",
              version: "test",
              filePath: "/fixture/config.toml",
              overriddenMetadata: null,
            };
          if (method === "skills/list") return { data: [] };
          throw new Error(`Unexpected request: ${method}`);
        });

        try {
          const reconciler = yield* makeTestBrowserPluginReconciler({
            browserRuntime: fixture.browserRuntime,
            computerUseAvailable: () => staleCache === "computer-use",
            staleCache,
            shouldPublishInstalledSkill: () => shouldPublishInstalledSkill,
            client: { request },
            runtimeStateHome: fixture.runtimeStateHome,
          });
          const first = yield* reconciler.ensureInstalled;
          if (staleCache === "computer-use") {
            expect(first).toMatchObject({ enabled: true, status: "ready" });
            expect(yield* reconciler.result).toEqual(first);
          }
          const staleResult =
            staleCache === "computer-use" && first.status === "ready" ? first.computerUse : first;
          expect(staleResult).toMatchObject({
            reason: "reconciliation-failed",
            status: "unavailable",
          });

          shouldPublishInstalledSkill = true;
          const result = yield* reconciler.ensureInstalled;
          if (result.status !== "ready") throw new Error(result.message);
          const revised = staleCache === "computer-use" ? result.computerUse : result;
          expect(revised).toMatchObject({
            installedVersion: MATERIALIZED_VERSIONS[staleCache],
            status: "ready",
          });
          expect(request.mock.calls.filter(([method]) => method === "plugin/install")).toEqual([
            [
              "plugin/install",
              { marketplacePath: fixture.marketplacePath, pluginName: staleCache },
            ],
            [
              "plugin/install",
              { marketplacePath: fixture.marketplacePath, pluginName: staleCache },
            ],
          ]);
        } finally {
          fs.rmSync(fixture.root, { force: true, recursive: true });
        }
      }),
  );

  it.effect("installs Browser and Computer Use from the materialized marketplace", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      const installed = new Set<string>();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "plugin/list") {
          return {
            featuredPluginIds: [],
            marketplaceLoadErrors: [],
            marketplaces: [
              {
                interface: null,
                name: fixture.marketplaceName,
                path: fixture.marketplacePath,
                plugins: [
                  plugin({
                    marketplaceName: fixture.marketplaceName,
                    enabled: false,
                    installed: installed.has("browser"),
                    version: MATERIALIZED_BROWSER_VERSION,
                  }),
                  plugin({
                    marketplaceName: fixture.marketplaceName,
                    enabled: false,
                    installed: installed.has("computer-use"),
                    name: "computer-use",
                    version: MATERIALIZED_COMPUTER_USE_VERSION,
                  }),
                ],
              },
            ],
          };
        }
        if (method === "plugin/install") {
          const pluginName = (params as { pluginName: string }).pluginName;
          installed.add(pluginName);
          return { appsNeedingAuth: [], authPolicy: "ON_INSTALL" };
        }
        if (method === "config/batchWrite")
          return {
            status: "ok",
            version: "test",
            filePath: "/fixture/config.toml",
            overriddenMetadata: null,
          };
        if (method === "skills/list") return { data: [] };
        throw new Error(`Unexpected request: ${method}`);
      });

      try {
        const reconciler = yield* makeTestBrowserPluginReconciler({
          browserRuntime: fixture.browserRuntime,
          client: { request },
          computerUseAvailable: () => true,
          runtimeStateHome: fixture.runtimeStateHome,
        });

        expect(yield* reconciler.ensureInstalled).toMatchObject({
          computerUse: {
            enabled: true,
            installedVersion: MATERIALIZED_COMPUTER_USE_VERSION,
            pluginRoot: path.join(fixture.marketplaceRoot, "plugins", "computer-use"),
            status: "ready",
          },
          enabled: true,
          status: "ready",
        });
        expect(
          request.mock.calls
            .filter(([method]) => method === "plugin/install")
            .map(([, params]) => (params as { pluginName: string }).pluginName),
        ).toEqual(["browser", "computer-use"]);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect("gives host agents the revised Computer Use skill directly", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      try {
        const result = yield* materializeHostDesktopToolPlugins({
          availableBackends: () => [],
          browserRuntime: fixture.browserRuntime,
          computerUseAvailable: true,
          runtimeStateHome: fixture.runtimeStateHome,
        });

        if (result.status !== "ready" || result.computerUse.status !== "ready") {
          throw new Error("Expected the host Computer Use plugin");
        }
        expect(result.computerUse.installedVersion).toBe(MATERIALIZED_COMPUTER_USE_VERSION);
        expect(
          fs.readFileSync(
            path.join(result.computerUse.pluginRoot, "skills", "computer-use", "SKILL.md"),
            "utf8",
          ),
        ).toContain("## Web pages and safe actions in Nodex");
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect("replaces only the current Profile marketplace source before verification", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      let source = "/tmp/obsolete-openai-bundled";
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "plugin/list") {
          return {
            featuredPluginIds: [],
            marketplaceLoadErrors: [],
            marketplaces: [
              {
                interface: null,
                name: fixture.marketplaceName,
                path: source,
                plugins: [
                  plugin({
                    marketplaceName: fixture.marketplaceName,
                    enabled: false,
                    installed: true,
                    version: MATERIALIZED_BROWSER_VERSION,
                  }),
                ],
              },
            ],
          };
        }
        if (method === "marketplace/remove") {
          expect(params).toEqual({ marketplaceName: fixture.marketplaceName });
          source = "";
          return {
            marketplaceName: fixture.marketplaceName,
            installedRoot: "/tmp/obsolete-openai-bundled",
          };
        }
        if (method === "marketplace/add") {
          source = fixture.marketplacePath;
          return {
            marketplaceName: fixture.marketplaceName,
            installedRoot: source,
            alreadyAdded: false,
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      try {
        const reconciler = yield* makeTestBrowserPluginReconciler({
          browserRuntime: fixture.browserRuntime,
          client: { request },
          runtimeStateHome: fixture.runtimeStateHome,
        });
        expect(yield* reconciler.ensureInstalled).toMatchObject({
          status: "ready",
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "plugin/list",
          "marketplace/remove",
          "marketplace/add",
          "plugin/list",
        ]);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect("fails closed when installation cannot be verified", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      let shouldFail = true;
      try {
        const reconciler = yield* makeTestBrowserPluginReconciler({
          browserRuntime: fixture.browserRuntime,
          client: {
            request: async (method) => {
              if (shouldFail) throw new Error("unsupported");
              if (method === "plugin/list") {
                return {
                  featuredPluginIds: [],
                  marketplaceLoadErrors: [],
                  marketplaces: [
                    {
                      interface: null,
                      name: fixture.marketplaceName,
                      path: fixture.marketplacePath,
                      plugins: [
                        plugin({
                          marketplaceName: fixture.marketplaceName,
                          enabled: false,
                          installed: true,
                          version: MATERIALIZED_BROWSER_VERSION,
                        }),
                      ],
                    },
                  ],
                };
              }
              throw new Error(`Unexpected request: ${method}`);
            },
          },
          runtimeStateHome: fixture.runtimeStateHome,
        });
        expect(yield* reconciler.ensureInstalled).toEqual({
          message: "Desktop tool plugin reconciliation failed: unsupported",
          reason: "reconciliation-failed",
          status: "unavailable",
        });
        shouldFail = false;
        expect(yield* reconciler.ensureInstalled).toMatchObject({
          status: "ready",
        });
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect("removes an installed Browser plugin when no host backend is available", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntime());
      let availableBackends: Array<"iab"> = [];
      let installed = true;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "plugin/list") {
          return {
            featuredPluginIds: [],
            marketplaceLoadErrors: [],
            marketplaces: [
              {
                interface: null,
                name: fixture.marketplaceName,
                path: fixture.marketplacePath,
                plugins: [
                  plugin({
                    marketplaceName: fixture.marketplaceName,
                    enabled: false,
                    installed,
                    version: MATERIALIZED_BROWSER_VERSION,
                  }),
                ],
              },
            ],
          };
        }
        if (method === "plugin/uninstall") {
          expect(params).toEqual({ pluginId: `browser@${fixture.marketplaceName}` });
          installed = false;
          return {};
        }
        if (method === "plugin/install") {
          installed = true;
          return { appsNeedingAuth: [], authPolicy: "ON_INSTALL" };
        }
        if (method === "config/batchWrite")
          return {
            status: "ok",
            version: "test",
            filePath: "/fixture/config.toml",
            overriddenMetadata: null,
          };
        if (method === "skills/list") return { data: [] };
        throw new Error(`Unexpected request: ${method}`);
      });

      try {
        const reconciler = yield* makeTestBrowserPluginReconciler({
          availableBackends: () => availableBackends,
          browserRuntime: fixture.browserRuntime,
          client: { request },
          runtimeStateHome: fixture.runtimeStateHome,
        });

        expect(yield* reconciler.ensureInstalled).toEqual({
          message: "Desktop tool host backends are unavailable",
          reason: "backend-unavailable",
          status: "unavailable",
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "plugin/list",
          "plugin/uninstall",
          "skills/list",
          "plugin/list",
        ]);

        availableBackends = ["iab"];
        expect(yield* reconciler.ensureInstalled).toEqual({
          chrome: {
            message: "Chrome provider backend is unavailable",
            reason: "backend-unavailable",
            status: "unavailable",
          },
          computerUse: {
            message: "Computer Use runtime capability is unavailable",
            reason: "capability-unavailable",
            status: "unavailable",
          },
          enabled: true,
          installedVersion: MATERIALIZED_BROWSER_VERSION,
          marketplaceRoot: fixture.marketplaceRoot,
          status: "ready",
        });
        expect(request.mock.calls.filter(([method]) => method === "plugin/uninstall")).toHaveLength(
          1,
        );
        expect(request.mock.calls.filter(([method]) => method === "plugin/install")).toHaveLength(
          1,
        );
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    }),
  );

  it.effect(
    "installs Chrome only while its live backend is available and leaves Browser installed",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => makeRuntime());
        let availableBackends: Array<"chrome" | "iab"> = ["iab"];
        const installed = new Set<string>();
        const request = vi.fn(async (method: string, params?: unknown) => {
          if (method === "plugin/list") {
            return {
              featuredPluginIds: [],
              marketplaceLoadErrors: [],
              marketplaces: [
                {
                  interface: null,
                  name: fixture.marketplaceName,
                  path: fixture.marketplacePath,
                  plugins: [
                    plugin({
                      marketplaceName: fixture.marketplaceName,
                      enabled: false,
                      installed: installed.has("browser"),
                      version: MATERIALIZED_BROWSER_VERSION,
                    }),
                    plugin({
                      marketplaceName: fixture.marketplaceName,
                      enabled: false,
                      installed: installed.has("chrome"),
                      name: "chrome",
                      version: "1.0.0-test",
                    }),
                  ],
                },
              ],
            };
          }
          if (method === "plugin/install") {
            installed.add((params as { pluginName: string }).pluginName);
            return { appsNeedingAuth: [], authPolicy: "ON_INSTALL" };
          }
          if (method === "plugin/uninstall") {
            const pluginId = (params as { pluginId: string }).pluginId;
            installed.delete(pluginId.split("@")[0]!);
            return {};
          }
          if (method === "config/batchWrite")
            return {
              status: "ok",
              version: "test",
              filePath: "/fixture/config.toml",
              overriddenMetadata: null,
            };
          if (method === "skills/list") return { data: [] };
          throw new Error(`Unexpected request: ${method}`);
        });

        try {
          const reconciler = yield* makeTestBrowserPluginReconciler({
            availableBackends: () => availableBackends,
            browserRuntime: fixture.browserRuntime,
            client: { request },
            runtimeStateHome: fixture.runtimeStateHome,
          });

          expect(yield* reconciler.ensureInstalled).toMatchObject({
            chrome: {
              reason: "backend-unavailable",
              status: "unavailable",
            },
            enabled: true,
            status: "ready",
          });
          expect(installed).toEqual(new Set(["browser"]));

          availableBackends = ["iab", "chrome"];
          expect(yield* reconciler.ensureInstalled).toMatchObject({
            chrome: {
              enabled: true,
              installedVersion: "1.0.0-test",
              pluginRoot: path.join(fixture.marketplaceRoot, "plugins", "chrome"),
              status: "ready",
            },
            enabled: true,
            status: "ready",
          });
          expect(installed).toEqual(new Set(["browser", "chrome"]));

          availableBackends = ["iab"];
          expect(yield* reconciler.ensureInstalled).toMatchObject({
            chrome: {
              reason: "backend-unavailable",
              status: "unavailable",
            },
            enabled: true,
            status: "ready",
          });
          expect(installed).toEqual(new Set(["browser"]));
          expect(
            request.mock.calls
              .filter(([method]) => method === "plugin/install")
              .map(([, params]) => (params as { pluginName: string }).pluginName),
          ).toEqual(["browser", "chrome"]);
          expect(
            request.mock.calls
              .filter(([method]) => method === "plugin/uninstall")
              .map(([, params]) => (params as { pluginId: string }).pluginId),
          ).toEqual([`chrome@${fixture.marketplaceName}`]);
        } finally {
          fs.rmSync(fixture.root, { force: true, recursive: true });
        }
      }),
  );
});
