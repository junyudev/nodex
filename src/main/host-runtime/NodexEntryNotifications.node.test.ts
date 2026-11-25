import { describe, expect } from "vite-plus/test";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make, turnNotification } from "./NodexEntryNotifications";
import { CoreModules } from "../core-runtime/CoreModules";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  type CodexApplicationEvent,
  CodexApplicationEventHub,
} from "../codex-application/CodexApplicationEventHub";
import { SystemActivity, type SystemActivitySample } from "../platform/electron/SystemActivity";
import { make as makeUserPresence } from "./UserPresence";
import { DESKTOP_AWAY_AFTER_MILLIS, desktopAttendanceSince } from "../../host/UserPresencePolicy";

describe("NodexEntryNotifications", () => {
  const occurrence = {
    spaceId: "personal",
    memberId: "member",
    pageId: "page",
    episode: "episode",
    title: "Review the change",
    body: "Checks passed",
    blocking: false,
  };
  it("applies preferences to episode notifications", () => {
    const away = { foreground: false, seen: false };
    const elsewhere = { foreground: true, seen: false };
    const reading = { foreground: true, seen: true };
    expect(turnNotification(occurrence, "off", true, away)).toBeNull();
    expect(turnNotification(occurrence, "unseen", true, reading)).toBeNull();
    // A focused window showing something else still leaves the Turn untold.
    expect(turnNotification(occurrence, "unseen", true, elsewhere)).not.toBeNull();
    expect(turnNotification(occurrence, "background", true, elsewhere)).toBeNull();
    expect(turnNotification(occurrence, "background", true, away)).not.toBeNull();
    expect(turnNotification({ ...occurrence, blocking: true }, "always", false, away)).toBeNull();
    expect(turnNotification(occurrence, "always", true, away)?.id).toBe(
      JSON.stringify(["turn", "personal", "member", "page", "episode"]),
    );
    expect(turnNotification({ ...occurrence, spaceId: "team" }, "always", true, away)?.id).not.toBe(
      turnNotification(occurrence, "always", true, away)?.id,
    );
  });
  it.effect("claims Turn and Snooze intents once and opens each Inbox message on click", () =>
    Effect.gen(function* () {
      let episode = "one";
      const claimed = new Set<string>();
      const snooze = {
        id: "returned",
        member_id: "member",
        page_id: "snoozed-page",
        title: "Renew the certificate",
        returned_at: "2026-11-12T09:00:00Z",
      };
      const shown: unknown[] = [];
      const clicks: unknown[] = [];
      const clickHandlers: ((action: unknown) => void)[] = [];
      const service = yield* make.pipe(
        Effect.provideService(CoreAuthority, {
          identity: { libraryId: "personal" },
        } as CoreAuthority["Service"]),
        Effect.provideService(CoreModules, {
          workspace: {
            read: (input: { kind: string }) =>
              Effect.succeed({
                value:
                  input.kind === "inbox_snooze_notifications"
                    ? { kind: input.kind, intents: [snooze] }
                    : input.kind === "inbox_turn_notifications"
                      ? {
                          kind: input.kind,
                          intents: [{ member_id: "member", page_id: "page", episode }],
                        }
                      : {
                          kind: "inbox_entry",
                          item: {
                            page_id: "page",
                            title: "Review",
                            body: "Passed",
                            turn: { turn: { episode, reason: "review" } },
                          },
                        },
              }),
            apply: (input: { intent: { kind: string } }) =>
              Effect.sync(() => {
                const id =
                  input.intent.kind === "claim_inbox_snooze_notification" ? snooze.id : episode;
                const duplicate = claimed.has(id);
                claimed.add(id);
                return { receipt: { duplicate }, outcome: { inbox_write: { replay: duplicate } } };
              }),
          },
        } as never),
        Effect.provideService(ApplicationSettings, {
          snapshot: () =>
            Effect.succeed({ notifications: { turnMode: "always", questionsEnabled: true } }),
        } as never),
        Effect.provideService(CodexRendererPresentationRegistry, {
          hasForegroundClient: () => false,
          isPresentedInForeground: () => false,
        } as never),
        Effect.provideService(WindowRuntime, {
          getLastFocused: () => ({
            isDestroyed: () => false,
            isMinimized: () => false,
            show: () => {},
            focus: () => {},
            webContents: { id: 1 },
          }),
        } as never),
        Effect.provideService(DesktopNotificationRuntime, {
          show: (payload: unknown, _target: unknown, handler: (action: unknown) => void) => {
            shown.push(payload);
            clickHandlers.push(handler);
          },
        } as never),
        Effect.provideService(RendererClientRuntime, {
          getClientIdForWebContentsId: () => "client",
          sendToClient: (_id: unknown, _channel: unknown, payload: unknown) => {
            clicks.push(payload);
            return true;
          },
        } as never),
      );
      yield* service.drain;
      yield* service.drain;
      assert.lengthOf(shown, 2);
      expect(shown[0]).toMatchObject({
        title: snooze.title,
        body: "Back in your Inbox",
      });
      episode = "two";
      yield* service.drain;
      assert.lengthOf(shown, 3);
      clickHandlers[0]?.({ actionType: "open" });
      expect(clicks[0]).toMatchObject({
        spaceId: "personal",
        inboxEntry: { pageId: snooze.page_id, scope: { kind: "all" } },
      });
      expect(clicks[0]).not.toHaveProperty("inboxEntry.turnEpisode");
      clickHandlers[2]?.({ actionType: "open" });
      expect(clicks[1]).toMatchObject({
        spaceId: "personal",
        inboxEntry: { pageId: "page", scope: { kind: "all" } },
      });
    }),
  );
});

describe("UserPresence", () => {
  const make = makeUserPresence;
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
        assert.isFalse(presence.isOnPhone("owner", { conversationId: "thread:window" }));

        const first = yield* Scope.make();
        const second = yield* Scope.make();
        const view = {
          memberId: "owner",
          sessionId: "session:phone",
          conversationId: "thread:phone",
        };
        yield* presence.showOnPhone(view).pipe(Scope.provide(first));
        yield* presence.showOnPhone(view).pipe(Scope.provide(second));
        assert.deepEqual(published, [
          { kind: "conversationSeen", value: "thread:phone", memberId: "owner" },
          { kind: "conversationSeen", value: "thread:phone", memberId: "owner" },
        ]);
        assert.isTrue(presence.isSeen({ conversationId: "thread:phone" }));
        assert.isTrue(
          presence.isOnPhone("owner", { conversationId: "other", sessionId: "session:phone" }),
        );
        // A phone shows its chat to its own Member only.
        assert.isFalse(presence.isOnPhone("someone-else", { conversationId: "thread:phone" }));
        yield* Scope.close(first, Exit.void);
        assert.isTrue(presence.isOnPhone("owner", { conversationId: "thread:phone" }));
        yield* Scope.close(second, Exit.void);
        assert.isFalse(
          presence.isSeen({ conversationId: "thread:phone", sessionId: "session:phone" }),
        );
      }),
  );

  it.effect(
    "waits for the person to come back or to have left, and a lock settles it at once",
    () =>
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
});
