import type { TurnStatus } from "@nodex/codex-app-server-protocol/v2";
import { defineMessages } from "./i18n/messages";

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

export const CONTEXT_COMPACTION_LABEL_MESSAGES = defineMessages({
  optimizing: {
    id: "shared.codexContextCompactionPresentation.optimizing",
    defaultMessage: "Optimizing the conversation",
  },
  optimizingWithDelay: {
    id: "shared.codexContextCompactionPresentation.optimizingWithDelay",
    defaultMessage: "Optimizing the conversation · This can take a few minutes",
  },
  compacting: {
    id: "shared.codexContextCompactionPresentation.compacting",
    defaultMessage: "Compacting context",
  },
  compactingWithDelay: {
    id: "shared.codexContextCompactionPresentation.compactingWithDelay",
    defaultMessage: "Compacting context · This can take a few minutes",
  },
  optimizationInterrupted: {
    id: "shared.codexContextCompactionPresentation.optimizationInterrupted",
    defaultMessage: "Optimization interrupted",
  },
  compactionInterrupted: {
    id: "shared.codexContextCompactionPresentation.compactionInterrupted",
    defaultMessage: "Compaction interrupted",
  },
  compacted: {
    id: "shared.codexContextCompactionPresentation.compacted",
    defaultMessage: "Context compacted",
  },
  optimized: {
    id: "shared.codexContextCompactionPresentation.optimized",
    defaultMessage: "Optimized the conversation",
  },
  automaticallyCompacted: {
    id: "shared.codexContextCompactionPresentation.automaticallyCompacted",
    defaultMessage: "Context automatically compacted",
  },
});

export function contextCompactionLabelMessage({
  status,
  source,
  proseSteps = false,
  showDelayNotice = false,
}: CodexContextCompactionLabelInput) {
  const messages = CONTEXT_COMPACTION_LABEL_MESSAGES;
  switch (status) {
    case "inProgress":
      if (proseSteps) return showDelayNotice ? messages.optimizingWithDelay : messages.optimizing;
      return showDelayNotice ? messages.compactingWithDelay : messages.compacting;
    case "interrupted":
      return proseSteps ? messages.optimizationInterrupted : messages.compactionInterrupted;
    case "completed":
      if (source === "manual") return messages.compacted;
      return proseSteps ? messages.optimized : messages.automaticallyCompacted;
  }
}

export function formatCodexContextCompactionLabel(input: CodexContextCompactionLabelInput): string {
  return contextCompactionLabelMessage(input).defaultMessage;
}
