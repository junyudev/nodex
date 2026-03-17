import { memo, useEffect, useRef, useState } from "react";
import { Card, type CardPropertyUpdateInput } from "./card";
import { ColumnActionPopover } from "./column-action-popover";
import type { DbViewDisplayPrefs } from "../../lib/db-view-prefs";
import { DropIndicator } from "./drop-indicator";
import { resolveDropIndicatorPlacement } from "./drop-indicator-placement";
import { InlineCardCreator } from "./inline-card-creator";
import {
  COLLAPSED_KANBAN_COLUMN_WIDTH,
  type KanbanColumnLayout,
} from "../../lib/kanban-column-layout";
import { StatusChip, StatusIcon, columnStyles as sharedColumnStyles } from "../../lib/status-chip";
import type { Card as CardType, CardCreatePlacement, Column as ColumnType, CardInput } from "../../lib/types";
import { cn } from "../../lib/utils";
import type { CardContextMenuProjectSummary } from "./card-context-menu-model";
import type { KanbanCardDragData } from "./pragmatic-drag-data";
import { bindKanbanColumnDropSurface } from "./column-drop-surface";

export { columnStyles } from "../../lib/status-chip";

interface ColumnProps {
  projectId: string;
  projectName: string;
  column: ColumnType;
  displayPrefs?: DbViewDisplayPrefs;
  dragInstanceId?: symbol;
  buildDragData?: (card: CardType, columnId: string) => KanbanCardDragData;
  layout: KanbanColumnLayout;
  onAddCard: (columnId: CardType["status"], input: CardInput, placement?: CardCreatePlacement) => Promise<void>;
  onEditCard: (columnId: CardType["status"], card: CardType, event: React.MouseEvent<HTMLDivElement>) => void;
  onUpdateCardProperty: (input: CardPropertyUpdateInput) => Promise<void>;
  onCollapsedChange: (columnId: CardType["status"], collapsed: boolean) => void;
  onWidthChange: (columnId: CardType["status"], width: number) => void;
  onMoveCardToProjectFromMenu?: (input: {
    cardId: string;
    sourceStatus: CardType["status"];
    targetProjectId: string;
  }) => Promise<void> | void;
  onDeleteCardFromMenu?: (input: {
    cardId: string;
    columnId: CardType["status"];
  }) => Promise<void> | void;
  onCopyCardLinkFromMenu?: (input: {
    cardId: string;
    projectId: string;
  }) => Promise<void> | void;
  onOpenCardMenu?: (cardId: string) => void;
  onNativeDragOver?: (columnId: CardType["status"], event: React.DragEvent<HTMLDivElement>) => void;
  onNativeDragLeave?: (columnId: CardType["status"], event: React.DragEvent<HTMLDivElement>) => void;
  onNativeDrop?: (columnId: CardType["status"], event: React.DragEvent<HTMLDivElement>) => void;
  dragDisabled?: boolean;
  cardDropDisabled?: boolean;
  columnDropDisabled?: boolean;
  dropIndicatorIndex?: number;
  dropIndicatorLabel?: string;
  draggedCardIds?: ReadonlySet<string>;
  isDropTargetActive?: boolean;
  dropBlockedMessage?: string;
  focusedCardId?: string;
  selectedCardIds?: ReadonlySet<string>;
  contextMenuProjects?: CardContextMenuProjectSummary[];
}

export const Column = memo(function Column({
  projectId,
  projectName,
  column,
  displayPrefs,
  dragInstanceId,
  buildDragData,
  layout,
  onAddCard,
  onEditCard,
  onUpdateCardProperty,
  onCollapsedChange,
  onWidthChange,
  onMoveCardToProjectFromMenu,
  onDeleteCardFromMenu,
  onCopyCardLinkFromMenu,
  onOpenCardMenu,
  onNativeDragOver,
  onNativeDragLeave,
  onNativeDrop,
  dragDisabled = false,
  cardDropDisabled = false,
  columnDropDisabled = false,
  dropIndicatorIndex,
  dropIndicatorLabel,
  draggedCardIds = new Set<string>(),
  isDropTargetActive = false,
  dropBlockedMessage,
  focusedCardId,
  selectedCardIds = new Set<string>(),
  contextMenuProjects = [],
}: ColumnProps) {
  const [showCreator, setShowCreator] = useState(false);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isAutoCollapsed = column.cards.length === 0 && !showCreator;
  const isUserCollapsed = layout.collapsed && !showCreator;
  const isCollapsed = isAutoCollapsed || isUserCollapsed;

  useEffect(() => {
    return bindKanbanColumnDropSurface({
      columnId: column.id,
      columnDropDisabled,
      dragInstanceId,
      element: columnRef.current,
      scrollElement: scrollContainerRef.current,
    });
  }, [column.id, columnDropDisabled, dragInstanceId]);

  const styles = sharedColumnStyles[column.id] || {
    dotColor: "bg-[var(--foreground-tertiary)]",
    headerBg: "bg-[var(--background-secondary)]",
    badgeBg: "bg-[var(--gray-bg)]",
    badgeText: "text-[var(--foreground-secondary)]",
    dropBg: "bg-[var(--background-secondary)]",
    accentColor: "#8E8B86",
  };

  const handleSaveCard = async (input: CardInput) => {
    await onAddCard(column.id, input, "top");
  };

  const handleCollapsedSurfaceClick = () => {
    if (isUserCollapsed) {
      onCollapsedChange(column.id, false);
      return;
    }

    setShowCreator(true);
  };

  const collapsedSurfaceTitle = isUserCollapsed
    ? `${column.name} \u2014 click to expand`
    : `${column.name} \u2014 click to add task`;
  const dropIndicatorPlacement = resolveDropIndicatorPlacement(
    column.cards,
    draggedCardIds,
    dropIndicatorIndex,
  );
  const surfaceToneClassName = isDropTargetActive ? styles.dropBg : styles.headerBg;
  const activeDropSurfaceStyle = isDropTargetActive
    ? {
      boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--column-accent) 38%, transparent)",
    } as React.CSSProperties
    : undefined;

  return (
    <div
      ref={columnRef}
      data-kanban-column-id={column.id}
      data-kanban-column-collapsed={isCollapsed ? "true" : "false"}
      onDragOver={(event) => onNativeDragOver?.(column.id, event)}
      onDragLeave={(event) => onNativeDragLeave?.(column.id, event)}
      onDrop={(event) => onNativeDrop?.(column.id, event)}
      className="flex shrink-0 flex-col overflow-clip pr-3"
      style={{
        width: isCollapsed ? COLLAPSED_KANBAN_COLUMN_WIDTH : layout.width,
        transition: 'width 200ms cubic-bezier(0.32, 0.72, 0, 1)',
        '--column-accent': styles.accentColor,
      } as React.CSSProperties}
    >
      {isCollapsed ? (
        /* Collapsed: thin vertical bar with rotated label + sticky header */
        <>
          <div
            onClick={handleCollapsedSurfaceClick}
            className="group flex flex-1 cursor-pointer flex-col"
            role="button"
            title={collapsedSurfaceTitle}
          >
            {/* Sticky header — dot + vertical name */}
            <div className="sticky top-0 z-10 bg-(--background)">
              <div
                className={cn(
                  "flex flex-col items-center rounded-t-lg px-1 pt-3 pb-2",
                  surfaceToneClassName,
                )}
                style={activeDropSurfaceStyle}
              >
                <StatusIcon
                  statusId={column.id}
                  className="size-4"
                  style={{ color: styles.accentColor }}
                />
                <span
                  className="mt-2 text-base font-medium whitespace-nowrap opacity-70 group-hover:opacity-100"
                  style={{
                    color: styles.accentColor,
                    writingMode: 'vertical-lr',
                  }}
                >
                  {column.name}
                </span>
                <span
                  className="mt-2 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums"
                  style={{
                    color: styles.accentColor,
                    background: "color-mix(in srgb, var(--column-accent) 14%, transparent)",
                  }}
                >
                  {column.cards.length}
                </span>
                <div
                  className="mt-2"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ColumnActionPopover
                    columnName={column.name}
                    collapsed={layout.collapsed}
                    width={layout.width}
                    accentColor={styles.accentColor}
                    alwaysVisible
                    onCollapsedChange={(collapsed) => onCollapsedChange(column.id, collapsed)}
                    onWidthChange={(width) => onWidthChange(column.id, width)}
                  />
                </div>
              </div>
            </div>

            {/* Body fill — visual continuity of the tinted bar */}
            <div
              className={cn(
                "flex-1 rounded-b-lg",
                surfaceToneClassName,
              )}
              style={activeDropSurfaceStyle}
            />
          </div>
          <div className="h-4 shrink-0" />
        </>
      ) : (
        <>
          {/* Sticky header */}
          <div className="sticky top-0 z-10 bg-(--background)">
            <div
              className={cn(
                "group flex h-10 shrink-0 items-center rounded-t-lg px-2",
                surfaceToneClassName,
              )}
              style={activeDropSurfaceStyle}
            >
              {/* Status badge pill */}
              <button
                className={cn(
                  "rounded-lg",
                  "hover:opacity-80",
                )}
              >
                <StatusChip statusId={column.id} label={column.name} />
              </button>

              {/* Card count */}
              <span
                className="ml-1 flex h-5 items-center rounded-xs px-1.5 text-sm"
                style={{ color: styles.accentColor }}
              >
                {column.cards.length}
              </span>
              {dropBlockedMessage ? (
                <span className="ml-2 rounded-sm bg-(--background) px-1.5 py-0.5 text-[10px]/none font-medium text-(--foreground-secondary)">
                  {dropBlockedMessage}
                </span>
              ) : null}

              {/* Hover actions (right side) */}
              <div
                className={cn(
                  "ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100",
                  isDropTargetActive && "opacity-0",
                )}
              >
                <ColumnActionPopover
                  columnName={column.name}
                  collapsed={layout.collapsed}
                  width={layout.width}
                  accentColor={styles.accentColor}
                  onCollapsedChange={(collapsed) => onCollapsedChange(column.id, collapsed)}
                  onWidthChange={(width) => onWidthChange(column.id, width)}
                />
                <button
                  onClick={() => setShowCreator(true)}
                  className="flex h-[calc(var(--spacing)*6)] w-[calc(var(--spacing)*6)] items-center justify-center rounded-xs text-(--column-accent) hover:bg-(--background-tertiary) hover:opacity-80"
                  title="New task"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Cards area with bottom rounded corners */}
          <div
            className={cn("flex flex-1 flex-col rounded-b-lg", surfaceToneClassName)}
            style={activeDropSurfaceStyle}
          >
            <div
              ref={scrollContainerRef}
              className={cn(
                "flex-1 overflow-y-auto px-2 pt-0.75 pb-2",
                "transition-colors duration-150",
              )}
            >
              <div className="flex flex-col gap-2">
                {showCreator && (
                  <InlineCardCreator
                    onSave={handleSaveCard}
                    onCancel={() => setShowCreator(false)}
                  />
                )}
                {column.cards.map((card) => (
                  <div
                    key={card.id}
                    data-kanban-card-id={card.id}
                    className="relative"
                  >
                    {dropIndicatorPlacement.beforeCardId === card.id ? (
                          <DropIndicator
                            className="absolute inset-x-0 top-0 -translate-y-1/2"
                            label={dropIndicatorLabel}
                          />
                    ) : null}
                    <Card
                      projectId={projectId}
                      card={card}
                      columnId={column.id}
                      displayPrefs={displayPrefs}
                      dragInstanceId={dragInstanceId}
                      buildDragData={buildDragData}
                      dragDisabled={dragDisabled}
                      dropDisabled={cardDropDisabled}
                      isFocused={card.id === focusedCardId}
                      isSelected={selectedCardIds.has(card.id)}
                      onClick={(event) => onEditCard(column.id, card, event)}
                      onUpdateProperty={onUpdateCardProperty}
                      contextMenu={onMoveCardToProjectFromMenu ? {
                        currentColumnId: column.id,
                        currentProjectId: projectId,
                        currentProjectName: projectName,
                        projects: contextMenuProjects,
                        onMoveToProject: (targetProjectId) => onMoveCardToProjectFromMenu({
                          cardId: card.id,
                          sourceStatus: column.id,
                          targetProjectId,
                        }),
                        onDelete: ({ cardId, columnId }) => onDeleteCardFromMenu?.({
                          cardId,
                          columnId: columnId as CardType["status"],
                        }),
                        onCopyLink: ({ cardId, projectId }) => onCopyCardLinkFromMenu?.({
                          cardId,
                          projectId,
                        }),
                        onMenuOpen: onOpenCardMenu ? () => onOpenCardMenu(card.id) : undefined,
                      } : undefined}
                    />
                  </div>
                ))}
                {dropIndicatorPlacement.atEnd ? (
                  <div className="-mt-2 relative h-0">
                    <DropIndicator
                      className="absolute inset-x-0 top-0"
                      label={dropIndicatorLabel}
                    />
                  </div>
                ) : null}
              </div>

              {/* New task button */}
              {!showCreator && (
                <button
                  onClick={() => setShowCreator(true)}
                  className={cn(
                    "flex w-full items-center gap-2.25 rounded-md border px-2.5 py-2.5 text-sm",
                    "transition-colors duration-100 hover:bg-[color-mix(in_srgb,var(--column-accent,#888)_15%,var(--card))]",
                    column.cards.length > 0 && "mt-2"
                  )}
                  style={{ color: styles.accentColor, borderColor: 'color-mix(in srgb, var(--column-accent) 20%, transparent)' }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8.00023 2.74023C8.17528 2.74023 8.34315 2.80977 8.46692 2.93354C8.5907 3.05732 8.66023 3.22519 8.66023 3.40023V7.34023H12.6002C12.7753 7.34023 12.9432 7.40977 13.0669 7.53354C13.1907 7.65732 13.2602 7.82519 13.2602 8.00023C13.2602 8.17528 13.1907 8.34315 13.0669 8.46692C12.9432 8.5907 12.7753 8.66023 12.6002 8.66023H8.66023V12.6002C8.66023 12.7753 8.5907 12.9432 8.46692 13.0669C8.34315 13.1907 8.17528 13.2602 8.00023 13.2602C7.82519 13.2602 7.65732 13.1907 7.53354 13.0669C7.40977 12.9432 7.34023 12.7753 7.34023 12.6002V8.66023H3.40023C3.22519 8.66023 3.05732 8.5907 2.93354 8.46692C2.80977 8.34315 2.74023 8.17528 2.74023 8.00023C2.74023 7.82519 2.80977 7.65732 2.93354 7.53354C3.05732 7.40977 3.22519 7.34023 3.40023 7.34023H7.34023V3.40023C7.34023 3.22519 7.40977 3.05732 7.53354 2.93354C7.65732 2.80977 7.82519 2.74023 8.00023 2.74023Z" fill="currentColor" />
                  </svg>
                  New task
                </button>
              )}
            </div>
          </div>

          {/* Bottom spacing outside background */}
          <div className="h-4 shrink-0" />
        </>
      )}
    </div>
  );
});

Column.displayName = "Column";
