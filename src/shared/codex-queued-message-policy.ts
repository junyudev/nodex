import type { CodexCanonicalConversationState } from "./codex-conversation-state/codex-conversation-state";
import { latestConversationTurn } from "./codex-conversation-state/codex-turn-selectors";
import type { QueuedMessageRole } from "./codex-queued-message-coordinator";
import { CODEX_INTERRUPTED_STEER_REASON } from "./codex-queued-follow-up-state";

/** Admission uses execution history, independent of transcript presentation markers. */
export function canAutomaticallySendQueuedMessage({
  conversation,
  message,
  role,
}: {
  conversation:
    | Pick<CodexCanonicalConversationState, "turns" | "turnHistory" | "resumeState">
    | null
    | undefined;
  message: { pausedReason?: string | null };
  role: QueuedMessageRole;
}): boolean {
  if (message.pausedReason || !conversation || role?.role === "follower") return false;
  const latest = latestConversationTurn(conversation);
  if (latest?.status === "inProgress") return false;
  if (conversation.resumeState === "needs_resume" || role === null || latest === null) return true;
  return (
    latest.status === "completed" &&
    latest.items.some(
      (item) =>
        item.type === "agentMessage" ||
        (item.type === "contextCompaction" && "source" in item && item.source === "manual"),
    )
  );
}

/** Resume an interruption without silently retrying unrelated delivery failures. */
export function resumeInterruptedQueuedMessage<
  Message extends { id: string; pausedReason?: string | null },
>(message: Message): Message {
  if (message.pausedReason !== CODEX_INTERRUPTED_STEER_REASON) return message;
  const resumed = { ...message };
  delete resumed.pausedReason;
  return resumed;
}
