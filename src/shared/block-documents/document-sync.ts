import type { ApplyDocumentUpdate, DocumentId } from "./contracts";
import type { LocalCommitApply, LocalCommitCommandSuccess } from "../local-commit-delivery";
import type { CoreFailureEvidence } from "../core-failure-evidence";
import type { DocumentHistoryFence } from "./document-history-fence";

export const MAX_DOCUMENT_AWARENESS_UPDATE_BYTES = 64 * 1024;

/**
 * Errors are values on the wire. Transport implementations must not require
 * callers to parse exception messages to decide whether a request can retry or
 * whether a cached Y.Doc has crossed an identity boundary.
 */
export type DocumentSyncErrorCode =
  | "transport_unavailable"
  | "request_cancelled"
  | "request_timeout"
  | "service_busy"
  | "unauthorized"
  | "store_not_initialized"
  | "store_epoch_mismatch"
  | "document_not_found"
  | "document_not_ready"
  | "document_generation_mismatch"
  | "unsupported_document_schema"
  | "future_base_head"
  | "invalid_document_update"
  | "invalid_awareness_update"
  | "document_update_missing_dependencies"
  | "protected_owner_mutation"
  | "update_id_collision"
  | "block_relocated"
  | "recovery_required"
  | "document_state_corrupt"
  | "invalid_response"
  | "unknown";

export interface DocumentSyncCommandError {
  readonly core?: CoreFailureEvidence;
  readonly code: DocumentSyncErrorCode;
  readonly message: string;
  /** The exact same durable command may be attempted again. */
  readonly retryable: boolean;
  /**
   * The surface must discard this Y.Doc and create a fresh one before syncing.
   * This is required after restore/store replacement or document regeneration.
   */
  readonly resetRequired: boolean;
  /** The committed relocation that made this stale update unsafe. */
  readonly relocationId?: string;
  /** Durable copy of an update that requires explicit recovery/merge. */
  readonly recoveryArtifactId?: string;
}

export type DocumentSyncCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DocumentSyncCommandError };

export interface DocumentSyncRequest {
  readonly documentId: DocumentId;
  readonly clientSessionId: string;
  readonly stateVector: Uint8Array;
  readonly historyAfterHeadSeq?: number;
}

export interface DocumentSyncResponse {
  readonly documentId: DocumentId;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly stateVector: Uint8Array;
  /** The server state missing from the supplied state vector. */
  readonly update: Uint8Array;
  readonly historyFence?: DocumentHistoryFence;
}

export interface DocumentUpdateResourceRef {
  readonly documentId: DocumentId;
  readonly generation: number;
  readonly updateId: string;
  readonly updateHash: string;
}

export type DocumentUpdateResourceUnavailableReason =
  | "compacted"
  | "generation_changed"
  | "hash_mismatch"
  | "missing";

export type DocumentUpdateResourceReadResult =
  | {
      readonly kind: "available";
      readonly documentId: DocumentId;
      readonly generation: number;
      readonly baseHeadSeq: number;
      readonly headSeq: number;
      readonly updateId: string;
      readonly updateHash: string;
      readonly updateByteLength: number;
      readonly update: Uint8Array;
    }
  | {
      readonly kind: "resync-required";
      readonly documentId: DocumentId;
      readonly requestedGeneration: number;
      readonly currentGeneration: number;
      readonly currentHeadSeq: number;
      readonly updateId: string;
      readonly updateHash: string;
      readonly reason: DocumentUpdateResourceUnavailableReason;
    };

export type DocumentSyncApplyRequest = ApplyDocumentUpdate;

interface DocumentSyncApplyAckBase {
  readonly documentId: DocumentId;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly updateId: string;
  /**
   * Sequence that causally satisfies this update. A redundant CRDT replay may
   * use the unchanged current head; an advancing commit uses its assigned seq.
   */
  readonly committedSeq: number;
  /** Latest durable sequence observed by the writer while producing the ACK. */
  readonly headSeq: number;
  readonly stateVector: Uint8Array;
  readonly duplicate: boolean;
}

/**
 * Closed acknowledgement of a Yjs command. Document head causality is common
 * to both cases, while only a semantic commit may carry a manifest identity
 * and post-state-authorized delivery.
 */
export type DocumentSyncApplyAck = DocumentSyncApplyAckBase &
  (
    | {
        readonly status: "committed";
        readonly commit: import("@nodex/core-protocol").components["schemas"]["CommitIdentity"];
        readonly delivery?: import("@nodex/core-protocol").components["schemas"]["AuthorizedDeliveryPacket"];
      }
    | {
        readonly status: "no_op";
        readonly observed: import("@nodex/core-protocol").components["schemas"]["StoreObservation"];
      }
  );

/** Final renderer-facing envelope for a durable Yjs update command. */
export type DocumentSyncApplyCommandResult =
  | LocalCommitCommandSuccess<DocumentSyncApplyAck>
  | { readonly ok: false; readonly error: DocumentSyncCommandError };

/** Projects the Document head ACK onto the common LocalCommit admission contract. */
export const localCommitFromDocumentSyncApplyAck = (
  acknowledgement: DocumentSyncApplyAck,
): LocalCommitApply =>
  acknowledgement.status === "committed"
    ? {
        status: "committed",
        commit: acknowledgement.commit,
        delivery: acknowledgement.delivery ?? null,
      }
    : {
        status: "no_op",
        observed: acknowledgement.observed,
      };

export const documentSyncApplyCommandResult = (
  result: DocumentSyncCommandResult<DocumentSyncApplyAck>,
): DocumentSyncApplyCommandResult =>
  result.ok
    ? {
        ok: true,
        value: result.value,
        localCommit: localCommitFromDocumentSyncApplyAck(result.value),
      }
    : result;

export interface DocumentSyncSubscribeRequest {
  readonly documentId: DocumentId;
  readonly clientSessionId: string;
}

/**
 * Transport boundary for a Project-bound editor session. The Project is an
 * authorization context; it is deliberately not part of the durable CRDT
 * identity handled by the Document runtime.
 */
export interface ProjectScopedDocumentSyncSubscribeRequest extends DocumentSyncSubscribeRequest {
  readonly projectId: string;
}

export interface ProjectScopedDocumentSyncRequest extends DocumentSyncRequest {
  readonly projectId: string;
}

export interface ProjectScopedDocumentSyncApplyRequest extends DocumentSyncApplyRequest {
  readonly projectId: string;
}

export interface ProjectScopedDocumentAwarenessPublishRequest extends DocumentAwarenessPublishRequest {
  readonly projectId: string;
}

export type DocumentAccessKind = "read" | "write";

export interface DocumentAccessRequest {
  readonly projectId: string;
  readonly documentId: DocumentId;
  readonly access: DocumentAccessKind;
}

export interface DocumentAccessAck {
  readonly projectId: string;
  readonly documentId: DocumentId;
  readonly access: DocumentAccessKind;
  readonly authorized: true;
}

/** Trusted local-user Library authorization without a caller-selected ID. */
export interface LibraryDocumentAccessRequest {
  readonly documentId: DocumentId;
  readonly access: DocumentAccessKind;
}

export interface LibraryDocumentAccessAck extends LibraryDocumentAccessRequest {
  readonly authorized: true;
}

export interface DocumentSyncSubscriptionAck {
  readonly subscribed: true;
}

export interface DocumentSyncUnsubscribeAck {
  readonly unsubscribed: true;
}

export interface DocumentAwarenessPublishRequest {
  readonly documentId: DocumentId;
  readonly clientSessionId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly update: Uint8Array;
}

export interface DocumentAwarenessPublishAck {
  readonly accepted: true;
}

export type DocumentSyncRealtimeEvent =
  | {
      readonly kind: "terminated";
      readonly documentId: DocumentId;
      readonly clientSessionId: string;
      readonly error: DocumentSyncCommandError;
    }
  | {
      readonly kind: "connection";
      readonly documentId: DocumentId;
      readonly clientSessionId: string;
      readonly state: "connected" | "disconnected";
    }
  | {
      /** The entire SQLite authority was replaced; no old client state may replay. */
      readonly kind: "store-reset";
      readonly documentId: DocumentId;
      readonly storeEpoch: string;
    }
  | {
      readonly kind: "document-update";
      readonly documentId: DocumentId;
      readonly storeEpoch: string;
      readonly generation: number;
      readonly headSeq: number;
      readonly commitSeq?: number;
      readonly effectSequence?: number;
      readonly updateId: string;
      readonly clientSessionId: string;
      readonly update: Uint8Array;
      readonly historyFence?: DocumentHistoryFence;
    }
  | {
      readonly kind: "awareness";
      readonly documentId: DocumentId;
      readonly storeEpoch: string;
      readonly generation: number;
      readonly clientSessionId: string;
      readonly update: Uint8Array;
    }
  | {
      readonly kind: "resync-required";
      readonly documentId: DocumentId;
      readonly storeEpoch: string;
      readonly generation: number;
      readonly headSeq: number;
      readonly commitSeq?: number;
      readonly effectSequence?: number;
      readonly reason:
        | "event-gap"
        | "history-compacted"
        | "transport-reconnected"
        | "resource-integrity-failure"
        | "identity-boundary-changed"
        | "access-revoked";
    };

/**
 * Transport boundary consumed by renderer-side collaborative document
 * providers. Implementations may use IPC, UDS, or an in-memory test harness,
 * but all durable and ephemeral behavior must preserve this one contract.
 */
export interface DocumentSyncAdapter {
  sync: (request: DocumentSyncRequest) => Promise<DocumentSyncCommandResult<DocumentSyncResponse>>;
  applyUpdate: (
    request: DocumentSyncApplyRequest,
  ) => Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>>;
  subscribe: (
    request: DocumentSyncSubscribeRequest,
    listener: (event: DocumentSyncRealtimeEvent) => void,
  ) => () => void;
  publishAwareness: (
    request: DocumentAwarenessPublishRequest,
  ) => Promise<DocumentSyncCommandResult<DocumentAwarenessPublishAck>>;
}
