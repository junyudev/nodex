import type { ContentAccessContext } from "../../shared/content-access-context";
import type { LibraryPageFileManifest, LibraryPageFileSummary } from "../../shared/library-module";
import {
  PAGE_FILE_IMPORT_MAX_BYTES,
  PAGE_FILE_IMPORT_MAX_COUNT,
  PAGE_FILE_MAX_BYTES,
  pageFileSource,
  parsePageFileSource,
  type PageFileBytes,
  type PreparedPickedPageFile,
} from "../../shared/page-files";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  applyLibraryModule,
  preparePageFile,
  readLibraryModule,
  readPageFileBytes,
  savePageFile,
} from "./api";

export interface PageFileAuthority {
  readonly contentAccessContext: ContentAccessContext;
  readonly pageId: string;
  readonly storeEpoch: string;
}

export type PageFileUploadSource =
  | { readonly kind: "browser_file"; readonly file: File }
  | { readonly kind: "local_path"; readonly path: string };

export interface CreatedPageFile {
  readonly fileId: string;
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly source: string;
}

/** Validate a browser-delivered selection before publishing any immutable blobs. */
export function validateBrowserPageFileBatch(files: readonly File[]): void {
  if (files.length > PAGE_FILE_IMPORT_MAX_COUNT) {
    throw new Error("File selection exceeds the 100 File batch limit");
  }

  let totalBytes = 0;
  for (const file of files) {
    if (file.size > PAGE_FILE_MAX_BYTES) {
      throw new Error(`${file.name} exceeds the 64 MiB File limit`);
    }
    totalBytes += file.size;
  }

  if (totalBytes > PAGE_FILE_IMPORT_MAX_BYTES) {
    throw new Error("File selection exceeds the 256 MiB batch limit");
  }
}

/** Prepare browser File objects sequentially so a large batch has bounded renderer memory use. */
export async function prepareBrowserPageFiles(
  contentAccessContext: ContentAccessContext,
  operationId: string,
  files: readonly File[],
): Promise<readonly PreparedPickedPageFile[]> {
  validateBrowserPageFileBatch(files);
  const prepared: PreparedPickedPageFile[] = [];
  for (const file of files) {
    prepared.push(
      await preparePageFile(contentAccessContext, {
        operationId,
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

const pageFilesFromRead = (value: Awaited<ReturnType<typeof readLibraryModule>>) => {
  if (!value.ok) throw new Error(value.error.message || "Couldn’t read Page Files");
  if (value.value.value.kind !== "page_files") {
    throw new Error("Unexpected Page Files response");
  }
  return value.value.value.value;
};

export async function readPageFileManifestPage(
  contentAccessContext: ContentAccessContext,
  pageId: string,
  input: {
    readonly cursor?: string;
    readonly query?: string;
    readonly includeDeleted?: boolean;
  } = {},
): Promise<LibraryPageFileManifest> {
  return pageFilesFromRead(
    await readLibraryModule(contentAccessContext, {
      read: {
        mode: "page_files",
        pageId,
        limit: 1,
        ...(input.query ? { query: input.query } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.includeDeleted ? { includeDeleted: true } : {}),
      },
    }),
  );
}

/** Prepare immutable bytes, claim one Page path, and expose the resulting stable File URI. */
export async function createOwnedPageFile(
  authority: PageFileAuthority,
  source: PageFileUploadSource,
  preferredLogicalPath?: string,
): Promise<CreatedPageFile> {
  const operationId = createUuidV7();
  const prepared =
    source.kind === "browser_file"
      ? (
          await prepareBrowserPageFiles(authority.contentAccessContext, operationId, [source.file])
        )[0]!
      : await preparePageFile(authority.contentAccessContext, {
          operationId,
          source: { kind: "local_path", path: source.path },
        });
  const manifest = await readPageFileManifestPage(authority.contentAccessContext, authority.pageId);
  const logicalPath = preferredLogicalPath?.trim() || prepared.logicalPath;
  const fileId = createUuidV7();
  const result = await applyLibraryModule(authority.contentAccessContext, {
    operationId,
    storeEpoch: authority.storeEpoch,
    operation: {
      kind: "apply_page_file_changes",
      pageId: authority.pageId,
      expectedManifestRevision: manifest.revision,
      changes: [
        {
          kind: "create",
          fileId,
          logicalPath,
          mimeType: prepared.mimeType,
          preparedBlobReceiptId: prepared.receiptId,
          collisionPolicy: "suffix",
        },
      ],
    },
  });
  if (!result.ok) throw new Error(result.error.message || "Couldn’t add Page File");
  const created = await readPageFileMetadata(authority, fileId);
  return {
    fileId,
    logicalPath: created.logicalPath,
    mimeType: created.mimeType,
    byteLength: created.byteLength,
    source: pageFileSource(fileId),
  };
}

/** Read current File bytes through the Page that owns or canonically places it. */
export async function readPlacedPageFile(
  authority: Pick<PageFileAuthority, "contentAccessContext" | "pageId">,
  source: string,
): Promise<PageFileBytes> {
  const fileId = parsePageFileSource(source);
  if (!fileId) throw new Error("Page File reference is invalid");
  return readPageFileBytes(authority.contentAccessContext, {
    pageId: authority.pageId,
    fileId,
  });
}

/** Read current File metadata through the Page that owns or canonically places it. */
export async function readPlacedPageFileMetadata(
  authority: Pick<PageFileAuthority, "contentAccessContext" | "pageId">,
  source: string,
): Promise<LibraryPageFileSummary> {
  const fileId = parsePageFileSource(source);
  if (!fileId) throw new Error("Page File reference is invalid");
  return readPageFileMetadata(authority, fileId);
}

async function readPageFileMetadata(
  authority: Pick<PageFileAuthority, "contentAccessContext" | "pageId">,
  fileId: string,
): Promise<LibraryPageFileSummary> {
  const result = await readLibraryModule(authority.contentAccessContext, {
    read: { mode: "page_file_metadata", pageId: authority.pageId, fileId },
  });
  if (!result.ok) throw new Error(result.error.message || "Couldn’t read Page File metadata");
  if (result.value.value.kind !== "page_file_metadata") {
    throw new Error("Unexpected Page File metadata response");
  }
  return result.value.value.value;
}

export async function saveOwnedPageFile(
  authority: Pick<PageFileAuthority, "contentAccessContext" | "pageId">,
  source: string,
  logicalPath: string,
): Promise<void> {
  const fileId = parsePageFileSource(source);
  if (!fileId) throw new Error("Page File reference is invalid");
  await savePageFile(authority.contentAccessContext, {
    pageId: authority.pageId,
    fileId,
    logicalPath,
  });
}

export async function pageFileImageDataUrl(
  authority: Pick<PageFileAuthority, "contentAccessContext" | "pageId">,
  source: string,
): Promise<string> {
  const file = await readPlacedPageFile(authority, source);
  const blob = new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mimeType });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Couldn’t read Page File image")),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Couldn’t encode Page File image")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}
