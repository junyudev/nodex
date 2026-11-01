import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ProjectSession } from "../../shared/types";
import type { SessionReminderWork } from "../project-application/ProjectWorkspace";
import { make } from "./SessionReminderRuntime";

const chat = (id: string, due: number): ProjectSession => ({
  id,
  projectId: null,
  noThreadFallbackTitle: id,
  displayTitle: id,
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  remindAt: DateTime.formatIso(DateTime.makeUnsafe(due)),
  thread: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
});
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });

const memory = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const sessions = new Map<string, ProjectSession>();
  const pending = new Map<string, SessionReminderWork>();
  const notifications: string[] = [];
  const unread: string[] = [];
  const state = { reads: 0, presented: false, failUnread: false, rescheduleDuringClaim: false };
  const options = {
    next: Effect.sync(() => {
      state.reads++;
      const work = [...sessions.values()].flatMap((session): SessionReminderWork[] =>
        session.remindAt
          ? [{ session, remindAt: session.remindAt, deliveryId: null, wakeAt: session.remindAt }]
          : [],
      );
      return (
        [...work, ...pending.values()].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt))[0] ?? null
      );
    }),
    consume: (id: string, expected: string, deliver: boolean) =>
      Effect.gen(function* () {
        if (state.rescheduleDuringClaim) {
          state.rescheduleDuringClaim = false;
          sessions.set(id, chat(id, 25_000));
          return false;
        }
        const current = sessions.get(id);
        if (current?.remindAt !== expected) return false;
        sessions.set(id, { ...current, remindAt: null });
        if (deliver)
          pending.set(id, {
            session: current,
            remindAt: expected,
            deliveryId: id,
            wakeAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          });
        return true;
      }),
    complete: (id: string) => Effect.sync(() => pending.delete(id)),
    defer: (id: string) =>
      Effect.gen(function* () {
        const current = pending.get(id);
        if (current)
          pending.set(id, {
            ...current,
            wakeAt: DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 30_000),
            ),
          });
      }),
    markUnread: (session: ProjectSession) =>
      Effect.suspend(() =>
        state.failUnread
          ? Effect.fail("identity unavailable")
          : Effect.sync(() => unread.push(session.id)),
      ),
    isPresented: () => state.presented,
    notify: (session: ProjectSession) => {
      notifications.push(session.id);
    },
    changes: Stream.fromPubSub(changes),
  };
  return {
    sessions,
    pending,
    notifications,
    unread,
    state,
    options,
    changed: PubSub.publish(changes, undefined),
  };
});

it.effect(
  "arms only the earliest deadline, re-arms on changes and never consumes a concurrent reschedule",
  () =>
    Effect.gen(function* () {
      const f = yield* memory;
      f.sessions.set("later", chat("later", 20_000));
      const owner = yield* make(f.options);
      yield* owner.activate;
      yield* settle;
      const reads = f.state.reads;
      yield* TestClock.adjust(5_000);
      assert.equal(f.state.reads, reads);
      f.sessions.set("earlier", chat("earlier", 10_000));
      yield* f.changed;
      yield* settle;
      yield* TestClock.adjust(5_000);
      yield* settle;
      assert.deepEqual(f.notifications, ["earlier"]);
      f.state.rescheduleDuringClaim = true;
      yield* TestClock.adjust(10_000);
      yield* settle;
      assert.deepEqual(f.notifications, ["earlier"]);
      yield* TestClock.adjust(5_000);
      yield* settle;
      assert.deepEqual(f.notifications, ["earlier", "later"]);
      assert.deepEqual(f.unread, f.notifications);
      yield* owner.wake;
      yield* settle;
      assert.lengthOf(f.notifications, 2);
    }),
);

it.effect(
  "catches up after start and resume and consumes a presented chat without unread or notification",
  () =>
    Effect.gen(function* () {
      const f = yield* memory;
      f.state.presented = true;
      f.sessions.set("visible", chat("visible", 0));
      const firstScope = yield* Scope.make();
      const first = yield* make(f.options).pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* first.activate;
      yield* settle;
      assert.equal(f.sessions.get("visible")?.remindAt, null);
      assert.lengthOf(f.notifications, 0);
      assert.lengthOf(f.unread, 0);
      f.state.presented = false;
      f.sessions.set("resume", chat("resume", 0));
      yield* first.wake;
      yield* settle;
      assert.deepEqual(f.notifications, ["resume"]);
      yield* Scope.close(firstScope, Exit.void);
      const second = yield* make(f.options);
      yield* second.activate;
      yield* settle;
      assert.deepEqual(f.notifications, ["resume"]);
      f.sessions.set("closed", chat("closed", 0));
      yield* second.wake;
      yield* settle;
      assert.deepEqual(f.notifications, ["resume", "closed"]);
    }),
);

it.effect("retains unfinished unread work across restart without blocking another reminder", () =>
  Effect.gen(function* () {
    const f = yield* memory;
    f.state.failUnread = true;
    f.sessions.set("retry", chat("retry", 0));
    const firstScope = yield* Scope.make();
    const first = yield* make(f.options).pipe(Effect.provideService(Scope.Scope, firstScope));
    yield* first.activate;
    yield* settle;
    assert.equal(f.sessions.get("retry")?.remindAt, null);
    assert.equal(f.pending.size, 1);
    assert.lengthOf(f.notifications, 0);
    f.state.failUnread = false;
    f.sessions.set("other", chat("other", 5_000));
    yield* first.wake;
    yield* settle;
    yield* TestClock.adjust(5_000);
    yield* settle;
    assert.deepEqual(f.notifications, ["other"]);
    yield* Scope.close(firstScope, Exit.void);
    const second = yield* make(f.options);
    yield* second.activate;
    yield* settle;
    yield* TestClock.adjust(25_000);
    yield* settle;
    assert.deepEqual(f.notifications, ["other", "retry"]);
    assert.equal(f.pending.size, 0);
  }),
);
