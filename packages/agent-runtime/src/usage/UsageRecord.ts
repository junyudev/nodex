export type UsageProvider = "claude" | "codex";
export type UsageSpeed = "standard" | "fast" | "ultrafast";

/** Reasoning is already part of output, so token totals never add it again. */
export interface UsageTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function processedTokens(totals: UsageTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/** One billed model request found in a transcript. */
export interface UsageRequestRecord {
  readonly kind: "request";
  readonly timestampMs: number;
  readonly model: string;
  readonly totals: UsageTotals;
  readonly speed: UsageSpeed;
  /** Claude copies records into resumed and forked transcripts, so they dedupe across files. */
  readonly dedupeKey: string | null;
}

/** One message the person sent, counted separately from the requests it caused. */
export interface UsageMessageRecord {
  readonly kind: "message";
  readonly timestampMs: number;
  readonly dedupeKey: string | null;
}

export type TranscriptRecord = UsageRequestRecord | UsageMessageRecord;

export interface TranscriptFormat<State> {
  /** ASCII markers that every relevant line contains, including lines that only update state. */
  readonly lineMarkers: readonly [string, ...string[]];
  readonly initialState: () => State;
  /** Rejects saved state from an older parser, which then costs one full re-read of the file. */
  readonly isState: (value: unknown) => value is State;
  readonly parseLine: (line: string, state: State) => readonly TranscriptRecord[];
  /** What a finished read knows about the conversation behind the file. */
  readonly describeSession: (input: { readonly path: string; readonly state: State }) => {
    readonly sessionId: string;
    readonly subagent: boolean;
  };
}

export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
