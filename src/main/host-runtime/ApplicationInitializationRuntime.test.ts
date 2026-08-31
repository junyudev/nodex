import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import { layer as mainShutdownLayer } from "../app/MainShutdown";
import { ApplicationInitializationRuntime, live } from "./ApplicationInitializationRuntime";

it.effect("projects Core migration progress and never regresses after completion", () =>
  Effect.gen(function* () {
    const broadcasts: unknown[] = [];
    const windows = {
      all: () => [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (_channel: string, step: unknown) => broadcasts.push(step),
          },
        },
      ],
      markRendererInitialized: () => true,
    } as unknown as WindowRuntimeService;
    const context = yield* Layer.build(live(windows).pipe(Layer.provide(mainShutdownLayer)));
    const runtime = Context.get(context, ApplicationInitializationRuntime);
    yield* runtime.observeCoreStartup({ kind: "migration_started", fromVersion: 1, toVersion: 2 });
    yield* runtime.observeCoreStartup({ kind: "migration_progress", completed: 3, total: 5 });
    assert.deepStrictEqual(yield* runtime.current, {
      phase: "migrating",
      fromVersion: 1,
      toVersion: 2,
      completed: 3,
      total: 5,
    });
    yield* runtime.markDone;
    yield* runtime.awaitDone;
    yield* runtime.observeCoreStartup({ kind: "migration_started", fromVersion: 2, toVersion: 3 });
    assert.deepStrictEqual(yield* runtime.current, { phase: "done" });
    assert.strictEqual(broadcasts.length, 3);
  }),
);

it.effect("publishes a terminal failure without opening the initialization gate", () =>
  Effect.gen(function* () {
    const broadcasts: unknown[] = [];
    const windows = {
      all: () => [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (_channel: string, step: unknown) => broadcasts.push(step),
          },
        },
      ],
      markRendererInitialized: () => true,
    } as unknown as WindowRuntimeService;
    const context = yield* Layer.build(live(windows).pipe(Layer.provide(mainShutdownLayer)));
    const runtime = Context.get(context, ApplicationInitializationRuntime);

    yield* runtime.markFailed;

    assert.deepStrictEqual(yield* runtime.current, { phase: "failed" });
    assert.deepStrictEqual(broadcasts, [{ phase: "failed" }]);
  }),
);

it.effect("admits each renderer readiness report only once", () =>
  Effect.gen(function* () {
    let initialized = false;
    const windows = {
      all: () => [],
      markRendererInitialized: () => {
        if (initialized) return false;
        initialized = true;
        return true;
      },
    } as unknown as WindowRuntimeService;
    const context = yield* Layer.build(live(windows).pipe(Layer.provide(mainShutdownLayer)));
    const runtime = Context.get(context, ApplicationInitializationRuntime);
    const report = { durationMs: 12, outcome: "ready" as const };

    assert.isTrue(yield* runtime.reportRenderer(42, report));
    assert.isFalse(yield* runtime.reportRenderer(42, report));
  }),
);
