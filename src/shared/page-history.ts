export const DEFAULT_PAGE_HISTORY_PAGE_SIZE = 50;
export const MAX_PAGE_HISTORY_PAGE_SIZE = 100;

export type PageHistoryCursor =
  | {
      readonly occurredAt: string;
      readonly source: "document_version";
      readonly versionId: string;
    }
  | {
      readonly occurredAt: string;
      readonly source: "change_log";
      readonly changeSeq: number;
    };

export interface ListPageHistoryRequest {
  readonly pageId: string;
  readonly before?: PageHistoryCursor;
  readonly pageSize?: number;
}

export type PageHistoryCategory =
  | "checkpoint"
  | "content"
  | "property"
  | "database"
  | "lifecycle"
  | "location"
  | "unknown";

export interface PageHistoryDisplay {
  readonly category: PageHistoryCategory;
  readonly title: string;
  readonly detail: string | null;
  readonly actorLabel: string | null;
}

export type PageHistoryEvidence =
  | { readonly status: "verified" }
  | {
      readonly status: "unavailable";
      readonly reason: "missing_ledger" | "malformed_evidence" | "unsupported_evidence";
    };

export type PageHistoryRecovery =
  | {
      readonly kind: "restore_document_version";
      readonly documentId: string;
      readonly versionId: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "document_generation_changed"
        | "insufficient_evidence"
        | "no_inverse_contract";
    };

interface PageHistoryEntryBase {
  readonly id: string;
  readonly libraryId: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly occurredAt: string;
  readonly display: PageHistoryDisplay;
  readonly evidence: PageHistoryEvidence;
  readonly recovery: PageHistoryRecovery;
}

export interface PageDocumentVersionHistoryEntry extends PageHistoryEntryBase {
  readonly kind: "document_version";
  readonly versionMetadata: {
    readonly versionId: string;
    readonly generation: number;
    readonly baseHeadSeq: number;
    readonly schemaKey: string;
    readonly schemaVersion: number;
    readonly cause: string;
    readonly label: string | null;
    readonly revisionKind: "automatic" | "manual" | "operation" | "restore" | "safety";
    readonly sourceMutationId: string | null;
    readonly sourceChangeSeq: number | null;
    readonly pinned: boolean;
    readonly checkpointHash: string;
    readonly byteLength: number;
  };
}

export interface PageBlockMutationHistoryEntry extends PageHistoryEntryBase {
  readonly kind: "block_mutation";
  readonly changeSeq: number;
  readonly mutationId: string | null;
  readonly mutationKind: string | null;
  readonly affectedBlockCount: number | null;
  readonly fieldIntentCount: number | null;
}

export interface PageBlockRelocationHistoryEntry extends PageHistoryEntryBase {
  readonly kind: "block_relocation";
  readonly changeSeq: number;
  readonly relocationId: string | null;
  readonly direction: "into_page" | "out_of_page" | "within_page" | "unknown";
  readonly movedBlockCount: number | null;
}

export type PageHistoryEntry =
  | PageDocumentVersionHistoryEntry
  | PageBlockMutationHistoryEntry
  | PageBlockRelocationHistoryEntry;

export interface PageHistoryPage {
  readonly libraryId: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly entries: readonly PageHistoryEntry[];
  readonly nextCursor: PageHistoryCursor | null;
}
