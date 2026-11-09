import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ActivitySample } from "../../host/UserPresencePolicy";
import { presenceReport, run } from "./RemotePresenceReporter";

const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

it.effect(
  "reports while someone uses this computer, at once when it locks, and stays quiet while away",
  () =>
    Effect.gen(function* () {
      const locks = yield* PubSub.unbounded<void>();
      const reports: (number | null)[] = [];
      let sample: ActivitySample = { idleMillis: 2_000, locked: false };
      yield* run({
        sample: Effect.sync(() => sample),
        locks: Stream.fromPubSub(locks),
        send: (report) => Effect.sync(() => reports.push(report.idle_ms ?? null)),
      });
      yield* settle;
      assert.deepEqual(reports, [2_000]);
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.deepEqual(reports, [2_000, 2_000]);

      // Locking says so at once, then nothing more is sent while nobody is here.
      sample = { idleMillis: null, locked: true };
      yield* PubSub.publish(locks, undefined);
      yield* settle;
      assert.deepEqual(reports, [2_000, 2_000, null]);
      yield* TestClock.adjust("2 minutes");
      yield* settle;
      assert.lengthOf(reports, 3);

      // Back at the keyboard: the next report says so.
      sample = { idleMillis: 500, locked: false };
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.deepEqual(reports.at(-1), 500);

      // Five minutes without input is away: one last report, then quiet.
      sample = { idleMillis: 5 * 60_000, locked: false };
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      const count = reports.length;
      assert.deepEqual(reports.at(-1), 5 * 60_000);
      yield* TestClock.adjust("5 minutes");
      yield* settle;
      assert.lengthOf(reports, count);
    }),
);

it("never reports idle time from behind a locked screen or a system that cannot tell", () => {
  assert.deepEqual(presenceReport({ idleMillis: 1_234.4, locked: false }), { idle_ms: 1_234 });
  assert.deepEqual(presenceReport({ idleMillis: 1_000, locked: true }), { idle_ms: null });
  assert.deepEqual(presenceReport({ idleMillis: null, locked: false }), { idle_ms: null });
});
