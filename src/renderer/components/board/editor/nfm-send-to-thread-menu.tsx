import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ActivitySpinnerIcon, PlusIcon, SearchIcon, ThreadIcon } from "@/components/shared/icons";
import {
  chatHighlightSegments,
  mergeChatSearchMatches,
  preferChatProject,
  useChatMessageSearch,
  useChatSearch,
} from "@/lib/chat-search";
import type { CommandPaletteHighlightSegment } from "@/lib/command-palette-highlight";
import { pageChatWindowQueryOptions } from "@/lib/query-options";
import { normalizeSearchText as normalizeCommandPaletteSearchText } from "@/lib/search-text";
import {
  areQueryFresh,
  resolvePendingQueryFreshAccept,
  resolveQueryFreshAccept,
  shouldConsumeStalePickerNavigation,
} from "@/lib/query-fresh-picker";
import { cn } from "@/lib/utils";
import {
  buildNfmSendToThreadRows,
  createLinkedChatMatch,
  moveNfmSendToThreadFocusedRowId,
  resolveNfmSendToThreadFocusedRowId,
  type NfmSendToThreadPreferredTarget,
  type NfmSendToThreadRequest,
  type NfmSendToThreadRow,
} from "./nfm-send-to-thread-menu-model";

export interface NfmSendToThreadMenuProps {
  projectId: string | null;
  /** The Page being sent, whose Linked chats lead the list. */
  sourcePageId?: string | null;
  projectNameById?: Readonly<Record<string, string>>;
  preferredTarget?: NfmSendToThreadPreferredTarget | null;
  initialQuery?: string;
  onAccept: (request: NfmSendToThreadRequest) => Promise<void> | void;
  onClose: () => void;
}

const SEND_TO_THREAD_ERROR = "Could not send";
const SEND_TO_THREAD_RESULT_LIMIT = 24;
const LINKED_CHAT_LIMIT = 20;

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
  const excerpt = row.kind === "thread" ? row.match.excerpt : null;
  const hasPreview = Boolean(excerpt);
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
        "group flex w-full select-none gap-1.5 rounded-[7px] px-1.5 text-left text-sm outline-hidden",
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
        {/* The current chat is a chat even before its first Turn; only a new chat is new. */}
        {row.kind === "new-thread" && !row.isPreferredTarget ? (
          <PlusIcon className="size-4" aria-hidden="true" />
        ) : (
          <ThreadIcon className="size-4" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("flex min-w-0 items-center", hasPreview ? "h-5" : "h-7")}>
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="ml-1 max-w-[118px] shrink truncate text-xs leading-4 text-token-description-foreground">
            {row.meta}
          </span>
        </span>
        {excerpt ? (
          <span className="line-clamp-1 text-xs leading-4 wrap-break-word text-token-description-foreground/90">
            {renderSendToThreadPreviewSegments(
              chatHighlightSegments(excerpt.text, excerpt.ranges) ?? [
                { text: excerpt.text, highlight: false },
              ],
              `${row.id}:preview`,
            )}
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
  sourcePageId = null,
  projectNameById,
  preferredTarget = null,
  initialQuery = "",
  onAccept,
  onClose,
}: NfmSendToThreadMenuProps) {
  const listboxId = useId();
  const comboboxId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [immediateAcceptingRowId, setAcceptingRowId] = useState<string | null>(null);
  const [readyRow, setReadyRow] = useState<NfmSendToThreadRow | null>(null);
  const acceptingRowId = immediateAcceptingRowId ?? readyRow?.id ?? null;
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [pendingAcceptQuery, setPendingAcceptQuery] = useState<string | null>(null);
  // Sending targets a Thread, so only started chats are destinations.
  const chatSearch = useChatSearch({
    enabled: Boolean(projectId),
    query,
    limit: SEND_TO_THREAD_RESULT_LIMIT,
    startedOnly: true,
  });
  const chatMessageSearch = useChatMessageSearch({
    enabled: Boolean(projectId),
    query,
    limit: SEND_TO_THREAD_RESULT_LIMIT,
  });
  const linkedChatWindows = useInfiniteQuery({
    ...pageChatWindowQueryOptions({
      pageId: sourcePageId ?? "",
      includeArchived: false,
      first: LINKED_CHAT_LIMIT,
    }),
    enabled: Boolean(projectId && sourcePageId),
  });
  const linkedChats = useMemo(
    () =>
      linkedChatWindows.data?.pages.flatMap((window) =>
        window.items.flatMap((item) => createLinkedChatMatch(item) ?? []),
      ),
    [linkedChatWindows.data],
  );
  // Rows answer the query chat search last answered; keys and Enter wait for the live one.
  const rowsQuery = chatSearch.query;
  const [previousInitialQuery, setPreviousInitialQuery] = useState(initialQuery);
  if (previousInitialQuery !== initialQuery) {
    setPreviousInitialQuery(initialQuery);
    setQuery(initialQuery);
    setFocusedRowId(null);
    setPendingAcceptQuery(null);
  }

  const messageMatches = chatMessageSearch.query === rowsQuery ? chatMessageSearch.matches : null;
  const rows = useMemo(
    () =>
      projectId
        ? buildNfmSendToThreadRows({
            matches: preferChatProject(
              mergeChatSearchMatches(
                chatSearch.matches,
                messageMatches ?? [],
                SEND_TO_THREAD_RESULT_LIMIT,
              ),
              projectId,
            ),
            linkedChats,
            query: rowsQuery,
            preferredTarget,
            projectNameById,
          })
        : [],
    [
      chatSearch.matches,
      linkedChats,
      messageMatches,
      preferredTarget,
      projectId,
      projectNameById,
      rowsQuery,
    ],
  );
  const rowsStale = shouldConsumeStalePickerNavigation({
    liveQuery: query,
    rowsQuery,
    normalizeQuery: normalizeCommandPaletteSearchText,
  });
  // A new chat is accepted only once chat search has answered whether an existing one matches.
  const waitingForChats =
    Boolean(projectId) &&
    normalizeCommandPaletteSearchText(query).length > 0 &&
    !chatSearch.settled;
  const resolveAcceptableRows = useCallback(
    (candidateRows: readonly NfmSendToThreadRow[]) =>
      waitingForChats ? candidateRows.filter((row) => row.kind === "thread") : candidateRows,
    [waitingForChats],
  );
  const resolvedFocusedRowId = resolveNfmSendToThreadFocusedRowId(focusedRowId, rowsQuery, rows);
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

  const acceptRow = useCallback(
    async (row: NfmSendToThreadRow) => {
      setAcceptError(null);
      setAcceptingRowId(row.id);
      try {
        await onAccept({ target: row.target });
        setAcceptingRowId(null);
      } catch (error) {
        const message = error instanceof Error ? error.message.trim() : "";
        setAcceptError(message || SEND_TO_THREAD_ERROR);
        setAcceptingRowId(null);
      }
    },
    [onAccept],
  );

  const activateRow = useCallback(
    (row: NfmSendToThreadRow | undefined) => {
      if (!row || disabled) return;
      setPendingAcceptQuery(null);
      void acceptRow(row);
    },
    [acceptRow, disabled],
  );

  const pendingResult = pendingAcceptQuery
    ? resolvePendingQueryFreshAccept({
        pendingQuery: pendingAcceptQuery,
        liveQuery: query,
        rowsQuery,
        rows: resolveAcceptableRows(rows),
        getRowId: (row) => row.id,
        normalizeQuery: normalizeCommandPaletteSearchText,
      })
    : null;
  if (pendingAcceptQuery && pendingResult?.status === "accepted" && !disabled) {
    setPendingAcceptQuery(null);
    setAcceptError(null);
    setReadyRow(pendingResult.row);
  }
  if (
    pendingAcceptQuery &&
    pendingResult?.status !== "accepted" &&
    !waitingForChats &&
    areQueryFresh({
      liveQuery: query,
      rowsQuery,
      normalizeQuery: normalizeCommandPaletteSearchText,
    })
  )
    setPendingAcceptQuery(null);

  const startedRowRef = useRef<NfmSendToThreadRow | null>(null);
  useEffect(() => {
    if (!readyRow || startedRowRef.current === readyRow) return;
    startedRowRef.current = readyRow;
    const accept = async () => onAccept({ target: readyRow.target });
    void accept()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message.trim() : "";
        setAcceptError(message || SEND_TO_THREAD_ERROR);
      })
      .finally(() => {
        startedRowRef.current = null;
        setReadyRow((current) => (current === readyRow ? null : current));
      });
  }, [onAccept, readyRow]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rowsStale) return;
      setFocusedRowId((currentRowId) =>
        moveNfmSendToThreadFocusedRowId(
          resolveNfmSendToThreadFocusedRowId(currentRowId, rowsQuery, rows),
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
          resolveNfmSendToThreadFocusedRowId(currentRowId, rowsQuery, rows),
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
        rowsQuery,
        rows,
        focusedIndex,
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
      className="flex max-h-[70vh] w-[330px] max-w-[calc(100vw-24px)] flex-col overflow-hidden text-sm leading-[1.2]"
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
          aria-label="Search chats"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-activedescendant={activeDescendantId}
          value={query}
          placeholder="Search chats…"
          className="h-7 min-w-0 flex-1 rounded-[7px] bg-transparent px-1.5 py-[3px] text-sm text-token-foreground outline-hidden placeholder:text-token-description-foreground focus:bg-token-foreground/5"
          onChange={(event) => {
            setAcceptError(null);
            setFocusedRowId(null);
            setPendingAcceptQuery(null);
            setQuery(event.target.value);
          }}
          onKeyDown={handleInputKeyDown}
        />
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-labelledby={comboboxId}
        aria-busy={
          rowsStale ||
          !chatSearch.settled ||
          chatMessageSearch.pending ||
          pendingAcceptQuery !== null
        }
        className="flex h-[340px] min-h-0 flex-col"
      >
        <div className="notion-scroller vertical min-h-0 flex-1 overflow-y-auto pb-1">
          <div className="pb-1">
            <div className="flex h-7 items-end px-[14px] pb-1 pt-3 text-xs leading-4 font-medium text-token-description-foreground">
              <span className="min-w-0 flex-1 truncate">Send to</span>
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
          {projectId && visibleMainRowCount === 0 ? (
            <SendToThreadStatusRow>
              {!chatSearch.answered
                ? "Loading chats..."
                : chatMessageSearch.pending
                  ? "Searching chat history…"
                  : rowsQuery
                    ? "No matching chats"
                    : "No chats yet"}
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
