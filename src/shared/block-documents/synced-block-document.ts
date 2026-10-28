import * as Y from "yjs";
import {
  assertValidBodyOnlyBlockDocumentRoots,
  BODY_ONLY_DOCUMENT_ROOT_KEY,
  createBodyOnlyBlockDocument,
  openBodyOnlyBlockDocument,
  type BodyOnlyBlockDocumentEnvelope,
} from "./body-only-block-document";
import type { DocumentId } from "./contracts";

export const SYNCED_BLOCK_SOURCE_TYPE = "synced_block_source";
export const SYNCED_BLOCK_REFERENCE_TYPE = "syncedBlockRef";
export const SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY = "nodex.synced-block";
export const SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION = 3;
export const SYNCED_BLOCK_DOCUMENT_BODY_KEY = BODY_ONLY_DOCUMENT_ROOT_KEY;

export type SyncedBlockDocumentEnvelope = BodyOnlyBlockDocumentEnvelope;

export interface CreateSyncedBlockDocumentOptions {
  readonly documentId: DocumentId;
  readonly initializeBody?: boolean;
  readonly gc?: boolean;
}

export class SyncedBlockDocumentRootValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SyncedBlockDocumentRootValidationError";
  }
}

const SYNCED_BLOCK_BODY_SCHEMA = {
  label: "Synced Block",
  makeRootError: (message: string) => new SyncedBlockDocumentRootValidationError(message),
} as const;

export const openSyncedBlockDocument = (document: Y.Doc): SyncedBlockDocumentEnvelope =>
  openBodyOnlyBlockDocument(document, SYNCED_BLOCK_BODY_SCHEMA);

export const assertValidSyncedBlockDocumentRoots = (document: Y.Doc): SyncedBlockDocumentEnvelope =>
  assertValidBodyOnlyBlockDocumentRoots(document, SYNCED_BLOCK_BODY_SCHEMA);

export const createSyncedBlockDocument = ({
  documentId,
  initializeBody = true,
  gc = true,
}: CreateSyncedBlockDocumentOptions): SyncedBlockDocumentEnvelope => {
  return createBodyOnlyBlockDocument({
    documentId,
    initializeBody,
    gc,
    ...SYNCED_BLOCK_BODY_SCHEMA,
  });
};
