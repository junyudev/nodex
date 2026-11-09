import type { components } from "@nodex/core-protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  decideCodexTurnOccurrence,
  isCodexNotificationChildConversation,
  resolveCodexTurnNotificationReply,
  type CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CodexApplicationEventHub } from "../../main/codex-application/CodexApplicationEventHub";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import {
  sessionSpeaksThroughNodex,
  turnSpeaksThroughNodex,
} from "../coordinator/notification-session";
import { UserPresence, anyReturned, reportedAttendanceSince } from "../UserPresence";
import type { PushMessage, PushRecipient, PushTargets } from "./push-delivery";
import { snapshotTurnItems } from "./transcript-projection";

/** One push, sealed and sent separately to each of the Member's Devices. */
export interface MobilePush {
  readonly recipients: readonly PushRecipient[];
  readonly message: PushMessage;
}

type Attention = Exclude<
  CodexThreadNotificationEvent,
  { readonly type: "request-resolved" | "async-question-resolved" }
>;

/** Who an occurrence concerns, for Core to resolve with its answer-entitlement rule. */
export const pushAudience = (occurrence: Attention): components["schemas"]["PhonePushAudience"] => {
  switch (occurrence.type) {
    case "turn-completed":
      return { kind: "run_requester", run_id: occurrence.turnId };
    case "approval-requested":
      return { kind: "request", run_id: occurrence.turnId || null, request: "approval" };
    case "user-input-requested":
    case "async-question-requested":
      return { kind: "request", run_id: occurrence.turnId || null, request: "question" };
    case "session-reminder":
      return { kind: "reminder_owner", member_id: occurrence.memberId };
  }
};

/** The phone's word for an occurrence, or null when it is not worth telling anyone. */
const pushKind = (occurrence: Attention, managed: boolean): PushMessage["kind"] | null => {
  if (occurrence.type === "turn-completed") {
    if (decideCodexTurnOccurrence(occurrence, { managed }).type === "suppress") return null;
    return occurrence.status === "failed" ? "failed" : "finished";
  }
  if (managed) return null;
  if (occurrence.type === "session-reminder") return "needs_you";
  return isCodexNotificationChildConversation(occurrence.conversation) ? null : "needs_you";
};

const waitKey = (conversationId: string, memberId: string) =>
  JSON.stringify([conversationId, memberId]);

type CurrentTurn = components["schemas"]["CurrentTurnNotification"];
const turnKey = (turn: CurrentTurn) => JSON.stringify([turn.member_id, turn.page_id, turn.episode]);

/** What a Page Turn says on the phone when its message has nothing to add. */
const turnBody = (turn: CurrentTurn) => {
  const body = turn.body.trim();
  if (body) return body;
  switch (turn.reason) {
    case "question":
      return "Nodex has a question";
    case "approval":
      return "Approval requested";
    case "review":
      return "Ready for your review";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "stalled":
      return "Stalled";
    default:
      return "It's your move";
  }
};

/**
 * Projects the host's attention occurrences, the same ones desktop notifications use, onto the
 * phones of the Member each concerns. Core names that Member. A phone is told only once its
 * Member has left every computer they use: this host's own screen, if it has one, and each of
 * their desktops that reports to the Space. That is at once when they are already away, otherwise
 * after they leave without having touched one again. Answering, seeing the chat anywhere, or a
 * newer occurrence for the same Member in the same chat withdraws what is still waiting.
 */
export const makeMobilePushEvents = Effect.gen(function* () {
  const hub = yield* CodexApplicationEventHub;
  const presence = yield* UserPresence;
  const runtime = yield* AgentRuntimeApplication;
  const core = yield* CoreModules;
  const database = yield* DatabaseNotifierRuntime;

  /** Every Member's current notifying Page Turns, whether or not a desktop already showed one. */
  const currentTurns = Effect.suspend(() =>
    core.workspace.read({ kind: "current_turn_notifications" }, undefined, null),
  ).pipe(
    Effect.map((snapshot) =>
      snapshot.value.kind === "current_turn_notifications" ? snapshot.value.turns : null,
    ),
  );
  // A Turn changes with its Page's Inbox row; the periodic read repairs a lost invalidation.
  const turnChanges = Stream.merge(
    database.inboxInvalidations.pipe(Stream.map(() => undefined)),
    Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(Stream.map(() => undefined)),
  ).pipe(Stream.debounce("120 millis"));

  // Core applies the phone chat list's root, side-chat, draft, Project and archive visibility rules.
  const listedTitle = Effect.fnUntraced(function* (sessionId: string) {
    const page = yield* core.workspace.read({
      kind: "session_window",
      archived: false,
      order: "conversation",
      exclude_drafts: true,
      session_ids: [sessionId],
      window: { first: 1 },
    });
    if (page.value.kind !== "session_window") return null;
    return page.value.sessions.items[0]?.task.session.display_title ?? null;
  });

  const questionBody = Effect.fnUntraced(function* (sessionId: string) {
    const { snapshot } = yield* runtime.read({ sessionId });
    const pending = new Set(
      snapshot.projection.runtimeRequests
        .filter(
          (request) => request.status === "pending" && request.responseCapability.type === "live",
        )
        .map((request) => request.id),
    );
    for (const item of snapshotTurnItems(snapshot.projection)) {
      if (item.type !== "user_input_request" || !pending.has(item.requestId)) continue;
      if (item.questions.some((question) => question.isSecret)) return "Answer on your desktop";
      return item.questions[0]?.question ?? "Answer requested";
    }
    return "Answer requested";
  });

  const body = (occurrence: Attention, sessionId: string): Effect.Effect<string, unknown> => {
    switch (occurrence.type) {
      case "turn-completed": {
        if (occurrence.status === "failed") return Effect.succeed("Run failed");
        const reply = resolveCodexTurnNotificationReply(occurrence);
        return Effect.succeed(
          reply ?? (occurrence.status === "interrupted" ? "Stopped" : "Finished"),
        );
      }
      case "approval-requested":
        return Effect.succeed(occurrence.prompt?.trim() || "Approval requested");
      case "user-input-requested":
        return questionBody(sessionId);
      case "async-question-requested":
        return Effect.succeed("Nodex has a question");
      case "session-reminder":
        return Effect.succeed("You asked to come back to this chat.");
    }
  };

  const pushes = (targets: Pick<PushTargets, "recipients" | "presence">) =>
    Stream.callback<MobilePush>((output) =>
      Effect.gen(function* () {
        // At most one occurrence per Member and chat waits for that Member to leave.
        const waiting = yield* FiberMap.make<string>();
        const entries = new Map<
          string,
          {
            readonly conversationId: string;
            readonly memberId: string;
            readonly kind: PushMessage["kind"];
            /** The Page Turn this waits for, which withdraws it once it moves on. */
            readonly turn?: string;
          }
        >();

        /** Waits for the Member to leave every computer, then tells their phones. */
        const wait = (
          key: string,
          entry: NonNullable<ReturnType<typeof entries.get>>,
          since: number,
          recipients: readonly PushRecipient[],
          message: Effect.Effect<PushMessage | null, unknown>,
        ) => {
          entries.set(key, entry);
          return FiberMap.run(
            waiting,
            key,
            Effect.gen(function* () {
              const ready = yield* message;
              if (ready === null) return;
              const attendance = yield* anyReturned([
                presence.attendanceSince(since),
                reportedAttendanceSince(targets.presence(entry.memberId), since),
              ]);
              if (attendance === "returned") return;
              yield* Queue.offer(output, { recipients, message: ready });
            }).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("Mobile notification could not be prepared"),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (entries.get(key) === entry) entries.delete(key);
                }),
              ),
            ),
          );
        };

        const tell = Effect.fnUntraced(function* (occurrence: Attention) {
          const since = yield* Clock.currentTimeMillis;
          const { conversation } = occurrence;
          const sessionId = conversation.runtimeSessionId;
          // A side chat's reply stays beside its source chat, which a phone does not show.
          if (!sessionId || conversation.sideConversationParentNavigationPath) return;
          const kind = pushKind(occurrence, yield* turnSpeaksThroughNodex(core, occurrence));
          if (!kind) return;
          const recipients = yield* targets.recipients(sessionId, pushAudience(occurrence));
          const memberId = recipients[0]?.memberId;
          if (!memberId) return;
          const target = {
            conversationId: conversation.conversationId,
            hostId: occurrence.hostId,
            sessionId,
          };
          const key = waitKey(target.conversationId, memberId);
          if (presence.isOnPhone(memberId, target)) return yield* FiberMap.remove(waiting, key);
          yield* wait(
            key,
            { conversationId: target.conversationId, memberId, kind },
            since,
            recipients,
            Effect.gen(function* () {
              const title = yield* listedTitle(sessionId);
              if (title === null) return null;
              return { kind, sessionId, title, body: yield* body(occurrence, sessionId) };
            }),
          );
        });

        /**
         * A Page Turn is its Member's move. It waits on the chat it came from, if any, beside that
         * chat's own occurrences, so one moment is told once; a question or approval from a chat
         * Nodex does not manage is told as that chat's own request.
         */
        const tellTurn = Effect.fnUntraced(function* (turn: CurrentTurn) {
          const since = yield* Clock.currentTimeMillis;
          const sessionId = turn.session_id ?? null;
          if (
            sessionId &&
            (turn.reason === "question" || turn.reason === "approval") &&
            !(yield* sessionSpeaksThroughNodex(core, sessionId))
          )
            return;
          const recipients = yield* targets.recipients(sessionId, {
            kind: "turn_owner",
            page_id: turn.page_id,
            episode: turn.episode,
          });
          const memberId = recipients[0]?.memberId;
          if (!memberId) return;
          const conversationId = turn.conversation_id ?? `page:${turn.page_id}`;
          const key = waitKey(conversationId, memberId);
          if (sessionId && presence.isOnPhone(memberId, { conversationId, sessionId }))
            return yield* FiberMap.remove(waiting, key);
          yield* wait(
            key,
            { conversationId, memberId, kind: "needs_you", turn: turnKey(turn) },
            since,
            recipients,
            Effect.succeed({
              kind: "needs_you",
              ...(sessionId ? { sessionId } : {}),
              pageId: turn.page_id,
              title: turn.title.trim() || "Your Turn",
              body: turnBody(turn),
            }),
          );
        });

        // Turns already current when the host starts are quiet, as a restart replays nothing.
        let knownTurns: ReadonlyMap<string, CurrentTurn> | null = null;
        const followTurns = Effect.gen(function* () {
          const turns = yield* currentTurns;
          if (!turns) return;
          const current = new Map(turns.map((turn) => [turnKey(turn), turn]));
          const previous = knownTurns;
          knownTurns = current;
          if (!previous) return;
          // A Turn that moved on withdraws what still waits for it.
          const cleared = new Set([...previous.keys()].filter((key) => !current.has(key)));
          yield* Effect.forEach(
            [...entries].filter(([, entry]) => entry.turn && cleared.has(entry.turn)),
            ([key]) => FiberMap.remove(waiting, key),
            { discard: true },
          );
          yield* Effect.forEach(
            [...current].filter(([key]) => !previous.has(key)),
            ([, turn]) =>
              tellTurn(turn).pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("A Page Turn notification could not be addressed"),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause(() => Effect.logWarning("Page Turns could not be read for phones")),
        );

        /** Withdraws what still waits in a chat: for one Member or everyone, or only requests. */
        const withdraw = (
          conversationId: string,
          filter: { readonly memberId?: string; readonly onlyRequests?: boolean },
        ) =>
          Effect.forEach(
            [...entries].filter(
              ([, entry]) =>
                entry.conversationId === conversationId &&
                (filter.memberId === undefined || entry.memberId === filter.memberId) &&
                (!filter.onlyRequests || entry.kind === "needs_you"),
            ),
            ([key]) => FiberMap.remove(waiting, key),
            { discard: true },
          );

        yield* followTurns;
        yield* Stream.merge(
          hub.events,
          turnChanges.pipe(Stream.map(() => ({ kind: "turnsChanged" as const }))),
        ).pipe(
          Stream.runForEach((event) => {
            if (event.kind === "turnsChanged") return followTurns;
            if (event.kind === "conversationSeen")
              return withdraw(
                event.value,
                event.memberId === undefined ? {} : { memberId: event.memberId },
              );
            if (event.kind !== "threadNotification") return Effect.void;
            const occurrence = event.value;
            if (
              occurrence.type === "request-resolved" ||
              occurrence.type === "async-question-resolved"
            )
              return withdraw(occurrence.conversationId, { onlyRequests: true });
            return tell(occurrence).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("Mobile notification could not be addressed"),
              ),
            );
          }),
        );
      }),
    );
  return { pushes };
});
