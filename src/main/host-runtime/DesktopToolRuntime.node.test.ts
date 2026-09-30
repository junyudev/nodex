import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComputerUseRuntime } from "./ComputerUseRuntime";
import { DesktopToolRuntime, testLayer } from "./DesktopToolRuntime";
import type { BrowserPluginReconcileResult } from "../codex/browser-plugin-reconciler";
import type { PluginSummary } from "@nodex/codex-app-server-protocol/v2/PluginSummary";
import { nodexDesktopToolMarketplaceName } from "../codex/bundled-desktop-tool-marketplace";

const installedPlugin = (id: string): PluginSummary => ({
  id,
  name: id.split("@")[0]!,
  remotePluginId: null,
  version: "1.0.0",
  localVersion: "1.0.0",
  shareContext: null,
  source: { type: "local", path: "/fixture/plugin" },
  installed: true,
  installedAt: null,
  enabled: true,
  installPolicy: "AVAILABLE",
  installPolicySource: null,
  mustShowInstallationInterstitial: null,
  authPolicy: "ON_INSTALL",
  availability: "AVAILABLE",
  disabledReason: null,
  eligiblePlanTypes: null,
  interface: null,
  keywords: [],
});

it.effect("owns desktop plugin readiness and derives one coherent snapshot", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const computerUse = {
      message: "Computer Use is unavailable in this fixture",
      reason: "runtime-unavailable" as const,
      status: "unavailable" as const,
    };
    let pluginResult: BrowserPluginReconcileResult | null = null;
    let requestedBackends: readonly string[] = [];
    let includeForeignPlugins = false;
    let listedCwd: string | null | undefined;
    const runtimeStateHome = "/tmp/nodex-desktop-tools-test";
    const currentPluginId = `browser@${nodexDesktopToolMarketplaceName(runtimeStateHome)}`;
    const otherPluginId = `chrome@${nodexDesktopToolMarketplaceName("/other-profile/runtime/agent")}`;
    const context = yield* Layer.buildWithScope(
      testLayer({
        availableBackends: () => ["iab"],
        browserRuntime: {
          message: "Browser runtime is unavailable in this fixture",
          reason: "backend-unavailable",
          status: "unavailable",
        },
        computerUse: ComputerUseRuntime.of({
          current: () => computerUse,
          ensureReady: Effect.succeed(computerUse),
          managedServiceChanges: Stream.empty,
          managedServiceSnapshot: () => ({ generation: 0, status: "pending" }),
          reconcileManagedService: () => Effect.succeed({ generation: 0, status: "pending" }),
        }),
        plugins: (availableBackends) =>
          Effect.succeed({
            ensureInstalled: Effect.sync(() => {
              requestedBackends = availableBackends();
              pluginResult = {
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
                installedVersion: "1.0.0-test",
                marketplaceRoot: "/tmp/openai-bundled",
                status: "ready",
              };
              return pluginResult;
            }),
            result: Effect.sync(() => pluginResult),
          }),
        readConfigRequirements: Effect.succeed({ requirements: null }),
        listPlugins: (cwd) => {
          listedCwd = cwd;
          return Effect.succeed({
            marketplaces: includeForeignPlugins
              ? [
                  {
                    name: "fixture",
                    path: null,
                    interface: null,
                    plugins: [
                      installedPlugin("browser@openai-bundled"),
                      installedPlugin(otherPluginId),
                      installedPlugin(currentPluginId),
                      installedPlugin("pdf@openai-bundled"),
                    ],
                  },
                ]
              : [],
            marketplaceLoadErrors: [],
          });
        },
        codexHome: "/tmp/native-codex-home",
        runtimeStateHome,
      }),
      scope,
    );
    const runtime = Context.get(context, DesktopToolRuntime);
    // Thread config must not rely on some earlier Settings read having initialized plugins.
    assert.isNull(yield* runtime.threadConfig());
    const ready = yield* runtime.ensureReady;

    assert.deepEqual(requestedBackends, ["iab"]);
    assert.isTrue(ready.browserPluginReady);
    assert.isFalse(ready.computerUsePluginReady);
    assert.strictEqual(ready.computerUse, computerUse);
    assert.isNull(yield* runtime.threadConfig());
    includeForeignPlugins = true;
    assert.deepEqual(yield* runtime.threadConfig("/workspace/project"), {
      "plugins.browser@openai-bundled.enabled": false,
      [`plugins.${otherPluginId}.enabled`]: false,
    });
    assert.strictEqual(listedCwd, "/workspace/project");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("builds the gated artifact template picker from cwd-scoped app-server skills", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const root = mkdtempSync(path.join(tmpdir(), "nodex-desktop-artifact-picker-"));
    const serverPath = path.join(root, "server.mjs");
    writeFileSync(serverPath, "export {};\n", "utf8");
    let listedCwd: string | null | undefined;
    const computerUse = {
      message: "Computer Use is unavailable in this fixture",
      reason: "runtime-unavailable" as const,
      status: "unavailable" as const,
    };
    const context = yield* Layer.buildWithScope(
      testLayer({
        availableBackends: () => [],
        artifactTemplatePickerEnabled: Effect.succeed(true),
        artifactTemplatePickerRuntime: { nodePath: "/runtime/node", serverPath },
        browserRuntime: {
          message: "Browser runtime is unavailable in this fixture",
          reason: "backend-unavailable",
          status: "unavailable",
        },
        computerUse: ComputerUseRuntime.of({
          current: () => computerUse,
          ensureReady: Effect.succeed(computerUse),
          managedServiceChanges: Stream.empty,
          managedServiceSnapshot: () => ({ generation: 0, status: "pending" }),
          reconcileManagedService: () => Effect.succeed({ generation: 0, status: "pending" }),
        }),
        plugins: () =>
          Effect.succeed({
            ensureInstalled: Effect.succeed({
              message: "Browser runtime is unavailable in this fixture",
              reason: "runtime-unavailable" as const,
              status: "unavailable" as const,
            }),
            result: Effect.succeed(null),
          }),
        listSkills: (cwd) => {
          listedCwd = cwd;
          return Effect.succeed({
            data: [
              {
                cwd: cwd ?? "/",
                errors: [],
                skills: [
                  {
                    name: "artifact-template-sheet",
                    description: "Spreadsheet template",
                    path: "/skills/artifact-template-sheet/SKILL.md",
                    scope: "user",
                    enabled: true,
                    pluginId: null,
                  },
                ],
              },
            ],
          });
        },
        readConfigRequirements: Effect.succeed({ requirements: null }),
        codexHome: "/tmp/native-codex-home",
        runtimeStateHome: "/tmp/nodex-desktop-tools-test",
      }),
      scope,
    );
    const runtime = Context.get(context, DesktopToolRuntime);
    const config = yield* runtime.threadConfig("/workspace/project");

    assert.strictEqual(listedCwd, "/workspace/project");
    assert.deepEqual(config, {
      "mcp_servers.openai_artifact_template_picker": {
        command: "/runtime/node",
        args: [serverPath],
        env: {
          CODEX_ARTIFACT_TEMPLATE_SKILLS: JSON.stringify([
            {
              skillName: "artifact-template-sheet",
              skillPath: "/skills/artifact-template-sheet/SKILL.md",
              description: "Spreadsheet template",
            },
          ]),
        },
      },
    });
    yield* Scope.close(scope, Exit.void);
  }),
);
