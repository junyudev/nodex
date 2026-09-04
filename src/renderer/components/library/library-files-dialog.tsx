import { FileDetailsMetadata, FileListMetadata } from "@/components/shared/file-metadata";
import { formatBytes, formatDate } from "@/lib/file-metadata-format";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { FileDetailsToolbar } from "@/components/shared/file-details-toolbar";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import {
  ActivitySpinnerIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  FileIcon,
  ProjectAccessIcon,
  PlusIcon,
  ReplaceIcon,
  UndoIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexIconButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  FileReadBoundary,
  useFilePlacementRuntime,
  useFileReadSnapshot,
} from "@/components/board/editor/file-runtime";
import {
  libraryContentAccess,
  type ContentAccessContext,
} from "../../../shared/content-access-context";
import type { LibraryFile, LibraryPageFileEntryReceipt } from "../../../shared/library-files";
import { fileSource } from "../../../shared/file-resources";
import {
  attachPageEntry,
  changeFileLifecycle,
  forkFile,
  importFiles,
  LibraryFileCommandError,
  renameFile,
  replaceFileContent,
} from "@/lib/library-file-commands";
import { appScope, useScopeHandle } from "@/lib/maitai";
import type { ModalCloseProps } from "@/lib/modal-registry";
import { openModal } from "@/lib/modal-registry";
import { queryKeys } from "@/lib/query-keys";
import {
  useLibraryFile,
  useLibraryFileCatalog,
  useLibraryFileDetail,
} from "@/lib/use-library-files";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { readPageFileInventoryPage, saveAuthorizedFile } from "@/lib/library-file-resources";
import { LibraryResourceAccessModal } from "./library-resource-action-modals";
import { cn } from "@/lib/utils";
import { useFileLocationNavigator } from "@/lib/file-location-navigation";

export interface LibraryFilesPageTarget {
  readonly pageId: string;
  readonly manifestRevision: number;
  readonly onAttached?: (receipt: LibraryPageFileEntryReceipt) => void | Promise<void>;
}

export interface LibraryFilesDialogProps extends ModalCloseProps {
  readonly accessContext?: ContentAccessContext;
  readonly pageTarget?: LibraryFilesPageTarget;
  readonly initialFileId?: string;
}

const isTextFile = (file: Pick<LibraryFile, "mime_type" | "default_name">): boolean =>
  file.mime_type.startsWith("text/") ||
  /\.(?:md|mdx|json|ya?ml|toml|xml|csv|tsv|tsx?|jsx?|py|rs|go|java|kt|swift|sh|css|scss|html)$/iu.test(
    file.default_name,
  );

export function ManagedFilePreview({ file }: { readonly file: LibraryFile }) {
  const runtime = useFilePlacementRuntime();
  const source = fileSource(file.file_id);
  const presentation = useFileReadSnapshot(runtime, source, { metadata: true });
  const target = presentation.metadata;
  const snapshot = useFileReadSnapshot(runtime, source, {
    metadata: true,
    content: Boolean(target && isTextFile(target) && target.byte_length <= 2 * 1_048_576),
    objectUrl: Boolean(target?.mime_type.startsWith("image/")),
  });

  if (snapshot.contentError || snapshot.metadataError) {
    return (
      <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-token-description-foreground">
        This File is no longer available in the current access context.
      </div>
    );
  }
  if (snapshot.contentLoading || snapshot.metadataLoading) {
    return (
      <div className="flex min-h-40 items-center justify-center text-token-description-foreground">
        <ActivitySpinnerIcon className="size-4" />
      </div>
    );
  }
  if (snapshot.objectUrl) {
    return (
      <div className="flex min-h-40 items-center justify-center overflow-hidden bg-token-foreground/3 p-4">
        <img
          src={snapshot.objectUrl}
          alt={target?.default_name ?? file.default_name}
          className="max-h-72 max-w-full object-contain"
        />
      </div>
    );
  }
  if (snapshot.bytes && target && isTextFile(target)) {
    return (
      <pre className="max-h-72 min-h-40 overflow-auto whitespace-pre-wrap break-words bg-token-foreground/3 p-4 font-mono text-xs/5 text-token-text-secondary">
        {new TextDecoder().decode(snapshot.bytes.bytes)}
      </pre>
    );
  }
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 bg-token-foreground/3 text-token-description-foreground">
      <ColorfulFileResourceIcon
        path={file.default_name}
        mimeType={file.mime_type}
        className="size-8"
      />
      <span className="text-sm">
        {target && isTextFile(target) && target.byte_length > 2 * 1_048_576
          ? "Text preview is limited to 2 MiB. Save the File to read it."
          : "Preview isn’t available for this format"}
      </span>
    </div>
  );
}

const commandMessage = (error: unknown): string => {
  if (error instanceof LibraryFileCommandError && error.code === "revision_conflict") {
    return "The File changed elsewhere. Review the latest version before trying again.";
  }
  return error instanceof Error ? error.message : "Couldn’t update File";
};

export function LibraryFilesDialog(props: LibraryFilesDialogProps) {
  return (
    <LibraryFilesDialogContent
      key={JSON.stringify([
        props.accessContext ?? libraryContentAccess,
        props.initialFileId ?? null,
        props.pageTarget?.pageId ?? null,
      ])}
      {...props}
    />
  );
}

function LibraryFilesDialogContent({
  accessContext = libraryContentAccess,
  pageTarget,
  initialFileId,
  onClose,
}: LibraryFilesDialogProps) {
  const appHandle = useScopeHandle(appScope);
  const openLocation = useFileLocationNavigator();
  const queryClient = useQueryClient();
  const metadata = useLibraryMetadata();
  const [filter, setFilter] = useState<"all" | "unused" | "trash">("all");
  const [query, setQuery] = useState("");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(initialFileId ?? null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [entryPath, setEntryPath] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [nameRevision, setNameRevision] = useState<number | null>(null);
  const [mutating, setMutating] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [pageManifestRevision, setPageManifestRevision] = useState(
    pageTarget?.manifestRevision ?? 0,
  );
  const importInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const catalog = useLibraryFileCatalog(accessContext, {
    lifecycle: filter === "trash" ? "trashed" : "live",
    usage: filter === "unused" ? "unused" : "all",
    query,
  });
  const identity = useLibraryFile(accessContext, selectedFileId);
  const selected = identity.file;
  const detail = useLibraryFileDetail(
    accessContext,
    pageTarget ? null : (selected?.file_id ?? null),
  );
  const previewVersion = selectedVersion ?? selected?.head_version ?? null;
  const versionMetadata = detail.versions.find((version) => version.version === previewVersion);

  useEffect(() => {
    if (selectedFileId === null && catalog.files.length > 0)
      setSelectedFileId(catalog.files[0]!.file_id);
  }, [catalog.files, selectedFileId]);

  useEffect(() => {
    setSelectedVersion(null);
    setConfirmPurge(false);
    setEditingName(false);
    setEntryPath(null);
  }, [selectedFileId]);

  const authority = metadata.data
    ? {
        contentAccessContext: accessContext,
        libraryId: metadata.data.libraryId,
        storeEpoch: metadata.data.storeEpoch,
      }
    : null;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.libraryFiles.all() });
    await catalog.refresh();
  };

  const runMutation = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    if (!authority || mutating) return;
    setMutating(true);
    try {
      await action();
      await refresh();
      toast.success(success);
    } catch (error) {
      if (error instanceof LibraryFileCommandError && error.code === "revision_conflict") {
        await refresh();
        const current = await identity.refresh();
        if (current) setNameRevision(current.revision);
        if (pageTarget) {
          const inventory = await readPageFileInventoryPage(accessContext, pageTarget.pageId, {
            limit: 1,
          });
          setPageManifestRevision(inventory.revision);
        }
      }
      toast.danger(commandMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const renameSelected = async (): Promise<void> => {
    const nextName = name.trim();
    if (!selected || !nextName || nextName === selected.default_name) {
      setEditingName(false);
      return;
    }
    await runMutation(async () => {
      await renameFile(
        authority!,
        { ...selected, revision: nameRevision ?? selected.revision },
        nextName,
      );
      setEditingName(false);
    }, "File renamed");
  };

  const importSelected = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    if (!authority || mutating) return;
    setMutating(true);
    try {
      const result = await importFiles(authority, Array.from(files));
      setImportReport(
        result.failures.length
          ? `${result.imported.length} imported; ${result.failures.length} failed. ${result.failures.map((failure) => `${failure.name}: ${failure.message}`).join("; ")} Retry only failed files.`
          : `${result.imported.length} Files imported`,
      );
      await refresh();
      if (result.imported[0]) setSelectedFileId(result.imported[0].file_id);
    } catch (error) {
      setImportReport(commandMessage(error));
    } finally {
      setMutating(false);
    }
    if (importInputRef.current) importInputRef.current.value = "";
  };

  const replaceSelected = async (files: FileList | null): Promise<void> => {
    const replacement = files?.[0];
    if (!selected || !replacement) return;
    await runMutation(
      async () => replaceFileContent(authority!, selected, replacement),
      "Shared File updated",
    );
    if (replaceInputRef.current) replaceInputRef.current.value = "";
  };

  const attachSelected = async (): Promise<void> => {
    if (!selected || !pageTarget || !(entryPath ?? selected.default_name).trim()) return;
    await runMutation(async () => {
      const receipt = await attachPageEntry(
        authority!,
        pageTarget.pageId,
        pageManifestRevision,
        selected.file_id,
        (entryPath ?? selected.default_name).trim(),
        { kind: "direct" },
      );
      setPageManifestRevision(receipt.manifest_revision);
      await pageTarget.onAttached?.(receipt);
    }, "File added to Page");
  };

  const saveSelected = async (): Promise<void> => {
    if (!selected || !authority || previewVersion === null) return;
    try {
      await saveAuthorizedFile(
        { ...authority, readSource: { kind: "direct" }, version: previewVersion },
        fileSource(selected.file_id),
        selected.default_name,
      );
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t save File");
    }
  };

  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent size="large">
        <NodexDialogFrame className="h-[min(760px,84vh)] overflow-hidden">
          <NodexDialogHeader className="border-b-[0.5px] border-token-border pb-3">
            <div className="flex items-center justify-between gap-4 pr-8">
              <div>
                <NodexDialogTitle>
                  {pageTarget ? "Add existing File" : "Library files"}
                </NodexDialogTitle>
                {pageTarget ? (
                  <p className="mt-0.5 text-sm text-token-description-foreground">
                    Choose a File and a path for this Page.
                  </p>
                ) : null}
              </div>
              {!pageTarget ? (
                <NodexDialogAction
                  tone="primary"
                  size="compact"
                  disabled={!authority || mutating}
                  onClick={() => importInputRef.current?.click()}
                >
                  {mutating ? <ActivitySpinnerIcon className="size-3" /> : <PlusIcon />}
                  Import
                </NodexDialogAction>
              ) : null}
            </div>
            <input
              ref={importInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => void importSelected(event.currentTarget.files)}
            />
            <input
              ref={replaceInputRef}
              type="file"
              hidden
              onChange={(event) => void replaceSelected(event.currentTarget.files)}
            />
          </NodexDialogHeader>
          <NodexDialogBody className="grid min-h-0 flex-1 grid-cols-[minmax(250px,0.82fr)_minmax(0,1.18fr)] gap-0 overflow-hidden p-0">
            <section className="flex min-h-0 flex-col border-r-[0.5px] border-token-border p-3">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search Library files"
                placeholder="Search files"
                className="h-8 rounded-lg bg-token-foreground/4 px-2.5 text-sm outline-none ring-[0.5px] ring-inset ring-token-border focus:ring-1 focus:ring-token-focus"
              />
              <div className="mt-2 flex gap-1" aria-label="File filters">
                {(["all", "unused", "trash"] as const)
                  .filter((value) => !pageTarget || value !== "trash")
                  .map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs capitalize text-token-description-foreground hover:bg-token-foreground/5",
                        filter === value && "bg-token-foreground/7 text-token-text-primary",
                      )}
                      onClick={() => {
                        setFilter(value);
                        setSelectedFileId(null);
                      }}
                    >
                      {value}
                    </button>
                  ))}
              </div>
              <div className="mt-2 min-h-0 flex-1 overflow-auto">
                {catalog.loading ? (
                  <div className="flex h-32 items-center justify-center" role="status">
                    <ActivitySpinnerIcon className="size-4" />
                  </div>
                ) : null}
                {!catalog.loading && catalog.files.length === 0 ? (
                  <div className="flex h-32 flex-col items-center justify-center gap-1 text-center text-sm text-token-description-foreground">
                    <FileIcon className="size-5" />
                    {query.trim()
                      ? "No matching files"
                      : filter === "trash"
                        ? "Trash is empty"
                        : "No files yet"}
                  </div>
                ) : null}
                {catalog.files.map((file) => (
                  <button
                    key={file.file_id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-token-foreground/4 focus-visible:ring-2 focus-visible:ring-token-focus",
                      file.file_id === selectedFileId && "bg-token-foreground/7",
                    )}
                    onClick={() => setSelectedFileId(file.file_id)}
                  >
                    <ColorfulFileResourceIcon
                      path={file.default_name}
                      mimeType={file.mime_type}
                      className="size-5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-token-text-primary">
                        {file.default_name}
                      </span>
                      <FileListMetadata file={file} />
                    </span>
                  </button>
                ))}
                {catalog.hasMore ? (
                  <button
                    type="button"
                    disabled={catalog.loadingMore}
                    className="mt-1 w-full rounded-md py-2 text-xs text-token-description-foreground hover:bg-token-foreground/4"
                    onClick={() => void catalog.loadMore()}
                  >
                    {catalog.loadingMore ? "Loading…" : `Load more · ${catalog.total} total`}
                  </button>
                ) : null}
              </div>
            </section>
            <section className="min-h-0 overflow-auto">
              {importReport ? (
                <p role="status" className="max-h-24 overflow-auto break-words px-4 py-2 text-sm">
                  {importReport}
                </p>
              ) : null}
              {!selected ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-token-description-foreground">
                  <FileIcon className="size-6" />
                  <span className="text-sm">
                    {identity.loading
                      ? "Loading File…"
                      : identity.error
                        ? "This File is unavailable or requires direct File access. Open its Page to preview or save it."
                        : "Select a File"}
                  </span>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      {editingName ? (
                        <div className="flex gap-1.5">
                          <input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void renameSelected();
                              if (event.key === "Escape") setEditingName(false);
                            }}
                            className="h-8 min-w-0 flex-1 rounded-md bg-token-foreground/4 px-2 text-sm outline-none ring-1 ring-token-focus"
                          />
                          <NodexDialogAction size="compact" onClick={() => void renameSelected()}>
                            Save
                          </NodexDialogAction>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(pageTarget) || mutating || !detail.canWrite}
                          className="group flex max-w-full items-center gap-1 text-left"
                          onClick={() => {
                            setName(selected.default_name);
                            setNameRevision(selected.revision);
                            setEditingName(true);
                          }}
                        >
                          <span className="truncate text-base font-medium text-token-text-primary">
                            {selected.default_name}
                          </span>
                          {detail.canWrite ? (
                            <EditIcon className="size-3 opacity-0 group-hover:opacity-60" />
                          ) : null}
                        </button>
                      )}
                      <FileDetailsMetadata
                        file={selected}
                        version={previewVersion ?? selected.head_version}
                        mimeType={versionMetadata?.mime_type ?? selected.mime_type}
                        byteLength={versionMetadata?.byte_length ?? selected.byte_length}
                      />
                    </div>
                    {pageTarget && selected.lifecycle === "live" ? (
                      <div>
                        <input
                          aria-label="Path in Page"
                          placeholder={selected.default_name}
                          value={entryPath ?? selected.default_name}
                          onChange={(event) => setEntryPath(event.target.value)}
                          className="mb-1 h-8 rounded-md bg-token-foreground/4 px-2 text-sm"
                        />
                        <NodexDialogAction
                          tone="primary"
                          size="compact"
                          disabled={mutating || !(entryPath ?? selected.default_name).trim()}
                          onClick={() => void attachSelected()}
                        >
                          Add to Page
                        </NodexDialogAction>
                      </div>
                    ) : null}
                  </div>
                  {!pageTarget && previewVersion !== selected.head_version ? (
                    <p className="px-4 pb-2 text-xs text-token-description-foreground">
                      Previewing v{previewVersion}. Current shared content is v
                      {selected.head_version}.
                    </p>
                  ) : null}
                  {!pageTarget && !detail.loading && !detail.error && !detail.canWrite ? (
                    <p className="px-4 pb-2 text-xs text-token-description-foreground">
                      Read-only File. Save or make an independent copy to work with this content.
                    </p>
                  ) : null}
                  {authority && previewVersion !== null ? (
                    <FileReadBoundary
                      authority={{
                        ...authority,
                        readSource: { kind: "direct" },
                        version: previewVersion,
                      }}
                    >
                      <ManagedFilePreview file={selected} />
                    </FileReadBoundary>
                  ) : null}
                  {!pageTarget ? (
                    <FileDetailsToolbar
                      infoLabel="File sharing and retention"
                      info={
                        <>
                          <p>
                            Page references follow shared updates. Canvas images and history keep
                            their captured versions.
                          </p>
                          {!detail.loading &&
                          !detail.error &&
                          detail.canWrite &&
                          (selected.lifecycle === "live" ? !detail.canTrash : !detail.canPurge) ? (
                            <p>
                              {selected.lifecycle === "live"
                                ? "Remove current or recoverable Page and Canvas uses before moving this File to Trash."
                                : "History or saved edits retain this File. Permanent deletion is unavailable while that evidence remains."}
                            </p>
                          ) : null}
                        </>
                      }
                    >
                      <NodexIconButton
                        icon={DownloadIcon}
                        ariaLabel={
                          previewVersion === selected.head_version
                            ? "Save"
                            : `Save v${previewVersion}`
                        }
                        disabled={mutating}
                        onClick={() => void saveSelected()}
                      />
                      {selected.lifecycle === "live" && detail.canWrite ? (
                        <NodexIconButton
                          icon={ReplaceIcon}
                          ariaLabel="Update shared content…"
                          disabled={mutating}
                          onClick={() => replaceInputRef.current?.click()}
                        />
                      ) : null}
                      {selected.lifecycle === "live" ? (
                        <NodexIconButton
                          icon={CopyIcon}
                          ariaLabel={`Copy v${previewVersion} as independent File`}
                          disabled={mutating}
                          onClick={() =>
                            void runMutation(async () => {
                              const copy = await forkFile(authority!, {
                                ...selected,
                                version: previewVersion!,
                              });
                              setSelectedFileId(copy.file_id);
                            }, "Independent copy created")
                          }
                        />
                      ) : null}
                      {accessContext.kind === "library" ? (
                        <NodexIconButton
                          icon={ProjectAccessIcon}
                          ariaLabel="Project access"
                          onClick={() =>
                            openModal(appHandle, LibraryResourceAccessModal, {
                              target: { kind: "file", fileId: selected.file_id },
                              title: selected.default_name,
                            })
                          }
                        />
                      ) : null}
                      {detail.canTrash ? (
                        <NodexIconButton
                          icon={DeleteIcon}
                          ariaLabel="Trash"
                          disabled={mutating}
                          tone="danger"
                          onClick={() =>
                            void runMutation(
                              async () => changeFileLifecycle(authority!, selected, "trash"),
                              "File moved to Trash",
                            )
                          }
                        />
                      ) : null}
                      {detail.canRestore ? (
                        <NodexIconButton
                          icon={UndoIcon}
                          ariaLabel="Restore"
                          disabled={mutating}
                          onClick={() =>
                            void runMutation(
                              async () => changeFileLifecycle(authority!, selected, "restore"),
                              "File restored",
                            )
                          }
                        />
                      ) : null}
                      {detail.canPurge ? (
                        <NodexIconButton
                          icon={DeleteIcon}
                          ariaLabel="Delete permanently"
                          disabled={mutating}
                          tone="danger"
                          onClick={() => setConfirmPurge(true)}
                        />
                      ) : null}
                    </FileDetailsToolbar>
                  ) : null}
                  {confirmPurge ? (
                    <div className="flex items-center justify-between gap-3 bg-token-charts-red/6 px-4 py-2 text-xs text-token-text-secondary">
                      <span>
                        This permanently removes the File identity and all of its versions.
                      </span>
                      <span className="flex gap-1">
                        <button
                          type="button"
                          className="rounded px-2 py-1"
                          onClick={() => setConfirmPurge(false)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="rounded bg-token-charts-red/15 px-2 py-1 text-token-charts-red"
                          onClick={() =>
                            void runMutation(
                              async () => changeFileLifecycle(authority!, selected, "purge"),
                              "File permanently deleted",
                            )
                          }
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                  ) : null}
                  {!pageTarget ? (
                    <div className="flex flex-col gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <h3 className="text-xs font-medium text-token-text-secondary">Versions</h3>
                        <div className="mt-1.5 space-y-1">
                          {detail.versions.map((version) => (
                            <NodexTooltip
                              key={version.version}
                              tooltipContent={formatDate(version.occurred_at)}
                            >
                              <button
                                type="button"
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-xs text-token-text-secondary hover:bg-token-foreground/4",
                                  previewVersion === version.version &&
                                    "bg-token-foreground/7 text-token-text-primary",
                                )}
                                onClick={() => setSelectedVersion(version.version)}
                              >
                                <span className="shrink-0">
                                  v{version.version} · {formatBytes(version.byte_length)}
                                </span>
                                <span className="truncate text-token-description-foreground">
                                  {formatDate(version.occurred_at)}
                                </span>
                              </button>
                            </NodexTooltip>
                          ))}
                        </div>
                        {detail.hasMoreVersions ? (
                          <button
                            type="button"
                            className="mt-2 text-xs text-token-description-foreground hover:text-token-text-primary"
                            onClick={() => void detail.loadMoreVersions()}
                          >
                            {detail.loadingMoreVersions ? "Loading…" : "Load more versions"}
                          </button>
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-xs font-medium text-token-text-secondary">Uses</h3>
                        {detail.usages.length === 0 ? (
                          <p className="mt-2 text-sm text-token-description-foreground">
                            No visible current uses
                          </p>
                        ) : (
                          <ul className="mt-2 space-y-2">
                            {detail.usages.map((usage) => (
                              <li
                                key={`${usage.target.kind}:${JSON.stringify(usage.target)}:${usage.logical_path ?? ""}`}
                                className="text-sm text-token-text-secondary"
                              >
                                <NodexTooltip tooltipContent={usage.title || "Untitled"}>
                                  <button
                                    type="button"
                                    disabled={!openLocation || usage.lifecycle !== "active"}
                                    className="block w-full truncate text-left underline decoration-token-border underline-offset-2"
                                    onClick={() => {
                                      if (!openLocation || usage.target.kind === "database") return;
                                      const target =
                                        usage.target.kind === "page"
                                          ? { kind: "page" as const, pageId: usage.target.page_id }
                                          : {
                                              kind: "canvas" as const,
                                              canvasId: usage.target.canvas_id,
                                            };
                                      void openLocation(target)
                                        .then((opened) => {
                                          if (opened) onClose();
                                        })
                                        .catch((error) => toast.danger(commandMessage(error)));
                                    }}
                                  >
                                    {usage.title || "Untitled"}
                                  </button>
                                </NodexTooltip>
                                {usage.logical_path ? (
                                  <NodexTooltip tooltipContent={usage.logical_path}>
                                    <p className="truncate text-xs text-token-description-foreground">
                                      {usage.logical_path}
                                    </p>
                                  </NodexTooltip>
                                ) : null}
                                <p className="truncate text-xs text-token-description-foreground">
                                  {usage.target.kind === "page"
                                    ? "Latest content"
                                    : "Fixed version"}
                                  {usage.lifecycle !== "active" ? ` · ${usage.lifecycle}` : ""}
                                  {usage.occurrence_count > 0
                                    ? ` · ${usage.occurrence_count} use${usage.occurrence_count === 1 ? "" : "s"}`
                                    : ""}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}
                        {detail.hasMoreUsages ? (
                          <p className="mt-1 text-xs text-token-description-foreground">
                            Showing {detail.usages.length} authorized locations; more are available.
                          </p>
                        ) : null}
                        {detail.hasMoreUsages ? (
                          <button
                            type="button"
                            className="mt-2 text-xs text-token-description-foreground hover:text-token-text-primary"
                            onClick={() => void detail.loadMoreUsages()}
                          >
                            {detail.loadingMoreUsages ? "Loading…" : "Load more locations"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
              {catalog.error || detail.error ? (
                <div className="border-t-[0.5px] border-token-border px-4 py-2 text-xs text-token-charts-red">
                  {(catalog.error ?? detail.error)?.message}
                </div>
              ) : null}
            </section>
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
