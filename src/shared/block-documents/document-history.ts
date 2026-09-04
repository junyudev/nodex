import type { BlockTreeNode, BlockTreeValue } from "./block-document-codec";
import type { RegisteredOwnedDocumentMaterialization } from "./document-schema-adapters";
import type { CanvasSceneForwardRestorePlan } from "./canvas-scene";
import type { BlockId, DocumentId } from "./contracts";
import type { DocumentBlockOperation } from "./document-operations";
import type { PortableRichText } from "./portable-rich-text";

export const MAX_DOCUMENT_VERSION_CAUSE_LENGTH = 128;
export const MAX_DOCUMENT_VERSION_LABEL_LENGTH = 512;
export const MAX_DOCUMENT_VERSION_HISTORY_LIMIT = 200;

export type DocumentVersionActor = Readonly<Record<string, BlockTreeValue>>;

export type DocumentRevisionKind = "automatic" | "manual" | "operation" | "restore" | "safety";

export interface CreateDocumentVersionCheckpoint {
  /** Allocated once by the caller and retained unchanged throughout exact retries. */
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly documentId: DocumentId;
  readonly expectedGeneration: number;
  readonly expectedHeadSeq: number;
  readonly cause: string;
  readonly label?: string;
  readonly actor: DocumentVersionActor;
  readonly revisionKind?: DocumentRevisionKind;
  readonly sourceMutationId?: string;
  readonly sourceChangeSeq?: number;
}

interface DocumentVersionSummaryBase {
  readonly versionId: string;
  readonly documentId: DocumentId;
  readonly projectId: string;
  readonly generation: number;
  readonly baseHeadSeq: number;
  readonly schemaKey: string;
  readonly schemaVersion: number;
  readonly cause: string;
  readonly label: string | null;
  readonly actor: DocumentVersionActor;
  readonly revisionKind: DocumentRevisionKind;
  readonly sourceMutationId: string | null;
  readonly sourceChangeSeq: number | null;
  readonly pinned: boolean;
  readonly checkpointHash: string;
  readonly materializationHash: string;
  readonly byteLength: number;
  readonly materializationKind: RegisteredOwnedDocumentMaterialization["kind"];
  readonly title: string | null;
  readonly preview: string;
  readonly blockCount: number;
  readonly createdAt: string;
}

export type DocumentVersionCheckpointMetadata =
  | {
      readonly format: "yjs_update_v1";
      readonly stateVectorHash: string;
    }
  | {
      readonly format: "block_tree_snapshot_v2";
    }
  | {
      readonly format: "canvas_scene_json_v1";
    };

export type DocumentVersionSummary = DocumentVersionSummaryBase & {
  readonly checkpointMetadata: DocumentVersionCheckpointMetadata;
};

export type DocumentVersionCheckpoint =
  | (DocumentVersionSummaryBase & {
      readonly checkpointMetadata: Extract<
        DocumentVersionCheckpointMetadata,
        { readonly format: "yjs_update_v1" }
      >;
      readonly fullUpdate: Uint8Array;
      readonly stateVector: Uint8Array;
      readonly materialization: RegisteredOwnedDocumentMaterialization;
    })
  | (DocumentVersionSummaryBase & {
      readonly checkpointMetadata: Extract<
        DocumentVersionCheckpointMetadata,
        { readonly format: "block_tree_snapshot_v2" }
      >;
      readonly snapshotJson: Uint8Array;
      readonly materialization: Exclude<
        RegisteredOwnedDocumentMaterialization,
        { readonly kind: "canvas_scene" }
      >;
    })
  | (DocumentVersionSummaryBase & {
      readonly checkpointMetadata: Extract<
        DocumentVersionCheckpointMetadata,
        { readonly format: "canvas_scene_json_v1" }
      >;
      readonly sceneJson: Uint8Array;
      readonly materialization: Extract<
        RegisteredOwnedDocumentMaterialization,
        { readonly kind: "canvas_scene" }
      >;
    });

export interface CreatedDocumentVersionCheckpoint {
  readonly checkpoint: DocumentVersionCheckpoint;
  readonly duplicate: boolean;
}

export interface CreatedDocumentVersionSummary {
  readonly checkpoint: DocumentVersionSummary;
  readonly duplicate: boolean;
}

export interface DocumentVersionDetail {
  readonly summary: DocumentVersionSummary;
  readonly materialization: RegisteredOwnedDocumentMaterialization;
}

export interface DocumentVersionCursor {
  readonly baseHeadSeq: number;
  readonly createdAt: string;
  readonly versionId: string;
}

export interface ListDocumentVersions {
  readonly projectId: string;
  readonly documentId: DocumentId;
  readonly before?: DocumentVersionCursor;
  readonly limit?: number;
}

export interface GetDocumentVersion {
  readonly projectId: string;
  readonly documentId: DocumentId;
  readonly versionId: string;
}

export interface PrepareDocumentVersionRestore {
  readonly mutationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly documentId: DocumentId;
  readonly versionId: string;
  readonly generation: number;
  readonly expectedHeadSeq: number;
  readonly clientSessionId?: string;
  readonly actor: DocumentVersionActor;
}

interface DocumentVersionRestorePlanBase {
  readonly kind: "document_version_restore";
  readonly mutationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly documentId: DocumentId;
  readonly generation: number;
  readonly expectedHeadSeq: number;
  readonly clientSessionId?: string;
  readonly actor: DocumentVersionActor;
  readonly sourceVersion: DocumentVersionSummary;
  readonly requiresWriteFence: true;
}

export interface BlockTreeDocumentVersionRestorePlan extends DocumentVersionRestorePlanBase {
  readonly contentModel: "block_tree";
  readonly targetTitle?: string;
  readonly targetRichTitle?: PortableRichText;
  readonly targetBlockTree: readonly BlockTreeNode[];
  readonly operations: readonly DocumentBlockOperation[];
}

export interface CanvasDocumentVersionRestorePlan extends DocumentVersionRestorePlanBase {
  readonly contentModel: "scene_graph";
  readonly forwardRestore: CanvasSceneForwardRestorePlan;
}

export type DocumentVersionRestorePlan =
  | BlockTreeDocumentVersionRestorePlan
  | CanvasDocumentVersionRestorePlan;

export type PreparedDocumentVersionRestore =
  | {
      readonly kind: "already_current";
      readonly sourceVersion: DocumentVersionSummary;
    }
  | {
      readonly kind: "operation_plan";
      readonly plan: DocumentVersionRestorePlan;
    };

export interface ListBlockChangeHistory {
  readonly projectId: string;
  readonly blockId?: BlockId;
  readonly documentId?: DocumentId;
  readonly beforeChangeSeq?: number;
  readonly limit?: number;
}

export interface BlockChangeHistoryEntry {
  readonly changeSeq: number;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly kind: "block_mutation" | "block_relocation";
  readonly operationId: string | null;
  readonly mutationKind: string | null;
  readonly clientSessionId: string | null;
  readonly actor: DocumentVersionActor;
  readonly blockIds: readonly BlockId[];
  readonly documentIds: readonly DocumentId[];
  readonly databaseBlockIds: readonly BlockId[];
  readonly fieldIntents: readonly BlockTreeValue[];
  readonly payload: Readonly<Record<string, BlockTreeValue>>;
  readonly committedAt: string;
}
