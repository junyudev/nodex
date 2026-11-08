import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ProjectSession } from "../../shared/types";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { UserPresence } from "./UserPresence";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createOperationId } from "../core-runtime/operation-identity";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import {
  ProjectWorkspace,
  type SessionReminderWork,
} from "../project-application/ProjectWorkspace";
import { makeSetSessionUnread } from "../project-application/SessionUnread";

export interface SessionReminderOptions {
  readonly next: Effect.Effect<SessionReminderWork | null, unknown>;
  readonly consume: (
    sessionId: string,
    remindAt: string,
    deliver: boolean,
  ) => Effect.Effect<boolean, unknown>;
  readonly complete: (sessionId: string, deliveryId: string) => Effect.Effect<boolean, unknown>;
  readonly defer: (sessionId: string, deliveryId: string) => Effect.Effect<void, unknown>;
  readonly markUnread: (session: ProjectSession) => Effect.Effect<unknown, unknown>;
  readonly isPresented: (session: ProjectSession) => boolean;
  readonly notify: (session: ProjectSession, remindAt: string) => void;
  readonly changes: Stream.Stream<unknown>;
}

/** One scoped loop, one earliest-deadline timer, and a coalesced wake for all external changes. */
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
    const { session, remindAt, deliveryId } = work;
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
      yield* options.consume(session.id, remindAt, !options.isPresented(session));
      return;
    }
    if (options.isPresented(session)) {
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
    options.notify(session, remindAt);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Chat reminder delivery failed", cause).pipe(Effect.andThen(wait(30_000))),
    ),
  );
  yield* Deferred.await(activation).pipe(Effect.andThen(Effect.forever(step)), Effect.forkScoped);
  return { activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid), wake };
});

export class SessionReminderRuntime extends Context.Service<
  SessionReminderRuntime,
  {
    readonly activate: Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/SessionReminderRuntime") {}

export const live = Layer.effect(
  SessionReminderRuntime,
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const core = yield* CoreAuthority;
    const events = yield* CodexApplicationEventHub;
    const presence = yield* UserPresence;
    const desktop = yield* ElectronDesktop;
    const setUnread = yield* makeSetSessionUnread;
    const owner = yield* make({
      next: SubscriptionRef.get(core.state).pipe(
        Effect.flatMap((state) =>
          state.kind === "ready" ? workspace.nextSessionReminder : Effect.succeed(null),
        ),
      ),
      consume: workspace.consumeSessionReminder,
      complete: workspace.completeSessionReminder,
      defer: workspace.deferSessionReminder,
      markUnread: (session) =>
        setUnread(session, true, createOperationId("session.reminder.unread")),
      isPresented: (session) =>
        presence.isSeen({
          conversationId:
            session.executionRef?.threadId ?? session.thread?.threadId ?? `session:${session.id}`,
          hostId: session.thread?.executionHostId,
          sessionId: session.id,
        }),
      notify: (session, remindAt) =>
        events.publish({
          kind: "threadNotification",
          value: {
            type: "session-reminder",
            hostId: session.thread?.executionHostId ?? "local",
            remindAt,
            conversation: {
              conversationId:
                session.executionRef?.threadId ??
                session.thread?.threadId ??
                `session:${session.id}`,
              title: session.displayTitle,
              runtimeSessionId: session.id,
              threadSource: null,
              parentThreadId: null,
              source: null,
              sideConversationParentNavigationPath: null,
            },
          },
        }),
      changes: Stream.merge(
        events.events.pipe(Stream.filter((event) => event.kind === "sessionOrganizationChanged")),
        SubscriptionRef.changes(core.state),
      ),
    });
    yield* desktop.onPowerEvent("resume", owner.wake);
    return SessionReminderRuntime.of({ activate: owner.activate });
  }),
);
