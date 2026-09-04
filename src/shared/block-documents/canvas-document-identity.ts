import { isUuidV7 } from "../uuid-v7";

export const CANVAS_BLOCK_TYPE = "canvas";
export const CANVAS_DOCUMENT_SCHEMA_KEY = "nodex.canvas";
export const CANVAS_DOCUMENT_SCHEMA_VERSION = 2;

const MAX_CANVAS_IDENTITY_LENGTH = 512;
const PRIMARY_CANVAS_BLOCK_PREFIX = "canvas:primary:";
const PRIMARY_CANVAS_DOCUMENT_PREFIX = "document:canvas:primary:";

export const primaryCanvasBlockId = (projectId: string): string =>
  `${PRIMARY_CANVAS_BLOCK_PREFIX}${projectId}`;

export const primaryCanvasDocumentId = (projectId: string): string =>
  `${PRIMARY_CANVAS_DOCUMENT_PREFIX}${projectId}`;

const isCanonicalPrimaryIdentity = (value: string, prefix: string): boolean => {
  if (
    value.length <= prefix.length ||
    value.length > MAX_CANVAS_IDENTITY_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !value.startsWith(prefix)
  ) {
    return false;
  }
  const projectId = value.slice(prefix.length);
  return (
    projectId.length > 0 &&
    projectId === projectId.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(projectId)
  );
};

export const isPrimaryCanvasBlockId = (value: string): boolean =>
  isCanonicalPrimaryIdentity(value, PRIMARY_CANVAS_BLOCK_PREFIX);

export const isPrimaryCanvasDocumentId = (value: string): boolean =>
  isCanonicalPrimaryIdentity(value, PRIMARY_CANVAS_DOCUMENT_PREFIX);

export const assertExistingCanvasBlockId = (value: string, label = "canvasId"): string => {
  if (isUuidV7(value) || isPrimaryCanvasBlockId(value)) return value;
  throw new Error(
    `Invalid ${label}: expected canonical lowercase UUID-v7 or primary Canvas Block ID`,
  );
};

export const assertExistingCanvasDocumentId = (value: string, label = "documentId"): string => {
  if (isUuidV7(value) || isPrimaryCanvasDocumentId(value)) return value;
  throw new Error(
    `Invalid ${label}: expected canonical lowercase UUID-v7 or primary Canvas Document ID`,
  );
};
