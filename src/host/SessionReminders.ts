import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ProjectSession } from "../shared/types";
import type { SessionReminderNotificationEvent } from "../shared/codex-thread-notification";
import { CodexApplicationEventHub } from "../main/codex-application/CodexApplicationEventHub";
import { UserPresence } from "./UserPresence";
import { CoreEventHub } from "../main/core-runtime/CoreEventHub";
import { DatabaseNotifierRuntime } from "../main/host-runtime/DatabaseNotifierRuntime";
import {
  ProjectWorkspace,
  type SessionReminderWork,
} from "../main/project-application/ProjectWorkspace";

export interface SessionReminderOptions {
  readonly next: Effect.Effect<SessionReminderWork | null, unknown>;
  readonly consume: (
    sessionId: string,
    memberId: string,
    remindAt: string,
    deliver: boolean,
  ) => Effect.Effect<boolean, unknown>;
  readonly complete: (sessionId: string, deliveryId: string) => Effect.Effect<boolean, unknown>;
  readonly defer: (sessionId: string, deliveryId: string) => Effect.Effect<void, unknown>;
  readonly markUnread: (session: ProjectSession) => Effect.Effect<unknown, unknown>;
  /** The Member has the chat in front of them, so its reminder is already answered. */
  readonly isPresented: (session: ProjectSession, memberId: string) => boolean;
  readonly notify: (session: ProjectSession, remindAt: string, memberId: string) => void;
  readonly changes: Stream.Stream<unknown>;
}

/** The chat a reminder names, as presence knows it. */
export const reminderTarget = (session: ProjectSession) => ({
  conversationId:
    session.executionRef?.threadId ?? session.thread?.threadId ?? `session:${session.id}`,
  hostId: session.thread?.executionHostId ?? "local",
  sessionId: session.id,
});

/** The attention occurrence a due reminder raises, for desktop notifications and phones alike. */
export const reminderOccurrence = (
  session: ProjectSession,
  remindAt: string,
  memberId: string,
): SessionReminderNotificationEvent => ({
  type: "session-reminder",
  hostId: reminderTarget(session).hostId,
  remindAt,
  memberId,
  conversation: {
    conversationId: reminderTarget(session).conversationId,
    title: session.displayTitle,
    runtimeSessionId: session.id,
    threadSource: null,
    parentThreadId: null,
    source: null,
    sideConversationParentNavigationPath: null,
  },
});

/**
 * Each Member's chat reminders come due here: one scoped loop, one earliest-deadline timer, and a
 * coalesced wake for all external changes. Presentation and notification are the embedder's ports.
 */
export const make = Effect.fn("SessionReminderRuntime.make")(function* (
  options: SessionReminderOptions,
) {
  const activation = yield* Deferred.make<void>();
  const wakes = yield* Queue.sliding<void>(1);
  const wake = Queue.offer(wakes, undefined).pipe(Effect.asVoid);
  const wait = (delay: number) =>
    Effect.timeoutOrElse(Queue.take(wakes), {
      duration: Math.min(delay, 2_147_483_647),
      orElse: () => Effect.void,
    });
  yield* options.changes.pipe(
    Stream.runForEach(() => wake),
    Effect.forkScoped({ startImmediately: true }),
  );
  const step = Effect.gen(function* () {
    const work = yield* options.next;
    if (!work) {
      yield* Queue.take(wakes);
      return;
    }
    const { session, remindAt, deliveryId, memberId } = work;
    if (session.archived) {
      if (deliveryId) yield* options.complete(session.id, deliveryId);
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    const delay = Date.parse(work.wakeAt) - now;
    if (delay > 0) {
      yield* wait(delay);
      return;
    }
    if (deliveryId === null) {
      // Claiming clears the exact reminder and durably retains its unfinished unread delivery.
      const deliver = !options.isPresented(session, memberId);
      yield* options.consume(session.id, memberId, remindAt, deliver);
      return;
    }
    if (options.isPresented(session, memberId)) {
      yield* options.complete(session.id, deliveryId);
      return;
    }
    const unread = yield* options.markUnread(session).pipe(Effect.result);
    if (unread._tag === "Failure") {
      yield* options.defer(session.id, deliveryId);
      return;
    }
    // Settlement is another CAS: cancellation, archive, rescheduling or another host wins safely.
    if (!(yield* options.complete(session.id, deliveryId))) return;
    options.notify(session, remindAt, memberId);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Chat reminder delivery failed", cause).pipe(Effect.andThen(wait(30_000))),
    ),
  );
  yield* Deferred.await(activation).pipe(Effect.andThen(Effect.forever(step)), Effect.forkScoped);
  return { activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid), wake };
});

/**
 * A team host delivers every Member's reminders: the chat turns unread for that Member when its
 * time comes, and their phones hear about it. The host has no window to check or notify.
 */
export const hostedLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const events = yield* CoreEventHub;
    const notifier = yield* DatabaseNotifierRuntime;
    const occurrences = yield* CodexApplicationEventHub;
    const presence = yield* UserPresence;
    const owner = yield* make({
      next: SubscriptionRef.get(events.connection).pipe(
        Effect.flatMap((state) =>
          state.kind === "ready" ? workspace.nextSessionReminder : Effect.succeed(null),
        ),
      ),
      consume: workspace.consumeSessionReminder,
      // Core turns the chat unread for the reminded Member as it settles the delivery.
      complete: (sessionId, deliveryId) =>
        workspace.completeSessionReminder(sessionId, deliveryId, true),
      defer: workspace.deferSessionReminder,
      markUnread: () => Effect.void,
      isPresented: (session, memberId) => presence.isOnPhone(memberId, reminderTarget(session)),
      notify: (session, remindAt, memberId) =>
        occurrences.publish({
          kind: "threadNotification",
          value: reminderOccurrence(session, remindAt, memberId),
        }),
      changes: Stream.merge(
        notifier.projectSessionInvalidations,
        SubscriptionRef.changes(events.connection),
      ),
    });
    yield* owner.activate;
  }),
);
