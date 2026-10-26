import type { CodexConversationSnapshot } from "./types";

export type ContextWindowIndicatorState =
  | { status: "ready"; percentFull: number; usedTokens: number; windowTokens: number }
  | { status: "usageOnly"; percentFull: null; usedTokens: number; windowTokens: null }
  | { status: "unavailable"; percentFull: null; usedTokens: null; windowTokens: null };

const unavailable: ContextWindowIndicatorState = {
  status: "unavailable",
  percentFull: null,
  usedTokens: null,
  windowTokens: null,
};

export function resolveContextWindowIndicatorState(
  conversation: CodexConversationSnapshot | null,
): ContextWindowIndicatorState {
  if (conversation?.resumeState !== "resumed") return unavailable;
  // An explicit null is authoritative absence from a Harness. Only the native
  // Codex projection, which omits contextUsage, uses the Codex protocol field.
  const usage =
    conversation.contextUsage !== undefined
      ? conversation.contextUsage
      : conversation.latestTokenUsageInfo
        ? {
            used: conversation.latestTokenUsageInfo.last.totalTokens,
            size: conversation.latestTokenUsageInfo.modelContextWindow,
          }
        : null;
  if (!usage || !Number.isFinite(usage.used) || usage.used < 0) return unavailable;
  const usedTokens = Math.round(usage.used);
  const windowTokens =
    typeof usage.size === "number" && Number.isFinite(usage.size) ? Math.round(usage.size) : 0;
  if (windowTokens <= 0) {
    return { status: "usageOnly", percentFull: null, usedTokens, windowTokens: null };
  }
  return {
    status: "ready",
    percentFull: Math.min(100, Math.max(0, Math.round((usedTokens / windowTokens) * 100))),
    usedTokens,
    windowTokens,
  };
}
