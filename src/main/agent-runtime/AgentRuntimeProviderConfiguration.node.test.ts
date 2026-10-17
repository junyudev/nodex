import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import { applyProviderSettings } from "./AgentRuntimeProviderConfiguration";

const harness = (initial: AgentRuntimeConnectionState) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(initial);
    const applied = yield* Ref.make(0);
    const settle = applyProviderSettings({
      states: SubscriptionRef.changes(state),
      running: SubscriptionRef.get(state).pipe(Effect.map(({ status }) => status === "ready")),
      apply: Ref.update(applied, (count) => count + 1),
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
