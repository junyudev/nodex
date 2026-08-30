import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { ActivitySpinnerIcon, DatabaseIcon, PageIcon } from "@/components/shared/icons";
import {
  NodexDestinationPicker,
  NodexDestinationPickerOption,
  NodexDestinationPickerSection,
  NodexDestinationPickerStatus,
} from "@/components/ui/destination-picker";
import { toast } from "@/components/ui/toast";
import {
  configuredPageSearchProjectIds,
  useInteractivePageSearch,
} from "@/lib/interactive-page-search";
import { normalizeSearchText } from "@/lib/search-text";
import {
  useApplyLibraryOperation,
  useLibraryPageRelocationChildren,
  useLibraryPageRelocationDestinations,
  useUndoLibraryPageRelocation,
} from "@/lib/use-library-navigation";
import type { LibraryPageRelocationDestinationEntry } from "../../../shared/library-module";

const LOAD_DELAY_MS = 400;

interface AuthoritativeDestinationRow {
  readonly id: string;
  readonly entry: LibraryPageRelocationDestinationEntry;
  readonly depth: number;
  readonly expanded: boolean;
  readonly context: "database" | "recent" | "page" | "search";
  readonly authority: "ready";
}

interface PreviewDestinationRow {
  readonly id: string;
  readonly title: string;
  readonly path: readonly string[];
  readonly depth: 0;
  readonly expanded: false;
  readonly context: "preview";
  readonly authority: "preview";
}

type DestinationRow = AuthoritativeDestinationRow | PreviewDestinationRow;

const rowDomId = (listboxId: string, rowId: string): string =>
  `${listboxId}-${rowId.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;

const pageDestinationId = (entry: LibraryPageRelocationDestinationEntry): string | null =>
  entry.kind === "page" && entry.destination.kind === "page" ? entry.destination.pageId : null;

const nextEnabledRowId = (
  rows: readonly DestinationRow[],
  currentId: string | null,
  direction: 1 | -1,
): string | null => {
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
    if (row && row.authority === "ready" && !row.entry.isCurrent) return row.id;
  }
  return null;
};

const flattenPageTree = (
  roots: readonly LibraryPageRelocationDestinationEntry[],
  children: ReadonlyMap<string, readonly LibraryPageRelocationDestinationEntry[]>,
  expanded: ReadonlySet<string>,
): readonly DestinationRow[] => {
  const rows: DestinationRow[] = [];
  const visited = new Set<string>();
  const append = (entries: readonly LibraryPageRelocationDestinationEntry[], depth: number) => {
    for (const entry of entries) {
      if (!visited.add(entry.key)) continue;
      const pageId = pageDestinationId(entry);
      rows.push({
        id: `page:${entry.key}`,
        entry,
        depth,
        expanded: pageId !== null && expanded.has(pageId),
        context: "page",
        authority: "ready",
      });
      if (!pageId || !expanded.has(pageId)) continue;
      append(children.get(pageId) ?? [], depth + 1);
    }
  };
  append(roots, 0);
  return rows;
};

function DestinationRowView({
  row,
  listboxId,
  focused,
  accepting,
  disabled,
  onFocus,
  onToggle,
  onAccept,
}: {
  readonly row: DestinationRow;
  readonly listboxId: string;
  readonly focused: boolean;
  readonly accepting: boolean;
  readonly disabled: boolean;
  readonly onFocus: () => void;
  readonly onToggle: () => void;
  readonly onAccept: () => void;
}) {
  const entry = row.authority === "ready" ? row.entry : null;
  const title = entry?.title ?? (row.authority === "preview" ? row.title : "");
  const path = entry?.path ?? (row.authority === "preview" ? row.path : []);
  const expandable = row.context === "page" && entry?.kind === "page" && entry.hasChildren;
  const metadata = entry?.isCurrent
    ? "Current"
    : path.length > 0
      ? path.join(" / ")
      : entry?.kind === "library"
        ? "Top level"
        : "";

  return (
    <NodexDestinationPickerOption
      id={rowDomId(listboxId, row.id)}
      focused={focused}
      disabled={disabled}
      depth={row.depth}
      expanded={expandable ? row.expanded : undefined}
      icon={
        entry?.kind === "database" ? (
          <DatabaseIcon className="size-4" aria-hidden="true" />
        ) : (
          <PageIcon className="size-4" aria-hidden="true" />
        )
      }
      onFocus={onFocus}
      onToggle={expandable ? onToggle : undefined}
      onSelect={onAccept}
    >
      <span className="min-w-0 flex-1 truncate">{title || "Untitled"}</span>
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

export function PageMoveDestinationPicker({
  pageId,
  title,
  onClose,
}: {
  readonly pageId: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const listboxId = useId();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeSearchText(query);
  const [expandedPageIds, setExpandedPageIds] = useState<Set<string>>(new Set());
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [acceptingRowId, setAcceptingRowId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const { mutation } = useApplyLibraryOperation();
  const undoPageRelocation = useUndoLibraryPageRelocation();
  const databases = useLibraryPageRelocationDestinations(pageId, {
    scope: { kind: "databases", ...(normalizedQuery ? { query: normalizedQuery } : {}) },
    limit: 100,
  });
  const suggested = useLibraryPageRelocationDestinations(
    pageId,
    { scope: { kind: "page_suggested" }, limit: 8 },
    !normalizedQuery,
  );
  const pages = useLibraryPageRelocationDestinations(pageId, {
    scope: normalizedQuery
      ? { kind: "page_search", query: normalizedQuery }
      : { kind: "page_children", parent: { kind: "library" } },
    limit: 100,
  });
  const metadataSearch = useInteractivePageSearch({
    projectIds: configuredPageSearchProjectIds(),
    query: normalizedQuery,
    excludePageIds: [pageId],
    limit: 100,
    complete: false,
  });
  const expandedPageIdList = [...expandedPageIds].sort();
  const childQueries = useLibraryPageRelocationChildren(
    pageId,
    expandedPageIdList,
    !normalizedQuery,
  );
  const childItems = new Map(
    expandedPageIdList.map(
      (parentPageId, index) => [parentPageId, childQueries[index]?.data?.items ?? []] as const,
    ),
  );
  const databaseRows = (databases.data?.items ?? []).map((entry): AuthoritativeDestinationRow => ({
    id: `database:${entry.key}`,
    entry,
    depth: 0,
    expanded: false,
    context: "database",
    authority: "ready",
  }));
  const authoritativePageRows = normalizedQuery
    ? (pages.data?.items ?? []).map((entry): AuthoritativeDestinationRow => ({
        id: `search:${entry.key}`,
        entry,
        depth: 0,
        expanded: false,
        context: "search",
        authority: "ready",
      }))
    : flattenPageTree(pages.data?.items ?? [], childItems, expandedPageIds);
  const previewPageRows: readonly DestinationRow[] =
    normalizedQuery && pages.isPending
      ? metadataSearch.rows.map((row) => ({
          id: `preview:${row.pageId}`,
          title: row.title,
          path: row.locationLabel.split(" / ").filter(Boolean),
          depth: 0,
          expanded: false,
          context: "preview",
          authority: "preview",
        }))
      : [];
  const pageRows = authoritativePageRows.length > 0 ? authoritativePageRows : previewPageRows;
  const recentRows = (suggested.data?.items ?? []).map((entry): AuthoritativeDestinationRow => ({
    id: `recent:${entry.key}`,
    entry,
    depth: 0,
    expanded: false,
    context: "recent",
    authority: "ready",
  }));
  const rows = [...databaseRows, ...recentRows, ...pageRows];
  const resolvedFocusedRowId =
    focusedRowId && rows.some((row) => row.id === focusedRowId)
      ? focusedRowId
      : nextEnabledRowId(rows, null, 1);
  const focusedRow = rows.find((row) => row.id === resolvedFocusedRowId) ?? null;
  const loading =
    databases.isPending ||
    pages.isPending ||
    (!normalizedQuery && suggested.isPending) ||
    childQueries.some((child) => child.isPending);
  const loadError =
    databases.error ??
    pages.error ??
    (!normalizedQuery ? suggested.error : null) ??
    childQueries.find((child) => child.error)?.error;
  const hasMore =
    Boolean(
      databases.data?.hasMore ||
      pages.data?.hasMore ||
      (!normalizedQuery && suggested.data?.hasMore),
    ) || childQueries.some((child) => Boolean(child.data?.hasMore));
  const pickerDisabled = acceptingRowId !== null;

  const refetchDestinations = (): void => {
    void databases.refetch();
    void pages.refetch();
    void suggested.refetch();
    for (const child of childQueries) void child.refetch();
  };

  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), LOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const accept = async (row: AuthoritativeDestinationRow): Promise<void> => {
    setAcceptError(null);
    setAcceptingRowId(row.id);
    try {
      const result = await mutation.mutateAsync({
        kind: "move_page",
        pageId,
        destination: row.entry.destination,
        expectedEtag: row.entry.expectedMoveEtag,
      });
      const undoToken = result.pageRelocation?.undoToken ?? null;
      onClose();
      toast.success(`Moved to ${row.entry.title || "destination"}`, {
        ...(undoToken
          ? {
              action: {
                label: "Undo",
                onClick: () => {
                  void undoPageRelocation(undoToken)
                    .then(() => toast.success("Move undone"))
                    .catch((error: unknown) =>
                      toast.danger(error instanceof Error ? error.message : "Could not undo move"),
                    );
                },
              },
            }
          : {}),
      });
    } catch (error) {
      setAcceptError(error instanceof Error ? error.message : "Could not move Page");
      setAcceptingRowId(null);
      refetchDestinations();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (pickerDisabled) return;
      setFocusedRowId(
        nextEnabledRowId(rows, resolvedFocusedRowId, event.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    if (
      event.key === "ArrowRight" &&
      focusedRow?.authority === "ready" &&
      focusedRow.entry.kind === "page"
    ) {
      if (focusedRow.context !== "page" || !focusedRow.entry.hasChildren) return;
      event.preventDefault();
      const destinationPageId = pageDestinationId(focusedRow.entry);
      if (!focusedRow.expanded && destinationPageId) {
        setExpandedPageIds((current) => new Set(current).add(destinationPageId));
      }
      return;
    }
    if (event.key === "ArrowLeft" && focusedRow?.authority === "ready" && focusedRow.expanded) {
      event.preventDefault();
      const destinationPageId = pageDestinationId(focusedRow.entry);
      if (!destinationPageId) return;
      setExpandedPageIds((current) => {
        const next = new Set(current);
        next.delete(destinationPageId);
        return next;
      });
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (
      !focusedRow ||
      focusedRow.authority !== "ready" ||
      pickerDisabled ||
      focusedRow.entry.isCurrent
    )
      return;
    void accept(focusedRow);
  };

  return (
    <NodexDestinationPicker
      ariaLabel={`Move ${title || "Page"} to`}
      placeholder="Search Databases and Pages…"
      query={query}
      inputId={inputId}
      listboxId={listboxId}
      activeDescendantId={
        resolvedFocusedRowId ? rowDomId(listboxId, resolvedFocusedRowId) : undefined
      }
      busy={loading}
      dialogRole="presentation"
      autoFocus
      onQueryChange={(nextQuery) => {
        setAcceptError(null);
        setFocusedRowId(null);
        setQuery(nextQuery);
      }}
      onKeyDown={handleKeyDown}
    >
      {databaseRows.length > 0 ? (
        <NodexDestinationPickerSection label="Databases">
          {databaseRows.map((row) => (
            <DestinationRowView
              key={row.id}
              row={row}
              listboxId={listboxId}
              focused={row.id === resolvedFocusedRowId}
              accepting={row.id === acceptingRowId}
              disabled={pickerDisabled || row.entry.isCurrent}
              onFocus={() => setFocusedRowId(row.id)}
              onToggle={() => undefined}
              onAccept={() => void accept(row)}
            />
          ))}
        </NodexDestinationPickerSection>
      ) : null}
      {!normalizedQuery && recentRows.length > 0 ? (
        <NodexDestinationPickerSection label="Recent">
          {recentRows.map((row) => (
            <DestinationRowView
              key={row.id}
              row={row}
              listboxId={listboxId}
              focused={row.id === resolvedFocusedRowId}
              accepting={row.id === acceptingRowId}
              disabled={pickerDisabled || row.authority !== "ready" || row.entry.isCurrent}
              onFocus={() => setFocusedRowId(row.id)}
              onToggle={() => undefined}
              onAccept={() => {
                if (row.authority === "ready") void accept(row);
              }}
            />
          ))}
        </NodexDestinationPickerSection>
      ) : null}
      {pageRows.length > 0 ? (
        <NodexDestinationPickerSection label="Pages">
          {pageRows.map((row) => (
            <DestinationRowView
              key={row.id}
              row={row}
              listboxId={listboxId}
              focused={row.id === resolvedFocusedRowId}
              accepting={row.id === acceptingRowId}
              disabled={pickerDisabled || row.authority !== "ready" || row.entry.isCurrent}
              onFocus={() => setFocusedRowId(row.id)}
              onToggle={() => {
                if (row.authority !== "ready") return;
                const destinationPageId = pageDestinationId(row.entry);
                if (!destinationPageId) return;
                setExpandedPageIds((current) => {
                  const next = new Set(current);
                  if (next.has(destinationPageId)) next.delete(destinationPageId);
                  else next.add(destinationPageId);
                  return next;
                });
              }}
              onAccept={() => {
                if (row.authority === "ready") void accept(row);
              }}
            />
          ))}
        </NodexDestinationPickerSection>
      ) : null}
      {showLoading ? (
        <NodexDestinationPickerStatus>
          <ActivitySpinnerIcon className="mr-2 size-3.5 text-token-description-foreground" />
          {rows.length > 0 ? "Loading more destinations…" : "Loading destinations…"}
        </NodexDestinationPickerStatus>
      ) : null}
      {acceptError ? (
        <NodexDestinationPickerStatus role="alert">{acceptError}</NodexDestinationPickerStatus>
      ) : loadError ? (
        <NodexDestinationPickerStatus role="alert">
          <span>Could not load destinations</span>
          <button
            type="button"
            className="ml-auto cursor-interaction rounded-md px-2 py-1 text-[12px] font-medium text-token-foreground hover:bg-token-foreground/5"
            onClick={refetchDestinations}
          >
            Retry
          </button>
        </NodexDestinationPickerStatus>
      ) : null}
      {!loading && !loadError && rows.length === 0 ? (
        <NodexDestinationPickerStatus>No matching destinations</NodexDestinationPickerStatus>
      ) : null}
      {!normalizedQuery && hasMore ? (
        <NodexDestinationPickerStatus>
          Search to find destinations outside this window
        </NodexDestinationPickerStatus>
      ) : null}
    </NodexDestinationPicker>
  );
}
