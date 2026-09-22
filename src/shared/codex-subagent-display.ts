import type { CodexConversationChildMembership, CodexThreadSummary } from "./types";
import type { CodexMultiAgentReceiverThread } from "./codex-transcript-special-items";

function normalizeOptionalLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() || null : trimmed;
}

export function isRawCodexSubagentThreadIdLabel(
  value: string | null | undefined,
  threadId: string,
): boolean {
  const label = normalizeOptionalLabel(value);
  const normalizedThreadId = threadId.trim();
  if (!label || !normalizedThreadId) return false;
  if (label === normalizedThreadId) return true;
  return label.length >= 8 && /^[0-9a-f-]+$/iu.test(label) && normalizedThreadId.startsWith(label);
}

function firstFriendlyLabel(
  threadId: string,
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    const label = normalizeOptionalLabel(value);
    if (!label) continue;
    if (isRawCodexSubagentThreadIdLabel(label, threadId)) continue;
    return label;
  }
  return null;
}

export function resolveCodexSubagentDisplayName(input: {
  threadId: string;
  membership?: CodexConversationChildMembership | null;
  receiverThread?: CodexMultiAgentReceiverThread | null;
  childSummary?: CodexThreadSummary | null;
  fallbackDisplayName?: string | null;
  fallbackLabel?: string | null;
}): string {
  const threadId = input.threadId.trim();
  const membership = input.membership ?? null;
  const receiverThread = input.receiverThread ?? null;
  const childSummary = input.childSummary ?? null;

  const friendlyLabel = firstFriendlyLabel(threadId, [
    membership?.displayName,
    receiverThread?.thread?.displayName,
    receiverThread?.thread?.name,
    membership?.thread?.displayName,
    membership?.thread?.name,
    membership?.thread?.nickname,
    childSummary?.agentNickname,
    receiverThread?.thread?.nickname,
    childSummary?.threadName,
    input.fallbackDisplayName,
  ]);
  if (friendlyLabel) return friendlyLabel;

  return (
    normalizeOptionalLabel(input.fallbackLabel) ??
    normalizeOptionalLabel(input.fallbackDisplayName) ??
    normalizeOptionalLabel(threadId) ??
    "Agent"
  );
}

/** Formats the final meaningful path segment used by modern agent identities. */
export function projectCodexSubagentPathDisplayName(agentPath: string): string | null {
  const segment = agentPath
    .split("/")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "root")
    .at(-1);
  if (!segment) return null;
  const normalized = segment.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();
  return normalized ? `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}` : null;
}
