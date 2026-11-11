import type { CodexConversationSnapshot } from "./types";

import type {
  CodexHeartbeatAssistantMessage,
  CodexHeartbeatDecision,
} from "./automation-heartbeat";
export { parseCodexHeartbeatAssistantMessage } from "./automation-heartbeat";
export type {
  CodexHeartbeatAssistantMessage,
  CodexHeartbeatDecision,
} from "./automation-heartbeat";

export interface CodexTurnCompleteNotificationEnvelope {
  conversationId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  lastAgentMessage: string | null;
  heartbeatAssistantMessage: CodexHeartbeatAssistantMessage | null;
  automationNotificationDecision?: CodexHeartbeatDecision | null;
  hasPendingContinuation: boolean;
}

export function normalizeDesktopNotificationText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function isCodexConversationDesktopNotificationEligible(
  conversation: Pick<CodexConversationSnapshot, "source"> & {
    parentThreadId?: string | null;
  },
): boolean {
  const directParentThreadId = conversation.parentThreadId?.trim() ?? "";
  if (directParentThreadId.length > 0) return false;
  return (conversation.source?.parentThreadId?.trim() ?? "").length === 0;
}

export interface CodexPendingContinuationFacts {
  terminalStatus: CodexTurnCompleteNotificationEnvelope["status"];
  queuedResourceLoading: boolean;
  queuedHeadPausedReason: string | null | undefined;
  threadGoalStatus: NonNullable<CodexConversationSnapshot["threadGoal"]>["status"] | null;
  latestMergedTurnStatus: "inProgress" | "completed" | "failed" | "interrupted" | null;
  hasRunningCollabAgent: boolean;
  hasActiveDescendant: boolean;
}

export function hasCodexPendingContinuation(facts: CodexPendingContinuationFacts): boolean {
  const queuedHeadWillContinue =
    facts.terminalStatus !== "interrupted" &&
    (facts.queuedResourceLoading || facts.queuedHeadPausedReason === null);
  if (queuedHeadWillContinue) return true;
  if (facts.terminalStatus === "completed" && facts.threadGoalStatus === "active") return true;
  if (facts.latestMergedTurnStatus === "inProgress") return true;
  if (facts.hasRunningCollabAgent) return true;
  return facts.hasActiveDescendant;
}
