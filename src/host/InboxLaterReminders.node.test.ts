import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeInboxLaterReminders } from "./InboxLaterReminders";

const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });

it.effect("catches up on startup, re-arms on change, and catches up when woken on resume", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const now = yield* Clock.currentTimeMillis;
      const pending = [now - 1, now + 10_000];
      const returned: number[] = [];
      const clock = yield* makeInboxLaterReminders({
        changes: Stream.fromPubSub(changes),
        next: Effect.sync(() => {
          const deadline = Math.min(...pending);
          return Number.isFinite(deadline) ? new Date(deadline).toISOString() : null;
        }),
        publishDue: () =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            for (const due of pending.filter((due) => due <= at)) {
              returned.push(due);
              pending.splice(pending.indexOf(due), 1);
            }
          }),
      });
      yield* settle;
      assert.deepEqual(returned, [now - 1]);
      pending.push(now + 1_000);
      yield* PubSub.publish(changes, undefined);
      yield* settle;
      yield* TestClock.adjust(1_001);
      yield* settle;
      assert.deepEqual(returned, [now - 1, now + 1_000]);

      // A changed deadline that did not publish while the machine was asleep is read on wake.
      pending.push(now + 500);
      yield* clock.wake;
      yield* settle;
      assert.deepEqual(returned, [now - 1, now + 1_000, now + 500]);
    }),
  ),
);
