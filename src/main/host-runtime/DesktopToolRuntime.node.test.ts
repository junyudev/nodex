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
        runtimeStateHome: "/tmp/nodex-desktop-tools-test",
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
