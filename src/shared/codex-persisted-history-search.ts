import type { ThreadSearchOccurrence } from "@nodex/codex-app-server-protocol/v2";
import type { CodexThreadHistoryFeatureUnavailable } from "./codex-thread-history-features";

export interface CodexPersistedHistorySearchPage {
  readonly threadId: string;
  readonly query: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly topologyGeneration: number;
  readonly occurrences: readonly ThreadSearchOccurrence[];
  readonly capped: boolean;
}

export type CodexPersistedHistorySearchResult =
  | {
      readonly status: "completed";
      readonly page: CodexPersistedHistorySearchPage;
    }
  | {
      readonly status: "unavailable";
      readonly feature: "persisted-search";
      readonly reason: "resident-only";
      readonly threadId: string;
    }
  | CodexThreadHistoryFeatureUnavailable;

export interface CodexPersistedHistoryOccurrenceHydrateInput {
  readonly threadId: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly topologyGeneration: number;
  readonly occurrence: ThreadSearchOccurrence;
}

export interface CodexPersistedHistoryOccurrenceResolution {
  readonly status: "found";
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly topologyGeneration: number;
}
