import { FileDetailsMetadata, FileListMetadata } from "@/components/shared/file-metadata";
import { type DragEvent, useEffect, useRef, useState } from "react";

import {
  ActivitySpinnerIcon,
  DownloadIcon,
  DeleteIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  OpenInIcon,
  EditIcon,
  FileIcon,
  PlusIcon,
  ReplaceIcon,
} from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
import { FileDetailsToolbar } from "@/components/shared/file-details-toolbar";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import { DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME } from "@/components/database/property-value-chip";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PropertyEmptyValue,
} from "@/components/database/property-empty-value";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { FileReadBoundary } from "@/components/board/editor/file-runtime";
import { LibraryFilesDialog, ManagedFilePreview } from "@/components/library/library-files-dialog";
import type { ContentAccessContext } from "../../../../shared/content-access-context";
import type {
  LibraryPageFileInventory,
  LibraryPageFileItem,
} from "../../../../shared/library-files";
import type { PreparedFileBlob } from "../../../../shared/file-resources";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { fileSource } from "../../../../shared/file-resources";
import {
  attachPageEntry,
  importPreparedPageEntries,
  LibraryFileCommandError,
  removePageEntry,
  renamePageEntry,
  replacePageEntry,
} from "@/lib/library-file-commands";
import { pickAndPrepareFiles, prepareDroppedFiles } from "@/lib/api";
import { saveAuthorizedFile } from "@/lib/library-file-resources";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { usePageFile } from "@/lib/use-library-files";
import { usePageFiles, type PageFilesReadModel } from "@/lib/use-page-files";
import { cn } from "@/lib/utils";
import type { PageStageController } from "./use-page-stage-controller";
import { pageStagePropertyAddControl } from "./property-value-styles";

interface PageFilesRowProps {
  readonly controller: PageStageController;
  readonly baseFiles: PageFilesReadModel;
  readonly hidden?: boolean;
}

interface PageFilesDialogProps extends ModalCloseProps {
  readonly accessContext: ContentAccessContext;
  readonly pageId: string;
  readonly initialFileId?: string;
  readonly onChanged: () => Promise<void>;
}

const EMPTY_INVENTORY = (pageId: string): LibraryPageFileInventory => ({
  page_id: pageId,
  can_write: false,
  revision: 0,
  body_usage_revision: 0,
  files: [],
  next_cursor: null,
  has_more: false,
  total: 0,
  unplaced_total: 0,
  placed_total: 0,
});

const mutationMessage = (error: unknown): string => {
  if (error instanceof LibraryFileCommandError && error.code === "revision_conflict") {
    return "Page Files changed elsewhere. Review the latest list before trying again.";
  }
  return error instanceof Error ? error.message : "Couldn’t update Page Files";
};

const isSystemFileDrag = (dataTransfer: DataTransfer): boolean =>
  Array.from(dataTransfer.types).includes("Files");

export function PageFilesDialog(props: PageFilesDialogProps) {
  return (
    <PageFilesDialogContent
      key={JSON.stringify([props.accessContext, props.pageId, props.initialFileId ?? null])}
      {...props}
    />
  );
}

function PageFilesDialogContent({
  accessContext,
  pageId,
  initialFileId,
  onChanged,
  onClose,
}: PageFilesDialogProps) {
  const appHandle = useScopeHandle(appScope);
  const metadata = useLibraryMetadata();
  const [query, setQuery] = useState("");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(initialFileId ?? null);
  const [mutating, setMutating] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [path, setPath] = useState("");
  const [pathRevision, setPathRevision] = useState<number | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragDepthRef = useRef(0);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const inventory = usePageFiles(accessContext, pageId, { query });
  const value = inventory.inventory ?? EMPTY_INVENTORY(pageId);
  const fileGroups = [
    {
      label: "Attachments",
      count: value.unplaced_total,
      files: value.files.filter((item) => item.body_count === 0),
    },
    {
      label: "In page",
      count: value.placed_total,
      files: value.files.filter((item) => item.body_count > 0),
    },
  ].filter((group) => group.files.length > 0);
  const canWrite = value.can_write;
  const selectedQuery = usePageFile(accessContext, pageId, selectedFileId);
  const selected =
    value.files.find((item) => item.file.file_id === selectedFileId) ?? selectedQuery.item;

  useEffect(() => {
    if (selectedFileId === null && value.files.length > 0)
      setSelectedFileId(value.files[0]!.file.file_id);
  }, [selectedFileId, value.files]);

  useEffect(() => {
    setPath("");
    setEditingPath(false);
  }, [selectedFileId]);

  const authority = metadata.data
    ? {
        contentAccessContext: accessContext,
        storeEpoch: metadata.data.storeEpoch,
        libraryId: metadata.data.libraryId,
      }
    : null;

  const refresh = async (): Promise<void> => {
    await Promise.all([inventory.refresh(), selectedQuery.refresh(), onChanged()]);
  };

  const run = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    if (!authority || !canWrite) return;
    setMutating(true);
    try {
      await action();
      await refresh();
      toast.success(success);
    } catch (error) {
      if (error instanceof LibraryFileCommandError && error.code === "revision_conflict") {
        const fresh = await inventory.refresh();
        setPathRevision(fresh.revision);
        await refresh();
      }
      toast.danger(mutationMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const addLocalSelection = async (selection: "files" | "directory"): Promise<void> => {
    if (!authority || !canWrite) return;
    const operationId = createUuidV7();
    setMutating(true);
    try {
      const picked = await pickAndPrepareFiles(accessContext, {
        operationId,
        selection,
        title: selection === "directory" ? "Add folder to Page" : "Add Files to Page",
      });
      if (picked.cancelled) return;
      await importPreparedPageEntries(authority, pageId, value.revision, operationId, picked.files);
      await refresh();
      toast.success(
        picked.files.length === 1 ? "File added" : `${picked.files.length} Files added`,
      );
    } catch (error) {
      if (error instanceof LibraryFileCommandError && error.code === "revision_conflict") {
        const fresh = await inventory.refresh();
        setPathRevision(fresh.revision);
        await refresh();
      }
      toast.danger(mutationMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const addDroppedFiles = async (
    operationId: string,
    files: readonly PreparedFileBlob[],
  ): Promise<void> => {
    if (!authority || !canWrite || files.length === 0) return;
    setMutating(true);
    try {
      await importPreparedPageEntries(authority, pageId, value.revision, operationId, files);
      await refresh();
      toast.success(files.length === 1 ? "File added" : `${files.length} Files added`);
    } catch (error) {
      if (error instanceof LibraryFileCommandError && error.code === "revision_conflict") {
        const fresh = await inventory.refresh();
        setPathRevision(fresh.revision);
        await refresh();
      }
      toast.danger(mutationMessage(error));
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
    if (mutating || !authority || !canWrite) {
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
    event.dataTransfer.dropEffect = mutating || !authority || !canWrite ? "none" : "copy";
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
    if (mutating || !authority || !canWrite) return;
    const operationId = createUuidV7();
    void prepareDroppedFiles(accessContext, operationId, Array.from(event.dataTransfer.files))
      .then((files) => addDroppedFiles(operationId, files))
      .catch((error) => toast.danger(mutationMessage(error)));
  };

  const replaceSelected = async (files: FileList | null): Promise<void> => {
    const replacement = files?.[0];
    if (!selected || !replacement || !selected.logical_path) return;
    await run(async () => {
      const receipt = await replacePageEntry(
        authority!,
        pageId,
        value.revision,
        selected.file.file_id,
        replacement,
      );
      const replacementId = receipt.replacements[selected.file.file_id];
      if (replacementId) setSelectedFileId(replacementId);
    }, "This Page entry now uses an independent File");
    if (replaceInputRef.current) replaceInputRef.current.value = "";
  };

  const savePath = async (): Promise<void> => {
    if (!selected || !authority || !canWrite || !path.trim()) return;
    const action = () =>
      selected.logical_path
        ? renamePageEntry(
            authority!,
            pageId,
            pathRevision ?? value.revision,
            selected.file.file_id,
            path.trim(),
          )
        : attachPageEntry(
            authority!,
            pageId,
            pathRevision ?? value.revision,
            selected.file.file_id,
            path.trim(),
            {
              kind: "page",
              page_id: pageId,
            },
          );
    await run(
      async () => {
        await action();
        setEditingPath(false);
      },
      selected.logical_path ? "Page path renamed" : "Page path added",
    );
  };

  const saveFile = async (): Promise<void> => {
    if (!selected || !authority) return;
    try {
      await saveAuthorizedFile(
        { ...authority, readSource: { kind: "page", page_id: pageId } },
        fileSource(selected.file.file_id),
        selected.logical_path ?? selected.file.default_name,
      );
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t save File");
    }
  };

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        resetFileDrag();
        onClose();
      }}
    >
      <NodexDialogContent size="large">
        <NodexDialogFrame
          className="relative h-[min(700px,82vh)] overflow-hidden"
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
              aria-label="Drop Files and folders to add to this Page"
              aria-live="polite"
              className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center rounded-2xl bg-token-dropdown-background/95 text-center text-token-text-primary shadow-lg ring-1 ring-inset ring-token-focus-border backdrop-blur-md"
            >
              <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-token-foreground/8 text-token-text-secondary">
                <FileIcon className="icon-base" />
              </div>
              <div className="text-sm font-medium">Drop Files and folders to add</div>
              <div className="mt-0.5 text-xs text-token-description-foreground">
                Library Files receive paths in this Page
              </div>
            </div>
          ) : null}
          <NodexDialogHeader className="border-b-[0.5px] border-token-border pb-3">
            <div className="flex items-center justify-between gap-4 pr-8">
              <div>
                <NodexDialogTitle>Page files</NodexDialogTitle>
              </div>
              <div className="flex gap-1">
                <NodexIconButton
                  icon={FolderOpenIcon}
                  ariaLabel="Browse Library"
                  disabled={!canWrite || mutating}
                  onClick={() => {
                    onClose();
                    openModal(appHandle, LibraryFilesDialog, {
                      accessContext,
                      pageTarget: {
                        pageId,
                        manifestRevision: value.revision,
                        onAttached: async () => refresh(),
                      },
                    });
                  }}
                />
                <NodexIconButton
                  icon={FolderPlusIcon}
                  ariaLabel="Add folder"
                  disabled={mutating || !authority || !canWrite}
                  onClick={() => void addLocalSelection("directory")}
                />
                <NodexDialogAction
                  tone="primary"
                  size="compact"
                  disabled={mutating || !authority || !canWrite}
                  onClick={() => void addLocalSelection("files")}
                >
                  {mutating ? <ActivitySpinnerIcon className="size-3" /> : <PlusIcon />}
                  Add files
                </NodexDialogAction>
              </div>
            </div>
            <input
              ref={replaceInputRef}
              hidden
              type="file"
              onChange={(event) => void replaceSelected(event.currentTarget.files)}
            />
          </NodexDialogHeader>
          <NodexDialogBody className="grid min-h-0 flex-1 grid-cols-[minmax(250px,0.82fr)_minmax(0,1.18fr)] gap-0 overflow-hidden p-0">
            <section className="flex min-h-0 flex-col border-r-[0.5px] border-token-border p-3">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search paths and names"
                aria-label="Search Page Files"
                className="h-8 rounded-lg bg-token-foreground/4 px-2.5 text-sm outline-none ring-[0.5px] ring-inset ring-token-border focus:ring-1 focus:ring-token-focus"
              />
              <div className="mt-2 min-h-0 flex-1 overflow-auto">
                {inventory.loading ? (
                  <div className="flex h-32 items-center justify-center" role="status">
                    <ActivitySpinnerIcon className="size-4" />
                  </div>
                ) : null}
                {!inventory.loading && value.files.length === 0 ? (
                  <button
                    type="button"
                    className="flex h-40 w-full flex-col items-center justify-center gap-1 text-sm text-token-description-foreground"
                    onClick={() => void addLocalSelection("files")}
                  >
                    <FileIcon className="size-5" />
                    {query.trim() ? "No matching Files" : "Add a File or browse the Library"}
                  </button>
                ) : null}
                {fileGroups.map((group) => (
                  <section key={group.label} aria-label={group.label} className="mb-3 last:mb-0">
                    <h3 className="flex items-baseline gap-1.5 pb-1 pt-2 text-xs font-medium text-token-description-foreground">
                      {group.label}
                      <span className="text-[11px] font-normal tabular-nums opacity-70">
                        {group.count}
                      </span>
                    </h3>
                    {group.files.map((item) => (
                      <button
                        key={item.file.file_id}
                        type="button"
                        aria-label={`Preview ${rowLabel(item)}`}
                        aria-pressed={selectedFileId === item.file.file_id}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-token-foreground/4 focus-visible:ring-2 focus-visible:ring-token-focus",
                          selectedFileId === item.file.file_id && "bg-token-foreground/7",
                        )}
                        onClick={() => setSelectedFileId(item.file.file_id)}
                      >
                        <ColorfulFileResourceIcon
                          path={item.logical_path ?? item.file.default_name}
                          mimeType={item.file.mime_type}
                          className="size-5 shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-token-text-primary">
                            {item.logical_path ?? item.file.default_name}
                          </span>
                          <FileListMetadata file={item.file} />
                        </span>
                      </button>
                    ))}
                  </section>
                ))}
                {inventory.hasMore ? (
                  <button
                    type="button"
                    className="mt-1 w-full rounded-md py-2 text-xs text-token-description-foreground hover:bg-token-foreground/4"
                    disabled={inventory.loadingMore}
                    onClick={() => void inventory.loadMore()}
                  >
                    {inventory.loadingMore ? "Loading…" : "Load more"}
                  </button>
                ) : null}
              </div>
            </section>
            <section className="min-h-0 overflow-auto">
              {!selected ? (
                <div className="flex h-full items-center justify-center text-sm text-token-description-foreground">
                  Select a File
                </div>
              ) : (
                <div>
                  <div className="px-4 py-3">
                    <h3 className="truncate text-base font-medium text-token-text-primary">
                      {selected.file.default_name}
                    </h3>
                    <FileDetailsMetadata file={selected.file} />
                  </div>
                  {authority ? (
                    <FileReadBoundary
                      authority={{
                        ...authority,
                        readSource: { kind: "page", page_id: pageId },
                      }}
                    >
                      <ManagedFilePreview file={selected.file} />
                    </FileReadBoundary>
                  ) : null}
                  <FileDetailsToolbar
                    infoLabel="Page File paths and content"
                    info={
                      <>
                        <p>
                          {selected.body_count === 0
                            ? "Not placed in Page content"
                            : `${selected.body_count} content placement${selected.body_count === 1 ? "" : "s"}`}
                        </p>
                        <p>
                          Paths organize this Page. Removing a path keeps the Library File and its
                          content placements.
                        </p>
                        <p>
                          Replacing a path creates an independent File for that entry. Existing Page
                          content and other Pages stay unchanged.
                        </p>
                        <p>
                          Open in Library to manage shared content and versions. Direct File access
                          is required.
                        </p>
                      </>
                    }
                  >
                    <NodexIconButton
                      icon={DownloadIcon}
                      ariaLabel="Save"
                      disabled={mutating}
                      onClick={() => void saveFile()}
                    />
                    {selected.logical_path && canWrite ? (
                      <NodexIconButton
                        icon={ReplaceIcon}
                        ariaLabel="Replace path entry…"
                        disabled={mutating}
                        onClick={() => replaceInputRef.current?.click()}
                      />
                    ) : null}
                    <NodexIconButton
                      icon={OpenInIcon}
                      ariaLabel="Open in Library"
                      onClick={() => {
                        onClose();
                        openModal(appHandle, LibraryFilesDialog, {
                          accessContext,
                          initialFileId: selected.file.file_id,
                        });
                      }}
                    />
                    {selected.logical_path && canWrite ? (
                      <NodexIconButton
                        icon={DeleteIcon}
                        ariaLabel="Remove Page path"
                        tone="danger"
                        disabled={mutating}
                        onClick={() =>
                          void run(
                            async () =>
                              removePageEntry(
                                authority!,
                                pageId,
                                value.revision,
                                selected.file.file_id,
                              ),
                            "Page path removed; the File and content placements remain",
                          )
                        }
                      />
                    ) : null}
                  </FileDetailsToolbar>
                  {!canWrite ? (
                    <p className="px-4 text-xs text-token-description-foreground">
                      Read-only Page. Files can be previewed and saved.
                    </p>
                  ) : null}
                  <div className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-xs text-token-description-foreground">
                        Page path
                      </span>
                      {editingPath ? (
                        <div className="flex min-w-0 flex-1 gap-1">
                          <input
                            autoFocus
                            aria-label="Page path"
                            value={path}
                            onChange={(event) => setPath(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void savePath();
                              if (event.key === "Escape") setEditingPath(false);
                            }}
                            className="h-8 min-w-0 flex-1 rounded-md bg-token-foreground/4 px-2 text-sm outline-none ring-1 ring-token-focus"
                          />
                          <NodexDialogAction size="compact" onClick={() => void savePath()}>
                            Save
                          </NodexDialogAction>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={!canWrite || mutating}
                          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm text-token-text-secondary hover:bg-token-foreground/4"
                          onClick={() => {
                            setPath(selected.logical_path ?? selected.file.default_name);
                            setPathRevision(value.revision);
                            setEditingPath(true);
                          }}
                        >
                          <span className="truncate">{selected.logical_path ?? "Add a path"}</span>
                          <EditIcon className="size-3 shrink-0" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {inventory.error ? (
                <div className="border-t-[0.5px] border-token-border px-4 py-2 text-xs text-token-charts-red">
                  {inventory.error.message}
                </div>
              ) : null}
            </section>
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

const rowLabel = (item: LibraryPageFileItem): string => item.logical_path ?? item.file.default_name;

export function PageFilesRow({ baseFiles, controller, hidden = false }: PageFilesRowProps) {
  const appHandle = useScopeHandle(appScope);
  const pageId = controller.page?.id ?? "";
  const inventory = baseFiles.inventory ?? EMPTY_INVENTORY(pageId);
  const visible = inventory.files.filter((item) => item.body_count === 0).slice(0, 2);
  const remainingUnplaced = Math.max(0, inventory.unplaced_total - visible.length);
  const hiddenCount = remainingUnplaced + inventory.placed_total;
  const summaryShowsInPage = remainingUnplaced === 0 && inventory.placed_total > 0;

  if (!controller.page) return null;

  const openFiles = (initialFileId?: string): void => {
    openModal(appHandle, PageFilesDialog, {
      accessContext: controller.contentAccessContext,
      pageId,
      ...(initialFileId ? { initialFileId } : {}),
      onChanged: async () => {
        await baseFiles.refresh();
      },
    });
  };

  return (
    <div hidden={hidden} className="grid min-h-7.5 grid-cols-[10rem_minmax(0,1fr)] items-start">
      <div className="flex min-h-7.5 min-w-0 items-center gap-1.5 pl-1.5">
        <div className="flex w-5 shrink-0 items-center justify-center text-(--foreground-secondary)">
          <FileIcon className="size-4" />
        </div>
        <span className="min-w-0 truncate text-sm/5 text-(--foreground-secondary)">Files</span>
      </div>
      <div className="min-w-0 px-2 self-center">
        {baseFiles.error && !baseFiles.inventory ? (
          <button
            type="button"
            className="min-h-7 text-xs text-(--red-text)"
            onClick={() => void baseFiles.refresh()}
          >
            Couldn’t load Files · Retry
          </button>
        ) : null}
        {baseFiles.loading && !baseFiles.inventory ? (
          <div
            role="status"
            aria-label="Loading Page Files"
            className="flex h-7 items-center px-1.5 text-(--foreground-tertiary)"
          >
            <ActivitySpinnerIcon className="size-3.5" />
          </div>
        ) : null}
        {!baseFiles.loading && !baseFiles.error && inventory.total === 0 ? (
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
        {inventory.total > 0 ? (
          <div className="flex min-h-7 flex-wrap items-center gap-1 py-0.5">
            {visible.map((item) => (
              <button
                key={item.file.file_id}
                type="button"
                data-page-file-chip="true"
                aria-label={`Open ${rowLabel(item)}`}
                className={cn(
                  DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
                  "max-w-64 gap-1 text-token-text-secondary outline-none hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus",
                )}
                onClick={() => openFiles(item.file.file_id)}
              >
                <ColorfulFileResourceIcon
                  path={rowLabel(item)}
                  mimeType={item.file.mime_type}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{rowLabel(item)}</span>
                {item.body_count > 0 ? (
                  <span className="text-token-description-foreground">· {item.body_count}</span>
                ) : null}
              </button>
            ))}
            {hiddenCount > 0 ? (
              <button
                type="button"
                aria-label={
                  summaryShowsInPage
                    ? `Open ${inventory.placed_total} ${inventory.placed_total === 1 ? "File" : "Files"} shown in Page`
                    : `Open ${hiddenCount} more Page Files`
                }
                className={cn(
                  DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
                  "text-token-description-foreground",
                )}
                onClick={() => openFiles()}
              >
                {summaryShowsInPage ? `${inventory.placed_total} in page` : `+${hiddenCount}`}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Add Page Files"
              aria-busy={baseFiles.loading}
              className={pageStagePropertyAddControl}
              onClick={() => openFiles()}
            >
              <PlusIcon className="icon-2xs" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
