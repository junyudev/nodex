import type { CodexThreadDetail } from "./types";

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

export function resolveContextWindowIndicatorState(thread: CodexThreadDetail | null): ContextWindowIndicatorState {
  if (!thread || thread.turns.length === 0) {
    return {
      status: "unavailable",
      percentFull: 0,
      usedTokens: null,
      windowTokens: null,
    };
  }

  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    const tokenUsage = turn?.tokenUsage;
    if (!tokenUsage) continue;

    const usedTokens = normalizeTokenCount(tokenUsage.last.totalTokens);
    const windowTokensRaw = tokenUsage.modelContextWindow;
    if (typeof windowTokensRaw === "number" && Number.isFinite(windowTokensRaw) && windowTokensRaw > 0) {
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

  return {
    status: "unavailable",
    percentFull: 0,
    usedTokens: null,
    windowTokens: null,
  };
}
