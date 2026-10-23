import type { TurnStatus } from "@nodex/codex-app-server-protocol/v2";

export type CodexContextCompactionStatus = "inProgress" | "completed" | "interrupted";
export type CodexContextCompactionSource = "automatic" | "manual";

/** A compaction still running after this long gains a reassurance that the wait is normal. */
export const CODEX_CONTEXT_COMPACTION_DELAY_NOTICE_MS = 10_000;

/**
 * A finished Turn settles every compaction it contains. Otherwise an unfinished
 * compaction keeps running with its Turn, and is interrupted once the Turn ends
 * any other way.
 */
export function resolveCodexContextCompactionStatus(input: {
  readonly completed: boolean | undefined;
  readonly turnStatus: TurnStatus;
}): CodexContextCompactionStatus {
  if (input.turnStatus === "completed" || input.completed !== false) return "completed";
  return input.turnStatus === "inProgress" ? "inProgress" : "interrupted";
}

export interface CodexContextCompactionLabelInput {
  readonly status: CodexContextCompactionStatus;
  readonly source: CodexContextCompactionSource;
  /** The `Steps` detail level (`STEPS_PROSE`) describes compaction as optimizing the conversation. */
  readonly proseSteps?: boolean;
  readonly showDelayNotice?: boolean;
}

export function formatCodexContextCompactionLabel({
  status,
  source,
  proseSteps = false,
  showDelayNotice = false,
}: CodexContextCompactionLabelInput): string {
  switch (status) {
    case "inProgress": {
      const label = proseSteps ? "Optimizing the conversation" : "Compacting context";
      return showDelayNotice ? `${label} · This can take a few minutes` : label;
    }
    case "interrupted":
      return proseSteps ? "Optimization interrupted" : "Compaction interrupted";
    case "completed":
      if (source === "manual") return "Context compacted";
      return proseSteps ? "Optimized the conversation" : "Context automatically compacted";
  }
}
