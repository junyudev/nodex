import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { codexUserInputConversationKey } from "../../shared/codex-user-input-auto-resolution";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { SystemActivity, live as systemActivityLive } from "../platform/electron/SystemActivity";
import { desktopAttendanceSince } from "./UserPresencePolicy";

/** A chat as presence knows it: its conversation and, for a product Session, the Session. */
export interface PresenceTarget {
  readonly conversationId: string;
  readonly hostId?: string;
  readonly sessionId?: string | null;
}

/** A chat a phone shows, while its channel to this desktop is live. */
export interface PhoneView {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly hostId?: string;
}

export interface UserPresenceService {
  /**
   * The chat is in front of the person: a focused Workbench window presents it, or Nodex Mobile
   * shows it on a phone with a live connection. Nothing needs to tell them about it.
   */
  readonly isSeen: (target: PresenceTarget) => boolean;
  /** Nodex Mobile shows the chat on a phone with a live connection. */
  readonly isOnPhone: (target: PresenceTarget) => boolean;
  /** Holds a phone's view of a chat for the caller's Scope, and withdraws what it has now seen. */
  readonly showOnPhone: (view: PhoneView) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Completes once it is known whether the person stayed at this computer after `sinceMillis`:
   * `returned` on input after it, `away` when the screen locks or input stops for long enough.
   */
  readonly attendanceSince: (sinceMillis: number) => Effect.Effect<"returned" | "away">;
}

export class UserPresence extends Context.Service<UserPresence, UserPresenceService>()(
  "nodex/main/host-runtime/UserPresence",
) {}

const sessionKey = (sessionId: string) => JSON.stringify(["session", sessionId]);
const conversationKey = (conversationId: string, hostId = "local") =>
  JSON.stringify(["conversation", codexUserInputConversationKey({ hostId, conversationId })]);

/** One owner for where the person is: which surfaces show a chat, and whether they are at the desk. */
export const make: Effect.Effect<
  UserPresenceService,
  never,
  CodexApplicationEventHub | CodexRendererPresentationRegistry | SystemActivity
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const windows = yield* CodexRendererPresentationRegistry;
  const activity = yield* SystemActivity;
  const phoneViews = new Map<string, number>();
  const adjust = (key: string, delta: number) => {
    const next = (phoneViews.get(key) ?? 0) + delta;
    if (next > 0) phoneViews.set(key, next);
    else phoneViews.delete(key);
  };
  const viewKeys = (view: PhoneView) => [
    sessionKey(view.sessionId),
    ...(view.conversationId ? [conversationKey(view.conversationId, view.hostId)] : []),
  ];

  const isOnPhone = ({ conversationId, hostId, sessionId }: PresenceTarget) =>
    phoneViews.has(conversationKey(conversationId, hostId)) ||
    (!!sessionId && phoneViews.has(sessionKey(sessionId)));

  return UserPresence.of({
    isSeen: (target) =>
      windows.isPresentedInForeground(target.conversationId, target.hostId) || isOnPhone(target),
    isOnPhone,
    showOnPhone: (view) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          for (const key of viewKeys(view)) adjust(key, 1);
          if (view.conversationId)
            events.publish({ kind: "conversationSeen", value: view.conversationId });
        }),
        () =>
          Effect.sync(() => {
            for (const key of viewKeys(view)) adjust(key, -1);
          }),
      ),
    attendanceSince: (sinceMillis) =>
      Effect.gen(function* () {
        for (;;) {
          const decision = desktopAttendanceSince(
            yield* activity.sample,
            sinceMillis,
            yield* Clock.currentTimeMillis,
          );
          if (decision.type !== "undecided") return decision.type;
          yield* Effect.raceFirst(
            Effect.sleep(decision.recheckAfterMillis),
            Stream.runHead(activity.locks),
          );
        }
      }),
  });
});

export const live: Layer.Layer<
  UserPresence,
  never,
  CodexApplicationEventHub | CodexRendererPresentationRegistry
> = Layer.effect(UserPresence, make).pipe(Layer.provide(systemActivityLive));
