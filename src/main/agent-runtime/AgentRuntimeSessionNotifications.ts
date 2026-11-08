import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type {
  CodexNotificationConversationFacts,
  CodexNotificationTurnStatus,
  CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import { parseCodexHeartbeatAssistantMessage } from "../../shared/codex-turn-notification";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";

export interface AgentRuntimeNotificationSession {
  readonly title: string | null;
  readonly archived: boolean;
  readonly unread: boolean;
  /**
   * The Session a temporary side chat was opened from, per Core's binding. A source that is gone,
   * archived or unbound has no root, so the side chat has nowhere to open.
   */
  readonly sideChatSource: {
    readonly sessionId: string;
    readonly rootThreadId: string | null;
  } | null;
}

export interface AgentRuntimeSessionNotificationOptions {
  readonly transitions: Stream.Stream<AgentRuntimeActivityTransition>;
  /** The person has this chat in front of them, in a focused window or on a phone. */
  readonly isSeen: (chat: { readonly rootThreadId: string; readonly sessionId: string }) => boolean;
  readonly readSession: (
    sessionId: string,
  ) => Effect.Effect<AgentRuntimeNotificationSession | null, unknown>;
  readonly markUnread: (sessionId: string) => Effect.Effect<void, unknown>;
  /** Desktop notifications and phone pushes each apply their own settings and presence. */
  readonly publish: (event: CodexThreadNotificationEvent) => void;
}

const terminalStatus = (status: string | null): CodexNotificationTurnStatus | null => {
  if (status === "completed" || status === "failed" || status === "interrupted") return status;
  return status === "cancelled" ? "interrupted" : null;
};

/** One waiting episode shares its request identity across foreground Runs. */
export const runtimeQuestionRequestId = (rootThreadId: string) =>
  `agent-runtime:${rootThreadId}:session`;

const waitingFamily = (activity: AgentRuntimeSessionActivity | null) => {
  if (activity?.status !== "waiting") return null;
  return activity.activeFlags?.includes("waitingOnApproval") ? "approval" : "question";
};

/**
 * Turns Session activity transitions into unread state and desktop notifications. A foreground
 * Run ending (including automatic wake Runs) or a new attention request marks an unpresented
 * Session unread and raises the shared notification owner with native conversation copy.
 * User attention replaces completion while the Session waits, including questions revealed at
 * turn end. A temporary side chat's attention surfaces through its source Session; its completion
 * keeps the side chat's own conversation and copy but opens its tab inside the source Session, and
 * does not notify when that source cannot be opened.
 */
export const run = Effect.fn("AgentRuntimeSessionNotifications.run")(function* (
  options: AgentRuntimeSessionNotificationOptions,
) {
  // A settled Run is durable history; native execution authority may already be gone.
  const readOutcome = (transition: AgentRuntimeActivityTransition, runId: string) =>
    transition.connection
      .request("run.outcome", {
        threadId: transition.rootThreadId,
        runId,
      })
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
  const finalReply = (
    transition: AgentRuntimeActivityTransition,
    outcome: AgentRuntimeOperations["run.outcome"]["output"],
  ) =>
    Effect.gen(function* () {
      if (!outcome?.finalAssistantItemId) return null;
      const item = yield* transition.connection.request("thread.item", {
        threadId: transition.rootThreadId,
        itemId: outcome.finalAssistantItemId,
      });
      return item?.type === "assistant_message" ? item.text : null;
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
  const observe = (transition: AgentRuntimeActivityTransition) =>
    Effect.gen(function* () {
      const { before, after, rootThreadId, sessionId } = transition;
      const endedRun = transition.endedRun;
      const outcome =
        endedRun && endedRun.status === null
          ? yield* readOutcome(transition, endedRun.runId)
          : undefined;
      const status = terminalStatus(endedRun?.status ?? outcome?.status ?? null);
      const beforeFamily = waitingFamily(before);
      const afterFamily = waitingFamily(after);
      const attentionStarted =
        afterFamily !== null &&
        after !== null &&
        (beforeFamily !== afterFamily ||
          after.pendingRequestCount > (before?.pendingRequestCount ?? 0) ||
          (afterFamily === "approval" && after.approvalPrompt !== before?.approvalPrompt));
      if (beforeFamily !== null && beforeFamily !== afterFamily)
        options.publish({
          type: "request-resolved",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversationId: rootThreadId,
          requestId: runtimeQuestionRequestId(rootThreadId),
          ...(beforeFamily === "approval" ? { family: "approval" } : {}),
        });
      const turnCompleted = status && endedRun && after?.status !== "waiting";
      if (!turnCompleted && !attentionStarted) return;
      const session = yield* options.readSession(sessionId);
      if (!session) return;
      const sideChatSource = session.sideChatSource;
      // A side chat's attention already waits on its source Session; only its replies notify.
      if (sideChatSource && !turnCompleted) return;
      if (!session.archived && !session.unread && !options.isSeen({ rootThreadId, sessionId }))
        yield* options.markUnread(sessionId);
      // A side chat opens as a tab of its source Session, never as a Scene of its own.
      const parentNavigationPath = sideChatSource?.rootThreadId
        ? `session:${encodeURIComponent(sideChatSource.sessionId)}/thread:${encodeURIComponent(sideChatSource.rootThreadId)}`
        : null;
      if (sideChatSource && !parentNavigationPath) return;
      const conversation: CodexNotificationConversationFacts = {
        conversationId: rootThreadId,
        title: session.title,
        threadSource: null,
        parentThreadId: null,
        source: null,
        sideConversationParentNavigationPath: parentNavigationPath,
        runtimeSessionId: sessionId,
      };
      if (turnCompleted) {
        // Delegated work that will wake the root, or a queued follow-up, continues this turn.
        const hasPendingContinuation =
          after?.status === "background" ||
          (after?.status === "running" && status !== "interrupted");
        const lastAgentMessage = !hasPendingContinuation
          ? yield* finalReply(
              transition,
              outcome === undefined ? yield* readOutcome(transition, endedRun.runId) : outcome,
            )
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
      if (attentionStarted && after)
        options.publish({
          hostId: DEFAULT_CODEX_HOST_ID,
          conversation,
          requestId: runtimeQuestionRequestId(rootThreadId),
          turnId: after.activeRunId ?? "",
          ...(afterFamily === "approval"
            ? { type: "approval-requested", prompt: after.approvalPrompt ?? null }
            : { type: "user-input-requested", questionCount: after.pendingRequestCount }),
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
