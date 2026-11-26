import {
  defineMessage,
  defineMessages,
  getIntl,
  useIntl,
  type IntlShape,
  type MessageDescriptor,
} from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
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
import { ReadonlyMarkdownBlockNotePreview } from "./editor/readonly-nfm-blocknote-preview";
import { mergePageHistoryEntries } from "./page-history-view-model";
import {
  getDocumentVersion,
  prepareLibraryOwnedBlockDocument,
  listPageHistory,
  restoreDocumentVersion,
} from "./history-panel-deps";

import {
  validateLibraryOwnedBlockDocumentDescriptor,
  unwrapLibraryOwnedBlockDocumentPreparationResult,
  type ReadyPageBlockDocumentDescriptor,
} from "@/lib/owned-block-document";
import type { LibraryFileAuthority } from "@/lib/library-file-resources";

type HistoryFilter = "revisions" | "activity";

const HISTORY_FILTERS: ReadonlyArray<{
  readonly value: HistoryFilter;
  readonly label: MessageDescriptor;
}> = [
  {
    value: "revisions",
    label: defineMessage({ id: "board.historyPanel.revisions", defaultMessage: "Revisions" }),
  },
  {
    value: "activity",
    label: defineMessage({ id: "board.historyPanel.activity", defaultMessage: "Activity" }),
  },
];

export interface HistoryPanelProps {
  fileAuthority: LibraryFileAuthority | null;
  descriptor: ReadyPageBlockDocumentDescriptor;
  pageTitle?: string;
  pageMarkdown?: string;
  projectWorkspacePath?: string | null;
  open: boolean;
  onClose: () => void;
  onPageMutated?: () => void;
}

const matchesFilter = (entry: PageHistoryEntry, filter: HistoryFilter): boolean => {
  if (filter === "revisions") return entry.kind === "document_version";
  return entry.kind !== "document_version";
};

export function HistoryPanel(props: HistoryPanelProps) {
  if (!props.open) return null;
  return (
    <OpenHistoryPanel
      key={JSON.stringify([
        props.descriptor.libraryId,
        props.descriptor.documentId,
        props.descriptor.storeEpoch,
        props.descriptor.generation,
      ])}
      {...props}
    />
  );
}

function OpenHistoryPanel({
  fileAuthority,
  descriptor: openedDocument,
  pageTitle,
  pageMarkdown,
  projectWorkspacePath,
  open,
  onClose,
  onPageMutated,
}: HistoryPanelProps) {
  const intl = useIntl();

  const pageId = openedDocument.ownerBlockId;
  const { libraryId, documentId } = openedDocument;
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
  const [loading, setLoading] = useState(pageId !== null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [timelineError, setTimelineError] = useState<"initial" | "earlier" | null>(null);
  const [previewCache, setPreviewCache] = useState<ReadonlyMap<string, DocumentVersionDetail>>(
    () => new Map(),
  );
  const [previewResult, setPreviewResult] = useState<{
    readonly entry: PageHistoryEntry;
    readonly error: string | null;
  } | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const loadFirstPage = useCallback(
    (targetPageId: string) => {
      const requestSerial = requestSerialRef.current + 1;
      requestSerialRef.current = requestSerial;
      const onFailure = () => {
        if (requestSerial !== requestSerialRef.current) return;
        setEntries([]);
        setNextCursor(null);
        setTimelineError("initial");
      };
      return listPageHistory({
        pageId: targetPageId,
        pageSize: DEFAULT_PAGE_HISTORY_PAGE_SIZE,
      })
        .then((result) => {
          if (requestSerial !== requestSerialRef.current) return;
          if (
            !result.ok ||
            result.value.libraryId !== libraryId ||
            result.value.pageId !== targetPageId ||
            result.value.documentId !== documentId
          )
            return onFailure();
          setEntries(result.value.entries);
          setNextCursor(result.value.nextCursor);
          setSelectedEntryId((current) =>
            current && result.value.entries.some((entry) => entry.id === current)
              ? current
              : "current",
          );
        })
        .catch(onFailure)
        .finally(() => {
          if (requestSerial === requestSerialRef.current) setLoading(false);
        });
    },
    [libraryId, documentId],
  );

  useEffect(() => {
    if (!open || !pageId) return;
    void loadFirstPage(pageId);
  }, [pageId, loadFirstPage, open]);

  useEffect(
    () => () => {
      requestSerialRef.current += 1;
      pendingRestoreRef.current = null;
    },
    [],
  );

  const filteredEntries = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, filter)),
    [entries, filter],
  );

  if (
    !(filter === "revisions" && selectedEntryId === "current") &&
    !filteredEntries.some((entry) => entry.id === selectedEntryId)
  ) {
    const nextId = filter === "revisions" ? "current" : (filteredEntries[0]?.id ?? null);
    if (selectedEntryId !== nextId) setSelectedEntryId(nextId);
  }

  const selectedIsCurrent = filter === "revisions" && selectedEntryId === "current";
  const selectedIndex = filteredEntries.findIndex((entry) => entry.id === selectedEntryId);
  const selectedEntry = selectedIndex < 0 ? null : (filteredEntries[selectedIndex] ?? null);
  const selectedPreview = selectedEntry ? (previewCache.get(selectedEntry.id) ?? null) : null;

  const [previousPreview, setPreviousPreview] = useState({ selectedEntry, previewCache });
  if (
    previousPreview.selectedEntry !== selectedEntry ||
    previousPreview.previewCache !== previewCache
  ) {
    setPreviousPreview({ selectedEntry, previewCache });
    setConfirmingRestore(false);
    setRestoreError(null);
    setPreviewResult(null);
  }
  const previewNeedsRead = selectedEntry?.kind === "document_version" && !selectedPreview;
  const previewLoading = previewNeedsRead && previewResult?.entry !== selectedEntry;
  const previewError =
    previewNeedsRead && previewResult?.entry === selectedEntry ? previewResult.error : null;

  useEffect(() => {
    pendingRestoreRef.current = null;
    if (!selectedEntry || selectedEntry.kind !== "document_version" || selectedPreview) return;
    let cancelled = false;
    void getDocumentVersion({
      projectId: null,
      documentId: selectedEntry.documentId,
      versionId: selectedEntry.versionMetadata.versionId,
    })
      .then((result) => {
        if (cancelled) return;
        setPreviewResult({ entry: selectedEntry, error: result.ok ? null : result.error.message });
        if (!result.ok) return;
        setPreviewCache((current) => new Map(current).set(selectedEntry.id, result.value));
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setPreviewResult({
            entry: selectedEntry,
            error: toErrorMessage(
              error,
              getIntl().formatMessage({
                id: "board.historyPanel.previewUnavailable",
                defaultMessage: "Revision preview is unavailable.",
              }),
            ),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, selectedPreview]);

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
    return await runWithCleanup(
      async () => {
        const result = await listPageHistory({
          pageId,
          before: cursor,
          pageSize: DEFAULT_PAGE_HISTORY_PAGE_SIZE,
        });
        if (requestSerial !== requestSerialRef.current) return;
        if (
          !result.ok ||
          result.value.libraryId !== libraryId ||
          result.value.pageId !== pageId ||
          result.value.documentId !== documentId
        ) {
          setTimelineError("earlier");
          return;
        }
        setEntries((current) => mergePageHistoryEntries(current, result.value.entries));
        setNextCursor(result.value.nextCursor);
      },
      {
        onError: async () => {
          if (requestSerial !== requestSerialRef.current) return;
          setTimelineError("earlier");
        },
        cleanup: () => {
          if (requestSerial === requestSerialRef.current) setLoadingOlder(false);
        },
      },
    );
  }, [pageId, loadingOlder, nextCursor, libraryId, documentId]);

  const handleRestore = useCallback(async () => {
    if (
      restoreInFlightRef.current ||
      !pageId ||
      !selectedEntry ||
      selectedEntry.recovery.kind !== "restore_document_version"
    ) {
      return;
    }
    const recovery = selectedEntry.recovery;
    restoreInFlightRef.current = true;
    setRestoring(true);
    setRestoreError(null);
    return await runWithCleanup(
      async () => {
        let pendingRestore = pendingRestoreRef.current;
        if (!pendingRestore || pendingRestore.entryId !== selectedEntry.id) {
          const descriptor = validateLibraryOwnedBlockDocumentDescriptor(
            pageId,
            unwrapLibraryOwnedBlockDocumentPreparationResult(
              await prepareLibraryOwnedBlockDocument(pageId),
            ),
          );
          if (
            descriptor.libraryId !== libraryId ||
            descriptor.storeEpoch !== openedDocument.storeEpoch ||
            descriptor.generation !== openedDocument.generation
          ) {
            throw new Error(
              getIntl().formatMessage({
                id: "board.historyPanel.syncBeforeRestore",
                defaultMessage: "This Page must finish syncing before it can be restored.",
              }),
            );
          }
          if (
            descriptor.documentId !== documentId ||
            descriptor.documentId !== recovery.documentId
          ) {
            throw new Error(
              getIntl().formatMessage({
                id: "board.historyPanel.revisionNotInDocument",
                defaultMessage: "This revision no longer belongs to the Page document.",
              }),
            );
          }
          pendingRestore = {
            entryId: selectedEntry.id,
            request: {
              mutationId: createUuidV7(),
              projectId: null,
              storeEpoch: descriptor.storeEpoch,
              documentId: descriptor.documentId,
              versionId: recovery.versionId,
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
            pendingRestore.request.projectId,
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
        setLoading(true);
        setLoadingOlder(false);
        setTimelineError(null);
        setEntries([]);
        setNextCursor(null);
        setSelectedEntryId(null);
        setPreviewCache(new Map());
        await loadFirstPage(pageId);
      },
      {
        onError: async (error: unknown) => {
          setRestoreError(
            toErrorMessage(
              error,
              getIntl().formatMessage({
                id: "board.historyPanel.restoreFailed",
                defaultMessage: "Couldn’t restore this revision.",
              }),
            ),
          );
        },
        cleanup: () => {
          restoreInFlightRef.current = false;
          setRestoring(false);
        },
      },
    );
  }, [
    auditSessionId,
    pageId,
    loadFirstPage,
    onPageMutated,
    documentId,
    libraryId,
    openedDocument.storeEpoch,
    openedDocument.generation,
    selectedEntry,
  ]);

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
        <NodexDialogTitle className="sr-only">
          {intl.formatMessage({ id: "board.historyPanel.title", defaultMessage: "Page history" })}
        </NodexDialogTitle>

        <section className="flex min-h-0 min-w-0 flex-col bg-token-main-surface-primary">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b-[0.5px] border-token-border px-3">
            <HistoryIcon className="icon-2xs shrink-0 text-token-description-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-token-text-secondary">
              {previewTitle ??
                pageTitle ??
                intl.formatMessage({
                  id: "board.historyPanel.untitled",
                  defaultMessage: "Untitled Page",
                })}
            </span>
            {selectedIsCurrent ? (
              <span className="hidden shrink-0 text-xs text-token-description-foreground sm:block">
                {intl.formatMessage({
                  id: "board.historyPanel.current",
                  defaultMessage: "Current",
                })}
              </span>
            ) : selectedEntry ? (
              <time
                dateTime={selectedEntry.occurredAt}
                className="hidden shrink-0 text-xs text-token-description-foreground sm:block"
              >
                {formatAbsoluteTimestamp(intl, selectedEntry.occurredAt)}
              </time>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {selectedIsCurrent ? (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                <HistoryCurrentRevisionPreview
                  fileAuthority={fileAuthority}
                  projectId={null}
                  pageId={pageId}
                  title={pageTitle}
                  markdown={pageMarkdown}
                  projectWorkspacePath={projectWorkspacePath}
                />
              </div>
            ) : loading || timelineError === "initial" ? null : entries.length === 0 ? (
              <HistoryEmptyState>
                {intl.formatMessage({
                  id: "board.historyPanel.noRevisions",
                  defaultMessage: "No durable revisions for this Page yet.",
                })}
              </HistoryEmptyState>
            ) : selectedEntry ? (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                {selectedEntry.kind === "document_version" ? (
                  <HistoryRevisionPreview
                    fileAuthority={fileAuthority}
                    projectId={null}
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
              <HistoryEmptyState>
                {intl.formatMessage({
                  id: "board.historyPanel.selectEvent",
                  defaultMessage: "Select an event to inspect its evidence.",
                })}
              </HistoryEmptyState>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-l-[0.5px] border-token-border bg-token-main-surface-primary max-md:border-t-[0.5px] max-md:border-l-0">
          <header className="flex shrink-0 items-start gap-2 px-3 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-medium text-token-text-primary">
                {intl.formatMessage({
                  id: "board.historyPanel.title",
                  defaultMessage: "Page history",
                })}
              </h2>
              <p className="mt-0.5 truncate text-xs text-token-description-foreground">
                {intl.formatMessage({
                  id: "board.historyPanel.subtitle",
                  defaultMessage: "Exact content revisions and durable activity",
                })}
              </p>
            </div>
            <NodexButton
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary"
              aria-label={intl.formatMessage({
                id: "board.historyPanel.close",
                defaultMessage: "Close Page history",
              })}
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
                  "relative flex h-8 items-center px-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border",
                  filter === item.value
                    ? "text-token-text-primary after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-token-text-primary"
                    : "text-token-description-foreground hover:text-token-text-secondary",
                )}
              >
                {intl.formatMessage(item.label)}
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
                  formatHistoryDate(intl, previous.occurredAt) !==
                    formatHistoryDate(intl, entry.occurredAt));
              return (
                <div key={entry.id}>
                  {showDate ? (
                    <p className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-token-description-foreground">
                      {formatHistoryDate(intl, entry.occurredAt)}
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
            {filteredEntries.length === 0 && filter === "activity" && !loading && !timelineError ? (
              <p className="px-2 py-3 text-xs text-token-description-foreground">
                {intl.formatMessage({
                  id: "board.historyPanel.noActivity",
                  defaultMessage: "No non-content activity yet.",
                })}
              </p>
            ) : null}
            {loading ? (
              <p role="status" className="px-2 py-3 text-xs text-token-description-foreground">
                {intl.formatMessage({
                  id: "board.historyPanel.loadingHistory",
                  defaultMessage: "Loading Page history…",
                })}
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
                {loadingOlder
                  ? intl.formatMessage({
                      id: "board.historyPanel.loading",
                      defaultMessage: "Loading…",
                    })
                  : intl.formatMessage({
                      id: "board.historyPanel.loadEarlier",
                      defaultMessage: "Load earlier",
                    })}
              </button>
            ) : null}
            {timelineError ? (
              <p role="alert" className="px-2 py-2 text-xs text-(--priority-critical-text)">
                {timelineError === "initial"
                  ? intl.formatMessage({
                      id: "board.historyPanel.loadFailed",
                      defaultMessage: "Couldn’t load Page history.",
                    })
                  : intl.formatMessage({
                      id: "board.historyPanel.loadEarlierFailed",
                      defaultMessage: "Couldn’t load earlier history.",
                    })}
              </p>
            ) : null}
            {timelineError === "initial" && pageId ? (
              <NodexButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLoading(true);
                  setTimelineError(null);
                  void loadFirstPage(pageId);
                }}
              >
                {intl.formatMessage({ id: "board.historyPanel.retry", defaultMessage: "Retry" })}
              </NodexButton>
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
  markdown = "",
  projectWorkspacePath,
}: {
  fileAuthority?: LibraryFileAuthority | null;
  projectId: string | null;
  pageId: string | null;
  title?: string;
  markdown?: string;
  projectWorkspacePath?: string | null;
}) {
  const intl = useIntl();

  return (
    <article className="min-w-0">
      <p className="mb-4 text-xs font-medium text-token-description-foreground">
        {intl.formatMessage({
          id: "board.historyPanel.currentContent",
          defaultMessage: "Current content",
        })}
      </p>
      <h2 className="wrap-break-word text-xl/snug-plus font-semibold tracking-normal text-token-text-primary">
        {title ||
          intl.formatMessage({
            id: "board.historyPanel.untitled",
            defaultMessage: "Untitled Page",
          })}
      </h2>
      <div className="mt-5 min-h-32">
        {pageId && markdown.trim() ? (
          <ReadonlyMarkdownBlockNotePreview
            fileAuthority={
              fileAuthority && pageId
                ? { ...fileAuthority, readSource: { kind: "page", page_id: pageId } }
                : null
            }
            content={markdown}
            projectId={projectId}
            pageId={pageId}
            historyId="current"
            projectWorkspacePath={projectWorkspacePath}
            className="text-token-text-primary"
          />
        ) : (
          <p className="text-sm text-token-description-foreground">
            {intl.formatMessage({
              id: "board.historyPanel.emptyDocument",
              defaultMessage: "Empty document",
            })}
          </p>
        )}
      </div>
      <p className="mt-5 text-xs text-token-description-foreground">
        {intl.formatMessage({
          id: "board.historyPanel.currentContentDetails",
          defaultMessage:
            "This is the latest committed title and body. Historical revisions below can be restored without removing newer history.",
        })}
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
  projectId: string | null;
  entry: Extract<PageHistoryEntry, { kind: "document_version" }>;
  detail: DocumentVersionDetail | null;
  loading: boolean;
  error: string | null;
  fallbackTitle?: string;
  projectWorkspacePath?: string | null;
}) {
  const intl = useIntl();

  if (loading && !detail) {
    return (
      <HistoryEmptyState>
        {intl.formatMessage({
          id: "board.historyPanel.loadingPreview",
          defaultMessage: "Loading revision preview…",
        })}
      </HistoryEmptyState>
    );
  }
  if (error && !detail) return <HistoryEmptyState>{error}</HistoryEmptyState>;
  if (!detail)
    return (
      <HistoryEmptyState>
        {intl.formatMessage({
          id: "board.historyPanel.previewUnavailable",
          defaultMessage: "Revision preview is unavailable.",
        })}
      </HistoryEmptyState>
    );

  const materialization = detail.materialization;
  if (materialization.kind === "canvas_scene") {
    return (
      <CanvasFilePreview
        scene={materialization}
        label={intl.formatMessage({
          id: "board.historyPanel.historicalCanvas",
          defaultMessage: "Historical Canvas scene",
        })}
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
      : (fallbackTitle ??
        intl.formatMessage({
          id: "board.historyPanel.documentRevision",
          defaultMessage: "Document revision",
        }));
  return (
    <article className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-token-description-foreground">
        <span>{formatRevisionKind(intl, entry.versionMetadata.revisionKind)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={entry.occurredAt}>{formatAbsoluteTimestamp(intl, entry.occurredAt)}</time>
        {entry.display.actorLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{entry.display.actorLabel}</span>
          </>
        ) : null}
      </div>
      <h2 className="wrap-break-word text-xl/snug-plus font-semibold tracking-normal text-token-text-primary">
        {title ||
          intl.formatMessage({
            id: "board.historyPanel.untitled",
            defaultMessage: "Untitled Page",
          })}
      </h2>
      {detail.summary.fileSnapshotStatus === "unresolved_legacy" ? (
        <p role="status" className="mt-4 text-sm text-token-description-foreground">
          {intl.formatMessage({
            id: "board.historyPanel.historicalFilesUnavailable",
            defaultMessage:
              "Exact files are unavailable for this revision. Current files will not be substituted.",
          })}
        </p>
      ) : null}
      <div className="mt-5 min-h-32">
        {materialization.markdown.trim() ? (
          <ReadonlyMarkdownBlockNotePreview
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
            content={materialization.markdown}
            projectId={projectId}
            pageId={entry.pageId}
            historyId={entry.versionMetadata.versionId}
            projectWorkspacePath={projectWorkspacePath}
            className="text-token-text-primary"
          />
        ) : (
          <p className="text-sm text-token-description-foreground">
            {intl.formatMessage({
              id: "board.historyPanel.emptyDocument",
              defaultMessage: "Empty document",
            })}
          </p>
        )}
      </div>
      <p className="mt-5 text-xs text-token-description-foreground">
        {intl.formatMessage({
          id: "board.historyPanel.restoreDetails",
          defaultMessage:
            "This revision contains the Page title and body. Restoring saves the current state first, then creates a new forward change.",
        })}
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
  const intl = useIntl();

  const metadata = collectEntryMetadata(intl, entry);
  const title = formatHistoryEntryTitle(intl, entry);
  const detail = formatHistoryEntryDetail(intl, entry);
  return (
    <article className="min-w-0">
      <div className="flex items-start gap-2">
        <HistoryKindIcon entry={entry} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="wrap-break-word text-lg font-medium text-token-text-primary">{title}</h2>
          {detail ? <p className="mt-1 text-sm text-token-text-secondary">{detail}</p> : null}
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
            ? intl.formatMessage({
                id: "board.historyPanel.verifiedEvidence",
                defaultMessage:
                  "This is verified durable evidence. It does not define an inverse operation.",
              })
            : intl.formatMessage(
                {
                  id: "board.historyPanel.incompleteEvidence",
                  defaultMessage:
                    "Evidence is incomplete: {reason}. This event cannot be reversed.",
                },
                { reason: formatEvidenceReason(intl, entry.evidence.reason) },
              )}
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
  const intl = useIntl();

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
          {intl.formatMessage({
            id: "board.historyPanel.confirmDetails",
            defaultMessage:
              "Nodex will save the current title and body first, then apply this revision as a new forward change.",
          })}
        </p>
      ) : null}
      {!recoverable ? (
        <p className="text-xs text-token-description-foreground">
          {formatRecoveryUnavailable(intl, entry)}
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
              {intl.formatMessage({ id: "board.historyPanel.cancel", defaultMessage: "Cancel" })}
            </NodexButton>
          ) : null}
          <NodexButton
            type="button"
            size="sm"
            disabled={restoring}
            onClick={confirming ? onConfirm : onRequestRestore}
          >
            {restoring
              ? intl.formatMessage({
                  id: "board.historyPanel.restoring",
                  defaultMessage: "Restoring…",
                })
              : confirming
                ? intl.formatMessage({
                    id: "board.historyPanel.confirmRestore",
                    defaultMessage: "Confirm restore",
                  })
                : intl.formatMessage({
                    id: "board.historyPanel.restore",
                    defaultMessage: "Restore title & body",
                  })}
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
  const intl = useIntl();
  const title = formatHistoryEntryTitle(intl, entry);

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={intl.formatMessage(
        { id: "board.historyPanel.entryAriaLabel", defaultMessage: "{title}, {time}" },
        { title, time: formatAbsoluteTimestamp(intl, entry.occurredAt) },
      )}
      onClick={onSelect}
      className={historyEntryRowClassName(selected)}
    >
      <HistoryKindIcon entry={entry} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-token-text-primary">{title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-token-description-foreground">
          <span className="truncate">{formatEntryCategory(intl, entry)}</span>
          <span aria-hidden="true">·</span>
          <time className="shrink-0" dateTime={entry.occurredAt}>
            {formatRelativeTimestamp(intl, entry.occurredAt)}
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
  const intl = useIntl();

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={intl.formatMessage({
        id: "board.historyPanel.currentEntry",
        defaultMessage: "Current Page content",
      })}
      onClick={onSelect}
      className={historyEntryRowClassName(selected)}
    >
      <HistoryIcon className="icon-2xs mt-0.5 shrink-0 text-token-description-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-token-text-primary">
          {intl.formatMessage({ id: "board.historyPanel.current", defaultMessage: "Current" })}
        </span>
        <span className="mt-0.5 block text-xs text-token-description-foreground">
          {intl.formatMessage({
            id: "board.historyPanel.currentEntryDetails",
            defaultMessage: "Latest title and body",
          })}
        </span>
      </span>
    </button>
  );
}

const historyEntryRowClassName = (selected: boolean): string =>
  cn(
    "flex w-full items-start gap-2 rounded-md bg-transparent px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border",
    selected ? "bg-token-foreground/10" : "hover:bg-token-foreground/5",
  );

// Core supplies authored display copy and saved revision labels in the same projection.
const historyEntryTitleMessages = defineMessages({
  "Edited Page": { id: "board.historyPanel.entryTitle.editedPage", defaultMessage: "Edited Page" },
  "Edited Page content": {
    id: "board.historyPanel.entryTitle.editedPageContent",
    defaultMessage: "Edited Page content",
  },
  "Before restore": {
    id: "board.historyPanel.entryTitle.beforeRestore",
    defaultMessage: "Before restore",
  },
  "Restored Page content": {
    id: "board.historyPanel.entryTitle.restoredPageContent",
    defaultMessage: "Restored Page content",
  },
  "Before editing": {
    id: "board.historyPanel.entryTitle.beforeEditing",
    defaultMessage: "Before editing",
  },
  "Saved Page revision": {
    id: "board.historyPanel.entryTitle.savedPageRevision",
    defaultMessage: "Saved Page revision",
  },
  "Created Page": {
    id: "board.historyPanel.entryTitle.createdPage",
    defaultMessage: "Created Page",
  },
  "Archived Page": {
    id: "board.historyPanel.entryTitle.archivedPage",
    defaultMessage: "Archived Page",
  },
  "Unarchived Page": {
    id: "board.historyPanel.entryTitle.unarchivedPage",
    defaultMessage: "Unarchived Page",
  },
  "Deleted Page": {
    id: "board.historyPanel.entryTitle.deletedPage",
    defaultMessage: "Deleted Page",
  },
  "Restored Page": {
    id: "board.historyPanel.entryTitle.restoredPage",
    defaultMessage: "Restored Page",
  },
  "Reordered Page in Library": {
    id: "board.historyPanel.entryTitle.reorderedInLibrary",
    defaultMessage: "Reordered Page in Library",
  },
  "Updated Page properties": {
    id: "board.historyPanel.entryTitle.updatedProperties",
    defaultMessage: "Updated Page properties",
  },
  "Reordered Page in a database View": {
    id: "board.historyPanel.entryTitle.reorderedInView",
    defaultMessage: "Reordered Page in a database View",
  },
  "Changed Page database membership": {
    id: "board.historyPanel.entryTitle.changedMembership",
    defaultMessage: "Changed Page database membership",
  },
  "Updated Page database values": {
    id: "board.historyPanel.entryTitle.updatedDatabaseValues",
    defaultMessage: "Updated Page database values",
  },
  "Replaced Page content from Markdown": {
    id: "board.historyPanel.entryTitle.replacedFromMarkdown",
    defaultMessage: "Replaced Page content from Markdown",
  },
  "Moved blocks into Page": {
    id: "board.historyPanel.entryTitle.movedIntoPage",
    defaultMessage: "Moved blocks into Page",
  },
  "Moved blocks out of Page": {
    id: "board.historyPanel.entryTitle.movedOutOfPage",
    defaultMessage: "Moved blocks out of Page",
  },
  "Moved blocks within Page": {
    id: "board.historyPanel.entryTitle.movedWithinPage",
    defaultMessage: "Moved blocks within Page",
  },
  "Moved Page blocks": {
    id: "board.historyPanel.entryTitle.movedPageBlocks",
    defaultMessage: "Moved Page blocks",
  },
  "Page change": { id: "board.historyPanel.entryTitle.pageChange", defaultMessage: "Page change" },
});

function formatHistoryEntryTitle(intl: IntlShape, entry: PageHistoryEntry): string {
  if (
    entry.kind === "document_version" &&
    entry.versionMetadata.revisionKind === "manual" &&
    entry.versionMetadata.label !== null
  ) {
    return entry.display.title;
  }
  const title = entry.display.title;
  if (!Object.hasOwn(historyEntryTitleMessages, title)) return title;
  return intl.formatMessage(
    historyEntryTitleMessages[title as keyof typeof historyEntryTitleMessages],
  );
}

function formatHistoryEntryDetail(intl: IntlShape, entry: PageHistoryEntry): string | null {
  const detail = entry.display.detail;
  if (!detail) return detail;
  if (entry.kind === "document_version") {
    switch (entry.versionMetadata.revisionKind) {
      case "automatic":
      case "safety":
        return formatRevisionKind(intl, entry.versionMetadata.revisionKind);
      case "manual":
        return entry.versionMetadata.label !== null
          ? formatRevisionKind(intl, "manual")
          : intl.formatMessage({
              id: "board.historyPanel.manualRevision",
              defaultMessage: "Manual revision",
            });
      default:
        return detail;
    }
  }
  if (entry.kind === "block_relocation" && entry.movedBlockCount !== null) {
    return intl.formatMessage(
      {
        id: "board.historyPanel.relocationDetail",
        defaultMessage: "{count, plural, one {# block} other {# blocks}}",
      },
      { count: entry.movedBlockCount },
    );
  }
  if (
    entry.kind === "block_mutation" &&
    entry.fieldIntentCount !== null &&
    (entry.display.title === "Updated Page properties" ||
      entry.display.title === "Updated Page database values")
  ) {
    return intl.formatMessage(
      {
        id: "board.historyPanel.fieldIntentDetail",
        defaultMessage: "{count, plural, one {# field intent} other {# field intents}}",
      },
      { count: entry.fieldIntentCount },
    );
  }
  if (entry.display.category === "unknown") {
    return intl.formatMessage({
      id: "board.historyPanel.evidenceUnavailableDetail",
      defaultMessage: "Stored evidence is unavailable or cannot be displayed safely.",
    });
  }
  return detail;
}

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
  intl: IntlShape,
  entry: PageHistoryEntry,
): ReadonlyArray<readonly [string, string]> => {
  const common: Array<readonly [string, string]> = [
    [
      intl.formatMessage({ id: "board.historyPanel.committed", defaultMessage: "Committed" }),
      formatAbsoluteTimestamp(intl, entry.occurredAt),
    ],
  ];
  if (entry.display.actorLabel)
    common.push([
      intl.formatMessage({ id: "board.historyPanel.actor", defaultMessage: "Actor" }),
      entry.display.actorLabel,
    ]);
  if (entry.kind === "document_version") {
    return [
      ...common,
      [
        intl.formatMessage({ id: "board.historyPanel.revision", defaultMessage: "Revision" }),
        formatRevisionKind(intl, entry.versionMetadata.revisionKind),
      ],
      [
        intl.formatMessage({ id: "board.historyPanel.reason", defaultMessage: "Reason" }),
        entry.versionMetadata.label ?? entry.versionMetadata.cause,
      ],
      [
        intl.formatMessage({ id: "board.historyPanel.retention", defaultMessage: "Retention" }),
        entry.versionMetadata.pinned
          ? intl.formatMessage({ id: "board.historyPanel.pinned", defaultMessage: "Pinned" })
          : intl.formatMessage({ id: "board.historyPanel.automatic", defaultMessage: "Automatic" }),
      ],
    ];
  }
  if (entry.kind === "block_relocation") {
    return [
      ...common,
      [
        intl.formatMessage({ id: "board.historyPanel.direction", defaultMessage: "Direction" }),
        formatDirection(intl, entry.direction),
      ],
      [
        intl.formatMessage({ id: "board.historyPanel.blocks", defaultMessage: "Blocks" }),
        formatOptionalCount(intl, entry.movedBlockCount),
      ],
      [
        intl.formatMessage({ id: "board.historyPanel.relocation", defaultMessage: "Relocation" }),
        entry.relocationId ??
          intl.formatMessage({
            id: "board.historyPanel.noLedger",
            defaultMessage: "Ledger unavailable",
          }),
      ],
      [
        intl.formatMessage({
          id: "board.historyPanel.changeSequence",
          defaultMessage: "Change sequence",
        }),
        intl.formatNumber(entry.changeSeq, { useGrouping: false }),
      ],
    ];
  }
  return [
    ...common,
    [
      intl.formatMessage({ id: "board.historyPanel.mutation", defaultMessage: "Mutation" }),
      entry.mutationKind ??
        intl.formatMessage({
          id: "board.historyPanel.unknownMutation",
          defaultMessage: "Unknown mutation",
        }),
    ],
    [
      intl.formatMessage({ id: "board.historyPanel.blocks", defaultMessage: "Blocks" }),
      formatOptionalCount(intl, entry.affectedBlockCount),
    ],
    [
      intl.formatMessage({
        id: "board.historyPanel.fieldIntents",
        defaultMessage: "Field intents",
      }),
      formatOptionalCount(intl, entry.fieldIntentCount),
    ],
    [
      intl.formatMessage({ id: "board.historyPanel.operation", defaultMessage: "Operation" }),
      entry.mutationId ??
        intl.formatMessage({
          id: "board.historyPanel.noLedger",
          defaultMessage: "Ledger unavailable",
        }),
    ],
    [
      intl.formatMessage({
        id: "board.historyPanel.changeSequence",
        defaultMessage: "Change sequence",
      }),
      intl.formatNumber(entry.changeSeq, { useGrouping: false }),
    ],
  ];
};

const formatRecoveryUnavailable = (intl: IntlShape, entry: PageHistoryEntry): string => {
  if (entry.recovery.kind !== "unavailable") return "";
  switch (entry.recovery.reason) {
    case "document_generation_changed":
      return intl.formatMessage({
        id: "board.historyPanel.olderDocument",
        defaultMessage:
          "This revision belongs to an earlier document generation and cannot be restored.",
      });
    case "insufficient_evidence":
      return intl.formatMessage({
        id: "board.historyPanel.insufficientEvidence",
        defaultMessage: "There isn’t enough durable evidence to reconstruct this state.",
      });
    case "no_inverse_contract":
      return intl.formatMessage({
        id: "board.historyPanel.noInverse",
        defaultMessage: "This committed event is evidence only; it has no inverse operation.",
      });
  }
};

const formatEvidenceReason = (
  intl: IntlShape,
  reason: Extract<PageHistoryEntry["evidence"], { status: "unavailable" }>["reason"],
): string =>
  intl.formatMessage(
    {
      id: "board.historyPanel.evidenceReason",
      defaultMessage:
        "{reason, select, missing_ledger {missing ledger} malformed_evidence {malformed evidence} unsupported_evidence {unsupported evidence} other {{fallback}}}",
    },
    { reason, fallback: reason.replaceAll("_", " ") },
  );

const formatDirection = (
  intl: IntlShape,
  direction: Extract<PageHistoryEntry, { kind: "block_relocation" }>["direction"],
): string => {
  switch (direction) {
    case "into_page":
      return intl.formatMessage({ id: "board.historyPanel.intoPage", defaultMessage: "Into Page" });
    case "out_of_page":
      return intl.formatMessage({
        id: "board.historyPanel.outOfPage",
        defaultMessage: "Out of Page",
      });
    case "within_page":
      return intl.formatMessage({
        id: "board.historyPanel.withinPage",
        defaultMessage: "Within Page",
      });
    case "unknown":
      return intl.formatMessage({ id: "board.historyPanel.unknown", defaultMessage: "Unknown" });
  }
};

const formatEntryCategory = (intl: IntlShape, entry: PageHistoryEntry): string => {
  if (entry.kind === "document_version") {
    return formatRevisionKind(intl, entry.versionMetadata.revisionKind);
  }
  if (entry.kind === "block_relocation")
    return intl.formatMessage({
      id: "board.historyPanel.relocation",
      defaultMessage: "Relocation",
    });
  return intl.formatMessage(
    {
      id: "board.historyPanel.eventCategory",
      defaultMessage:
        "{category, select, checkpoint {Checkpoint} content {Content} property {Property} database {Database} lifecycle {Lifecycle} location {Location} other {Mutation}}",
    },
    { category: entry.display.category },
  );
};

const formatOptionalCount = (intl: IntlShape, value: number | null): string =>
  value === null
    ? intl.formatMessage({ id: "board.historyPanel.unknown", defaultMessage: "Unknown" })
    : intl.formatNumber(value, { useGrouping: false });

const formatRevisionKind = (
  intl: IntlShape,
  kind: Extract<PageHistoryEntry, { kind: "document_version" }>["versionMetadata"]["revisionKind"],
): string => {
  switch (kind) {
    case "automatic":
      return intl.formatMessage({
        id: "board.historyPanel.automaticRevision",
        defaultMessage: "Automatic revision",
      });
    case "manual":
      return intl.formatMessage({
        id: "board.historyPanel.namedRevision",
        defaultMessage: "Named revision",
      });
    case "operation":
      return intl.formatMessage({
        id: "board.historyPanel.commandRevision",
        defaultMessage: "Command revision",
      });
    case "restore":
      return intl.formatMessage({
        id: "board.historyPanel.restoreRevision",
        defaultMessage: "Restore revision",
      });
    case "safety":
      return intl.formatMessage({
        id: "board.historyPanel.safetyRevision",
        defaultMessage: "Safety revision",
      });
  }
};

const formatHistoryDate = (intl: IntlShape, value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(intl.locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
};

const formatAbsoluteTimestamp = (intl: IntlShape, value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(intl.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const formatRelativeTimestamp = (intl: IntlShape, value: string): string => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000)
    return intl.formatMessage({ id: "board.historyPanel.now", defaultMessage: "now" });
  if (elapsed < 3_600_000)
    return intl.formatMessage(
      { id: "board.historyPanel.minutesAgo", defaultMessage: "{count}m" },
      { count: Math.floor(elapsed / 60_000) },
    );
  if (elapsed < 86_400_000)
    return intl.formatMessage(
      { id: "board.historyPanel.hoursAgo", defaultMessage: "{count}h" },
      { count: Math.floor(elapsed / 3_600_000) },
    );
  if (elapsed < 604_800_000)
    return intl.formatMessage(
      { id: "board.historyPanel.daysAgo", defaultMessage: "{count}d" },
      { count: Math.floor(elapsed / 86_400_000) },
    );
  return new Intl.DateTimeFormat(intl.locale, { month: "short", day: "numeric" }).format(timestamp);
};

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;
