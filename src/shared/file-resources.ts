export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
export const FILE_IMPORT_MAX_COUNT = 100;

export interface PickFilesInput {
  readonly operationId: string;
  readonly title?: string;
  readonly selection?: "files" | "directory";
}

export interface PrepareDroppedFilesInput {
  readonly operationId: string;
  readonly localPaths: readonly string[];
}

export interface PrepareFileBlobInput {
  readonly operationId: string;
  readonly idempotencySlot?: string;
  readonly source:
    | {
        readonly kind: "bytes";
        readonly logicalPath: string;
        readonly mimeType?: string;
        readonly bytes: Uint8Array;
      }
    | {
        readonly kind: "local_path";
        readonly path: string;
      };
}

export interface PreparedFileBlob {
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly receiptId: string;
  readonly blobEtag: string;
  readonly byteLength: number;
  readonly expiresAtUnixMs: number;
}

export interface PickFilesResult {
  readonly cancelled: boolean;
  readonly files: readonly PreparedFileBlob[];
}

export interface PrepareDroppedFilesResult {
  readonly files: readonly PreparedFileBlob[];
}

export const FILE_SOURCE_PREFIX = "nodex://files/";

const isValidFileId = (fileId: string): boolean =>
  Boolean(fileId) &&
  fileId === fileId.trim() &&
  !fileId.includes("/") &&
  !fileId.includes("%") &&
  !/[\u0000-\u001f\u007f]/u.test(fileId);

export const fileSource = (fileId: string): string => {
  if (!isValidFileId(fileId)) {
    throw new Error("File IDs must be non-empty URI path segments");
  }
  return `${FILE_SOURCE_PREFIX}${fileId}`;
};

export const parseFileSource = (source: string): string | null => {
  if (!source.startsWith(FILE_SOURCE_PREFIX)) return null;
  const fileId = source.slice(FILE_SOURCE_PREFIX.length);
  if (!isValidFileId(fileId)) return null;
  return fileId;
};

export interface FileBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly etag: string;
}

export interface SaveFileResult {
  readonly status: "cancelled" | "saved";
}
