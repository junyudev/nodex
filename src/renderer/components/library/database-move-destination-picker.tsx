import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";

import { PageIcon, ActivitySpinnerIcon } from "@/components/shared/icons";
import {
  NodexDestinationPicker,
  NodexDestinationPickerOption,
  NodexDestinationPickerSection,
  NodexDestinationPickerStatus,
} from "@/components/ui/destination-picker";
import { buildLibraryMoveOperation } from "@/lib/library-operations";
import { normalizeSearchText } from "@/lib/search-text";
import {
  useApplyLibraryOperation,
  useLibraryMoveDestinationChildren,
  useLibraryMoveDestinations,
} from "@/lib/use-library-navigation";
import type {
  LibraryMoveDestinationEntry,
  LibraryResourceTarget,
  LibraryWriteParent,
} from "../../../shared/library-module";
import {
  configuredPageSearchProjectIds,
  useInteractivePageSearch,
} from "@/lib/interactive-page-search";

const ROOT_ROW_ID = "library-root";
const LOAD_DELAY_MS = 400;

export type DatabaseMoveDestinationPickerRow =
  | {
      readonly kind: "root";
      readonly id: typeof ROOT_ROW_ID;
      readonly label: "Pages";
      readonly metadata: "Top level" | "Current";
      readonly disabled: boolean;
    }
  | {
      readonly kind: "page";
      readonly id: string;
      readonly entry: LibraryMoveDestinationEntry;
      readonly depth: number;
      readonly expanded: boolean;
      readonly context: "recent" | "search" | "tree";
    };

export interface DatabaseMoveDestinationPickerSection {
  readonly key: "recent" | "search" | "pages";
  readonly label: string;
  readonly rows: readonly DatabaseMoveDestinationPickerRow[];
}

function destinationRowDomId(listboxId: string, rowId: string) {
  return `${listboxId}-${rowId.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function moveFocus(
  rows: readonly DatabaseMoveDestinationPickerRow[],
  currentId: string | null,
  direction: 1 | -1,
) {
  if (rows.length === 0) return null;
  const currentIndex = currentId ? rows.findIndex((row) => row.id === currentId) : -1;
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const index =
      currentIndex < 0
        ? direction > 0
          ? offset - 1
          : rows.length - offset
        : (currentIndex + direction * offset + rows.length) % rows.length;
    const row = rows[index];
    if (row && !rowDisabled(row)) return row.id;
  }
  return null;
}

function rowDisabled(row: DatabaseMoveDestinationPickerRow) {
  return row.kind === "root" ? row.disabled : row.entry.isCurrent;
}

function rowMetadata(row: DatabaseMoveDestinationPickerRow) {
  if (row.kind === "root") return row.metadata;
  if (row.entry.isCurrent) return "Current";
  if (row.context === "tree") return "";
  return row.entry.path.join(" / ");
}

function DestinationRow({
  row,
  listboxId,
  focused,
  accepting,
  pickerDisabled,
  onFocus,
  onToggle,
  onAccept,
}: {
  readonly row: DatabaseMoveDestinationPickerRow;
  readonly listboxId: string;
  readonly focused: boolean;
  readonly accepting: boolean;
  readonly pickerDisabled: boolean;
  readonly onFocus: () => void;
  readonly onToggle: () => void;
  readonly onAccept: () => void;
}) {
  const disabled = pickerDisabled || rowDisabled(row);
  const metadata = rowMetadata(row);
  const expandable = row.kind === "page" && row.context === "tree" && row.entry.hasChildren;

  return (
    <NodexDestinationPickerOption
      id={destinationRowDomId(listboxId, row.id)}
      focused={focused}
      disabled={disabled}
      depth={row.kind === "page" ? row.depth : 0}
      expanded={expandable ? row.expanded : undefined}
      icon={<PageIcon className="size-4" aria-hidden="true" />}
      onFocus={onFocus}
      onToggle={expandable ? onToggle : undefined}
      onSelect={onAccept}
    >
      <span className="min-w-0 flex-1 truncate">
        {row.kind === "root" ? row.label : row.entry.title || "Untitled"}
      </span>
      {metadata ? (
        <span className="ml-1 max-w-[132px] shrink truncate text-[12px] leading-4 text-token-description-foreground">
          {metadata}
        </span>
      ) : null}
      {accepting ? (
        <ActivitySpinnerIcon className="size-3.5 shrink-0 text-token-description-foreground" />
      ) : null}
    </NodexDestinationPickerOption>
  );
}

export function DatabaseMoveDestinationPickerSurface({
  ariaLabel,
  query,
  sections,
  loading,
  stale,
  error,
  acceptingRowId,
  hasMore,
  onQueryChange,
  onToggle,
  onAccept,
  onClose,
}: {
  readonly ariaLabel: string;
  readonly query: string;
  readonly sections: readonly DatabaseMoveDestinationPickerSection[];
  readonly loading: boolean;
  readonly stale: boolean;
  readonly error: string | null;
  readonly acceptingRowId: string | null;
  readonly hasMore: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onToggle: (row: Extract<DatabaseMoveDestinationPickerRow, { kind: "page" }>) => void;
  readonly onAccept: (row: DatabaseMoveDestinationPickerRow) => void;
  readonly onClose: () => void;
}) {
  const listboxId = useId();
  const inputId = useId();
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const resolvedFocusedRowId =
    focusedRowId && rows.some((row) => row.id === focusedRowId)
      ? focusedRowId
      : moveFocus(rows, null, 1);
  const focusedRow = rows.find((row) => row.id === resolvedFocusedRowId);
  const activeDescendantId = resolvedFocusedRowId
    ? destinationRowDomId(listboxId, resolvedFocusedRowId)
    : undefined;
  const pickerDisabled = acceptingRowId !== null || stale;

  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), LOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (stale || pickerDisabled) return;
      setFocusedRowId(moveFocus(rows, resolvedFocusedRowId, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "ArrowRight" && focusedRow?.kind === "page") {
      if (focusedRow.context !== "tree" || !focusedRow.entry.hasChildren) return;
      event.preventDefault();
      if (!focusedRow.expanded) onToggle(focusedRow);
      return;
    }
    if (event.key === "ArrowLeft" && focusedRow?.kind === "page") {
      if (focusedRow.context !== "tree" || !focusedRow.expanded) return;
      event.preventDefault();
      onToggle(focusedRow);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!focusedRow || stale || pickerDisabled || rowDisabled(focusedRow)) return;
    onAccept(focusedRow);
  };

  return (
    <NodexDestinationPicker
      ariaLabel={ariaLabel}
      placeholder="Search Pages…"
      query={query}
      inputId={inputId}
      listboxId={listboxId}
      activeDescendantId={activeDescendantId}
      busy={loading || stale}
      dialogRole="presentation"
      autoFocus
      onQueryChange={(nextQuery) => {
        setFocusedRowId(null);
        onQueryChange(nextQuery);
      }}
      onKeyDown={handleKeyDown}
    >
      {sections.map((section) =>
        section.rows.length > 0 ? (
          <NodexDestinationPickerSection key={section.key} label={section.label}>
            {section.rows.map((row) => (
              <DestinationRow
                key={`${section.key}:${row.id}`}
                row={row}
                listboxId={listboxId}
                focused={row.id === resolvedFocusedRowId}
                accepting={row.id === acceptingRowId}
                pickerDisabled={pickerDisabled}
                onFocus={() => {
                  if (!stale) setFocusedRowId(row.id);
                }}
                onToggle={() => {
                  if (row.kind === "page") onToggle(row);
                }}
                onAccept={() => onAccept(row)}
              />
            ))}
          </NodexDestinationPickerSection>
        ) : null,
      )}
      {showLoading ? (
        <NodexDestinationPickerStatus>
          <ActivitySpinnerIcon className="mr-2 size-3.5 text-token-description-foreground" />
          {rows.length > 0 ? "Loading more Pages…" : "Loading Pages…"}
        </NodexDestinationPickerStatus>
      ) : null}
      {error ? <NodexDestinationPickerStatus>{error}</NodexDestinationPickerStatus> : null}
      {!loading && !error && rows.length === 0 ? (
        <NodexDestinationPickerStatus>No matching Pages</NodexDestinationPickerStatus>
      ) : null}
      {!query && hasMore ? (
        <NodexDestinationPickerStatus>
          Search to find destinations outside this window
        </NodexDestinationPickerStatus>
      ) : null}
    </NodexDestinationPicker>
  );
}

function flattenTreeRows(
  rootItems: readonly LibraryMoveDestinationEntry[],
  childItems: ReadonlyMap<string, readonly LibraryMoveDestinationEntry[]>,
  expandedIds: ReadonlySet<string>,
) {
  const rows: DatabaseMoveDestinationPickerRow[] = [];
  const visited = new Set<string>();
  const append = (items: readonly LibraryMoveDestinationEntry[], depth: number) => {
    for (const entry of items) {
      if (!visited.add(entry.pageId)) continue;
      rows.push({
        kind: "page",
        id: `tree:${entry.pageId}`,
        entry,
        depth,
        expanded: expandedIds.has(entry.pageId),
        context: "tree",
      });
      if (!expandedIds.has(entry.pageId)) continue;
      append(childItems.get(entry.pageId) ?? [], depth + 1);
    }
  };
  append(rootItems, 0);
  return rows;
}

export function DatabaseMoveDestinationPicker({
  target,
  title,
  expectedLocationRevision,
  onClose,
  onMoved,
}: {
  readonly target: Extract<LibraryResourceTarget, { readonly kind: "database" }>;
  readonly title: string;
  readonly expectedLocationRevision: number;
  readonly onClose: () => void;
  readonly onMoved: () => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeSearchText(query);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [acceptingRowId, setAcceptingRowId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const { mutation } = useApplyLibraryOperation();
  const root = useLibraryMoveDestinations(
    target,
    {
      scope: { kind: "children", parent: { kind: "library" } },
      limit: 100,
    },
    !normalizedQuery,
  );
  const recent = useLibraryMoveDestinations(
    target,
    {
      scope: { kind: "suggested" },
      limit: 8,
    },
    !normalizedQuery,
  );
  const search = useLibraryMoveDestinations(
    target,
    {
      scope: { kind: "search", query: normalizedQuery || "disabled" },
      limit: 100,
    },
    Boolean(normalizedQuery),
  );
  const metadataSearch = useInteractivePageSearch({
    projectIds: configuredPageSearchProjectIds(),
    query: normalizedQuery,
    excludePageIds: [],
    limit: 100,
    complete: false,
  });
  const expandedPageIds = useMemo(() => [...expandedIds].sort(), [expandedIds]);
  const childQueries = useLibraryMoveDestinationChildren(target, expandedPageIds, !normalizedQuery);
  const childItems = new Map(
    expandedPageIds.map(
      (pageId, index) => [pageId, childQueries[index]?.data?.items ?? []] as const,
    ),
  );
  const treeRows = flattenTreeRows(root.data?.items ?? [], childItems, expandedIds);
  const rootIsCurrent = root.data?.rootIsCurrent ?? recent.data?.rootIsCurrent ?? false;
  const rootRow: DatabaseMoveDestinationPickerRow = {
    kind: "root",
    id: ROOT_ROW_ID,
    label: "Pages",
    metadata: rootIsCurrent ? "Current" : "Top level",
    disabled: rootIsCurrent,
  };
  const currentDestination =
    recent.data?.currentDestination ?? root.data?.currentDestination ?? null;
  const recentDestinations = currentDestination
    ? [
        currentDestination,
        ...(recent.data?.items ?? []).filter((entry) => entry.pageId !== currentDestination.pageId),
      ]
    : (recent.data?.items ?? []);
  const searchEntries =
    search.data?.items ??
    (search.isPending
      ? metadataSearch.rows.map((row): LibraryMoveDestinationEntry => ({
          pageId: row.pageId,
          title: row.title,
          path: row.locationLabel.split(" / ").filter(Boolean),
          hasChildren: false,
          documentGeneration: 0,
          documentHeadSeq: 0,
          updatedAt: row.updatedAt,
          isCurrent: false,
        }))
      : []);
  const sections = normalizedQuery
    ? [
        {
          key: "search" as const,
          label: "Search results",
          rows: searchEntries.map((entry) => ({
            kind: "page" as const,
            id: `search:${entry.pageId}`,
            entry,
            depth: 0,
            expanded: false,
            context: "search" as const,
          })),
        },
      ]
    : [
        {
          key: "recent" as const,
          label: "Recent",
          rows: recentDestinations.slice(0, 5).map((entry) => ({
            kind: "page" as const,
            id: `recent:${entry.pageId}`,
            entry,
            depth: 0,
            expanded: false,
            context: "recent" as const,
          })),
        },
        {
          key: "pages" as const,
          label: "Pages",
          rows: [rootRow, ...treeRows],
        },
      ];
  const rowsStale = Boolean(normalizedQuery && search.isPending);
  const activeQuery = normalizedQuery ? search : root;
  const loading =
    activeQuery.isPending ||
    (!normalizedQuery && recent.isPending) ||
    childQueries.some((child) => child.isPending);
  const loadError =
    activeQuery.error ?? recent.error ?? childQueries.find((child) => child.error)?.error;
  const hasMore =
    Boolean(activeQuery.data?.hasMore) ||
    (!normalizedQuery && childQueries.some((child) => child.data?.hasMore));

  const accept = async (row: DatabaseMoveDestinationPickerRow) => {
    const parent: LibraryWriteParent =
      row.kind === "root"
        ? { kind: "library" }
        : {
            kind: "page",
            pageId: row.entry.pageId,
            expectedDocumentGeneration: row.entry.documentGeneration,
            expectedDocumentHeadSeq: row.entry.documentHeadSeq,
          };
    setAcceptError(null);
    setAcceptingRowId(row.id);
    try {
      await mutation.mutateAsync(
        buildLibraryMoveOperation({
          target,
          expectedLocationRevision,
          parent,
        }),
      );
      onMoved();
    } catch (error) {
      setAcceptError(error instanceof Error ? error.message : "Could not move Library item");
      setAcceptingRowId(null);
    }
  };

  return (
    <DatabaseMoveDestinationPickerSurface
      ariaLabel={`Move ${title} to`}
      query={query}
      sections={sections}
      loading={loading}
      stale={rowsStale}
      error={acceptError ?? (loadError ? "Could not load destinations" : null)}
      acceptingRowId={acceptingRowId}
      hasMore={hasMore}
      onQueryChange={(nextQuery) => {
        setAcceptError(null);
        setQuery(nextQuery);
      }}
      onToggle={(row) => {
        setExpandedIds((current) => {
          const next = new Set(current);
          if (next.has(row.entry.pageId)) next.delete(row.entry.pageId);
          else next.add(row.entry.pageId);
          return next;
        });
      }}
      onAccept={(row) => void accept(row)}
      onClose={onClose}
    />
  );
}
