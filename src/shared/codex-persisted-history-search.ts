import type { ThreadSearchOccurrence } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationHistoryMutation } from "./codex-conversation-history-page";
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
  | CodexThreadHistoryFeatureUnavailable;

export interface CodexPersistedHistoryOccurrenceHydrateInput {
  readonly threadId: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly topologyGeneration: number;
  readonly occurrence: ThreadSearchOccurrence;
}

/** Main-facing operation identity used to discard a superseded asynchronous hydration. */
export interface CodexPersistedHistoryOccurrenceHydrateRequest extends CodexPersistedHistoryOccurrenceHydrateInput {
  readonly requestId: string;
}

export type CodexPersistedHistoryOccurrenceResolution =
  | {
      readonly status: "found";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly topologyGeneration: number;
    }
  | {
      readonly status: "bounded-incomplete";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly topologyGeneration: number;
      readonly reason: "item-count-limit" | "item-byte-limit" | "next-item-page-required";
    };

export type CodexPersistedHistoryOccurrenceHydrateResult =
  CodexPersistedHistoryOccurrenceResolution & {
    /** Null only when the selected occurrence was already resident and no history changed. */
    readonly mutation: CodexConversationHistoryMutation | null;
  };

export interface CodexThreadOwnerHistoryMutationResult {
  readonly revision: number;
}

export interface CodexThreadOwnerPersistedHistoryHydrationResult extends CodexThreadOwnerHistoryMutationResult {
  readonly hydration: CodexPersistedHistoryOccurrenceResolution;
}
