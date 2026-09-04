import type { ContentAccessContext } from "../../shared/content-access-context";
import type {
  LibraryFile,
  LibraryFileChange,
  LibraryFileReadSource,
  LibraryPageFileEntryChange,
  LibraryPageFileEntryReceipt,
} from "../../shared/library-files";
import { FILE_IMPORT_MAX_BYTES, FILE_IMPORT_MAX_COUNT } from "../../shared/file-resources";
import type { PreparedFileBlob } from "../../shared/file-resources";
import { createUuidV7 } from "../../shared/uuid-v7";
import { applyLibraryModule, prepareFileBlob } from "./api";
import { prepareBrowserFiles } from "./library-file-resources";

export interface LibraryFileCommandAuthority {
  readonly contentAccessContext: ContentAccessContext;
  readonly storeEpoch: string;
}

export class LibraryFileCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LibraryFileCommandError";
    this.code = code;
  }
}

const requireResult = <Value extends { readonly ok: boolean }>(
  result: Value,
): Extract<Value, { readonly ok: true }> => {
  if (result.ok) return result as Extract<Value, { readonly ok: true }>;
  const failed = result as Value & {
    readonly error: { readonly code: string; readonly message?: string };
  };
  throw new LibraryFileCommandError(
    failed.error.code,
    failed.error.message || "Couldn’t update File",
  );
};

export async function applyFileChange(
  authority: LibraryFileCommandAuthority,
  change: LibraryFileChange,
  operationId = createUuidV7(),
): Promise<LibraryFile | null> {
  const result = requireResult(
    await applyLibraryModule(authority.contentAccessContext, {
      operationId,
      storeEpoch: authority.storeEpoch,
      operation: { kind: "apply_file_change", change },
    }),
  );
  return result.value.fileMutation?.file ?? null;
}

export async function importFiles(
  authority: LibraryFileCommandAuthority,
  files: readonly File[],
): Promise<{
  readonly imported: readonly LibraryFile[];
  readonly failures: readonly { name: string; message: string }[];
}> {
  if (
    files.length > FILE_IMPORT_MAX_COUNT ||
    files.reduce((total, file) => total + file.size, 0) > FILE_IMPORT_MAX_BYTES
  ) {
    throw new Error("Select up to 100 Files and 256 MiB per import.");
  }
  const imported: LibraryFile[] = [];
  const failures: { name: string; message: string }[] = [];
  for (const file of files) {
    try {
      const operationId = createUuidV7();
      const prepared = (
        await prepareBrowserFiles(authority.contentAccessContext, operationId, [file])
      )[0];
      if (!prepared) throw new Error("File publication omitted its upload receipt");
      const committed = await applyFileChange(
        authority,
        {
          kind: "create",
          file_id: createUuidV7(),
          default_name: prepared.logicalPath.split("/").at(-1) ?? prepared.logicalPath,
          mime_type: prepared.mimeType,
          prepared_blob_receipt_id: prepared.receiptId,
        },
        operationId,
      );
      if (!committed) throw new Error("Import omitted its committed File");
      imported.push(committed);
    } catch (error) {
      failures.push({
        name: file.name,
        message: error instanceof Error ? error.message : "Import failed",
      });
    }
  }
  return { imported, failures };
}

export async function replaceFileContent(
  authority: LibraryFileCommandAuthority,
  target: Pick<LibraryFile, "file_id" | "revision" | "head_version">,
  replacement: File,
): Promise<LibraryFile> {
  const operationId = createUuidV7();
  const prepared = (
    await prepareBrowserFiles(authority.contentAccessContext, operationId, [replacement])
  )[0];
  if (!prepared) throw new Error("Choose one replacement File");
  const committed = await applyFileChange(
    authority,
    {
      kind: "replace_content",
      file_id: target.file_id,
      expected_revision: target.revision,
      expected_head_version: target.head_version,
      mime_type: prepared.mimeType,
      prepared_blob_receipt_id: prepared.receiptId,
    },
    operationId,
  );
  if (!committed) throw new Error("File update omitted its committed result");
  return committed;
}

export const renameFile = (
  authority: LibraryFileCommandAuthority,
  target: Pick<LibraryFile, "file_id" | "revision">,
  defaultName: string,
) =>
  applyFileChange(authority, {
    kind: "rename",
    file_id: target.file_id,
    expected_revision: target.revision,
    default_name: defaultName,
  });

export const changeFileLifecycle = (
  authority: LibraryFileCommandAuthority,
  target: Pick<LibraryFile, "file_id" | "revision">,
  kind: "trash" | "restore" | "purge",
) =>
  applyFileChange(authority, {
    kind,
    file_id: target.file_id,
    expected_revision: target.revision,
  });

export async function forkFile(
  authority: LibraryFileCommandAuthority,
  source: Pick<LibraryFile, "file_id" | "default_name"> & { readonly version: number },
): Promise<LibraryFile> {
  const fileId = createUuidV7();
  const committed = await applyFileChange(authority, {
    kind: "fork",
    source_file_id: source.file_id,
    source_version: source.version,
    source: { kind: "direct" },
    file_id: fileId,
    default_name: source.default_name,
  });
  if (!committed || committed.file_id !== fileId) {
    throw new Error("File copy omitted its committed result");
  }
  return committed;
}

async function applyPageEntryChanges(
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  changes: readonly LibraryPageFileEntryChange[],
  operationId = createUuidV7(),
): Promise<LibraryPageFileEntryReceipt> {
  const result = requireResult(
    await applyLibraryModule(authority.contentAccessContext, {
      operationId,
      storeEpoch: authority.storeEpoch,
      operation: {
        kind: "apply_page_file_entries",
        page_id: pageId,
        expected_manifest_revision: expectedManifestRevision,
        changes,
      },
    }),
  );
  const receipt = (result.value.pageFileEntries ?? []).find((item) => item.page_id === pageId);
  if (!receipt) throw new Error("Page File update omitted its committed result");
  return receipt;
}

export async function importPageEntries(
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  files: readonly File[],
): Promise<LibraryPageFileEntryReceipt> {
  const operationId = createUuidV7();
  const prepared = await prepareBrowserFiles(authority.contentAccessContext, operationId, files);
  return importPreparedPageEntries(
    authority,
    pageId,
    expectedManifestRevision,
    operationId,
    prepared,
  );
}

export function importPreparedPageEntries(
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  operationId: string,
  prepared: readonly PreparedFileBlob[],
): Promise<LibraryPageFileEntryReceipt> {
  return applyPageEntryChanges(
    authority,
    pageId,
    expectedManifestRevision,
    prepared.map((file) => ({
      kind: "import" as const,
      file_id: createUuidV7(),
      logical_path: file.logicalPath,
      mime_type: file.mimeType,
      prepared_blob_receipt_id: file.receiptId,
      collision_policy: "suffix" as const,
    })),
    operationId,
  );
}

export const attachPageEntry = (
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  fileId: string,
  logicalPath: string,
  source: LibraryFileReadSource,
) =>
  applyPageEntryChanges(authority, pageId, expectedManifestRevision, [
    {
      kind: "attach",
      file_id: fileId,
      logical_path: logicalPath,
      source,
      collision_policy: "reject",
    },
  ]);

export const renamePageEntry = (
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  fileId: string,
  logicalPath: string,
) =>
  applyPageEntryChanges(authority, pageId, expectedManifestRevision, [
    { kind: "rename", file_id: fileId, logical_path: logicalPath },
  ]);

export const removePageEntry = (
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  fileId: string,
) =>
  applyPageEntryChanges(authority, pageId, expectedManifestRevision, [
    { kind: "remove", file_id: fileId },
  ]);

export async function replacePageEntry(
  authority: LibraryFileCommandAuthority,
  pageId: string,
  expectedManifestRevision: number,
  targetFileId: string,
  replacement: File,
): Promise<LibraryPageFileEntryReceipt> {
  const operationId = createUuidV7();
  const prepared = (
    await prepareBrowserFiles(authority.contentAccessContext, operationId, [replacement])
  )[0];
  if (!prepared) throw new Error("Choose one replacement File");
  return applyPageEntryChanges(
    authority,
    pageId,
    expectedManifestRevision,
    [
      {
        kind: "replace",
        file_id: targetFileId,
        replacement_file_id: createUuidV7(),
        mime_type: prepared.mimeType,
        prepared_blob_receipt_id: prepared.receiptId,
      },
    ],
    operationId,
  );
}

export async function replaceTextFileContent(
  authority: LibraryFileCommandAuthority,
  target: Pick<LibraryFile, "file_id" | "revision" | "head_version" | "default_name" | "mime_type">,
  text: string,
): Promise<LibraryFile> {
  const operationId = createUuidV7();
  const prepared = await prepareFileBlob(authority.contentAccessContext, {
    operationId,
    source: {
      kind: "bytes",
      logicalPath: target.default_name,
      mimeType: target.mime_type,
      bytes: new TextEncoder().encode(text),
    },
  });
  const committed = await applyFileChange(
    authority,
    {
      kind: "replace_content",
      file_id: target.file_id,
      expected_revision: target.revision,
      expected_head_version: target.head_version,
      mime_type: target.mime_type,
      prepared_blob_receipt_id: prepared.receiptId,
    },
    operationId,
  );
  if (!committed) throw new Error("File update omitted its committed result");
  return committed;
}
