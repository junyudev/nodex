import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import { makeProviderSettingsRefresh } from "./AgentRuntimeProviderConfiguration";

const harness = (initial: AgentRuntimeConnectionState) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(initial);
    const applied = yield* Ref.make(0);
    const settle = yield* makeProviderSettingsRefresh({
      states: SubscriptionRef.changes(state),
      current: SubscriptionRef.get(state).pipe(
        Effect.map((current) => (current.status === "ready" ? current : null)),
      ),
      apply: () => Ref.update(applied, (count) => count + 1),
    });
    return { state, applied, settle };
  });

it.effect("configures a process that finishes starting after the settings change", () =>
  Effect.gen(function* () {
    const { state, applied, settle } = yield* harness({ status: "starting" });
    const fiber = yield* Effect.forkChild(settle);
    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(applied), 0);
    yield* SubscriptionRef.set(state, { status: "ready", generation: "first" });
    yield* Fiber.join(fiber);
    assert.equal(yield* Ref.get(applied), 1);
  }),
);

it.effect("configures a ready process at once and leaves an idle one to read its settings", () =>
  Effect.gen(function* () {
    const ready = yield* harness({ status: "ready", generation: "first" });
    yield* ready.settle;
    assert.equal(yield* Ref.get(ready.applied), 1);
    const idle = yield* harness({ status: "idle" });
    yield* idle.settle;
    assert.equal(yield* Ref.get(idle.applied), 0);
  }),
);

it.effect("never configures a process whose start failed", () =>
  Effect.gen(function* () {
    const { state, applied, settle } = yield* harness({ status: "restarting", attempt: 1 });
    const fiber = yield* Effect.forkChild(settle);
    yield* Effect.yieldNow;
    yield* SubscriptionRef.set(state, { status: "failed", message: "Engine exited" });
    yield* Fiber.join(fiber);
    assert.equal(yield* Ref.get(applied), 0);
  }),
);

it.effect("applies concurrent saves in one lane and reads the latest saved configuration", () =>
  Effect.gen(function* () {
    const firstRead = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const settings = yield* Ref.make({ enabled: true });
    const applied: boolean[] = [];
    const refresh = yield* makeProviderSettingsRefresh({
      states: Stream.succeed({ status: "ready", generation: "one" } as const),
      current: Effect.succeed({ generation: "one" }),
      apply: () =>
        Effect.gen(function* () {
          const captured = yield* Ref.get(settings);
          if (captured.enabled) {
            yield* Deferred.succeed(firstRead, undefined);
            yield* Deferred.await(releaseFirst);
          }
          applied.push(captured.enabled);
          return captured;
        }),
    });
    const first = yield* Effect.forkChild(refresh);
    yield* Deferred.await(firstRead);
    yield* Ref.set(settings, { enabled: false });
    const second = yield* Effect.forkChild(refresh);
    yield* Effect.yieldNow;
    assert.deepEqual(applied, []);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    assert.deepEqual(yield* Fiber.join(second), { enabled: false });
    assert.deepEqual(applied, [true, false]);
  }),
);

it.effect(
  "does not restart an engine that exits between its ready event and the passive lookup",
  () =>
    Effect.gen(function* () {
      let applied = false;
      const refresh = yield* makeProviderSettingsRefresh({
        states: Stream.succeed({ status: "ready", generation: "old" } as const),
        current: Effect.succeed(null),
        apply: () =>
          Effect.sync(() => {
            applied = true;
          }),
      });
      assert.isUndefined(yield* refresh);
      assert.isFalse(applied);
    }),
);
