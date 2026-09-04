import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Route, ShieldCheck } from "@/components/shared/icons/generic-icons";
import {
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  HistoryIcon,
  ThreadSummaryCommitIcon,
} from "@/components/shared/icons";

import { NodexButton } from "@/components/ui/button";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useMutationAuditSessionId } from "@/lib/mutation-audit-session";
import { createUuidV7 } from "../../../shared/uuid-v7";
import {
  DEFAULT_PAGE_HISTORY_PAGE_SIZE,
  type PageHistoryCursor,
  type PageHistoryEntry,
} from "../../../shared/page-history";
import {
  type DocumentVersionDetail,
  type PrepareDocumentVersionRestore,
} from "../../../shared/block-documents/document-history";
import { CanvasFilePreview } from "../canvas/canvas-file-preview";
import { ReadonlyNfmBlockNotePreview } from "./editor/readonly-nfm-blocknote-preview";
import { mergePageHistoryEntries } from "./page-history-view-model";
import {
  getDocumentVersion,
  getOwnedDocumentDescriptor,
  listPageHistory,
  restoreDocumentVersion,
} from "./history-panel-deps";

import type { LibraryFileAuthority } from "@/lib/library-file-resources";

type HistoryFilter = "revisions" | "activity";

const HISTORY_FILTERS: ReadonlyArray<{
  readonly value: HistoryFilter;
  readonly label: string;
}> = [
  { value: "revisions", label: "Revisions" },
  { value: "activity", label: "Activity" },
];

export interface HistoryPanelProps {
  fileAuthority: LibraryFileAuthority | null;
  projectId: string;
  pageId: string | null;
  pageTitle?: string;
  pageNfm?: string;
  projectWorkspacePath?: string | null;
  open: boolean;
  onClose: () => void;
  onPageMutated?: () => void;
}

const matchesFilter = (entry: PageHistoryEntry, filter: HistoryFilter): boolean => {
  if (filter === "revisions") return entry.kind === "document_version";
  return entry.kind !== "document_version";
};

export function HistoryPanel({
  fileAuthority,
  projectId,
  pageId,
  pageTitle,
  pageNfm,
  projectWorkspacePath,
  open,
  onClose,
  onPageMutated,
}: HistoryPanelProps) {
  const auditSessionId = useMutationAuditSessionId();
  const requestSerialRef = useRef(0);
  const restoreInFlightRef = useRef(false);
  const pendingRestoreRef = useRef<{
    readonly entryId: string;
    readonly request: PrepareDocumentVersionRestore;
  } | null>(null);
  const [entries, setEntries] = useState<readonly PageHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<PageHistoryCursor | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("revisions");
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [previewCache, setPreviewCache] = useState<ReadonlyMap<string, DocumentVersionDetail>>(
    () => new Map(),
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const loadFirstPage = useCallback(
    async (targetPageId: string) => {
      const requestSerial = requestSerialRef.current + 1;
      requestSerialRef.current = requestSerial;
      setLoading(true);
      setLoadingOlder(false);
      setTimelineError(null);
      setEntries([]);
      setNextCursor(null);
      setSelectedEntryId(null);
      setPreviewCache(new Map());
      try {
        const result = await listPageHistory({
          requestingProjectId: projectId,
          pageId: targetPageId,
          pageSize: DEFAULT_PAGE_HISTORY_PAGE_SIZE,
        });
        if (requestSerial !== requestSerialRef.current) return;
        if (!result.ok) {
          setEntries([]);
          setNextCursor(null);
          setTimelineError(result.error.message);
          return;
        }
        setEntries(result.value.entries);
        setNextCursor(result.value.nextCursor);
        setSelectedEntryId((current) => {
          if (current && result.value.entries.some((entry) => entry.id === current)) {
            return current;
          }
          return "current";
        });
      } catch (error) {
        if (requestSerial !== requestSerialRef.current) return;
        setEntries([]);
        setNextCursor(null);
        setTimelineError(toErrorMessage(error, "Couldn’t load Page history."));
      } finally {
        if (requestSerial === requestSerialRef.current) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!open || !pageId) return;
    void loadFirstPage(pageId);
  }, [pageId, loadFirstPage, open]);

  useEffect(() => {
    if (open) return;
    requestSerialRef.current += 1;
    setEntries([]);
    setNextCursor(null);
    setSelectedEntryId(null);
    setFilter("revisions");
    setTimelineError(null);
    setPreviewCache(new Map());
    setPreviewError(null);
    setConfirmingRestore(false);
    setRestoreError(null);
    pendingRestoreRef.current = null;
  }, [open]);

  const filteredEntries = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, filter)),
    [entries, filter],
  );

  useEffect(() => {
    if (filter === "revisions" && selectedEntryId === "current") return;
    if (filteredEntries.some((entry) => entry.id === selectedEntryId)) return;
    setSelectedEntryId(filter === "revisions" ? "current" : (filteredEntries[0]?.id ?? null));
  }, [filter, filteredEntries, selectedEntryId]);

  const selectedIsCurrent = filter === "revisions" && selectedEntryId === "current";
  const selectedIndex = filteredEntries.findIndex((entry) => entry.id === selectedEntryId);
  const selectedEntry = selectedIndex < 0 ? null : (filteredEntries[selectedIndex] ?? null);
  const selectedPreview = selectedEntry ? (previewCache.get(selectedEntry.id) ?? null) : null;

  useEffect(() => {
    setConfirmingRestore(false);
    setRestoreError(null);
    pendingRestoreRef.current = null;
    if (!selectedEntry || selectedEntry.kind !== "document_version") {
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }
    if (previewCache.has(selectedEntry.id)) {
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void getDocumentVersion({
      projectId,
      documentId: selectedEntry.documentId,
      versionId: selectedEntry.versionMetadata.versionId,
    })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setPreviewError(result.error.message);
          return;
        }
        setPreviewCache((current) => {
          const next = new Map(current);
          next.set(selectedEntry.id, result.value);
          return next;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewError(toErrorMessage(error, "Revision preview is unavailable."));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [previewCache, projectId, selectedEntry]);

  const navigate = useCallback(
    (direction: -1 | 1) => {
      const selectableIds = [
        ...(filter === "revisions" ? ["current"] : []),
        ...filteredEntries.map((entry) => entry.id),
      ];
      if (selectableIds.length === 0) return;
      const currentIndex = selectableIds.indexOf(selectedEntryId ?? "");
      const nextIndex =
        currentIndex < 0
          ? 0
          : Math.min(selectableIds.length - 1, Math.max(0, currentIndex + direction));
      setSelectedEntryId(selectableIds[nextIndex] ?? null);
    },
    [filter, filteredEntries, selectedEntryId],
  );

  const handleTimelineKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        navigate(1);
        return;
      }
      if (event.key !== "ArrowUp") return;
      event.preventDefault();
      navigate(-1);
    },
    [navigate],
  );

  const handleLoadOlder = useCallback(async () => {
    if (!pageId || !nextCursor || loadingOlder) return;
    const cursor = nextCursor;
    const requestSerial = requestSerialRef.current;
    setLoadingOlder(true);
    setTimelineError(null);
    try {
      const result = await listPageHistory({
        requestingProjectId: projectId,
        pageId: pageId,
        before: cursor,
        pageSize: DEFAULT_PAGE_HISTORY_PAGE_SIZE,
      });
      if (requestSerial !== requestSerialRef.current) return;
      if (!result.ok) {
        setTimelineError(result.error.message);
        return;
      }
      setEntries((current) => mergePageHistoryEntries(current, result.value.entries));
      setNextCursor(result.value.nextCursor);
    } catch (error) {
      if (requestSerial !== requestSerialRef.current) return;
      setTimelineError(toErrorMessage(error, "Couldn’t load earlier history."));
    } finally {
      if (requestSerial === requestSerialRef.current) setLoadingOlder(false);
    }
  }, [pageId, loadingOlder, nextCursor, projectId]);

  const handleRestore = useCallback(async () => {
    if (
      restoreInFlightRef.current ||
      !pageId ||
      !selectedEntry ||
      selectedEntry.recovery.kind !== "restore_document_version"
    ) {
      return;
    }
    restoreInFlightRef.current = true;
    setRestoring(true);
    setRestoreError(null);
    try {
      let pendingRestore = pendingRestoreRef.current;
      if (!pendingRestore || pendingRestore.entryId !== selectedEntry.id) {
        const descriptor = await getOwnedDocumentDescriptor(projectId, pageId);
        if (descriptor.readiness !== "ready") {
          throw new Error("This Page must finish syncing before it can be restored.");
        }
        if (descriptor.documentId !== selectedEntry.recovery.documentId) {
          throw new Error("This revision no longer belongs to the Page document.");
        }
        pendingRestore = {
          entryId: selectedEntry.id,
          request: {
            mutationId: createUuidV7(),
            projectId,
            storeEpoch: descriptor.storeEpoch,
            documentId: descriptor.documentId,
            versionId: selectedEntry.recovery.versionId,
            generation: descriptor.generation,
            expectedHeadSeq: descriptor.headSeq,
            clientSessionId: auditSessionId,
            actor: { kind: "renderer_history_restore" },
          },
        };
        pendingRestoreRef.current = pendingRestore;
      }

      const commit = () =>
        restoreDocumentVersion(
          projectId,
          pendingRestore.request.documentId,
          pendingRestore.request,
        );
      let result;
      let retried = false;
      try {
        result = await commit();
      } catch {
        retried = true;
        result = await commit();
      }
      if (!result.ok && result.error.retryable && !retried) {
        result = await commit();
      }
      if (!result.ok) {
        if (!result.error.retryable) pendingRestoreRef.current = null;
        throw new Error(result.error.message);
      }
      pendingRestoreRef.current = null;
      setConfirmingRestore(false);
      onPageMutated?.();
      await loadFirstPage(pageId);
    } catch (error) {
      setRestoreError(toErrorMessage(error, "Couldn’t restore this revision."));
    } finally {
      restoreInFlightRef.current = false;
      setRestoring(false);
    }
  }, [auditSessionId, pageId, loadFirstPage, onPageMutated, projectId, selectedEntry]);

  if (!open) return null;

  const previewTitle =
    selectedPreview?.materialization.kind === "page"
      ? selectedPreview.materialization.title
      : pageTitle;

  return (
    <NodexDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <NodexDialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName="bg-black/55"
        style={{
          width: "min(94vw, 1180px)",
          maxWidth: "calc(100vw - 1.5rem)",
          height: "min(88vh, 760px)",
        }}
        className={cn(
          "grid max-w-none grid-cols-1 gap-0 sm:max-w-none",
          "md:grid-cols-[minmax(0,1fr)_20rem]",
        )}
      >
        <NodexDialogTitle className="sr-only">Page history</NodexDialogTitle>

        <section className="flex min-h-0 min-w-0 flex-col bg-token-main-surface-primary">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b-[0.5px] border-token-border px-3">
            <HistoryIcon className="icon-2xs shrink-0 text-token-description-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-token-text-secondary">
              {previewTitle ?? pageTitle ?? "Untitled Page"}
            </span>
            {selectedIsCurrent ? (
              <span className="hidden shrink-0 text-xs text-token-description-foreground sm:block">
                Current
              </span>
            ) : selectedEntry ? (
              <time
                dateTime={selectedEntry.occurredAt}
                className="hidden shrink-0 text-xs text-token-description-foreground sm:block"
              >
                {formatAbsoluteTimestamp(selectedEntry.occurredAt)}
              </time>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {loading ? (
              <HistoryEmptyState>Loading Page history…</HistoryEmptyState>
            ) : timelineError && entries.length === 0 ? (
              <HistoryEmptyState>{timelineError}</HistoryEmptyState>
            ) : selectedIsCurrent ? (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                <HistoryCurrentRevisionPreview
                  fileAuthority={fileAuthority}
                  projectId={projectId}
                  pageId={pageId}
                  title={pageTitle}
                  nfm={pageNfm}
                  projectWorkspacePath={projectWorkspacePath}
                />
              </div>
            ) : entries.length === 0 ? (
              <HistoryEmptyState>No durable revisions for this Page yet.</HistoryEmptyState>
            ) : selectedEntry ? (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                {selectedEntry.kind === "document_version" ? (
                  <HistoryRevisionPreview
                    fileAuthority={fileAuthority}
                    projectId={projectId}
                    entry={selectedEntry}
                    detail={selectedPreview}
                    loading={previewLoading}
                    error={previewError}
                    fallbackTitle={pageTitle}
                    projectWorkspacePath={projectWorkspacePath}
                  />
                ) : (
                  <HistoryTimelineDetails entry={selectedEntry} />
                )}
              </div>
            ) : (
              <HistoryEmptyState>Select an event to inspect its evidence.</HistoryEmptyState>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-l-[0.5px] border-token-border bg-token-main-surface-primary max-md:border-t-[0.5px] max-md:border-l-0">
          <header className="flex shrink-0 items-start gap-2 px-3 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-medium text-token-text-primary">
                Page history
              </h2>
              <p className="mt-0.5 truncate text-xs text-token-description-foreground">
                Exact content revisions and durable activity
              </p>
            </div>
            <NodexButton
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary"
              aria-label="Close Page history"
              onClick={onClose}
            >
              <CloseIcon className="icon-2xs shrink-0" />
            </NodexButton>
          </header>

          <div className="flex h-8 shrink-0 items-end gap-3 border-b-[0.5px] border-token-border px-3">
            {HISTORY_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  "relative flex h-8 items-center px-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-token-focus",
                  filter === item.value
                    ? "text-token-text-primary after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-token-text-primary"
                    : "text-token-description-foreground hover:text-token-text-secondary",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
            onKeyDown={handleTimelineKeyDown}
          >
            {filter === "revisions" ? (
              <CurrentHistoryEntryRow
                selected={selectedIsCurrent}
                onSelect={() => setSelectedEntryId("current")}
              />
            ) : null}
            {filteredEntries.map((entry, index) => {
              const previous = filteredEntries[index - 1];
              const showDate =
                filter === "revisions" &&
                (!previous ||
                  formatHistoryDate(previous.occurredAt) !== formatHistoryDate(entry.occurredAt));
              return (
                <div key={entry.id}>
                  {showDate ? (
                    <p className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-token-description-foreground">
                      {formatHistoryDate(entry.occurredAt)}
                    </p>
                  ) : null}
                  <HistoryEntryRow
                    entry={entry}
                    selected={entry.id === selectedEntry?.id}
                    onSelect={() => setSelectedEntryId(entry.id)}
                  />
                </div>
              );
            })}
            {filteredEntries.length === 0 && filter === "activity" ? (
              <p className="px-2 py-3 text-xs text-token-description-foreground">
                No non-content activity yet.
              </p>
            ) : null}
            {nextCursor ? (
              <button
                type="button"
                disabled={loadingOlder}
                onClick={() => void handleLoadOlder()}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-secondary disabled:opacity-40"
              >
                <ChevronDownIcon className="icon-2xs shrink-0" />
                {loadingOlder ? "Loading…" : "Load earlier"}
              </button>
            ) : null}
            {timelineError && entries.length > 0 ? (
              <p role="alert" className="px-2 py-2 text-xs text-(--priority-critical-text)">
                {timelineError}
              </p>
            ) : null}
          </div>

          <HistoryRecoveryFooter
            entry={selectedIsCurrent ? null : selectedEntry}
            confirming={confirmingRestore}
            restoring={restoring}
            error={restoreError}
            onRequestRestore={() => setConfirmingRestore(true)}
            onCancel={() => {
              setConfirmingRestore(false);
              setRestoreError(null);
            }}
            onConfirm={() => void handleRestore()}
          />
        </aside>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function HistoryCurrentRevisionPreview({
  fileAuthority,
  projectId,
  pageId,
  title,
  nfm = "",
  projectWorkspacePath,
}: {
  fileAuthority?: LibraryFileAuthority | null;
  projectId: string;
  pageId: string | null;
  title?: string;
  nfm?: string;
  projectWorkspacePath?: string | null;
}) {
  return (
    <article className="min-w-0">
      <p className="mb-4 text-xs font-medium text-token-description-foreground">Current content</p>
      <h2 className="wrap-break-word text-xl/snug-plus font-semibold tracking-normal text-token-text-primary">
        {title || "Untitled Page"}
      </h2>
      <div className="mt-5 min-h-32">
        {pageId && nfm.trim() ? (
          <ReadonlyNfmBlockNotePreview
            fileAuthority={
              fileAuthority && pageId
                ? { ...fileAuthority, readSource: { kind: "page", page_id: pageId } }
                : null
            }
            content={nfm}
            projectId={projectId}
            pageId={pageId}
            historyId="current"
            projectWorkspacePath={projectWorkspacePath}
            className="text-token-text-primary"
          />
        ) : (
          <p className="text-sm text-token-description-foreground">Empty document</p>
        )}
      </div>
      <p className="mt-5 text-xs text-token-description-foreground">
        This is the latest committed title and body. Historical revisions below can be restored
        without removing newer history.
      </p>
    </article>
  );
}

export function HistoryRevisionPreview({
  fileAuthority,
  projectId,
  entry,
  detail,
  loading,
  error,
  fallbackTitle,
  projectWorkspacePath,
}: {
  fileAuthority?: LibraryFileAuthority | null;
  projectId: string;
  entry: Extract<PageHistoryEntry, { kind: "document_version" }>;
  detail: DocumentVersionDetail | null;
  loading: boolean;
  error: string | null;
  fallbackTitle?: string;
  projectWorkspacePath?: string | null;
}) {
  if (loading && !detail) {
    return <HistoryEmptyState>Loading revision preview…</HistoryEmptyState>;
  }
  if (error && !detail) return <HistoryEmptyState>{error}</HistoryEmptyState>;
  if (!detail) return <HistoryEmptyState>Revision preview is unavailable.</HistoryEmptyState>;

  const materialization = detail.materialization;
  if (materialization.kind === "canvas_scene") {
    return (
      <CanvasFilePreview
        scene={materialization}
        label="Historical Canvas scene"
        authority={
          fileAuthority && fileAuthority.libraryId === entry.libraryId
            ? {
                ...fileAuthority,
                documentId: entry.documentId,
                revisionId: entry.versionMetadata.versionId,
              }
            : null
        }
      />
    );
  }

  const title =
    materialization.kind === "page"
      ? materialization.title
      : (fallbackTitle ?? "Document revision");
  return (
    <article className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-token-description-foreground">
        <span>{formatRevisionKind(entry.versionMetadata.revisionKind)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={entry.occurredAt}>{formatAbsoluteTimestamp(entry.occurredAt)}</time>
        {entry.display.actorLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{entry.display.actorLabel}</span>
          </>
        ) : null}
      </div>
      <h2 className="wrap-break-word text-xl/snug-plus font-semibold tracking-normal text-token-text-primary">
        {title || "Untitled Page"}
      </h2>
      {detail.summary.fileSnapshotStatus === "unresolved_legacy" ? (
        <p role="status" className="mt-4 text-sm text-token-description-foreground">
          Exact files are unavailable for this revision. Current files will not be substituted.
        </p>
      ) : null}
      <div className="mt-5 min-h-32">
        {materialization.nfm.trim() ? (
          <ReadonlyNfmBlockNotePreview
            fileAuthority={
              fileAuthority && fileAuthority.libraryId === entry.libraryId
                ? {
                    ...fileAuthority,
                    readSource: {
                      kind: "document_revision",
                      document_id: entry.documentId,
                      revision_id: entry.versionMetadata.versionId,
                    },
                  }
                : null
            }
            content={materialization.nfm}
            projectId={projectId}
            pageId={entry.pageId}
            historyId={entry.versionMetadata.versionId}
            projectWorkspacePath={projectWorkspacePath}
            className="text-token-text-primary"
          />
        ) : (
          <p className="text-sm text-token-description-foreground">Empty document</p>
        )}
      </div>
      <p className="mt-5 text-xs text-token-description-foreground">
        This revision contains the Page title and body. Restoring saves the current state first,
        then creates a new forward change.
      </p>
    </article>
  );
}

export function HistoryTimelineDetails({
  entry,
  children,
}: {
  entry: PageHistoryEntry;
  children?: ReactNode;
}) {
  const metadata = collectEntryMetadata(entry);
  return (
    <article className="min-w-0">
      <div className="flex items-start gap-2">
        <HistoryKindIcon entry={entry} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="wrap-break-word text-lg font-medium text-token-text-primary">
            {entry.display.title}
          </h2>
          {entry.display.detail ? (
            <p className="mt-1 text-sm text-token-text-secondary">{entry.display.detail}</p>
          ) : null}
        </div>
      </div>

      {children ? <p className="mt-4 text-sm text-token-text-secondary">{children}</p> : null}

      <dl className="mt-5 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        {metadata.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="truncate text-token-description-foreground">{label}</dt>
            <dd className="min-w-0 wrap-break-word text-token-text-secondary">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 flex items-start gap-2 rounded-lg bg-transparent px-3 py-2.5 text-xs text-token-description-foreground ring-[0.5px] ring-inset ring-token-border">
        <ShieldCheck className="icon-2xs mt-0.5 shrink-0" />
        <p>
          {entry.evidence.status === "verified"
            ? "This is verified durable evidence. It does not define an inverse operation."
            : `Evidence is incomplete: ${formatEvidenceReason(entry.evidence.reason)}. This event cannot be reversed.`}
        </p>
      </div>
    </article>
  );
}

function HistoryRecoveryFooter({
  entry,
  confirming,
  restoring,
  error,
  onRequestRestore,
  onCancel,
  onConfirm,
}: {
  entry: PageHistoryEntry | null;
  confirming: boolean;
  restoring: boolean;
  error: string | null;
  onRequestRestore: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!entry) return null;
  const recoverable = entry.recovery.kind === "restore_document_version";
  return (
    <footer className="shrink-0 border-t-[0.5px] border-token-border px-3 py-3">
      {error ? (
        <p role="alert" className="mb-2 text-xs text-(--priority-critical-text)">
          {error}
        </p>
      ) : null}
      {confirming && recoverable ? (
        <p className="mb-2 text-xs text-token-text-secondary">
          Nodex will save the current title and body first, then apply this revision as a new
          forward change.
        </p>
      ) : null}
      {!recoverable ? (
        <p className="text-xs text-token-description-foreground">
          {formatRecoveryUnavailable(entry)}
        </p>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {confirming ? (
            <NodexButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={restoring}
              onClick={onCancel}
            >
              Cancel
            </NodexButton>
          ) : null}
          <NodexButton
            type="button"
            size="sm"
            disabled={restoring}
            onClick={confirming ? onConfirm : onRequestRestore}
          >
            {restoring ? "Restoring…" : confirming ? "Confirm restore" : "Restore title & body"}
          </NodexButton>
        </div>
      )}
    </footer>
  );
}

function HistoryEntryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: PageHistoryEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${entry.display.title}, ${formatAbsoluteTimestamp(entry.occurredAt)}`}
      onClick={onSelect}
      className={historyEntryRowClassName(selected)}
    >
      <HistoryKindIcon entry={entry} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-token-text-primary">
          {entry.display.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-token-description-foreground">
          <span className="truncate">{formatEntryCategory(entry)}</span>
          <span aria-hidden="true">·</span>
          <time className="shrink-0" dateTime={entry.occurredAt}>
            {formatRelativeTimestamp(entry.occurredAt)}
          </time>
        </span>
      </span>
    </button>
  );
}

function CurrentHistoryEntryRow({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label="Current Page content"
      onClick={onSelect}
      className={historyEntryRowClassName(selected)}
    >
      <HistoryIcon className="icon-2xs mt-0.5 shrink-0 text-token-description-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-token-text-primary">Current</span>
        <span className="mt-0.5 block text-xs text-token-description-foreground">
          Latest title and body
        </span>
      </span>
    </button>
  );
}

const historyEntryRowClassName = (selected: boolean): string =>
  cn(
    "flex w-full items-start gap-2 rounded-md bg-transparent px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-token-focus",
    selected ? "bg-token-foreground/10" : "hover:bg-token-foreground/5",
  );

function HistoryKindIcon({ entry, className }: { entry: PageHistoryEntry; className?: string }) {
  if (entry.kind === "document_version") {
    return (
      <FileIcon className={cn("icon-2xs shrink-0 text-token-description-foreground", className)} />
    );
  }
  if (entry.kind === "block_relocation") {
    return (
      <Route className={cn("icon-2xs shrink-0 text-token-description-foreground", className)} />
    );
  }
  return (
    <ThreadSummaryCommitIcon
      className={cn("icon-2xs shrink-0 text-token-description-foreground", className)}
    />
  );
}

function HistoryEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-token-description-foreground">{children}</div>
  );
}

const collectEntryMetadata = (
  entry: PageHistoryEntry,
): ReadonlyArray<readonly [string, string]> => {
  const common: Array<readonly [string, string]> = [
    ["Committed", formatAbsoluteTimestamp(entry.occurredAt)],
  ];
  if (entry.display.actorLabel) common.push(["Actor", entry.display.actorLabel]);
  if (entry.kind === "document_version") {
    return [
      ...common,
      ["Revision", formatRevisionKind(entry.versionMetadata.revisionKind)],
      ["Reason", entry.versionMetadata.label ?? entry.versionMetadata.cause],
      ["Retention", entry.versionMetadata.pinned ? "Pinned" : "Automatic"],
    ];
  }
  if (entry.kind === "block_relocation") {
    return [
      ...common,
      ["Direction", formatDirection(entry.direction)],
      ["Blocks", formatOptionalCount(entry.movedBlockCount)],
      ["Relocation", entry.relocationId ?? "Ledger unavailable"],
      ["Change sequence", String(entry.changeSeq)],
    ];
  }
  return [
    ...common,
    ["Mutation", entry.mutationKind ?? "Unknown mutation"],
    ["Blocks", formatOptionalCount(entry.affectedBlockCount)],
    ["Field intents", formatOptionalCount(entry.fieldIntentCount)],
    ["Operation", entry.mutationId ?? "Ledger unavailable"],
    ["Change sequence", String(entry.changeSeq)],
  ];
};

const formatRecoveryUnavailable = (entry: PageHistoryEntry): string => {
  if (entry.recovery.kind !== "unavailable") return "";
  switch (entry.recovery.reason) {
    case "document_generation_changed":
      return "This revision belongs to an earlier document generation and cannot be restored.";
    case "insufficient_evidence":
      return "There isn’t enough durable evidence to reconstruct this state.";
    case "no_inverse_contract":
      return "This committed event is evidence only; it has no inverse operation.";
  }
};

const formatEvidenceReason = (
  reason: Extract<PageHistoryEntry["evidence"], { status: "unavailable" }>["reason"],
): string => reason.replaceAll("_", " ");

const formatDirection = (
  direction: Extract<PageHistoryEntry, { kind: "block_relocation" }>["direction"],
): string => {
  switch (direction) {
    case "into_page":
      return "Into Page";
    case "out_of_page":
      return "Out of Page";
    case "within_page":
      return "Within Page";
    case "unknown":
      return "Unknown";
  }
};

const formatEntryCategory = (entry: PageHistoryEntry): string => {
  if (entry.kind === "document_version") {
    return formatRevisionKind(entry.versionMetadata.revisionKind);
  }
  if (entry.kind === "block_relocation") return "Relocation";
  return entry.display.category === "unknown"
    ? "Mutation"
    : entry.display.category.charAt(0).toUpperCase() + entry.display.category.slice(1);
};

const formatOptionalCount = (value: number | null): string =>
  value === null ? "Unknown" : String(value);

const formatRevisionKind = (
  kind: Extract<PageHistoryEntry, { kind: "document_version" }>["versionMetadata"]["revisionKind"],
): string => {
  switch (kind) {
    case "automatic":
      return "Automatic revision";
    case "manual":
      return "Named revision";
    case "operation":
      return "Command revision";
    case "restore":
      return "Restore revision";
    case "safety":
      return "Safety revision";
  }
};

const formatHistoryDate = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
};

const formatAbsoluteTimestamp = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const formatRelativeTimestamp = (value: string): string => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
};

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;
