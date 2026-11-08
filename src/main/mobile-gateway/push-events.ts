import type { PushPayload } from "@nodex/mobile-protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  decideCodexTurnOccurrence,
  isCodexNotificationChildConversation,
  resolveCodexTurnNotificationReply,
  type CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CoreModules } from "../core-runtime/CoreModules";
import { UserPresence } from "../host-runtime/UserPresence";
import { snapshotTurnItems } from "./transcript-projection";

export class MobilePushEvents extends Context.Service<
  MobilePushEvents,
  {
    /** What paired phones should be told now, before each phone's own preferences. */
    readonly events: Stream.Stream<PushPayload>;
  }
>()("nodex/main/mobile-gateway/MobilePushEvents") {}

type Attention = Exclude<
  CodexThreadNotificationEvent,
  { readonly type: "request-resolved" | "async-question-resolved" }
>;

/** The phone's word for an occurrence, or null when it is not worth telling anyone. */
const pushKind = (occurrence: Attention): PushPayload["kind"] | null => {
  if (occurrence.type === "turn-completed") {
    if (decideCodexTurnOccurrence(occurrence).type === "suppress") return null;
    return occurrence.status === "failed" ? "failed" : "finished";
  }
  if (occurrence.type === "session-reminder") return "needs_you";
  return isCodexNotificationChildConversation(occurrence.conversation) ? null : "needs_you";
};

/**
 * Projects the desktop's attention occurrences, the same ones its own notifications use, onto the
 * phone. A phone is told only once the person has left this computer: immediately when they are
 * already away, otherwise after they leave without having touched it again. Answering, seeing the
 * chat anywhere, or a newer occurrence in the same chat withdraws what is still waiting.
 */
export const makeMobilePushEvents = Effect.gen(function* () {
  const hub = yield* CodexApplicationEventHub;
  const presence = yield* UserPresence;
  const runtime = yield* AgentRuntimeApplication;
  const core = yield* CoreModules;

  // Core applies the phone chat list's root, side-chat, Project and archive visibility rules.
  const listedTitle = Effect.fnUntraced(function* (sessionId: string) {
    const page = yield* core.workspace.read({
      kind: "session_window",
      archived: false,
      order: "conversation",
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

  const events = Stream.callback<PushPayload>((queue) =>
    Effect.gen(function* () {
      // At most one occurrence per conversation waits for the person to leave.
      const waiting = yield* FiberMap.make<string>();
      const waitingKinds = new Map<string, { readonly kind: PushPayload["kind"] }>();

      const tell = (occurrence: Attention) =>
        Effect.gen(function* () {
          const { conversation } = occurrence;
          const sessionId = conversation.runtimeSessionId;
          const kind = pushKind(occurrence);
          // A side chat's reply stays beside its source chat, which a phone does not show.
          if (!sessionId || !kind || conversation.sideConversationParentNavigationPath) return;
          const target = {
            conversationId: conversation.conversationId,
            hostId: occurrence.hostId,
            sessionId,
          };
          if (presence.isOnPhone(target)) {
            yield* FiberMap.remove(waiting, target.conversationId);
            return;
          }
          const since = yield* Clock.currentTimeMillis;
          const entry = { kind };
          waitingKinds.set(target.conversationId, entry);
          yield* FiberMap.run(
            waiting,
            target.conversationId,
            Effect.gen(function* () {
              const title = yield* listedTitle(sessionId);
              if (title === null) return;
              const payload: PushPayload = {
                kind,
                sessionId,
                title,
                body: yield* body(occurrence, sessionId),
              };
              if ((yield* presence.attendanceSince(since)) === "returned") return;
              yield* Queue.offer(queue, payload);
            }).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("Mobile notification could not be prepared"),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (waitingKinds.get(target.conversationId) === entry)
                    waitingKinds.delete(target.conversationId);
                }),
              ),
            ),
          );
        });

      const withdraw = (conversationId: string, onlyRequests: boolean) =>
        onlyRequests && waitingKinds.get(conversationId)?.kind !== "needs_you"
          ? Effect.void
          : FiberMap.remove(waiting, conversationId);

      yield* hub.events.pipe(
        Stream.runForEach((event) => {
          if (event.kind === "conversationSeen") return withdraw(event.value, false);
          if (event.kind !== "threadNotification") return Effect.void;
          const occurrence = event.value;
          if (
            occurrence.type === "request-resolved" ||
            occurrence.type === "async-question-resolved"
          )
            return withdraw(occurrence.conversationId, true);
          return tell(occurrence);
        }),
      );
    }),
  );
  return MobilePushEvents.of({ events });
});
