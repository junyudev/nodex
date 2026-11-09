import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { codexUserInputConversationKey } from "../shared/codex-user-input-auto-resolution";
import { CodexApplicationEventHub } from "../main/codex-application/CodexApplicationEventHub";
import { PRESENCE_REPORT_INTERVAL_MILLIS, desktopAttendanceSince } from "./UserPresencePolicy";

/** A chat as presence knows it: its conversation and, for a product Session, the Session. */
export interface PresenceTarget {
  readonly conversationId: string;
  readonly hostId?: string;
  readonly sessionId?: string | null;
}

/** A chat one Member's phone shows, while its channel to this host is live. */
export interface PhoneView {
  readonly memberId: string;
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly hostId?: string;
}

/**
 * Whether someone stayed at a computer after something happened: `returned` on input after it,
 * `away` once they are known to have left it.
 */
export type Attendance = "returned" | "away";

export interface UserPresenceService {
  /**
   * The chat is in front of someone: a focused window of this desktop presents it, or a phone
   * shows it. Nothing needs to tell them about it, and it stays read.
   */
  readonly isSeen: (target: PresenceTarget) => boolean;
  /** One of this Member's phones shows the chat over a live channel. */
  readonly isOnPhone: (memberId: string, target: PresenceTarget) => boolean;
  /** Holds a phone's view of a chat for the caller's Scope, and withdraws what it has now seen. */
  readonly showOnPhone: (view: PhoneView) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Completes once it is known whether the person at this computer stayed at it after
   * `sinceMillis`. A host with no screen has nobody at it, so it answers `away` at once; each
   * Member's other computers report for themselves through the Space's Core.
   */
  readonly attendanceSince: (sinceMillis: number) => Effect.Effect<Attendance>;
}

/** Where the people this host serves are, as far as this host can tell. */
export class UserPresence extends Context.Service<UserPresence, UserPresenceService>()(
  "nodex/host/UserPresence",
) {}

/** Keys a view for its Member, and for anyone (`null`). */
const sessionKey = (memberId: string | null, sessionId: string) =>
  JSON.stringify([memberId, "session", sessionId]);
const conversationKey = (memberId: string | null, conversationId: string, hostId = "local") =>
  JSON.stringify([
    memberId,
    "conversation",
    codexUserInputConversationKey({ hostId, conversationId }),
  ]);

/**
 * The chats each Member's phones show. A view lasts as long as its phone channel watches the
 * chat; two phones showing a chat count once each, so closing one keeps the other.
 */
export const makePhoneViews = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const views = new Map<string, number>();
  const adjust = (key: string, delta: number) => {
    const next = (views.get(key) ?? 0) + delta;
    if (next > 0) views.set(key, next);
    else views.delete(key);
  };
  const viewKeys = (view: PhoneView) =>
    [view.memberId, null].flatMap((memberId) => [
      sessionKey(memberId, view.sessionId),
      ...(view.conversationId ? [conversationKey(memberId, view.conversationId, view.hostId)] : []),
    ]);
  const shown = (memberId: string | null, { conversationId, hostId, sessionId }: PresenceTarget) =>
    views.has(conversationKey(memberId, conversationId, hostId)) ||
    (!!sessionId && views.has(sessionKey(memberId, sessionId)));
  return {
    isOnPhone: (memberId: string, target: PresenceTarget) => shown(memberId, target),
    /** Some Member's phone shows the chat. */
    isOnAnyPhone: (target: PresenceTarget) => shown(null, target),
    showOnPhone: (view: PhoneView) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          for (const key of viewKeys(view)) adjust(key, 1);
          if (view.conversationId)
            events.publish({
              kind: "conversationSeen",
              value: view.conversationId,
              memberId: view.memberId,
            });
        }),
        () =>
          Effect.sync(() => {
            for (const key of viewKeys(view)) adjust(key, -1);
          }),
      ),
  };
});

/**
 * A headless host has no window and no screen. A phone shows a chat to its own Member only,
 * whose attention Core keeps, so nothing here is seen by the host's own account.
 */
export const headless: Layer.Layer<UserPresence, never, CodexApplicationEventHub> = Layer.effect(
  UserPresence,
  Effect.gen(function* () {
    const phones = yield* makePhoneViews;
    return UserPresence.of({
      isSeen: () => false,
      isOnPhone: phones.isOnPhone,
      showOnPhone: phones.showOnPhone,
      attendanceSince: () => Effect.succeed("away"),
    });
  }),
);

/**
 * Whether a Member stayed at one of their desktops after `sinceMillis`, from what those desktops
 * report through the Space's Core. `idleMillis` reads the least time since they used a desktop
 * that vouches for them now, or null when none does. The same rule as a desk applies: input after
 * the occurrence means they were here, five minutes without it means they left, and a Member no
 * desktop vouches for is away.
 */
export const reportedAttendanceSince = (
  idleMillis: Effect.Effect<number | null>,
  sinceMillis: number,
): Effect.Effect<Attendance> =>
  Effect.gen(function* () {
    for (;;) {
      const idle = yield* idleMillis;
      if (idle === null) return "away";
      const decision = desktopAttendanceSince(
        { idleMillis: idle, locked: false },
        sinceMillis,
        yield* Clock.currentTimeMillis,
      );
      if (decision.type !== "undecided") return decision.type;
      // A desktop reports every interval, so a return shows up by the next one.
      yield* Effect.sleep(Math.min(decision.recheckAfterMillis, PRESENCE_REPORT_INTERVAL_MILLIS));
    }
  });

class Returned extends Data.TaggedError("Returned")<{}> {}

/** Someone came back as soon as any computer says so; they left only once every one agrees. */
export const anyReturned = (sources: ReadonlyArray<Effect.Effect<Attendance>>) =>
  Effect.forEach(
    sources,
    (source) =>
      Effect.flatMap(source, (attendance) =>
        attendance === "returned" ? Effect.fail(new Returned()) : Effect.void,
      ),
    { concurrency: "unbounded", discard: true },
  ).pipe(
    Effect.as<Attendance>("away"),
    Effect.catchTag("Returned", () => Effect.succeed<Attendance>("returned")),
  );
