import type { CodexConversationSnapshot } from "./types";

export interface ContextWindowIndicatorState {
  status: "ready" | "usageOnly" | "unavailable";
  percentFull: number;
  usedTokens: number | null;
  windowTokens: number | null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function resolveContextWindowIndicatorState(
  conversation: CodexConversationSnapshot | null,
): ContextWindowIndicatorState {
  const tokenUsage =
    conversation?.resumeState === "resumed" ? conversation.latestTokenUsageInfo : null;
  const contextUsage =
    conversation?.resumeState === "resumed" ? conversation.contextUsage : undefined;
  if (!tokenUsage && !contextUsage) {
    return {
      status: "unavailable",
      percentFull: 0,
      usedTokens: null,
      windowTokens: null,
    };
  }

  const usedTokens = normalizeTokenCount(contextUsage?.used ?? tokenUsage?.last.totalTokens ?? 0);
  const windowTokensRaw = contextUsage?.size ?? tokenUsage?.modelContextWindow;
  if (
    typeof windowTokensRaw === "number" &&
    Number.isFinite(windowTokensRaw) &&
    windowTokensRaw > 0
  ) {
    const windowTokens = normalizeTokenCount(windowTokensRaw);
    if (windowTokens <= 0) {
      return {
        status: "usageOnly",
        percentFull: 0,
        usedTokens,
        windowTokens: null,
      };
    }

    return {
      status: "ready",
      percentFull: clampPercent((usedTokens / windowTokens) * 100),
      usedTokens,
      windowTokens,
    };
  }

  return {
    status: "usageOnly",
    percentFull: 0,
    usedTokens,
    windowTokens: null,
  };
}
