import type { Thread } from "@nodex/codex-app-server-protocol/v2";

export type CodexThreadHistoryFeature = "prompt-rail" | "persisted-search";

export type CodexThreadHistoryUnavailableReason =
  | "thread-history-legacy"
  | "host-unsupported"
  | "capability-unproven";

/** Stable renderer-safe explanation for an optional persisted-history feature being unavailable. */
export interface CodexThreadHistoryFeatureUnavailable {
  readonly status: "unavailable";
  readonly feature: CodexThreadHistoryFeature;
  readonly reason: CodexThreadHistoryUnavailableReason;
  readonly threadId: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly sourceEpoch: string | null;
  readonly appServerVersion: string | null;
  readonly historyMode: Thread["historyMode"];
}
