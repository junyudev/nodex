import { describe, expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ProjectSession } from "../shared/types";
import type { SessionSnoozeWork } from "../main/project-application/ProjectWorkspace";
import { make } from "./SessionSnoozes";
import * as Layer from "effect/Layer";
import { CoreModules } from "../main/core-runtime/CoreModules";
import {
  make as makeNotificationIntents,
  NotificationIntentPresentation,
} from "./NotificationIntents";
import { makeInboxSnoozeClock } from "./InboxSnoozeClock";

describe("SessionSnoozes", () => {
  const chat = (id: string, due: number): ProjectSession => ({
    id,
    projectId: null,
    noThreadFallbackTitle: id,
    displayTitle: id,
    activityAt: 0,
    managed: false,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    snoozedUntil: DateTime.formatIso(DateTime.makeUnsafe(due)),
    snoozedAt: null,
    wokeAt: null,
    pageTurn: null,
    canManage: true,
    canStop: true,
    thread: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
  const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
    discard: true,
  });

  const memory = Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    const sessions = new Map<string, ProjectSession>();
    const pending = new Map<string, SessionSnoozeWork>();
    const notifications: string[] = [];
    const notifiedMembers: string[] = [];
    const unread: string[] = [];
    const state = { reads: 0, presented: false, failUnread: false, rescheduleDuringClaim: false };
    const options = {
      next: Effect.sync(() => {
        state.reads++;
        const work = [...sessions.values()].flatMap((session): SessionSnoozeWork[] =>
          session.snoozedUntil
            ? [
                {
                  session,
                  memberId: "member",
                  snoozedUntil: session.snoozedUntil,
                  deliveryId: null,
                  wakeAt: session.snoozedUntil,
                },
              ]
            : [],
        );
        return (
          [...work, ...pending.values()].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt))[0] ?? null
        );
      }),
      consume: (id: string, _member: string, expected: string, deliver: boolean) =>
        Effect.gen(function* () {
          if (state.rescheduleDuringClaim) {
            state.rescheduleDuringClaim = false;
            sessions.set(id, chat(id, 25_000));
            return false;
          }
          const current = sessions.get(id);
          if (current?.snoozedUntil !== expected) return false;
          sessions.set(id, { ...current, snoozedUntil: null });
          if (deliver)
            pending.set(id, {
              session: current,
              memberId: "member",
              snoozedUntil: expected,
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
      notify: (session: ProjectSession, _snoozedUntil: string, memberId: string) => {
        notifications.push(session.id);
        notifiedMembers.push(memberId);
      },
      changes: Stream.fromPubSub(changes),
    };
    return {
      sessions,
      pending,
      notifications,
      notifiedMembers,
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
        // Each snooze reaches the Member who set it, on every channel that tells them.
        assert.deepEqual(f.notifiedMembers, ["member", "member"]);
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
        assert.equal(f.sessions.get("visible")?.snoozedUntil, null);
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

  it.effect("retains unfinished unread work across restart without blocking another snooze", () =>
    Effect.gen(function* () {
      const f = yield* memory;
      f.state.failUnread = true;
      f.sessions.set("retry", chat("retry", 0));
      const firstScope = yield* Scope.make();
      const first = yield* make(f.options).pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* first.activate;
      yield* settle;
      assert.equal(f.sessions.get("retry")?.snoozedUntil, null);
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
});

describe("NotificationIntents", () => {
  const make = makeNotificationIntents;
  it.effect("retains notification intents until a presentation sink can accept them", () =>
    Effect.gen(function* () {
      let available = false;
      let claims = 0;
      let deliveries = 0;
      const producer = yield* make.pipe(
        Effect.provideService(CoreModules, {
          workspace: {
            read: (input: { kind: string }) =>
              Effect.succeed({
                value:
                  input.kind === "inbox_turn_notifications"
                    ? {
                        kind: input.kind,
                        intents: [{ member_id: "member", page_id: "page", episode: "one" }],
                      }
                    : {
                        kind: "inbox_entry",
                        item: { title: "Review", turn: { turn: { episode: "one" } } },
                      },
              }),
            apply: () =>
              Effect.sync(() => ({
                receipt: { duplicate: claims++ > 0 },
                outcome: { inbox_write: { replay: false } },
              })),
          },
        } as never),
        Effect.provide(
          Layer.succeed(NotificationIntentPresentation, {
            available: Effect.sync(() => available),
            publish: () =>
              Effect.sync(() => {
                deliveries++;
              }),
          }),
        ),
      );
      yield* producer.drain;
      expect(claims).toBe(0);
      available = true;
      yield* producer.drain;
      yield* producer.drain;
      expect(claims).toBe(2);
      expect(deliveries).toBe(1);
    }),
  );

  it.effect("never claims an intent whose Turn episode changed", () =>
    Effect.gen(function* () {
      let published = false;
      const producer = yield* make.pipe(
        Effect.provideService(CoreModules, {
          workspace: {
            read: (input: { kind: string }) =>
              Effect.succeed({
                value:
                  input.kind === "inbox_turn_notifications"
                    ? {
                        kind: input.kind,
                        intents: [{ member_id: "member", page_id: "page", episode: "old" }],
                      }
                    : { kind: "inbox_entry", item: { turn: { turn: { episode: "current" } } } },
              }),
            apply: () => Effect.die("A stale intent cannot be claimed"),
          },
        } as never),
        Effect.provideService(NotificationIntentPresentation, {
          available: Effect.succeed(true),
          publish: () =>
            Effect.sync(() => {
              published = true;
            }),
        }),
      );
      yield* producer.drain;
      expect(published).toBe(false);
    }),
  );
});

describe("InboxSnoozeClock", () => {
  const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
    discard: true,
  });

  it.effect("catches up on startup, re-arms on change, and catches up when woken on resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<void>();
        const now = yield* Clock.currentTimeMillis;
        const pending = [now - 1, now + 10_000];
        const returned: number[] = [];
        const clock = yield* makeInboxSnoozeClock({
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
});
