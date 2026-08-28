import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ActivitySpinnerIcon,
  InfoIcon,
  PlusIcon,
  SearchIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  selectCommandPaletteChatResults,
  type CommandPaletteThreadSearchBatch,
  useCommandPaletteThreadSearch,
  useCommandPaletteThreadItems,
} from "@/lib/command-palette-chat-search";
import type { CommandPaletteThread } from "@/lib/command-palette";
import type { CommandPaletteHighlightSegment } from "@/lib/command-palette-highlight";
import { normalizeSearchText as normalizeCommandPaletteSearchText } from "@/lib/search-text";
import {
  areQueryFresh,
  resolvePendingQueryFreshAccept,
  resolveQueryFreshAccept,
  shouldConsumeStalePickerNavigation,
} from "@/lib/query-fresh-picker";
import { useCommandPaletteThreadSearchIndex } from "@/lib/use-command-palette-thread-search-index";
import { cn } from "@/lib/utils";
import {
  readNfmSendToThreadMode,
  writeNfmSendToThreadMode,
} from "./nfm-send-to-thread-mode-settings";
import {
  buildNfmSendToThreadRows,
  moveNfmSendToThreadFocusedRowId,
  resolveNfmSendToThreadFocusedRowId,
  type NfmSendToThreadMode,
  type NfmSendToThreadPreferredTarget,
  type NfmSendToThreadRequest,
  type NfmSendToThreadRow,
} from "./nfm-send-to-thread-menu-model";

interface NfmSendToThreadMenuProps {
  projectId: string | null;
  projectNameById?: Readonly<Record<string, string>>;
  preferredTarget?: NfmSendToThreadPreferredTarget | null;
  onAccept: (request: NfmSendToThreadRequest) => Promise<void> | void;
  onClose: () => void;
  showModeSelector?: boolean;
}

export interface NfmSendToThreadMenuSurfaceProps extends NfmSendToThreadMenuProps {
  threadItems: readonly CommandPaletteThread[];
  initialQuery?: string;
  threadItemsLoading?: boolean;
  threadSearchBatch?: CommandPaletteThreadSearchBatch;
  enableThreadSearch?: boolean;
}

const SEND_TO_THREAD_ERROR = "Could not send";
const SEND_TO_THREAD_WRAP_TOOLTIP =
  "Sends the blocks, then replaces them with a collapsed toggle linking to the thread.";
const SEND_TO_THREAD_RESULT_LIMIT = 24;

function getSendToThreadRowDomId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}

function keepEditorSelection(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) return;
  event.preventDefault();
}

function SendToThreadStatusRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 items-center px-3 text-[13px] leading-5 text-token-description-foreground">
      {children}
    </div>
  );
}

function renderSendToThreadPreviewSegments(
  segments: readonly CommandPaletteHighlightSegment[],
  keyPrefix: string,
) {
  return segments.map((segment, index) => (
    <span
      key={`${keyPrefix}:${index}`}
      className={
        segment.highlight
          ? "rounded-[3px] bg-token-foreground/8 px-0.5 text-token-foreground"
          : undefined
      }
    >
      {segment.text}
    </span>
  ));
}

function SendToThreadModeSelector({
  mode,
  disabled,
  onModeChange,
}: {
  mode: NfmSendToThreadMode;
  disabled: boolean;
  onModeChange: (mode: NfmSendToThreadMode) => void;
}) {
  const modeItems = [
    { value: "send", label: "Send", hasInfo: false },
    { value: "wrap-toggle", label: "Send & wrap", hasInfo: true },
  ] as const;

  return (
    <div className="mx-2 mb-1 grid h-7 shrink-0 grid-cols-2 rounded-lg bg-token-foreground/5 p-0.5">
      {modeItems.map(({ value, label, hasInfo }) => {
        return (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={disabled}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1 rounded-[7px] px-2 text-[12px] leading-6 text-token-description-foreground",
              "disabled:cursor-default disabled:opacity-50",
              mode === value && "bg-token-dropdown-background text-token-foreground shadow-sm",
            )}
            onPointerDown={keepEditorSelection}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onModeChange(value);
            }}
          >
            <span className="min-w-0 truncate">{label}</span>
            {hasInfo ? (
              <NodexTooltip
                tooltipContent={SEND_TO_THREAD_WRAP_TOOLTIP}
                side="top"
                sideOffset={4}
                tooltipBodyClassName="max-w-[220px] text-[12px] leading-4"
              >
                <span
                  data-testid="send-to-thread-wrap-mode-info"
                  className="inline-flex size-3.5 shrink-0 items-center justify-center text-token-description-foreground"
                  aria-hidden="true"
                >
                  <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
                </span>
              </NodexTooltip>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function SendToThreadRow({
  row,
  index,
  listboxId,
  focused,
  disabled,
  accepting,
  onAccept,
  onFocusRowChange,
}: {
  row: NfmSendToThreadRow;
  index: number;
  listboxId: string;
  focused: boolean;
  disabled: boolean;
  accepting: boolean;
  onAccept: (row: NfmSendToThreadRow) => void;
  onFocusRowChange: (rowId: string) => void;
}) {
  const preview = row.kind === "thread" ? row.searchPreview : null;
  const hasPreview = Boolean(preview);
  return (
    <button
      id={getSendToThreadRowDomId(listboxId, index)}
      type="button"
      role="option"
      aria-selected={focused}
      aria-disabled={disabled || undefined}
      data-focused={focused ? "true" : undefined}
      data-nfm-send-to-thread-row-kind={row.kind}
      className={cn(
        "group flex w-full select-none gap-1.5 rounded-[7px] px-1.5 text-left text-[14px] outline-hidden",
        hasPreview ? "min-h-9 items-start py-1" : "h-7 items-center leading-7",
        "text-token-foreground",
        disabled
          ? "cursor-default opacity-55"
          : "cursor-interaction hover:bg-token-list-hover-background",
        focused && "bg-token-list-hover-background",
      )}
      onPointerDown={keepEditorSelection}
      onPointerEnter={() => onFocusRowChange(row.id)}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onAccept(row);
      }}
    >
      <span
        className={cn(
          "flex h-[18px] w-[22px] shrink-0 items-center justify-center text-token-description-foreground",
          hasPreview && "mt-0.5",
        )}
      >
        {row.kind === "new-thread" ? (
          <PlusIcon className="size-4" aria-hidden="true" />
        ) : (
          <ThreadIcon className="size-4" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("flex min-w-0 items-center", hasPreview ? "h-5" : "h-7")}>
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="ml-1 max-w-[118px] shrink truncate text-[12px] leading-4 text-token-description-foreground">
            {row.meta}
          </span>
        </span>
        {preview ? (
          <span className="line-clamp-1 text-[12px] leading-4 wrap-break-word text-token-description-foreground/90">
            {renderSendToThreadPreviewSegments(preview.segments, `${row.id}:preview`)}
          </span>
        ) : null}
      </span>
      {accepting ? (
        <ActivitySpinnerIcon
          className={cn(
            "size-3.5 shrink-0 text-token-description-foreground",
            hasPreview && "mt-1",
          )}
        />
      ) : null}
    </button>
  );
}

export function NfmSendToThreadMenu({
  projectId,
  projectNameById,
  preferredTarget = null,
  onAccept,
  onClose,
  showModeSelector = true,
}: NfmSendToThreadMenuProps) {
  const { threads, loading } = useCommandPaletteThreadItems({
    enabled: Boolean(projectId),
    activeProjectId: projectId ?? "",
    refreshKey: 0,
  });

  return (
    <NfmSendToThreadMenuSurface
      projectId={projectId}
      threadItems={threads}
      threadItemsLoading={loading}
      projectNameById={projectNameById}
      preferredTarget={preferredTarget}
      onAccept={onAccept}
      onClose={onClose}
      showModeSelector={showModeSelector}
    />
  );
}

export function NfmSendToThreadMenuSurface({
  projectId,
  threadItems,
  threadItemsLoading = false,
  projectNameById,
  preferredTarget = null,
  initialQuery = "",
  onAccept,
  onClose,
  showModeSelector = true,
  threadSearchBatch: injectedThreadSearchBatch,
  enableThreadSearch = true,
}: NfmSendToThreadMenuSurfaceProps) {
  const listboxId = useId();
  const comboboxId = useId();
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [mode, setMode] = useState<NfmSendToThreadMode>(() => readNfmSendToThreadMode());
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [acceptingRowId, setAcceptingRowId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [pendingAcceptQuery, setPendingAcceptQuery] = useState<string | null>(null);
  const normalizedThreadItems = useMemo(() => [...threadItems], [threadItems]);
  const threadSearchIndex = useCommandPaletteThreadSearchIndex(normalizedThreadItems);
  const fetchedThreadSearchBatch = useCommandPaletteThreadSearch({
    enabled: enableThreadSearch && Boolean(projectId),
    query: deferredQuery,
    limit: SEND_TO_THREAD_RESULT_LIMIT,
  });
  const threadSearchBatch = injectedThreadSearchBatch ?? fetchedThreadSearchBatch;
  const visibleThreads = useMemo(
    () =>
      selectCommandPaletteChatResults({
        query: deferredQuery,
        threads: normalizedThreadItems,
        threadSearchIndex,
        threadSearchBatch,
        threadLimit: SEND_TO_THREAD_RESULT_LIMIT,
        activeProjectId: projectId ?? "",
      }),
    [deferredQuery, normalizedThreadItems, projectId, threadSearchBatch, threadSearchIndex],
  );

  useEffect(() => {
    setQuery(initialQuery);
    setFocusedRowId(null);
    setPendingAcceptQuery(null);
  }, [initialQuery]);

  const rows = useMemo(() => {
    if (!projectId) return [];
    return buildNfmSendToThreadRows({
      threads: visibleThreads,
      query: deferredQuery,
      preferredTarget,
      projectNameById,
    });
  }, [deferredQuery, preferredTarget, projectId, projectNameById, visibleThreads]);
  const buildRowsForQuery = useCallback(
    (nextQuery: string): readonly NfmSendToThreadRow[] => {
      if (!projectId) return [];
      const threads = selectCommandPaletteChatResults({
        query: nextQuery,
        threads: normalizedThreadItems,
        threadSearchIndex,
        threadSearchBatch,
        threadLimit: SEND_TO_THREAD_RESULT_LIMIT,
        activeProjectId: projectId,
      });
      return buildNfmSendToThreadRows({
        threads,
        query: nextQuery,
        preferredTarget,
        projectNameById,
      });
    },
    [
      normalizedThreadItems,
      preferredTarget,
      projectId,
      projectNameById,
      threadSearchBatch,
      threadSearchIndex,
    ],
  );
  const rowsStale = shouldConsumeStalePickerNavigation({
    liveQuery: query,
    rowsQuery: deferredQuery,
    normalizeQuery: normalizeCommandPaletteSearchText,
  });
  const normalizedLiveQuery = normalizeCommandPaletteSearchText(query);
  const shouldWaitForThreadSearch =
    enableThreadSearch &&
    normalizedLiveQuery.length > 0 &&
    (threadSearchBatch.loading ||
      normalizeCommandPaletteSearchText(threadSearchBatch.query) !== normalizedLiveQuery);
  const resolveAcceptableRows = useCallback(
    (candidateRows: readonly NfmSendToThreadRow[]) =>
      shouldWaitForThreadSearch
        ? candidateRows.filter((row) => row.kind === "thread")
        : candidateRows,
    [shouldWaitForThreadSearch],
  );
  const resolvedFocusedRowId = resolveNfmSendToThreadFocusedRowId(
    focusedRowId,
    deferredQuery,
    rows,
  );
  const focusedIndex = resolvedFocusedRowId
    ? rows.findIndex((row) => row.id === resolvedFocusedRowId)
    : -1;
  const activeDescendantId =
    focusedIndex >= 0 && focusedIndex < rows.length
      ? getSendToThreadRowDomId(listboxId, focusedIndex)
      : undefined;
  const disabled = Boolean(acceptingRowId) || !projectId;
  const rowEntries = rows.map((row, index) => ({ row, index }));
  const mainRowEntries = rowEntries.filter(
    ({ row }) => row.kind !== "new-thread" || !row.isFooterAction,
  );
  const footerRowEntry = rowEntries.find(
    ({ row }) => row.kind === "new-thread" && row.isFooterAction,
  );
  const visibleMainRowCount = mainRowEntries.length;

  const handleModeChange = useCallback((nextMode: NfmSendToThreadMode) => {
    setMode(writeNfmSendToThreadMode(nextMode));
  }, []);

  const acceptRow = useCallback(
    async (row: NfmSendToThreadRow) => {
      setAcceptError(null);
      setAcceptingRowId(row.id);
      try {
        await onAccept({
          target: row.target,
          mode: showModeSelector ? mode : "send",
        });
        setAcceptingRowId(null);
      } catch (error) {
        const message = error instanceof Error ? error.message.trim() : "";
        setAcceptError(message || SEND_TO_THREAD_ERROR);
        setAcceptingRowId(null);
      }
    },
    [mode, onAccept, showModeSelector],
  );

  const activateRow = useCallback(
    (row: NfmSendToThreadRow | undefined) => {
      if (!row || disabled) return;
      setPendingAcceptQuery(null);
      void acceptRow(row);
    },
    [acceptRow, disabled],
  );

  useEffect(() => {
    if (!pendingAcceptQuery) return;
    const result = resolvePendingQueryFreshAccept({
      pendingQuery: pendingAcceptQuery,
      liveQuery: query,
      rowsQuery: deferredQuery,
      rows: resolveAcceptableRows(rows),
      getRowId: (row) => row.id,
      normalizeQuery: normalizeCommandPaletteSearchText,
    });
    if (result.status === "accepted") {
      activateRow(result.row);
      return;
    }

    if (
      !areQueryFresh({
        liveQuery: query,
        rowsQuery: deferredQuery,
        normalizeQuery: normalizeCommandPaletteSearchText,
      })
    ) {
      return;
    }

    if (!threadItemsLoading && !shouldWaitForThreadSearch) {
      setPendingAcceptQuery(null);
    }
  }, [
    activateRow,
    deferredQuery,
    pendingAcceptQuery,
    query,
    resolveAcceptableRows,
    rows,
    shouldWaitForThreadSearch,
    threadItemsLoading,
  ]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rowsStale) return;
      setFocusedRowId((currentRowId) =>
        moveNfmSendToThreadFocusedRowId(
          resolveNfmSendToThreadFocusedRowId(currentRowId, deferredQuery, rows),
          1,
          rows,
        ),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rowsStale) return;
      setFocusedRowId((currentRowId) =>
        moveNfmSendToThreadFocusedRowId(
          resolveNfmSendToThreadFocusedRowId(currentRowId, deferredQuery, rows),
          -1,
          rows,
        ),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = resolveQueryFreshAccept({
        liveQuery: query,
        rowsQuery: deferredQuery,
        rows,
        focusedIndex,
        buildFreshRows: (nextQuery) => resolveAcceptableRows(buildRowsForQuery(nextQuery)),
        canWaitForFreshRows: true,
        getRowId: (row) => row.id,
        normalizeQuery: normalizeCommandPaletteSearchText,
      });
      if (result.status === "accepted") {
        activateRow(result.row);
        return;
      }
      if (result.status === "pending") {
        setPendingAcceptQuery(result.query);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="flex max-h-[70vh] w-[330px] max-w-[calc(100vw-24px)] flex-col overflow-hidden text-[14px] leading-[1.2]"
      contentEditable={false}
    >
      <div className="flex h-[38px] shrink-0 items-center gap-1.5 px-2 py-[5px]">
        <SearchIcon
          className="size-4 shrink-0 text-token-description-foreground"
          aria-hidden="true"
        />
        <input
          id={comboboxId}
          role="combobox"
          aria-label="Search threads"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-activedescendant={activeDescendantId}
          value={query}
          placeholder="Search threads..."
          className="h-7 min-w-0 flex-1 rounded-[7px] bg-transparent px-1.5 py-[3px] text-[14px] text-token-foreground outline-hidden placeholder:text-token-description-foreground focus:bg-token-foreground/5"
          onChange={(event) => {
            setAcceptError(null);
            setFocusedRowId(null);
            setPendingAcceptQuery(null);
            setQuery(event.target.value);
          }}
          onKeyDown={handleInputKeyDown}
        />
      </div>
      {showModeSelector ? (
        <SendToThreadModeSelector mode={mode} disabled={disabled} onModeChange={handleModeChange} />
      ) : null}
      <div
        id={listboxId}
        role="listbox"
        aria-labelledby={comboboxId}
        aria-busy={
          rowsStale ||
          threadItemsLoading ||
          shouldWaitForThreadSearch ||
          pendingAcceptQuery !== null
        }
        className="flex h-[340px] min-h-0 flex-col"
      >
        <div className="notion-scroller vertical min-h-0 flex-1 overflow-y-auto pb-1">
          <div className="pb-1">
            <div className="flex h-7 items-end px-[14px] pb-1 pt-3 text-[12px] leading-4 font-medium text-token-description-foreground">
              <span className="min-w-0 flex-1 truncate">Destination</span>
            </div>
            <div className="flex flex-col gap-px px-1">
              {mainRowEntries.map(({ row, index }) => (
                <SendToThreadRow
                  key={row.id}
                  row={row}
                  index={index}
                  listboxId={listboxId}
                  focused={focusedIndex === index}
                  disabled={disabled}
                  accepting={acceptingRowId === row.id}
                  onAccept={(acceptedRow) => {
                    if (rowsStale) return;
                    activateRow(acceptedRow);
                  }}
                  onFocusRowChange={(rowId) => {
                    if (rowsStale) return;
                    setFocusedRowId(rowId);
                  }}
                />
              ))}
            </div>
          </div>
          {!projectId ? <SendToThreadStatusRow>No project selected</SendToThreadStatusRow> : null}
          {projectId && threadItemsLoading && visibleMainRowCount === 0 ? (
            <SendToThreadStatusRow>Loading chats...</SendToThreadStatusRow>
          ) : null}
          {projectId && !threadItemsLoading && visibleMainRowCount === 0 ? (
            <SendToThreadStatusRow>
              {deferredQuery.trim() ? "No matching chats" : "No chats yet"}
            </SendToThreadStatusRow>
          ) : null}
          {acceptError ? <SendToThreadStatusRow>{acceptError}</SendToThreadStatusRow> : null}
        </div>
        {projectId && footerRowEntry ? (
          <div className="shrink-0 px-1 pb-1 pt-1">
            <div className="mb-1 h-px w-full bg-token-menu-border" />
            <SendToThreadRow
              row={footerRowEntry.row}
              index={footerRowEntry.index}
              listboxId={listboxId}
              focused={focusedIndex === footerRowEntry.index}
              disabled={disabled}
              accepting={acceptingRowId === footerRowEntry.row.id}
              onAccept={(acceptedRow) => {
                if (rowsStale) return;
                activateRow(acceptedRow);
              }}
              onFocusRowChange={(rowId) => {
                if (rowsStale) return;
                setFocusedRowId(rowId);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
