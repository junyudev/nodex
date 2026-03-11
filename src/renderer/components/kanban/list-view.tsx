import { useState, useMemo, useCallback, useRef, useEffect, useDeferredValue } from "react";
import { useKanban } from "@/lib/use-kanban";
import { resolveKanbanPriorityOption } from "../../lib/kanban-options";
import { columnStyles } from "./column";
import { estimateStyles } from "@/lib/types";
import type { Card } from "@/lib/types";
import { cn } from "@/lib/utils";
import { buildCardSearchText, matchesSearchTokens, tokenizeSearchQuery } from "@/lib/card-search";
import {
  ChevronUp,
  ChevronDown,
  Tag,
  Type,
  CircleArrowDown,
  Users,
  Calendar,
} from "lucide-react";
import type { ReactNode } from "react";

// Card with column info attached
interface CardWithColumn extends Card {
  columnId: string;
  columnName: string;
}

type SortField = "tags" | "title" | "status" | "priority" | "estimate" | "assignee" | "created";
type SortDirection = "asc" | "desc";

// Column configuration — index 1 (title) is the flex column
const COLUMNS: { key: SortField; label: string; minWidth: number; defaultWidth: number }[] = [
  { key: "tags", label: "Tags", minWidth: 80, defaultWidth: 114 },
  { key: "title", label: "Title", minWidth: 150, defaultWidth: 0 }, // 0 = flex
  { key: "status", label: "Status", minWidth: 80, defaultWidth: 140 },
  { key: "priority", label: "Priority", minWidth: 60, defaultWidth: 150 },
  { key: "estimate", label: "Estimate", minWidth: 60, defaultWidth: 120 },
  { key: "assignee", label: "Assignee", minWidth: 80, defaultWidth: 120 },
  { key: "created", label: "Created", minWidth: 80, defaultWidth: 100 },
];

const TITLE_COL_INDEX = 1;

// Notion "burst" property icon (no Lucide equivalent)
function BurstIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" className={className}>
      <path
        d="M10.5 5.74V2.7H8.7V5.74H10.5ZM12.96 7.51L15.12 5.36L13.84 4.08L11.69 6.24L12.96 7.51ZM16.5 10.5H13.46V8.7H16.5V10.5ZM11.69 12.96L13.84 15.12L15.12 13.84L12.96 11.69L11.69 12.96ZM8.7 16.5V13.46H10.5V16.5H8.7ZM6.24 11.69L4.09 13.84L5.36 15.12L7.51 12.96L6.24 11.69ZM2.7 8.7H5.74V10.5H2.7V8.7ZM7.51 6.24L5.36 4.08L4.09 5.36L6.24 7.51L7.51 6.24Z"
        fill="currentColor"
      />
    </svg>
  );
}

// Header icons per column (matching Notion property-type icons)
const iconCls = "size-4 shrink-0 text-[var(--gray-text)]";
const COLUMN_ICONS: Record<SortField, ReactNode> = {
  tags: <Tag className={iconCls} />,
  title: <Type className={iconCls} />,
  status: <BurstIcon className={iconCls} />,
  priority: <CircleArrowDown className={iconCls} />,
  estimate: <CircleArrowDown className={iconCls} />,
  assignee: <Users className={iconCls} />,
  created: <Calendar className={iconCls} />,
};

// Format relative date
function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

interface ListViewProps {
  projectId: string;
  searchQuery: string;
  openCardStage: (
    projectId: string,
    cardId: string,
    titleSnapshot?: string,
  ) => void;
  cardStageCardId: string | undefined;
  cardStageCloseRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

export function ListView({ projectId, searchQuery, openCardStage, cardStageCardId, cardStageCloseRef }: ListViewProps) {
  const {
    board,
    loading,
    error,
  } = useKanban({ projectId });
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("created");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Column widths state (index 0 is title which uses flex)
  const [columnWidths, setColumnWidths] = useState<number[]>(
    COLUMNS.map((col) => col.defaultWidth)
  );

  // Resize state
  const [resizing, setResizing] = useState<number | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Flatten all cards with column info
  const cardsWithColumn = useMemo(() => {
    if (!board) return [];
    return board.columns.flatMap((col) =>
      col.cards.map((card) => ({
        ...card,
        columnId: col.id,
        columnName: col.name,
      }))
    );
  }, [board]);

  const searchTokens = useMemo(
    () => tokenizeSearchQuery(deferredSearchQuery),
    [deferredSearchQuery]
  );

  const filteredCards = useMemo(() => {
    if (searchTokens.length === 0) return cardsWithColumn;
    return cardsWithColumn.filter((card) =>
      matchesSearchTokens(
        `${buildCardSearchText(card)} ${card.columnName.toLowerCase()}`,
        searchTokens
      )
    );
  }, [cardsWithColumn, searchTokens]);

  // Sort cards
  const sortedCards = useMemo(() => {
    return [...filteredCards].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "tags":
          cmp = a.tags.join(",").localeCompare(b.tags.join(","));
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "status":
          cmp = a.columnId.localeCompare(b.columnId);
          break;
        case "priority":
          cmp = a.priority.localeCompare(b.priority);
          break;
        case "estimate":
          cmp = (a.estimate || "").localeCompare(b.estimate || "");
          break;
        case "assignee":
          cmp = (a.assignee || "").localeCompare(b.assignee || "");
          break;
        case "created":
          cmp = new Date(a.created).getTime() - new Date(b.created).getTime();
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [filteredCards, sortField, sortDirection]);

  // Handle column header click for sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  // Handle row click to open/toggle CardStage
  const handleRowClick = async (card: CardWithColumn) => {
    if (cardStageCardId === card.id) {
      await cardStageCloseRef?.current?.();
      return;
    }
    openCardStage(projectId, card.id, card.title);
  };

  // Resize handlers
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, colIndex: number) => {
      e.preventDefault();
      e.stopPropagation();
      setResizing(colIndex);
      resizeStartX.current = e.clientX;
      // For flex column (width=0), read actual rendered width from DOM
      const startWidth = columnWidths[colIndex] ||
        (e.currentTarget.closest("th")?.getBoundingClientRect().width ?? columnWidths[colIndex]);
      resizeStartWidth.current = startWidth;
    },
    [columnWidths]
  );

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (resizing === null) return;
      const delta = e.clientX - resizeStartX.current;
      const newWidth = Math.max(
        COLUMNS[resizing].minWidth,
        resizeStartWidth.current + delta
      );
      setColumnWidths((prev) => {
        const next = [...prev];
        next[resizing] = newWidth;
        return next;
      });
    },
    [resizing]
  );

  const handleResizeEnd = useCallback(() => {
    setResizing(null);
  }, []);

  // Attach global mouse events for resize
  useEffect(() => {
    if (resizing !== null) {
      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeEnd);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      return () => {
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }
  }, [resizing, handleResizeMove, handleResizeEnd]);

  // Render sort indicator inline
  const renderSortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return sortDirection === "asc" ? (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    );
  };

  // Get column style (width or flex)
  const getColStyle = (index: number) => {
    if (index === TITLE_COL_INDEX && columnWidths[index] === 0)
      return { minWidth: COLUMNS[TITLE_COL_INDEX].minWidth };
    return { width: columnWidths[index], minWidth: COLUMNS[index].minWidth };
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-(--foreground-secondary)">
          Loading tasks...
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-(--destructive)">
          Error: {error}
        </div>
      </div>
    );
  }

  if (!board) {
    return null;
  }

  // Empty state
  if (sortedCards.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-(--foreground-secondary)">
          {searchTokens.length > 0
            ? "No tasks match this search."
            : "No tasks yet. Create one in the kanban view."}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="h-full overflow-auto">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            {COLUMNS.map((col, i) => (
              <col
                key={col.key}
                style={
                  i === TITLE_COL_INDEX && columnWidths[i] === 0
                    ? {}
                    : { width: columnWidths[i] }
                }
              />
            ))}
          </colgroup>

          {/* Table header */}
          <thead className="sticky top-0 z-10 bg-(--background)">
            <tr className="h-9 border-b border-(--table-border)">
              {COLUMNS.map((col, i) => (
                <th
                  key={col.key}
                  style={getColStyle(i)}
                  className={cn(
                    "relative cursor-pointer border-r border-(--table-border) px-2 text-left text-sm font-normal text-(--foreground-secondary) select-none hover:bg-(--row-hover)",
                    i === TITLE_COL_INDEX && "w-auto",
                    i === COLUMNS.length - 1 && "border-r-0"
                  )}
                >
                  <div
                    onClick={() => handleSort(col.key)}
                    className="flex items-center gap-1.5"
                  >
                    {COLUMN_ICONS[col.key]}
                    <span className="leading-[calc(var(--spacing)*4.2)]">{col.label}</span>
                    {renderSortIndicator(col.key)}
                  </div>
                  {/* Resize handle */}
                  {i < COLUMNS.length - 1 && (
                    <div
                      onMouseDown={(e) => handleResizeStart(e, i)}
                      className={cn(
                        "group absolute top-0 right-0 bottom-0 w-1 cursor-col-resize",
                        "hover:bg-blue-500/50",
                        resizing === i && "bg-blue-500"
                      )}
                    >
                      <div className="absolute top-0 right-0 bottom-0 w-4 -translate-x-1/2" />
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          {/* Table body */}
          <tbody>
            {sortedCards.map((card) => {
              const priorityOption = resolveKanbanPriorityOption(card.priority);
              const style = columnStyles[card.columnId] || columnStyles.draft;

              return (
                <tr
                  key={card.id}
                  onClick={() => handleRowClick(card)}
                  className={cn(
                    "cursor-pointer border-b border-(--table-border)",
                    "hover:bg-(--row-hover)",
                    "transition-colors duration-100",
                    cardStageCardId === card.id && "bg-(--blue-bg)"
                  )}
                >
                  {/* Tags */}
                  <td className="overflow-hidden border-r border-(--table-border) px-2 py-1 whitespace-nowrap">
                    {card.tags.length > 0 ? (
                      <span className="inline-flex h-5 max-w-full items-center truncate rounded-sm bg-(--gray-bg) px-1.5 text-sm/5 text-(--gray-text)">
                        {card.tags.join(", ")}
                      </span>
                    ) : null}
                  </td>

                  {/* Title */}
                  <td className="border-r border-(--table-border) py-1 pr-2 pl-2.25">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-(--foreground)">
                        {card.title}
                      </span>
                      {card.agentBlocked && (
                        <span className="shrink-0 rounded-sm bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">
                          Blocked
                        </span>
                      )}
                    </div>
                    {card.agentStatus && (
                      <p className="mt-0.5 truncate font-mono text-sm text-(--blue-text)">
                        {card.agentStatus}
                      </p>
                    )}
                  </td>

                  {/* Status */}
                  <td className="border-r border-(--table-border) px-2 py-1 whitespace-nowrap">
                    <span
                      className={cn(
                        "inline-flex h-5 items-center gap-1.25 rounded-lg pr-2.25 pl-1.75",
                        style.badgeBg
                      )}
                    >
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          style.dotColor
                        )}
                      />
                      <span className="truncate text-sm/5 font-normal text-(--foreground)">
                        {card.columnName}
                      </span>
                    </span>
                  </td>

                  {/* Priority */}
                  <td className="border-r border-(--table-border) px-2 py-1 whitespace-nowrap">
                    <span
                      className={cn(
                        "inline-flex h-5 items-center rounded-sm px-1.5 text-sm/5",
                        priorityOption.className
                      )}
                    >
                      {priorityOption.label}
                    </span>
                  </td>

                  {/* Estimate */}
                  <td className="border-r border-(--table-border) px-2 py-1 whitespace-nowrap">
                    {card.estimate ? (
                      <span className={cn("inline-flex h-5 items-center rounded-sm px-1.5 text-sm/5", estimateStyles[card.estimate].className)}>
                        {estimateStyles[card.estimate].label}
                      </span>
                    ) : (
                      <span className="text-sm text-(--foreground-tertiary)">
                        —
                      </span>
                    )}
                  </td>

                  {/* Assignee */}
                  <td className="border-r border-(--table-border) px-2 py-1 whitespace-nowrap">
                    {card.assignee ? (
                      <span className="block truncate text-sm text-(--foreground)">
                        @{card.assignee}
                      </span>
                    ) : (
                      <span className="text-sm text-(--foreground-tertiary)">
                        —
                      </span>
                    )}
                  </td>

                  {/* Created */}
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className="text-sm text-(--foreground-secondary)">
                      {formatRelativeDate(new Date(card.created))}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </>
  );
}
