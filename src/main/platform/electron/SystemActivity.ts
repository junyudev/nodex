import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { powerMonitor } from "electron";
import type { ActivitySample } from "../../../host/UserPresencePolicy";

/** Whether someone is using this computer, as the operating system reports it. */
export type SystemActivitySample = ActivitySample;

export class SystemActivity extends Context.Service<
  SystemActivity,
  {
    readonly sample: Effect.Effect<SystemActivitySample>;
    /** Emits each time the screen locks. */
    readonly locks: Stream.Stream<void>;
  }
>()("nodex/main/platform/electron/SystemActivity") {}

export const live: Layer.Layer<SystemActivity> = Layer.effect(
  SystemActivity,
  Effect.gen(function* () {
    // A lock is a signal, not a queue: listeners only need to know one happened since they looked.
    const locks = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
    const onLock = () => {
      PubSub.publishUnsafe(locks, undefined);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => powerMonitor.on("lock-screen", onLock)),
      () => Effect.sync(() => powerMonitor.removeListener("lock-screen", onLock)),
    );
    return SystemActivity.of({
      sample: Effect.sync((): SystemActivitySample => {
        const state = powerMonitor.getSystemIdleState(1);
        if (state === "locked") return { idleMillis: null, locked: true };
        if (state === "unknown") return { idleMillis: null, locked: false };
        return { idleMillis: (powerMonitor.getSystemIdleTime() + 1) * 1000, locked: false };
      }),
      locks: Stream.fromPubSub(locks),
    });
  }),
);
