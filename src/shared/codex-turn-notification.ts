import type { CodexConversationSnapshot } from "./types";

export type CodexHeartbeatDecision = "NOTIFY" | "DONT_NOTIFY";

export interface CodexHeartbeatAssistantMessage {
  decision: CodexHeartbeatDecision;
  visibleText: string | null;
  notificationMessage: string | null;
}

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

function findLastHeartbeatRange(text: string): { start: number; end: number; body: string } | null {
  const heartbeatPattern = /<heartbeat\b[^>]*>[\s\S]*?<\/heartbeat>/gi;
  let match: RegExpExecArray | null = null;
  let lastMatch: RegExpExecArray | null = null;

  while ((match = heartbeatPattern.exec(text)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch || typeof lastMatch.index !== "number") return null;
  const raw = lastMatch[0] ?? "";
  const body = raw.replace(/^<heartbeat\b[^>]*>/i, "").replace(/<\/heartbeat>$/i, "");
  return {
    start: lastMatch.index,
    end: lastMatch.index + raw.length,
    body,
  };
}

function readXmlishTagValue(body: string, tagName: string): string | null {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i");
  const match = pattern.exec(body);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function removeHeartbeatFence(text: string): string {
  return text.replace(/```(?:xml|heartbeat)?\s*<heartbeat\b[\s\S]*?<\/heartbeat>\s*```/gi, "");
}

export function parseCodexHeartbeatAssistantMessage(
  text: string | null | undefined,
): CodexHeartbeatAssistantMessage | null {
  if (typeof text !== "string" || text.length === 0) return null;

  const range = findLastHeartbeatRange(text);
  if (!range) return null;

  const rawDecision = readXmlishTagValue(range.body, "decision");
  if (rawDecision !== "NOTIFY" && rawDecision !== "DONT_NOTIFY") return null;

  const withoutHeartbeat = removeHeartbeatFence(
    `${text.slice(0, range.start)}${text.slice(range.end)}`,
  );

  return {
    decision: rawDecision,
    visibleText: withoutHeartbeat.trim() || null,
    notificationMessage: readXmlishTagValue(range.body, "message"),
  };
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
