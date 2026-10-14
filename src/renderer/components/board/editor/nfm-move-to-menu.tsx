import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ActivitySpinnerIcon, NfmSideMenuChevronRightIcon } from "@/components/shared/icons";
import { resolveQueryFreshAccept } from "@/lib/query-fresh-picker";
import { normalizeSearchText } from "@/lib/search-text";
import { StatusIcon } from "@/lib/status-presentation";
import type { BoardSummary, Project } from "@/lib/types";
import { useProjects } from "@/lib/use-projects";
import { useBoardsForProjects } from "@/lib/use-project-board-windows";
import {
  mergeDestinationSearchResults,
  useProjectPageDestinationSearch,
} from "@/lib/use-project-page-destination-search";
import { cn } from "@/lib/utils";
import {
  buildNfmMoveToSections,
  flattenNfmMoveToRows,
  getDefaultNfmMoveToExpandedProjectIds,
  getDefaultNfmMoveToProjectId,
  getNfmMoveToExecutableProjects,
  moveNfmMoveToFocusedRowId,
  resolveNfmMoveToFocusedRowId,
  type NfmMoveToDestination,
  type NfmMoveToResultScope,
  type NfmMoveToRow,
  type NfmMoveToSection,
} from "./nfm-move-to-menu-model";
import { createNfmMoveToSearchIndex } from "./nfm-move-to-menu-search";
import { ProjectMarker } from "@/components/workbench/project-marker";
import {
  NodexDestinationPicker,
  NodexDestinationPickerPageRowContent,
  NodexDestinationPickerSection,
  NodexDestinationPickerStatus,
} from "@/components/ui/destination-picker";

interface NfmMoveToMenuProps {
  sourceProjectId: string | null;
  sourcePageId: string | null;
  onAccept: (destination: NfmMoveToDestination) => Promise<void> | void;
  onClose: () => void;
  resultScope?: NfmMoveToResultScope;
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

export interface NfmMoveToMenuSurfaceProps extends NfmMoveToMenuProps {
  projects: readonly Project[];
  pageBoardMap: ReadonlyMap<string, BoardSummary>;
  loading: boolean;
  loadError?: string | null;
  initialQuery?: string;
  loadPageWindow?: boolean;
  enableRemotePageSearch?: boolean;
}

const MOVE_TO_MENU_LOAD_DELAY_MS = 400;
const MOVE_TO_MENU_ERROR = "Couldn’t move these blocks.";
const MOVE_TO_ROW_BASE_PADDING_X = 6;
const MOVE_TO_ROW_GAP = 6;
const MOVE_TO_ROW_PROJECT_ICON_SLOT_WIDTH = 22;
const MOVE_TO_ROW_COLUMN_PADDING_LEFT =
  MOVE_TO_ROW_BASE_PADDING_X + MOVE_TO_ROW_PROJECT_ICON_SLOT_WIDTH + MOVE_TO_ROW_GAP;

function getMoveToRowDomId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}

function keepEditorSelection(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) return;
  event.preventDefault();
}

function MoveToProjectIcon({
  projectAppearance,
  className,
}: {
  projectAppearance: Project["appearance"];
  className?: string;
}) {
  return <ProjectMarker appearance={projectAppearance} className={className} />;
}

type NfmMoveToNonPageRow = Exclude<NfmMoveToRow, { kind: "page" }>;

function MoveToRowIcon({ row }: { row: NfmMoveToNonPageRow }) {
  if (row.kind === "db-column") {
    return <StatusIcon statusId={row.columnId} label={row.columnName} className="size-4" />;
  }
  return <MoveToProjectIcon projectAppearance={row.projectAppearance} />;
}

function getMoveToRowLabel(row: NfmMoveToNonPageRow) {
  if (row.kind === "db-column") return row.columnName;
  return row.projectName;
}

function isAcceptableMoveToRow(
  row: NfmMoveToRow,
): row is Extract<NfmMoveToRow, { kind: "page" | "db-column" }> {
  return row.kind === "page" || row.kind === "db-column";
}

function NfmMoveToResultRow({
  row,
  index,
  listboxId,
  focused,
  disabled,
  accepting,
  showProjectName,
  onToggleProject,
  onAccept,
  onFocusRowChange,
}: {
  row: NfmMoveToRow;
  index: number;
  listboxId: string;
  focused: boolean;
  disabled: boolean;
  accepting: boolean;
  showProjectName: boolean;
  onToggleProject: (projectId: string) => void;
  onAccept: (row: NfmMoveToRow) => void;
  onFocusRowChange: (rowId: string) => void;
}) {
  return (
    <button
      id={getMoveToRowDomId(listboxId, index)}
      type="button"
      role="option"
      aria-selected={focused}
      aria-expanded={row.kind === "db" ? row.expanded : undefined}
      aria-disabled={disabled || undefined}
      data-focused={focused ? "true" : undefined}
      data-nfm-move-to-row-kind={row.kind}
      data-nfm-move-to-project-id={row.projectId}
      className={cn(
        "group flex h-7 w-full select-none items-center gap-1.5 rounded-[7px] pr-2 text-left text-sm leading-7 outline-hidden",
        "text-token-foreground",
        disabled
          ? "cursor-default opacity-55"
          : "cursor-interaction hover:bg-token-list-hover-background",
        focused && "bg-token-list-hover-background",
      )}
      style={{
        paddingLeft:
          row.kind === "db-column" ? MOVE_TO_ROW_COLUMN_PADDING_LEFT : MOVE_TO_ROW_BASE_PADDING_X,
      }}
      onPointerDown={keepEditorSelection}
      onPointerEnter={() => onFocusRowChange(row.id)}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        if (row.kind === "db") {
          onToggleProject(row.projectId);
          return;
        }
        onAccept(row);
      }}
    >
      {row.kind === "page" ? (
        <NodexDestinationPickerPageRowContent
          title={row.pageTitle}
          statusId={row.columnId}
          statusLabel={row.columnName}
          projectName={showProjectName ? row.projectName : undefined}
          accepting={accepting}
        />
      ) : (
        <>
          <span
            className={cn(
              "relative flex h-[18px] w-[22px] shrink-0 items-center justify-center text-token-description-foreground",
              row.kind === "db-column" && "w-[18px]",
            )}
          >
            {row.kind === "db" ? (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 flex items-center justify-center",
                    "group-hover:opacity-0 group-focus-visible:opacity-0",
                    focused && "opacity-0",
                  )}
                >
                  <MoveToRowIcon row={row} />
                </span>
                <NfmSideMenuChevronRightIcon
                  className={cn(
                    "icon-2xs opacity-0 transition-transform duration-150 ease-out",
                    "group-hover:opacity-100 group-focus-visible:opacity-100",
                    focused && "opacity-100",
                    row.expanded ? "rotate-90" : "rotate-0",
                  )}
                />
              </>
            ) : (
              <MoveToRowIcon row={row} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{getMoveToRowLabel(row)}</span>
          {accepting && row.kind === "db-column" ? (
            <ActivitySpinnerIcon className="size-3.5 shrink-0 text-token-description-foreground" />
          ) : null}
        </>
      )}
    </button>
  );
}

function NfmMoveToSectionView({
  section,
  listboxId,
  startIndex,
  focusedIndex,
  disabled,
  acceptingRowId,
  showProjectName,
  onToggleProject,
  onAccept,
  onFocusRowChange,
}: {
  section: NfmMoveToSection;
  listboxId: string;
  startIndex: number;
  focusedIndex: number;
  disabled: boolean;
  acceptingRowId: string | null;
  showProjectName: boolean;
  onToggleProject: (projectId: string) => void;
  onAccept: (row: NfmMoveToRow) => void;
  onFocusRowChange: (rowId: string) => void;
}) {
  if (section.rows.length === 0) return null;

  return (
    <NodexDestinationPickerSection label={section.label}>
      {section.rows.map((row, offset) => {
        const index = startIndex + offset;
        return (
          <NfmMoveToResultRow
            key={row.id}
            row={row}
            index={index}
            listboxId={listboxId}
            focused={focusedIndex === index}
            disabled={disabled}
            accepting={acceptingRowId === row.id}
            showProjectName={showProjectName}
            onToggleProject={onToggleProject}
            onAccept={onAccept}
            onFocusRowChange={onFocusRowChange}
          />
        );
      })}
    </NodexDestinationPickerSection>
  );
}

export function NfmMoveToMenu({
  sourceProjectId,
  sourcePageId,
  onAccept,
  onClose,
  resultScope,
  ariaLabel,
  placeholder,
  autoFocus,
}: NfmMoveToMenuProps) {
  const { projects, loading, error } = useProjects();
  const scopedProjects = getNfmMoveToExecutableProjects(projects, sourceProjectId);
  const scopeError =
    error ??
    (!loading && sourceProjectId && scopedProjects.length === 0
      ? "The current Project is unavailable."
      : null);

  return (
    <NfmMoveToMenuSurface
      projects={scopedProjects}
      pageBoardMap={new Map()}
      loading={loading}
      loadError={scopeError}
      loadPageWindow
      enableRemotePageSearch
      sourceProjectId={sourceProjectId}
      sourcePageId={sourcePageId}
      onAccept={onAccept}
      onClose={onClose}
      resultScope={resultScope}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      autoFocus={autoFocus}
    />
  );
}

export function NfmMoveToMenuSurface({
  projects,
  pageBoardMap: providedPageBoardMap,
  sourceProjectId,
  sourcePageId,
  loading,
  loadError = null,
  initialQuery = "",
  loadPageWindow = false,
  enableRemotePageSearch = false,
  resultScope = "all",
  ariaLabel = "Move blocks to",
  placeholder = "Move blocks to…",
  autoFocus = false,
  onAccept,
  onClose,
}: NfmMoveToMenuSurfaceProps) {
  const listboxId = useId();
  const comboboxId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() =>
    getDefaultNfmMoveToExpandedProjectIds(projects, sourceProjectId),
  );
  const defaultPageProjectId = getDefaultNfmMoveToProjectId(projects, sourceProjectId);
  const pageProjects = useMemo(
    () =>
      loadPageWindow && resultScope !== "db-only"
        ? projects.filter((project) => project.id === defaultPageProjectId)
        : [],
    [defaultPageProjectId, loadPageWindow, projects, resultScope],
  );
  const pageBoards = useBoardsForProjects(pageProjects);
  const pageBoardMap = useMemo(() => {
    if (!loadPageWindow) return providedPageBoardMap;
    return new Map([...providedPageBoardMap, ...pageBoards.boards]);
  }, [loadPageWindow, pageBoards.boards, providedPageBoardMap]);
  const resolvedLoading = loading || pageBoards.loading;
  const resolvedLoadError = loadError ?? pageBoards.error;
  const [acceptingRowId, setAcceptingRowId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);

  useEffect(() => {
    setExpandedProjectIds(getDefaultNfmMoveToExpandedProjectIds(projects, sourceProjectId));
  }, [projects, sourceProjectId]);

  useEffect(() => {
    setQuery(initialQuery);
    setFocusedRowId(null);
  }, [initialQuery]);

  useEffect(() => {
    if (!resolvedLoading) {
      setShowDelayedLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowDelayedLoading(true);
    }, MOVE_TO_MENU_LOAD_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [resolvedLoading]);

  const searchIndex = useMemo(
    () =>
      createNfmMoveToSearchIndex({
        projects,
        boardMap: pageBoardMap,
        sourceProjectId,
        sourcePageId,
      }),
    [pageBoardMap, projects, sourcePageId, sourceProjectId],
  );
  const searchResult = useMemo(() => searchIndex.search(query), [query, searchIndex]);
  const pageSearchEnabled = enableRemotePageSearch && resultScope !== "db-only";
  const remoteSearchResult = useProjectPageDestinationSearch({
    projects,
    query,
    enabled: pageSearchEnabled,
    sourceProjectId,
    sourcePageId,
  });
  const resolvedSearchResult = useMemo(
    () => mergeDestinationSearchResults(searchResult, remoteSearchResult),
    [remoteSearchResult, searchResult],
  );
  const sections = useMemo(
    () =>
      buildNfmMoveToSections({
        projects,
        pageBoardMap,
        sourceProjectId,
        sourcePageId,
        expandedProjectIds,
        query,
        searchResult: resolvedSearchResult,
        resultScope,
      }),
    [
      pageBoardMap,
      expandedProjectIds,
      projects,
      query,
      resultScope,
      resolvedSearchResult,
      sourcePageId,
      sourceProjectId,
    ],
  );
  const rows = useMemo(() => flattenNfmMoveToRows(sections), [sections]);
  const buildRowsForQuery = useCallback(
    (nextQuery: string): readonly NfmMoveToRow[] => {
      const nextSearchResult =
        normalizeSearchText(nextQuery) === resolvedSearchResult.normalizedQuery
          ? resolvedSearchResult
          : searchIndex.search(nextQuery);
      const nextSections = buildNfmMoveToSections({
        projects,
        pageBoardMap,
        sourceProjectId,
        sourcePageId,
        expandedProjectIds,
        query: nextQuery,
        searchResult: nextSearchResult,
        resultScope,
      });
      return flattenNfmMoveToRows(nextSections);
    },
    [
      pageBoardMap,
      expandedProjectIds,
      projects,
      resultScope,
      resolvedSearchResult,
      searchIndex,
      sourcePageId,
      sourceProjectId,
    ],
  );
  const resolvedFocusedRowId = resolveNfmMoveToFocusedRowId(focusedRowId, query, rows);
  const focusedIndex = resolvedFocusedRowId
    ? rows.findIndex((row) => row.id === resolvedFocusedRowId)
    : -1;
  const activeDescendantId =
    focusedIndex >= 0 && focusedIndex < rows.length
      ? getMoveToRowDomId(listboxId, focusedIndex)
      : undefined;
  const displayError = acceptError ?? resolvedLoadError;
  const visibleRowCount = rows.length;
  const disabled = Boolean(acceptingRowId);
  const showProjectName = projects.length > 1;

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
        return next;
      }
      next.add(projectId);
      return next;
    });
  }, []);

  const acceptRow = useCallback(
    async (row: NfmMoveToRow) => {
      if (!isAcceptableMoveToRow(row)) return;
      setAcceptError(null);
      setAcceptingRowId(row.id);
      try {
        await onAccept(row.destination);
        setAcceptingRowId(null);
      } catch (error) {
        console.error("[nfm-move-to:accept]", {
          destination: row.destination,
          error,
        });
        setAcceptError(
          error instanceof Error && error.message.trim() ? error.message : MOVE_TO_MENU_ERROR,
        );
        setAcceptingRowId(null);
      }
    },
    [onAccept],
  );

  const activateRow = useCallback(
    (row: NfmMoveToRow | undefined) => {
      if (!row || disabled) return;
      if (row.kind === "db") {
        toggleProject(row.projectId);
        return;
      }
      void acceptRow(row);
    },
    [acceptRow, disabled, toggleProject],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedRowId((currentRowId) =>
        moveNfmMoveToFocusedRowId(resolveNfmMoveToFocusedRowId(currentRowId, query, rows), 1, rows),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedRowId((currentRowId) =>
        moveNfmMoveToFocusedRowId(
          resolveNfmMoveToFocusedRowId(currentRowId, query, rows),
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
        rowsQuery: query,
        rows,
        focusedIndex,
        buildFreshRows: buildRowsForQuery,
        getRowId: (row) => row.id,
        normalizeQuery: normalizeSearchText,
      });
      if (result.status === "accepted") {
        activateRow(result.row);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let rowIndex = 0;

  return (
    <NodexDestinationPicker
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      query={query}
      inputId={comboboxId}
      listboxId={listboxId}
      activeDescendantId={activeDescendantId}
      busy={resolvedLoading}
      onQueryChange={(nextQuery) => {
        setAcceptError(null);
        setFocusedRowId(null);
        setQuery(nextQuery);
      }}
      onKeyDown={handleInputKeyDown}
      autoFocus={autoFocus}
    >
      {sections.map((section) => {
        const startIndex = rowIndex;
        rowIndex += section.rows.length;
        return (
          <NfmMoveToSectionView
            key={section.key}
            section={section}
            listboxId={listboxId}
            startIndex={startIndex}
            focusedIndex={focusedIndex}
            disabled={disabled}
            acceptingRowId={acceptingRowId}
            showProjectName={showProjectName}
            onToggleProject={toggleProject}
            onAccept={(row) => void acceptRow(row)}
            onFocusRowChange={setFocusedRowId}
          />
        );
      })}
      {showDelayedLoading ? (
        <NodexDestinationPickerStatus role="status">
          <ActivitySpinnerIcon className="mr-2 size-3.5 text-token-description-foreground" />
          Loading…
        </NodexDestinationPickerStatus>
      ) : null}
      {query && pageSearchEnabled && remoteSearchResult.enrichment === "loading" ? (
        <NodexDestinationPickerStatus role="status">
          {rows.length > 0 ? "Loading more Pages…" : "Loading Pages…"}
        </NodexDestinationPickerStatus>
      ) : null}
      {query && pageSearchEnabled && remoteSearchResult.enrichment === "unavailable" ? (
        <NodexDestinationPickerStatus role="status">
          Full Page search is unavailable
        </NodexDestinationPickerStatus>
      ) : null}
      {displayError ? (
        <NodexDestinationPickerStatus role="alert">{displayError}</NodexDestinationPickerStatus>
      ) : null}
      {!resolvedLoading && !displayError && visibleRowCount === 0 ? (
        <NodexDestinationPickerStatus role="status">No results</NodexDestinationPickerStatus>
      ) : null}
    </NodexDestinationPicker>
  );
}
