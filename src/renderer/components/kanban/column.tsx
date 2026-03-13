import { memo, useMemo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Card, type CardPropertyUpdateInput } from "./card";
import { DropIndicator } from "./drop-indicator";
import { InlineCardCreator } from "./inline-card-creator";
import type { Card as CardType, CardCreatePlacement, Column as ColumnType, CardInput } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { CardContextMenuProjectSummary } from "./card-context-menu-model";

interface ColumnProps {
  projectId: string;
  projectName: string;
  column: ColumnType;
  onAddCard: (columnId: CardType["status"], input: CardInput, placement?: CardCreatePlacement) => Promise<void>;
  onEditCard: (columnId: CardType["status"], card: CardType, event: React.MouseEvent<HTMLDivElement>) => void;
  onUpdateCardProperty: (input: CardPropertyUpdateInput) => Promise<void>;
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
  dropIndicatorIndex?: number;
  focusedCardId?: string;
  selectedCardIds?: ReadonlySet<string>;
  contextMenuProjects?: CardContextMenuProjectSummary[];
}

// Column colors - Notion exact RGBA values from Chrome DevTools inspection
export const columnStyles: Record<string, { dotColor: string; headerBg: string; badgeBg: string; badgeText: string; dropBg: string; accentColor: string }> = {
  draft: {
    dotColor: "bg-[var(--column-ideas-dot)]",
    headerBg: "bg-[var(--column-ideas-header-bg)]",
    badgeBg: "bg-[var(--status-ideas-bg)]",
    badgeText: "text-[var(--status-ideas-text)]",
    dropBg: "bg-[var(--column-ideas-drop-bg)]",
    accentColor: "var(--status-ideas-dot)",
  },
  backlog: {
    dotColor: "bg-[var(--column-backlog-dot)]",
    headerBg: "bg-[var(--column-backlog-header-bg)]",
    badgeBg: "bg-[var(--status-backlog-bg)]",
    badgeText: "text-[var(--status-backlog-text)]",
    dropBg: "bg-[var(--column-backlog-drop-bg)]",
    accentColor: "var(--status-backlog-dot)",
  },
  in_progress: {
    dotColor: "bg-[var(--column-in-progress-dot)]",
    headerBg: "bg-[var(--column-in-progress-header-bg)]",
    badgeBg: "bg-[var(--status-in-progress-bg)]",
    badgeText: "text-[var(--status-in-progress-text)]",
    dropBg: "bg-[var(--column-in-progress-drop-bg)]",
    accentColor: "var(--status-in-progress-dot)",
  },
  in_review: {
    dotColor: "bg-[var(--column-review-dot)]",
    headerBg: "bg-[var(--column-review-header-bg)]",
    badgeBg: "bg-[var(--status-review-bg)]",
    badgeText: "text-[var(--status-review-text)]",
    dropBg: "bg-[var(--column-review-drop-bg)]",
    accentColor: "var(--status-review-dot)",
  },
  done: {
    dotColor: "bg-[var(--column-done-dot)]",
    headerBg: "bg-[var(--column-done-header-bg)]",
    badgeBg: "bg-[var(--status-done-bg)]",
    badgeText: "text-[var(--status-done-text)]",
    dropBg: "bg-[var(--column-done-drop-bg)]",
    accentColor: "var(--status-done-dot)",
  },
  "n-archive": {
    dotColor: "bg-[var(--column-archive-dot)]",
    headerBg: "bg-[var(--column-archive-header-bg)]",
    badgeBg: "bg-[var(--column-archive-badge-bg)]",
    badgeText: "text-[var(--column-archive-badge-text)]",
    dropBg: "bg-[var(--column-archive-drop-bg)]",
    accentColor: "var(--column-archive-dot)",
  },
};

export const Column = memo(function Column({
  projectId,
  projectName,
  column,
  onAddCard,
  onEditCard,
  onUpdateCardProperty,
  onMoveCardToProjectFromMenu,
  onDeleteCardFromMenu,
  onCopyCardLinkFromMenu,
  onOpenCardMenu,
  onNativeDragOver,
  onNativeDragLeave,
  onNativeDrop,
  dragDisabled = false,
  dropIndicatorIndex,
  focusedCardId,
  selectedCardIds = new Set<string>(),
  contextMenuProjects = [],
}: ColumnProps) {
  const [showCreator, setShowCreator] = useState(false);
  const isEmpty = column.cards.length === 0 && !showCreator;

  const { setNodeRef } = useDroppable({
    id: column.id,
    data: { column },
    disabled: dragDisabled,
  });
  const sortableCardIds = useMemo(
    () => column.cards.map((card) => card.id),
    [column.cards],
  );

  const styles = columnStyles[column.id] || {
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

  return (
    <div
      ref={setNodeRef}
      onDragOver={(event) => onNativeDragOver?.(column.id, event)}
      onDragLeave={(event) => onNativeDragLeave?.(column.id, event)}
      onDrop={(event) => onNativeDrop?.(column.id, event)}
      className="flex shrink-0 flex-col overflow-clip pr-3"
      style={{
        width: isEmpty ? 56 : 288,
        transition: 'width 200ms cubic-bezier(0.32, 0.72, 0, 1)',
        '--column-accent': styles.accentColor,
      } as React.CSSProperties}
    >
      {isEmpty ? (
        /* Collapsed: thin vertical bar with rotated label + sticky header */
        <>
          <div
            onClick={() => setShowCreator(true)}
            className="group flex flex-1 cursor-pointer flex-col"
            role="button"
            title={`${column.name} \u2014 click to add task`}
          >
            {/* Sticky header — dot + vertical name */}
            <div className="sticky top-0 z-10 bg-(--background)">
              <div
                className={cn(
                  "flex flex-col items-center rounded-t-lg pt-3 pb-2",
                  styles.headerBg,
                )}
              >
                <span className={cn("mb-2 h-2 w-2 shrink-0 rounded-full", styles.dotColor)} />
                <span
                  className="text-base font-medium whitespace-nowrap opacity-70 group-hover:opacity-100"
                  style={{
                    color: styles.accentColor,
                    writingMode: 'vertical-lr',
                  }}
                >
                  {column.name}
                </span>
              </div>
            </div>

            {/* Body fill — visual continuity of the tinted bar */}
            <div
              className={cn(
                "flex-1 rounded-b-lg",
                styles.headerBg,
              )}
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
                styles.headerBg
              )}
            >
              {/* Status badge pill */}
              <button
                className={cn(
                  "flex h-5 items-center gap-1.25 rounded-lg px-1.75 pr-2.25",
                  "hover:opacity-80",
                  styles.badgeBg,
                  styles.badgeText
                )}
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", styles.dotColor)} />
                <span className="text-sm/5 font-normal">
                  {column.name}
                </span>
              </button>

              {/* Card count */}
              <span
                className="ml-1 flex h-5 items-center rounded-xs px-1.5 text-sm"
                style={{ color: styles.accentColor }}
              >
                {column.cards.length}
              </span>

              {/* Hover actions (right side) */}
              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button
                  className="flex h-[calc(var(--spacing)*6)] w-[calc(var(--spacing)*6)] items-center justify-center rounded-xs text-(--column-accent) hover:bg-(--background-tertiary) hover:opacity-80"
                  title="More options"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="3" cy="7" r="1.2" fill="currentColor" />
                    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
                    <circle cx="11" cy="7" r="1.2" fill="currentColor" />
                  </svg>
                </button>
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
          <div className={cn("flex flex-1 flex-col rounded-b-lg", styles.headerBg)}>
            <div
              className={cn(
                "flex-1 px-2 pt-0.75 pb-2",
                "transition-colors duration-150",
              )}
            >
              <SortableContext
                items={sortableCardIds}
                strategy={verticalListSortingStrategy}
                disabled={dragDisabled}
              >
                <div className="flex flex-col gap-2">
                  {showCreator && (
                    <InlineCardCreator
                      onSave={handleSaveCard}
                      onCancel={() => setShowCreator(false)}
                    />
                  )}
                  {column.cards.map((card, i) => (
                    <div
                      key={card.id}
                      data-kanban-card-id={card.id}
                      className="relative"
                    >
                      {dropIndicatorIndex === i ? (
                        <DropIndicator className="absolute inset-x-0 top-0 -translate-y-1/2" />
                      ) : null}
                      <Card
                        card={card}
                        columnId={column.id}
                        dragDisabled={dragDisabled}
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
                  {dropIndicatorIndex === column.cards.length ? (
                    <div className="-mt-2 relative h-0">
                      <DropIndicator className="absolute inset-x-0 top-0" />
                    </div>
                  ) : null}
                </div>
              </SortableContext>

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
