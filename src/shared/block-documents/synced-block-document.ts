import * as Y from "yjs";
import {
  assertValidBodyOnlyBlockDocumentRoots,
  createBodyOnlyBlockDocument,
  type BodyOnlyBlockDocumentEnvelope,
} from "./body-only-block-document";
import type { DocumentId } from "./contracts";

export const SYNCED_BLOCK_SOURCE_TYPE = "synced_block_source";
export const SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY = "nodex.synced-block";
export const SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION = 3;

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
