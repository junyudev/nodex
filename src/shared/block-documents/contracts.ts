import type {
  ContentRoutingIdentity,
  LibraryContentRoutingContext,
  ProjectContentRoutingContext,
} from "../content-routing-context";

export type BlockId = string;
export type DocumentId = string;
export type DocumentReadiness = "pending_genesis" | "ready" | "failed";

/**
 * Lifecycle of a Document's owning Block. Content synchronization uses
 * `OwnedDocumentDescriptor.sync` independently of the owner's content kind.
 */
export type BlockLifecycle = "active" | "archived" | "deleted";

export interface OwnedDocumentIdentity extends ContentRoutingIdentity {
  readonly ownerBlockId: BlockId;
  readonly ownerType: string;
  readonly ownerLifecycle: BlockLifecycle;
  readonly documentId: DocumentId;
  readonly storeEpoch: string;
}

/** Engine-neutral durable coordinates shared by every owned Document. */
export interface OwnedDocumentHead {
  readonly generation: number;
  readonly headSeq: number;
  readonly schemaKey: string;
  readonly schemaVersion: number;
}

export interface YjsDocumentSyncEngine {
  readonly kind: "yjs";
  readonly stateVector: Uint8Array;
}

export interface CanvasSceneDocumentSyncEngine {
  readonly kind: "canvas_scene";
}

export type OwnedDocumentSyncEngine = YjsDocumentSyncEngine | CanvasSceneDocumentSyncEngine;

/**
 * Public ownership descriptor. Document identity and durable head semantics do
 * not depend on the content-specific synchronization engine.
 */
export interface OwnedDocumentDescriptor extends OwnedDocumentIdentity, OwnedDocumentHead {
  readonly readiness: DocumentReadiness;
  readonly sync: OwnedDocumentSyncEngine;
}

export interface ProjectAccessedDocumentDescriptor extends OwnedDocumentDescriptor {
  readonly routingContext: ProjectContentRoutingContext;
}

export interface LibraryAccessedDocumentDescriptor extends OwnedDocumentDescriptor {
  readonly routingContext: LibraryContentRoutingContext;
}

export const requireLibraryAccessedDocumentDescriptor = (
  descriptor: OwnedDocumentDescriptor,
): LibraryAccessedDocumentDescriptor => {
  if (descriptor.routingContext.kind === "library") {
    return { ...descriptor, routingContext: descriptor.routingContext };
  }
  throw new TypeError("Owned Document descriptor does not use Library routing context");
};

export const requireProjectAccessedDocumentDescriptor = (
  descriptor: OwnedDocumentDescriptor,
  projectId: string,
): ProjectAccessedDocumentDescriptor => {
  if (
    descriptor.routingContext.kind === "project" &&
    descriptor.routingContext.projectId === projectId
  ) {
    return { ...descriptor, routingContext: descriptor.routingContext };
  }
  throw new TypeError(
    "Owned Document descriptor does not match the requested Project routing context",
  );
};

export const MAX_PAGE_DOCUMENT_UPDATE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGE_DOCUMENT_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_PAGE_DOCUMENT_BODY_XML_LENGTH = 4_000_000;
export const MAX_PAGE_DOCUMENT_BLOCKS = 100_000;
export const MAX_PAGE_DOCUMENT_XML_PATH_DEPTH = 512;
export const MAX_DOCUMENT_TOUCHED_BLOCK_IDS = 10_000;
export const MAX_BLOCK_ID_LENGTH = 512;
export const MAX_REFERENCE_DISPLAY_HINT_LENGTH = 512;
export const MAX_RELOCATION_ROOT_BLOCKS = 10_000;
export const MAX_RELOCATION_ID_LENGTH = 512;

export type BlockLocation =
  | {
      readonly kind: "library";
      readonly libraryId: string;
      readonly rankKey: string;
    }
  | {
      readonly kind: "document";
      readonly documentId: DocumentId;
    }
  | {
      readonly kind: "data_source";
      readonly databaseBlockId: BlockId;
      readonly dataSourceId: string;
    };

export interface ApplyDocumentUpdate {
  readonly documentId: DocumentId;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly updateId: string;
  readonly clientSessionId: string;
  readonly baseHeadSeq: number;
  readonly touchedBlockIds: readonly BlockId[];
  readonly update: Uint8Array;
}

export interface DocumentCommitRef {
  readonly documentId: DocumentId;
  readonly generation: number;
  readonly baseHeadSeq: number;
  readonly headSeq: number;
  readonly updateId: string;
  /** Null only on an idempotent retry after the exact update payload was compacted. */
  readonly update: Uint8Array | null;
  readonly stateVector: Uint8Array;
}
