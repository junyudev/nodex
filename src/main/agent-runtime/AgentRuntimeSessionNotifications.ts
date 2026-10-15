import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type {
  CodexNotificationConversationFacts,
  CodexNotificationTurnStatus,
  CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import { parseCodexHeartbeatAssistantMessage } from "../../shared/codex-turn-notification";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";

export interface AgentRuntimeNotificationSession {
  readonly title: string | null;
  readonly archived: boolean;
  readonly unread: boolean;
}

export interface AgentRuntimeSessionNotificationOptions {
  readonly transitions: Stream.Stream<AgentRuntimeActivityTransition>;
  /** A focused window currently presents this root Thread's conversation. */
  readonly isPresentedInForeground: (rootThreadId: string) => boolean;
  readonly readSession: (
    sessionId: string,
  ) => Effect.Effect<AgentRuntimeNotificationSession | null, unknown>;
  readonly markUnread: (sessionId: string) => Effect.Effect<void, unknown>;
  /** Whether turn policy could show a notification now; otherwise the reply is not read. */
  readonly turnMayShow: Effect.Effect<boolean>;
  /** The desktop notification owner applies settings, focus and presentation policy. */
  readonly publish: (event: CodexThreadNotificationEvent) => void;
}

const terminalStatus = (status: string | null): CodexNotificationTurnStatus | null => {
  if (status === "completed" || status === "failed" || status === "interrupted") return status;
  return status === "cancelled" ? "interrupted" : null;
};

/** One waiting episode of a root shares a question identity until its questions resolve. */
export const runtimeQuestionRequestId = (transition: {
  readonly rootThreadId: string;
  readonly activeRunId: string | null;
}) => `agent-runtime:${transition.rootThreadId}:${transition.activeRunId ?? "session"}`;

/**
 * Turns Session activity transitions into unread state and desktop notifications. A foreground
 * Run ending (including automatic wake Runs) or a new information question marks an unpresented
 * Session unread and raises the shared notification owner with native conversation copy.
 */
export const run = Effect.fn("AgentRuntimeSessionNotifications.run")(function* (
  options: AgentRuntimeSessionNotificationOptions,
) {
  const finalReply = (transition: AgentRuntimeActivityTransition, runId: string) =>
    Effect.gen(function* () {
      const { connection, rootThreadId } = transition;
      const authority = yield* connection.request("thread.authority", {
        threadId: rootThreadId,
        runId,
      });
      if (!authority) return null;
      const outcome = yield* connection.request("run.outcome", {
        threadId: rootThreadId,
        messageId: authority.userMessageId,
      });
      if (!outcome?.finalAssistantItemId) return null;
      const item = yield* connection.request("thread.item", {
        threadId: rootThreadId,
        itemId: outcome.finalAssistantItemId,
      });
      return item?.type === "assistant_message" ? item.text : null;
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
  const endedStatus = (transition: AgentRuntimeActivityTransition, runId: string) =>
    transition.endedRun?.status
      ? Effect.succeed(transition.endedRun.status)
      : transition.connection
          .request("thread.authority", { threadId: transition.rootThreadId, runId })
          .pipe(
            Effect.map((authority) => authority?.status ?? null),
            Effect.catchCause(() => Effect.succeed(null)),
          );

  const observe = (transition: AgentRuntimeActivityTransition) =>
    Effect.gen(function* () {
      const { before, after, rootThreadId, sessionId } = transition;
      const endedRun = transition.endedRun;
      const status = endedRun ? terminalStatus(yield* endedStatus(transition, endedRun.runId)) : null;
      const questionStarted =
        after?.status === "waiting" &&
        (before?.status !== "waiting" || after.pendingRequestCount > before.pendingRequestCount);
      const questionsResolved = before?.status === "waiting" && after?.status !== "waiting";
      if (questionsResolved && before)
        options.publish({
          type: "request-resolved",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversationId: rootThreadId,
          requestId: runtimeQuestionRequestId({
            rootThreadId,
            activeRunId: before.activeRunId,
          }),
        });
      if (!status && !questionStarted) return;
      const session = yield* options.readSession(sessionId);
      if (!session) return;
      if (!session.archived && !session.unread && !options.isPresentedInForeground(rootThreadId))
        yield* options.markUnread(sessionId);
      const conversation: CodexNotificationConversationFacts = {
        conversationId: rootThreadId,
        title: session.title,
        threadSource: null,
        parentThreadId: null,
        source: null,
        sideConversationParentNavigationPath: null,
      };
      if (status && endedRun) {
        // Delegated work that will wake the root, or a queued follow-up, continues this turn.
        const hasPendingContinuation =
          after?.status === "background" ||
          (after?.status === "running" && status !== "interrupted");
        const lastAgentMessage =
          !hasPendingContinuation && (yield* options.turnMayShow)
            ? yield* finalReply(transition, endedRun.runId)
            : null;
        options.publish({
          type: "turn-completed",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversation,
          turnId: endedRun.runId,
          status,
          lastAgentMessage,
          heartbeatAssistantMessage: parseCodexHeartbeatAssistantMessage(lastAgentMessage),
          automationNotificationDecision: null,
          hasPendingContinuation,
        });
      }
      if (questionStarted && after)
        options.publish({
          type: "user-input-requested",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversation,
          requestId: runtimeQuestionRequestId({ rootThreadId, activeRunId: after.activeRunId }),
          turnId: after.activeRunId ?? "",
          questionCount: after.pendingRequestCount,
        });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Agent Session notification could not be delivered").pipe(
          Effect.annotateLogs({ sessionId: transition.sessionId, cause }),
        ),
      ),
    );

  return yield* options.transitions.pipe(Stream.runForEach(observe));
});
