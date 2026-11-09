import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeAppBadge } from "../platform/electron/AppBadge";
import { make } from "./UnreadBadgeRuntime";

const yields = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});
const settle = TestClock.adjust("150 millis").pipe(Effect.andThen(yields));

it.effect(
  "follows the unread count, replaces a stale badge and clears it when the Profile closes",
  () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const badges: number[] = [];
      let reads = 0;
      let count: number | null = 0;
      const scope = yield* Scope.make();
      const badge = yield* make((next) => Effect.sync(() => badges.push(next))).pipe(
        Scope.provide(scope),
      );
      yield* badge
        .count("personal", {
          count: Effect.sync(() => {
            reads += 1;
            return count;
          }),
          changes: Stream.fromPubSub(changes),
        })
        .pipe(Scope.provide(scope));
      yield* yields;
      const change = PubSub.publish(changes, undefined);
      const settle = TestClock.adjust("150 millis").pipe(Effect.andThen(yields));

      // The first read sets the badge even at zero, replacing one an earlier run left behind.
      yield* change;
      yield* settle;
      assert.deepEqual(badges, [0]);

      // A burst of changes is read once.
      count = 3;
      yield* change;
      yield* change;
      yield* change;
      yield* settle;
      assert.deepEqual(badges, [0, 3]);
      assert.strictEqual(reads, 2);

      // An unchanged count, or one that cannot be read, leaves the badge as it is.
      yield* change;
      yield* settle;
      count = null;
      yield* change;
      yield* settle;
      assert.deepEqual(badges, [0, 3]);

      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(badges, [0, 3, 0]);
    }),
);

it.effect("adds up every open Space's own count and drops a Space once it is no longer open", () =>
  Effect.gen(function* () {
    const badges: number[] = [];
    const badge = yield* make((next) => Effect.sync(() => badges.push(next)));
    const team = yield* PubSub.unbounded<void>();
    let teamCount: number | null = 4;
    let teamFails = false;
    yield* badge.count("personal", { count: Effect.succeed(2), changes: Stream.never });
    const open = yield* Scope.make();
    yield* badge
      .count("team", {
        count: Effect.suspend(() =>
          teamFails ? Effect.fail("unreachable") : Effect.succeed(teamCount),
        ),
        changes: Stream.fromPubSub(team),
      })
      .pipe(Scope.provide(open));
    yield* yields;
    yield* settle;
    assert.deepEqual(badges, [6]);
    // Each Space's changes reread it; one that cannot be read keeps its last count.
    teamCount = 1;
    yield* PubSub.publish(team, undefined);
    yield* settle;
    teamFails = true;
    yield* PubSub.publish(team, undefined);
    yield* settle;
    assert.deepEqual(badges, [6, 3]);
    // Leaving the Space takes its chats out of the badge.
    yield* Scope.close(open, Exit.void);
    yield* settle;
    assert.deepEqual(badges, [6, 3, 2]);
  }),
);

it.effect("badges the app where the platform has a badge, and never fails the caller", () =>
  Effect.gen(function* () {
    const set: string[] = [];
    const badgeOn = (platform: NodeJS.Platform) =>
      makeAppBadge({
        platform,
        setNotificationCenterBadge: (count) => {
          if (count < 0) throw new Error("Badge count must be a non-negative integer");
          set.push(`notification-center ${count}`);
        },
        setLauncherBadge: (count) => set.push(`launcher ${count}`),
      });
    yield* badgeOn("darwin").set(2);
    yield* badgeOn("linux").set(1);
    yield* badgeOn("win32").set(5);
    yield* badgeOn("darwin").set(-1);
    assert.deepEqual(set, ["notification-center 2", "launcher 1"]);
  }),
);
