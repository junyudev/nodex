import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
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
    assert.isNull(yield* runtime.threadConfig);
    const ready = yield* runtime.ensureReady;

    assert.deepEqual(requestedBackends, ["iab"]);
    assert.isTrue(ready.browserPluginReady);
    assert.isFalse(ready.computerUsePluginReady);
    assert.strictEqual(ready.computerUse, computerUse);
    assert.isNull(yield* runtime.threadConfig);
    yield* Scope.close(scope, Exit.void);
  }),
);
