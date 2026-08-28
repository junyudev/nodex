import { type DragEvent, useEffect, useRef, useState } from "react";

import {
  ActivitySpinnerIcon,
  ChevronRightIcon,
  FileIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  PlusIcon,
  ReplaceIcon,
} from "@/components/shared/icons";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import { DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME } from "@/components/database/property-value-chip";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PropertyEmptyValue,
} from "@/components/database/property-empty-value";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  applyLibraryModule,
  pickAndPreparePageFiles,
  prepareDroppedPageFiles,
  preparePageFile,
  readPageFileBytes,
  savePageFile,
} from "@/lib/api";
import type {
  LibraryModuleApplyResult,
  LibraryPageFileChange,
  LibraryPageFileManifest,
  LibraryPageFileSummary,
} from "../../../../shared/library-module";
import type { PreparedPickedPageFile } from "../../../../shared/page-files";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { cn } from "@/lib/utils";
import type { PageStageController } from "./use-page-stage-controller";
import { usePageFiles, type PageFilesReadModel } from "@/lib/use-page-files";
import { pageStagePropertyAddControl } from "./property-value-styles";

interface PageFilesRowProps {
  readonly controller: PageStageController;
  readonly baseFiles: PageFilesReadModel;
  readonly hidden?: boolean;
}

interface FilePreview {
  readonly fileId: string;
  readonly kind: "image" | "text" | "unsupported";
  readonly objectUrl?: string;
  readonly text?: string;
}

const EMPTY_MANIFEST = (pageId: string): LibraryPageFileManifest => ({
  pageId,
  revision: 0,
  bodyUsageRevision: 0,
  files: [],
  nextCursor: null,
  hasMore: false,
  total: 0,
  liveTotal: 0,
  unplacedTotal: 0,
  placedTotal: 0,
  deletedTotal: 0,
});
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const PAGE_FILE_ROW_CHIP_LIMIT = 2;

const isSystemFileDrag = (dataTransfer: DataTransfer): boolean =>
  Array.from(dataTransfer.types).includes("Files");

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
};

const pageFilesErrorMessage = (result: LibraryModuleApplyResult): string => {
  if (result.ok) return "";
  if (result.error.code === "file_in_use") {
    return "This file is used in the Page. Remove its placements before deleting it.";
  }
  if (result.error.code === "revision_conflict") {
    return "Files changed elsewhere. The latest version has been reloaded.";
  }
  return result.error.message || "Couldn’t update Page Files";
};

const isTextPreview = (mimeType: string, logicalPath: string): boolean =>
  mimeType.startsWith("text/") ||
  /\.(?:md|mdx|json|ya?ml|toml|xml|csv|tsv|tsx?|jsx?|py|rs|go|java|kt|swift|sh|css|scss|html)$/i.test(
    logicalPath,
  );

function FilePreviewSurface({
  file,
  preview,
  text,
  onTextChange,
}: {
  file: LibraryPageFileSummary;
  preview: FilePreview;
  text: string;
  onTextChange: (value: string) => void;
}) {
  if (preview.kind === "image" && preview.objectUrl) {
    return (
      <div className="flex min-h-56 items-center justify-center overflow-hidden rounded-xl bg-token-foreground/4 p-3">
        <img
          src={preview.objectUrl}
          alt={file.logicalPath}
          className="max-h-[52vh] max-w-full object-contain"
        />
      </div>
    );
  }
  if (preview.kind === "text") {
    return (
      <textarea
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        aria-label={`Edit ${file.logicalPath}`}
        spellCheck={false}
        className="min-h-72 max-h-[52vh] w-full resize-y rounded-xl bg-token-foreground/4 p-4 font-mono text-xs/5 text-token-text-secondary outline-none ring-1 ring-transparent focus:ring-token-focus"
      />
    );
  }
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl bg-token-foreground/4 text-token-description-foreground">
      <ColorfulFileResourceIcon
        path={file.logicalPath}
        mimeType={file.mimeType}
        className="icon-lg"
      />
      <span className="text-sm">Preview isn’t available for this format</span>
    </div>
  );
}

export function PageFilesRow({ baseFiles, controller, hidden = false }: PageFilesRowProps) {
  const { contentAccessContext, page, storeEpoch } = controller;
  const [open, setOpen] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState("");
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [query, setQuery] = useState("");
  const [inPageExpanded, setInPageExpanded] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);

  const pageId = page?.id ?? "";
  const fileDragDepthRef = useRef(0);
  const previewRequestRef = useRef(0);
  const normalizedQuery = query.trim();
  const searchActive = normalizedQuery.length > 0;
  const filteredFiles = usePageFiles(contentAccessContext, pageId, {
    query: normalizedQuery,
    enabled: open && searchActive,
  });
  const inventory = searchActive ? filteredFiles : baseFiles;
  const rowManifest = baseFiles.manifest ?? EMPTY_MANIFEST(pageId);
  const manifest = inventory.manifest ?? EMPTY_MANIFEST(pageId);
  const loading = inventory.loading;
  const rowUnavailable = baseFiles.error !== null && baseFiles.manifest === null;

  useEffect(() => {
    if (baseFiles.error) toast.danger("Couldn’t load Page Files");
  }, [baseFiles.error]);

  useEffect(
    () => () => {
      if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    },
    [preview?.objectUrl],
  );

  if (!page) return null;

  const refreshInventories = async (): Promise<void> => {
    await baseFiles.refresh();
    if (searchActive) await filteredFiles.refresh();
  };

  const applyChanges = async (
    operationId: string,
    expectedManifestRevision: number,
    changes: readonly LibraryPageFileChange[],
  ): Promise<boolean> => {
    const result = await applyLibraryModule(contentAccessContext, {
      operationId,
      storeEpoch,
      operation: {
        kind: "apply_page_file_changes",
        pageId,
        expectedManifestRevision,
        changes,
      },
    });
    if (result.ok) {
      await refreshInventories();
      return true;
    }
    toast.danger(pageFilesErrorMessage(result));
    if (result.error.code === "revision_conflict") await refreshInventories();
    return false;
  };

  const addPreparedFiles = async (
    operationId: string,
    preparedFiles: readonly PreparedPickedPageFile[],
  ): Promise<void> => {
    if (preparedFiles.length === 0) return;
    const current = await baseFiles.refresh();
    const changes = preparedFiles.map((file) => {
      return {
        kind: "create" as const,
        fileId: createUuidV7(),
        logicalPath: file.logicalPath,
        mimeType: file.mimeType,
        preparedBlobReceiptId: file.receiptId,
        collisionPolicy: "suffix" as const,
      };
    });
    if (await applyChanges(operationId, current.revision, changes)) {
      toast.success(
        preparedFiles.length === 1 ? "File added" : `${preparedFiles.length} files added`,
      );
    }
  };

  const addFiles = async (): Promise<void> => {
    const operationId = createUuidV7();
    setMutating(true);
    try {
      const picked = await pickAndPreparePageFiles(contentAccessContext, { operationId });
      if (picked.cancelled || picked.files.length === 0) return;
      await addPreparedFiles(operationId, picked.files);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t add files");
    } finally {
      setMutating(false);
    }
  };

  const addDirectory = async (): Promise<void> => {
    const operationId = createUuidV7();
    setMutating(true);
    try {
      const picked = await pickAndPreparePageFiles(contentAccessContext, {
        operationId,
        selection: "directory",
      });
      if (picked.cancelled || picked.files.length === 0) return;
      await addPreparedFiles(operationId, picked.files);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t add folder");
    } finally {
      setMutating(false);
    }
  };

  const addDroppedFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) {
      toast.danger("No regular files were available to add");
      return;
    }

    const operationId = createUuidV7();
    setMutating(true);
    try {
      const prepared = await prepareDroppedPageFiles(contentAccessContext, operationId, files);
      if (prepared.length === 0) {
        toast.danger("No regular files were available to add");
        return;
      }
      await addPreparedFiles(operationId, prepared);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t add dropped files");
    } finally {
      setMutating(false);
    }
  };

  const resetFileDrag = (): void => {
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
  };

  const handleFileDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!isSystemFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (loading || mutating) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    fileDragDepthRef.current += 1;
    event.dataTransfer.dropEffect = "copy";
    setFileDragActive(true);
  };

  const handleFileDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!isSystemFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = loading || mutating ? "none" : "copy";
  };

  const handleFileDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!isSystemFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  };

  const handleFileDrop = (event: DragEvent<HTMLElement>): void => {
    if (!isSystemFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    resetFileDrag();
    if (loading || mutating) return;
    void addDroppedFiles(Array.from(event.dataTransfer.files));
  };

  const replaceFile = async (file: LibraryPageFileSummary): Promise<void> => {
    const operationId = createUuidV7();
    setMutating(true);
    try {
      const picked = await pickAndPreparePageFiles(contentAccessContext, {
        operationId,
        title: `Replace ${file.logicalPath}`,
      });
      if (picked.cancelled || picked.files.length === 0) return;
      if (picked.files.length !== 1) throw new Error("Choose exactly one replacement file");
      const replacement = picked.files[0]!;
      await applyChanges(operationId, manifest.revision, [
        {
          kind: "replace_content",
          fileId: file.fileId,
          expectedVersion: file.version,
          mimeType: replacement.mimeType,
          preparedBlobReceiptId: replacement.receiptId,
        },
      ]);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t replace file");
    } finally {
      setMutating(false);
    }
  };

  const savePreviewText = async (file: LibraryPageFileSummary): Promise<void> => {
    const operationId = createUuidV7();
    setMutating(true);
    try {
      const prepared = await preparePageFile(contentAccessContext, {
        operationId,
        source: {
          kind: "bytes",
          logicalPath: file.logicalPath,
          mimeType: file.mimeType,
          bytes: new TextEncoder().encode(previewText),
        },
      });
      const updated = await applyChanges(operationId, manifest.revision, [
        {
          kind: "replace_content",
          fileId: file.fileId,
          expectedVersion: file.version,
          mimeType: file.mimeType,
          preparedBlobReceiptId: prepared.receiptId,
        },
      ]);
      if (!updated) return;
      setPreview({ fileId: file.fileId, kind: "text", text: previewText });
      toast.success("File saved");
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t save file");
    } finally {
      setMutating(false);
    }
  };

  const renameFile = async (file: LibraryPageFileSummary): Promise<void> => {
    const logicalPath = editingPath.trim();
    if (!logicalPath || logicalPath === file.logicalPath) {
      setEditingFileId(null);
      return;
    }
    setMutating(true);
    try {
      const updated = await applyChanges(createUuidV7(), manifest.revision, [
        {
          kind: "rename",
          fileId: file.fileId,
          expectedVersion: file.version,
          logicalPath,
        },
      ]);
      if (updated) setEditingFileId(null);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t rename file");
    } finally {
      setMutating(false);
    }
  };

  const deleteFile = async (file: LibraryPageFileSummary): Promise<void> => {
    setMutating(true);
    try {
      await applyChanges(createUuidV7(), manifest.revision, [
        { kind: "delete", fileId: file.fileId, expectedVersion: file.version },
      ]);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t delete file");
    } finally {
      setMutating(false);
    }
  };

  const restoreFile = async (file: LibraryPageFileSummary): Promise<void> => {
    if (file.version < 2) return;
    setMutating(true);
    try {
      await applyChanges(createUuidV7(), manifest.revision, [
        {
          kind: "restore_version",
          fileId: file.fileId,
          expectedVersion: file.version,
          sourceVersion: file.version - 1,
        },
      ]);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t restore file");
    } finally {
      setMutating(false);
    }
  };

  const openPreview = async (file: LibraryPageFileSummary): Promise<void> => {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreviewFileId(file.fileId);
    setPreview(null);
    if (
      isTextPreview(file.mimeType, file.logicalPath) &&
      file.byteLength > MAX_TEXT_PREVIEW_BYTES
    ) {
      setPreview({ fileId: file.fileId, kind: "unsupported" });
      return;
    }
    try {
      const result = await readPageFileBytes(contentAccessContext, {
        pageId,
        fileId: file.fileId,
      });
      if (file.mimeType.startsWith("image/")) {
        const objectUrl = URL.createObjectURL(
          new Blob([result.bytes.slice().buffer as ArrayBuffer], { type: result.mimeType }),
        );
        if (previewRequestRef.current !== requestId) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPreview({ fileId: file.fileId, kind: "image", objectUrl });
        return;
      }
      if (previewRequestRef.current !== requestId) return;
      if (isTextPreview(file.mimeType, file.logicalPath)) {
        const text = new TextDecoder().decode(result.bytes);
        setPreview({
          fileId: file.fileId,
          kind: "text",
          text,
        });
        setPreviewText(text);
        return;
      }
      setPreview({ fileId: file.fileId, kind: "unsupported" });
    } catch {
      if (previewRequestRef.current !== requestId) return;
      setPreviewFileId(null);
      toast.danger("Couldn’t preview file");
    }
  };

  const rowLiveFiles = rowManifest.files.filter((file) => file.state === "live");
  const liveFiles = manifest.files.filter((file) => file.state === "live");
  const unplacedFiles = liveFiles.filter((file) => file.bodyUsage.kind === "not_in_body");
  const inPageFiles = liveFiles.filter((file) => file.bodyUsage.kind === "placed");
  const deletedFiles = manifest.files.filter((file) => file.state === "deleted");
  const previewFile =
    [...rowLiveFiles, ...liveFiles].find((file) => file.fileId === previewFileId) ?? null;
  const rowFiles = rowLiveFiles
    .filter((file) => file.bodyUsage.kind === "not_in_body")
    .slice(0, PAGE_FILE_ROW_CHIP_LIMIT);
  const hiddenUnplacedFileCount = Math.max(0, rowManifest.unplacedTotal - rowFiles.length);
  const hiddenFileCount = hiddenUnplacedFileCount + rowManifest.placedTotal;
  const summaryShowsInPage = hiddenUnplacedFileCount === 0 && rowManifest.placedTotal > 0;
  const summaryLabel = summaryShowsInPage
    ? `${rowManifest.placedTotal} in page`
    : `+${hiddenFileCount}`;
  const hiddenSummaryParts = [
    hiddenUnplacedFileCount > 0
      ? `${hiddenUnplacedFileCount} more ${hiddenUnplacedFileCount === 1 ? "file" : "files"}`
      : null,
    rowManifest.placedTotal > 0 ? `${rowManifest.placedTotal} shown in page` : null,
  ].filter((part): part is string => part !== null);
  const hiddenSummaryTooltip = hiddenSummaryParts.join(" · ");
  const inPageSectionExpanded = searchActive || inPageExpanded;
  const hasSearchResults = manifest.total > 0;

  const openFiles = (options: { readonly expandInPage?: boolean } = {}): void => {
    setInPageExpanded(options.expandInPage ?? false);
    setOpen(true);
  };

  const renderFileRow = (file: LibraryPageFileSummary) => (
    <div key={file.fileId} className="group flex min-h-12 items-center gap-3 py-2">
      <button
        type="button"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-transparent text-token-text-secondary hover:bg-token-foreground/6"
        onClick={() => void openPreview(file)}
        aria-label={`Preview ${file.logicalPath}`}
      >
        <ColorfulFileResourceIcon
          path={file.logicalPath}
          mimeType={file.mimeType}
          className="icon-sm"
        />
      </button>
      <div className="min-w-0 flex-1">
        {editingFileId === file.fileId ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void renameFile(file);
            }}
          >
            <input
              autoFocus
              value={editingPath}
              disabled={mutating}
              onChange={(event) => setEditingPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditingFileId(null);
              }}
              className="h-7 min-w-0 flex-1 rounded-md bg-token-foreground/5 px-2 text-sm outline-none ring-1 ring-token-border focus:ring-token-focus"
              aria-label="File path"
            />
            <button className="text-xs text-token-text-primary" type="submit">
              Save
            </button>
            <button
              className="text-xs text-token-description-foreground"
              type="button"
              onClick={() => setEditingFileId(null)}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="block max-w-full truncate text-left text-sm text-token-text-primary hover:underline"
            onClick={() => void openPreview(file)}
          >
            {file.logicalPath}
          </button>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-token-description-foreground">
          <span>{formatBytes(file.byteLength)}</span>
          <span aria-hidden="true">·</span>
          <span>v{file.version}</span>
          {file.bodyUsage.kind === "placed" ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {file.bodyUsage.placementCount === 1
                  ? "In page"
                  : `${file.bodyUsage.placementCount} placements`}
              </span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className="truncate">{file.mimeType}</span>
        </div>
      </div>
      {editingFileId !== file.fileId ? (
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            mutating && "pointer-events-none opacity-40",
          )}
        >
          <NodexTooltip tooltipContent="Rename">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/6 hover:text-token-text-primary"
              onClick={() => {
                setEditingFileId(file.fileId);
                setEditingPath(file.logicalPath);
              }}
              aria-label={`Rename ${file.logicalPath}`}
            >
              <EditIcon className="icon-2xs" />
            </button>
          </NodexTooltip>
          <NodexTooltip tooltipContent="Replace">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/6 hover:text-token-text-primary"
              onClick={() => void replaceFile(file)}
              aria-label={`Replace ${file.logicalPath}`}
            >
              <ReplaceIcon className="icon-2xs" />
            </button>
          </NodexTooltip>
          <NodexTooltip tooltipContent="Download">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/6 hover:text-token-text-primary"
              onClick={() =>
                void savePageFile(contentAccessContext, {
                  pageId,
                  fileId: file.fileId,
                  logicalPath: file.logicalPath,
                }).catch(() => toast.danger("Couldn’t save file"))
              }
              aria-label={`Download ${file.logicalPath}`}
            >
              <DownloadIcon className="icon-2xs" />
            </button>
          </NodexTooltip>
          <NodexTooltip tooltipContent="Delete">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-charts-red/10 hover:text-token-charts-red"
              onClick={() => void deleteFile(file)}
              aria-label={`Delete ${file.logicalPath}`}
            >
              <DeleteIcon className="icon-2xs" />
            </button>
          </NodexTooltip>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <div hidden={hidden} className="grid min-h-7.5 grid-cols-[10rem_minmax(0,1fr)] items-start">
        <div className="flex min-h-7.5 min-w-0 items-center gap-1.5 pl-1.5">
          <div className="flex w-5 shrink-0 items-center justify-center text-(--foreground-secondary)">
            <FileIcon className="size-4" />
          </div>
          <span className="min-w-0 truncate text-sm/5 text-(--foreground-secondary)">Files</span>
        </div>
        <div className={cn("min-w-0 px-2", rowManifest.liveTotal === 0 && "self-center")}>
          {rowUnavailable ? (
            <div className="flex min-h-7 items-center gap-2 text-xs text-(--red-text)">
              <span className="min-w-0 flex-1 truncate">Couldn’t load files</span>
              <button
                type="button"
                className="shrink-0 text-(--foreground-secondary) hover:text-(--foreground)"
                onClick={() => {
                  void baseFiles.refresh().catch(() => toast.danger("Couldn’t load Page Files"));
                }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {baseFiles.loading && !rowUnavailable ? (
            <div
              role="status"
              aria-label="Loading Page Files"
              className="flex h-7 items-center px-1.5 text-(--foreground-tertiary)"
            >
              <ActivitySpinnerIcon className="size-3.5" />
            </div>
          ) : null}
          {!baseFiles.loading && !rowUnavailable && rowManifest.liveTotal === 0 ? (
            <button
              type="button"
              className={cn(
                "flex min-h-6 min-w-0 items-center text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus",
                DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
              )}
              onClick={() => openFiles()}
              aria-label="Add Page Files"
              aria-busy={baseFiles.loading}
            >
              <PropertyEmptyValue className="truncate" />
            </button>
          ) : null}
          {!baseFiles.loading && !rowUnavailable && rowManifest.liveTotal > 0 ? (
            <div className="flex min-h-7 flex-wrap items-center gap-1 py-0.5" aria-busy="false">
              {rowFiles.map((file) => (
                <button
                  key={file.fileId}
                  type="button"
                  data-page-file-chip="true"
                  aria-label={`Open ${file.logicalPath}`}
                  className={cn(
                    DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
                    "max-w-64 gap-1 text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus",
                  )}
                  onClick={() => void openPreview(file)}
                >
                  <ColorfulFileResourceIcon
                    path={file.logicalPath}
                    mimeType={file.mimeType}
                    className="size-3.5 shrink-0 text-(--foreground-secondary)"
                  />
                  <span className="min-w-0 truncate">{file.logicalPath}</span>
                </button>
              ))}
              {hiddenFileCount > 0 ? (
                <NodexTooltip tooltipContent={hiddenSummaryTooltip}>
                  <button
                    type="button"
                    aria-label={
                      summaryShowsInPage
                        ? `Open ${rowManifest.placedTotal} ${rowManifest.placedTotal === 1 ? "File" : "Files"} shown in Page`
                        : `Open ${hiddenFileCount} more Page Files`
                    }
                    className={cn(
                      DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
                      "text-token-description-foreground outline-none hover:bg-token-foreground/5 hover:text-token-text-secondary focus-visible:ring-2 focus-visible:ring-token-focus",
                    )}
                    onClick={() => openFiles({ expandInPage: summaryShowsInPage })}
                  >
                    {summaryLabel}
                  </button>
                </NodexTooltip>
              ) : null}
              <button
                type="button"
                aria-label="Add Page Files"
                className={pageStagePropertyAddControl}
                onClick={() => openFiles()}
              >
                <PlusIcon className="icon-2xs shrink-0" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <NodexDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            resetFileDrag();
            setQuery("");
            setInPageExpanded(false);
            setEditingFileId(null);
            setPreviewFileId(null);
            setPreview(null);
          }
        }}
      >
        <NodexDialogContent size="wide">
          <NodexDialogFrame
            className="relative max-h-[78vh] min-h-[360px]"
            data-page-files-drop-surface="true"
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            onDragEnd={resetFileDrag}
          >
            {fileDragActive ? (
              <div
                data-page-files-drop-indicator="true"
                role="status"
                aria-label="Drop files and folders to add to this Page"
                aria-live="polite"
                className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center rounded-2xl bg-token-dropdown-background/95 text-center text-token-text-primary shadow-lg ring-1 ring-inset ring-token-focus-border backdrop-blur-md"
              >
                <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-token-foreground/8 text-token-text-secondary">
                  <FileIcon className="icon-base" />
                </div>
                <div className="text-sm font-medium">Drop files and folders to add</div>
                <div className="mt-0.5 text-xs text-token-description-foreground">
                  They’ll be stored in this Page
                </div>
              </div>
            ) : null}
            <NodexDialogHeader>
              <div className="flex items-center justify-between gap-4 pr-8">
                <div className="min-w-0">
                  <NodexDialogTitle>Files</NodexDialogTitle>
                  <p className="mt-0.5 text-sm text-token-description-foreground">
                    Owned by this Page · Drop files or folders anywhere to add
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <NodexDialogAction
                    size="compact"
                    disabled={mutating}
                    onClick={() => void addDirectory()}
                  >
                    Add folder
                  </NodexDialogAction>
                  <NodexDialogAction
                    tone="primary"
                    size="compact"
                    disabled={mutating}
                    onClick={() => void addFiles()}
                  >
                    {mutating ? <ActivitySpinnerIcon className="size-3" /> : <PlusIcon />}
                    Add files
                  </NodexDialogAction>
                </div>
              </div>
            </NodexDialogHeader>
            <NodexDialogBody className="min-h-0 flex-1 overflow-auto pt-3">
              {loading ? (
                <div className="flex flex-1 items-center justify-center py-16 text-token-description-foreground">
                  <ActivitySpinnerIcon className="size-4" />
                </div>
              ) : null}
              {!loading && !searchActive && rowManifest.liveTotal === 0 ? (
                <button
                  type="button"
                  disabled={mutating}
                  data-page-files-empty-drop-zone="true"
                  className="flex min-h-52 w-full flex-col items-center justify-center gap-2 rounded-2xl border-[0.5px] border-dashed border-token-border text-token-description-foreground hover:bg-token-foreground/3 focus-visible:outline-2 focus-visible:outline-token-focus disabled:opacity-50"
                  onClick={() => void addFiles()}
                >
                  {mutating ? (
                    <>
                      <ActivitySpinnerIcon className="icon-base" />
                      <span className="text-sm text-token-text-secondary">Adding files…</span>
                    </>
                  ) : (
                    <>
                      <FileIcon className="icon-lg" />
                      <span className="text-sm text-token-text-secondary">
                        Drop files or folders here
                      </span>
                      <span className="text-xs">or click to add files</span>
                    </>
                  )}
                </button>
              ) : null}
              {!baseFiles.loading && rowManifest.liveTotal > 0 ? (
                <div className="mb-2">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter by path"
                    aria-label="Filter Page Files"
                    className="h-8 w-full rounded-lg bg-token-foreground/4 px-3 text-sm outline-none ring-[0.5px] ring-inset ring-token-border focus:ring-1 focus:ring-token-focus"
                  />
                </div>
              ) : null}
              {!loading && unplacedFiles.length > 0 ? (
                <div className="divide-y-[0.5px] divide-token-border/70">
                  {unplacedFiles.map(renderFileRow)}
                </div>
              ) : null}
              {!loading && inPageFiles.length > 0 ? (
                <section
                  className={cn(
                    unplacedFiles.length > 0 && "mt-3 border-t-[0.5px] border-token-border/70 pt-2",
                  )}
                >
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-1 rounded-md px-1 text-left text-xs font-medium text-token-description-foreground outline-none hover:bg-token-foreground/4 hover:text-token-text-secondary focus-visible:ring-2 focus-visible:ring-token-focus"
                    aria-expanded={inPageSectionExpanded}
                    onClick={() => setInPageExpanded((expanded) => !expanded)}
                  >
                    <ChevronRightIcon
                      className={cn(
                        "icon-2xs shrink-0 transition-transform duration-150",
                        inPageSectionExpanded && "rotate-90",
                      )}
                    />
                    <span>In page · {manifest.placedTotal}</span>
                  </button>
                  {inPageSectionExpanded ? (
                    <div className="divide-y-[0.5px] divide-token-border/70">
                      {inPageFiles.map(renderFileRow)}
                    </div>
                  ) : null}
                </section>
              ) : null}
              {!loading && searchActive && !hasSearchResults ? (
                <div className="py-12 text-center text-sm text-token-description-foreground">
                  No files match
                </div>
              ) : null}
              {!loading && deletedFiles.length > 0 ? (
                <div className="mt-4 border-t-[0.5px] border-token-border/70 pt-3">
                  <h3 className="mb-1 px-1 text-xs font-medium text-token-description-foreground">
                    Deleted
                  </h3>
                  <div className="divide-y-[0.5px] divide-token-border/50">
                    {deletedFiles.map((file) => (
                      <div
                        key={file.fileId}
                        className="flex min-h-10 items-center gap-3 py-1.5 opacity-70"
                      >
                        <ColorfulFileResourceIcon
                          path={file.logicalPath}
                          mimeType={file.mimeType}
                          className="icon-sm shrink-0 text-token-description-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-token-text-secondary line-through">
                            {file.logicalPath}
                          </div>
                          <div className="text-xs text-token-description-foreground">
                            version {file.version}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={mutating || file.version < 2}
                          className="rounded-md px-2 py-1 text-xs text-token-text-secondary hover:bg-token-foreground/6 disabled:opacity-40"
                          onClick={() => void restoreFile(file)}
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {!loading && inventory.hasMore ? (
                <div className="flex justify-center pt-3">
                  <NodexDialogAction
                    size="compact"
                    disabled={inventory.loadingMore}
                    onClick={() => void inventory.loadMore()}
                  >
                    {inventory.loadingMore ? <ActivitySpinnerIcon className="size-3" /> : null}
                    Load more
                  </NodexDialogAction>
                </div>
              ) : null}
            </NodexDialogBody>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>

      <NodexDialog
        open={previewFile !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            previewRequestRef.current += 1;
            setPreviewFileId(null);
            setPreview(null);
            setPreviewText("");
          }
        }}
      >
        <NodexDialogContent size="large">
          <NodexDialogFrame className="max-h-[82vh]">
            <NodexDialogHeader>
              <div className="flex items-start justify-between gap-4 pr-8">
                <div className="flex min-w-0 items-start gap-2">
                  {previewFile ? (
                    <ColorfulFileResourceIcon
                      path={previewFile.logicalPath}
                      mimeType={previewFile.mimeType}
                      className="icon-sm mt-0.5 shrink-0 text-token-text-secondary"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <NodexDialogTitle className="truncate">
                      {previewFile?.logicalPath ?? "File"}
                    </NodexDialogTitle>
                    {previewFile ? (
                      <p className="mt-0.5 text-sm text-token-description-foreground">
                        {formatBytes(previewFile.byteLength)} · version {previewFile.version}
                      </p>
                    ) : null}
                  </div>
                </div>
                {previewFile ? (
                  <div className="flex items-center gap-1.5">
                    {preview?.kind === "text" && previewText !== preview.text ? (
                      <NodexDialogAction
                        tone="primary"
                        size="compact"
                        disabled={mutating}
                        onClick={() => void savePreviewText(previewFile)}
                      >
                        Save changes
                      </NodexDialogAction>
                    ) : null}
                    <NodexDialogAction
                      size="compact"
                      onClick={() =>
                        void savePageFile(contentAccessContext, {
                          pageId,
                          fileId: previewFile.fileId,
                          logicalPath: previewFile.logicalPath,
                        }).catch(() => toast.danger("Couldn’t save file"))
                      }
                    >
                      <DownloadIcon className="icon-xs" />
                      Download
                    </NodexDialogAction>
                  </div>
                ) : null}
              </div>
            </NodexDialogHeader>
            <NodexDialogBody>
              {!preview || preview.fileId !== previewFile?.fileId ? (
                <div className="flex min-h-56 items-center justify-center text-token-description-foreground">
                  <ActivitySpinnerIcon className="size-4" />
                </div>
              ) : null}
              {previewFile && preview && preview.fileId === previewFile.fileId ? (
                <FilePreviewSurface
                  file={previewFile}
                  preview={preview}
                  text={previewText}
                  onTextChange={setPreviewText}
                />
              ) : null}
            </NodexDialogBody>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </>
  );
}
