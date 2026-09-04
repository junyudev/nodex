import type { ContentAccessContext } from "../../shared/content-access-context";
import type {
  LibraryFile,
  LibraryFilePresentation,
  LibraryFileReadBinding,
  LibraryFileReadSource,
  LibraryPageFileInventory,
} from "../../shared/library-files";
import {
  FILE_IMPORT_MAX_BYTES,
  FILE_IMPORT_MAX_COUNT,
  FILE_MAX_BYTES,
  fileSource,
  parseFileSource,
  type FileBytes,
  type PreparedFileBlob,
} from "../../shared/file-resources";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  applyLibraryModule,
  prepareFileBlob,
  readLibraryModule,
  readFileBytes,
  saveFile,
  materializeFile,
} from "./api";

export interface LibraryFileAuthority {
  readonly contentAccessContext: ContentAccessContext;
  readonly storeEpoch: string;
  readonly libraryId: string;
}

/** The complete read capability; history and recovery never fall back to current Page access. */
export interface FileReadAuthority extends LibraryFileAuthority {
  readonly readSource: LibraryFileReadSource;
  readonly version?: number;
}

/** Every managed source in a captured or merged preview must have an explicit binding. */
export interface FilePreviewAuthority extends LibraryFileAuthority {
  readonly bindings: Readonly<Record<string, LibraryFileReadBinding>>;
}

export type FileUploadSource =
  | { readonly kind: "browser_file"; readonly file: File }
  | { readonly kind: "local_path"; readonly path: string };

export interface CreatedLibraryFile {
  readonly file: LibraryFile;
  readonly source: string;
}

export function validateBrowserFileBatch(files: readonly File[]): void {
  if (files.length > FILE_IMPORT_MAX_COUNT) {
    throw new Error("File selection exceeds the 100 File batch limit");
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > FILE_MAX_BYTES) {
      throw new Error(`${file.name} exceeds the 64 MiB File limit`);
    }
    totalBytes += file.size;
  }
  if (totalBytes > FILE_IMPORT_MAX_BYTES) {
    throw new Error("File selection exceeds the 256 MiB batch limit");
  }
}

/** Publish sequentially to bound renderer memory; each selected file gets its own receipt slot. */
export async function prepareBrowserFiles(
  access: ContentAccessContext,
  operationId: string,
  files: readonly File[],
): Promise<readonly PreparedFileBlob[]> {
  validateBrowserFileBatch(files);
  const prepared: PreparedFileBlob[] = [];
  for (const [index, file] of files.entries()) {
    prepared.push(
      await prepareFileBlob(access, {
        operationId,
        idempotencySlot: `selection:${index}`,
        source: {
          kind: "bytes",
          logicalPath: file.name,
          ...(file.type ? { mimeType: file.type } : {}),
          bytes: new Uint8Array(await file.arrayBuffer()),
        },
      }),
    );
  }
  return prepared;
}

export async function readPageFileInventoryPage(
  access: ContentAccessContext,
  pageId: string,
  input: { readonly cursor?: string; readonly query?: string; readonly limit?: number } = {},
): Promise<LibraryPageFileInventory> {
  const result = await readLibraryModule(access, {
    read: {
      mode: "page_file_inventory",
      page_id: pageId,
      limit: input.limit ?? 100,
      ...(input.query ? { query: input.query } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  });
  if (!result.ok) throw new Error(result.error.message || "Couldn’t read Page Files");
  if (result.value.value.kind !== "page_file_inventory")
    throw new Error("Unexpected Page Files response");
  return result.value.value.value;
}

/** Body upload creates a Library File. It does not claim or mutate a Page path. */
export async function importLibraryFile(
  authority: LibraryFileAuthority,
  source: FileUploadSource,
  defaultName?: string,
): Promise<CreatedLibraryFile> {
  const operationId = createUuidV7();
  const prepared =
    source.kind === "browser_file"
      ? (await prepareBrowserFiles(authority.contentAccessContext, operationId, [source.file]))[0]!
      : await prepareFileBlob(authority.contentAccessContext, {
          operationId,
          source: { kind: "local_path", path: source.path },
        });
  const fileId = createUuidV7();
  const result = await applyLibraryModule(authority.contentAccessContext, {
    operationId,
    storeEpoch: authority.storeEpoch,
    operation: {
      kind: "apply_file_change",
      change: {
        kind: "create",
        file_id: fileId,
        default_name: defaultName?.trim() || prepared.logicalPath.split("/").at(-1)!,
        mime_type: prepared.mimeType,
        prepared_blob_receipt_id: prepared.receiptId,
      },
    },
  });
  if (!result.ok) throw new Error(result.error.message || "Couldn’t import File");
  const file = result.value.fileMutation?.file;
  if (!file || file.file_id !== fileId) throw new Error("File import omitted its committed result");
  return { file, source: fileSource(fileId) };
}

const fileIdFromSource = (source: string): string => {
  const fileId = parseFileSource(source);
  if (!fileId) throw new Error("File reference is invalid");
  return fileId;
};

export function readAuthorizedFile(
  authority: FileReadAuthority,
  source: string,
): Promise<FileBytes> {
  return readFileBytes(authority.contentAccessContext, {
    fileId: fileIdFromSource(source),
    source: authority.readSource,
    ...(authority.version !== undefined ? { version: authority.version } : {}),
  });
}

export async function readFilePresentation(
  authority: FileReadAuthority,
  source: string,
): Promise<LibraryFilePresentation> {
  const result = await readLibraryModule(authority.contentAccessContext, {
    read: {
      mode: "file_presentation",
      file_id: fileIdFromSource(source),
      source: authority.readSource,
      ...(authority.version !== undefined ? { version: authority.version } : {}),
    },
  });
  if (!result.ok) throw new Error(result.error.message || "Couldn’t read File");
  if (result.value.value.kind !== "file_presentation")
    throw new Error("Unexpected File presentation response");
  return result.value.value.value;
}

export async function saveAuthorizedFile(
  authority: FileReadAuthority,
  source: string,
  defaultName: string,
): Promise<void> {
  await saveFile(authority.contentAccessContext, {
    fileId: fileIdFromSource(source),
    source: authority.readSource,
    defaultName,
    ...(authority.version !== undefined ? { version: authority.version } : {}),
  });
}

/** Export an authorized exact version to a rebuildable local cache for clipboard paths. */
export async function materializeAuthorizedFile(
  authority: FileReadAuthority,
  source: string,
): Promise<string> {
  const presentation = await readFilePresentation(authority, source);
  return materializeFile(authority.contentAccessContext, {
    fileId: presentation.file_id,
    source: authority.readSource,
    version: presentation.version,
    defaultName: presentation.default_name,
  });
}
