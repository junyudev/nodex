import type { ReasoningSummary } from "@nodex/codex-app-server-protocol";

/** The app-server feature that makes readable reasoning summaries available. */
export const CODEX_CONCURRENT_REASONING_SUMMARIES_FEATURE =
  "concurrent_reasoning_summaries" as const;

/** Readable reasoning summaries are enabled for locally launched Threads. */
export const CODEX_CONCURRENT_REASONING_SUMMARIES_ENABLED = true as const;

/** Enabling readable reasoning selects detailed summaries for ordinary Turns. */
export const CODEX_DEFAULT_REASONING_SUMMARY: ReasoningSummary = "detailed";

const REASONING_SUMMARIES = new Set<ReasoningSummary>(["auto", "concise", "detailed", "none"]);

export function parseCodexReasoningSummary(value: unknown): ReasoningSummary | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return REASONING_SUMMARIES.has(value as ReasoningSummary)
    ? (value as ReasoningSummary)
    : undefined;
}

/**
 * Resolves retained Turn parameters, next settings, the capability override,
 * then an explicit per-Turn value. A defined null remains a native value.
 */
export function resolveCodexReasoningSummary(
  input: {
    inheritedSummary?: ReasoningSummary | null;
    configuredSummary?: ReasoningSummary | null;
    explicitSummary?: ReasoningSummary | null;
    concurrentReasoningSummaries?: boolean;
  } = {},
): ReasoningSummary | null {
  let summary: ReasoningSummary | null = input.inheritedSummary ?? "none";
  if (input.configuredSummary !== undefined) summary = input.configuredSummary;
  if (input.concurrentReasoningSummaries ?? CODEX_CONCURRENT_REASONING_SUMMARIES_ENABLED) {
    summary = CODEX_DEFAULT_REASONING_SUMMARY;
  }
  if (input.explicitSummary !== undefined) {
    summary = input.explicitSummary;
  }
  return summary;
}
