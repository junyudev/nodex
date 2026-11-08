import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexApplicationEvent } from "../codex-application/CodexApplicationEventHub";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { SystemActivity, type SystemActivitySample } from "../platform/electron/SystemActivity";
import { make } from "./UserPresence";
import { DESKTOP_AWAY_AFTER_MILLIS, desktopAttendanceSince } from "./UserPresencePolicy";

const active = (idleMillis: number): SystemActivitySample => ({ idleMillis, locked: false });

it("decides attendance from input after the occurrence, the lock and the away threshold", () => {
  const since = 1_000_000;
  // Input after the occurrence: the person was here to be told.
  assert.deepEqual(desktopAttendanceSince(active(1_000), since, since + 5_000), {
    type: "returned",
  });
  // The last input came before it and the threshold is not reached yet.
  assert.deepEqual(desktopAttendanceSince(active(30_000), since, since), {
    type: "undecided",
    recheckAfterMillis: DESKTOP_AWAY_AFTER_MILLIS - 30_000,
  });
  assert.deepEqual(desktopAttendanceSince(active(DESKTOP_AWAY_AFTER_MILLIS), since, since), {
    type: "away",
  });
  assert.deepEqual(desktopAttendanceSince({ idleMillis: 0, locked: true }, since, since), {
    type: "away",
  });
  // A system that cannot report input never silences the phone.
  assert.deepEqual(desktopAttendanceSince({ idleMillis: null, locked: false }, since, since), {
    type: "away",
  });
});

const fixture = Effect.gen(function* () {
  const published: CodexApplicationEvent[] = [];
  const locks = yield* PubSub.unbounded<void>();
  const presentedInWindow = new Set<string>();
  let sample: SystemActivitySample = active(0);
  const presence = yield* make.pipe(
    Effect.provideService(CodexApplicationEventHub, {
      events: Stream.never,
      publish: (event) => {
        published.push(event);
      },
    }),
    Effect.provideService(CodexRendererPresentationRegistry, {
      isPresentedInForeground: (conversationId: string) => presentedInWindow.has(conversationId),
    } as unknown as CodexRendererPresentationRegistry["Service"]),
    Effect.provideService(SystemActivity, {
      sample: Effect.sync(() => sample),
      locks: Stream.fromPubSub(locks),
    }),
  );
  return {
    presence,
    published,
    presentedInWindow,
    lock: PubSub.publish(locks, undefined),
    setSample: (next: SystemActivitySample) => {
      sample = next;
    },
  };
});

it.effect(
  "a chat is seen in a focused window or on a phone, for as long as the phone shows it",
  () =>
    Effect.gen(function* () {
      const { presence, published, presentedInWindow } = yield* fixture;
      presentedInWindow.add("thread:window");
      assert.isTrue(presence.isSeen({ conversationId: "thread:window" }));
      assert.isFalse(presence.isOnPhone({ conversationId: "thread:window" }));

      const first = yield* Scope.make();
      const second = yield* Scope.make();
      const view = { sessionId: "session:phone", conversationId: "thread:phone" };
      yield* presence.showOnPhone(view).pipe(Scope.provide(first));
      yield* presence.showOnPhone(view).pipe(Scope.provide(second));
      assert.deepEqual(published, [
        { kind: "conversationSeen", value: "thread:phone" },
        { kind: "conversationSeen", value: "thread:phone" },
      ]);
      assert.isTrue(presence.isSeen({ conversationId: "thread:phone" }));
      assert.isTrue(presence.isOnPhone({ conversationId: "other", sessionId: "session:phone" }));
      yield* Scope.close(first, Exit.void);
      assert.isTrue(presence.isOnPhone({ conversationId: "thread:phone" }));
      yield* Scope.close(second, Exit.void);
      assert.isFalse(
        presence.isSeen({ conversationId: "thread:phone", sessionId: "session:phone" }),
      );
    }),
);

it.effect("waits for the person to come back or to have left, and a lock settles it at once", () =>
  Effect.gen(function* () {
    const { presence, lock, setSample } = yield* fixture;
    const since = yield* Clock.currentTimeMillis;
    setSample(active(60_000));
    const leaving = yield* presence.attendanceSince(since).pipe(Effect.forkChild);
    // Still nobody at the keyboard when the away threshold arrives.
    setSample(active(DESKTOP_AWAY_AFTER_MILLIS));
    yield* TestClock.adjust(DESKTOP_AWAY_AFTER_MILLIS - 60_000);
    assert.strictEqual(yield* Fiber.join(leaving), "away");

    // Typing just before the next occurrence, then again after it.
    setSample(active(0));
    const returning = yield* presence
      .attendanceSince(yield* Clock.currentTimeMillis)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(1_000);
    setSample(active(500));
    yield* TestClock.adjust(DESKTOP_AWAY_AFTER_MILLIS);
    assert.strictEqual(yield* Fiber.join(returning), "returned");

    const now = yield* Clock.currentTimeMillis;
    setSample(active(0));
    const locking = yield* presence.attendanceSince(now).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    setSample({ idleMillis: null, locked: true });
    yield* lock;
    assert.strictEqual(yield* Fiber.join(locking), "away");
  }),
);
