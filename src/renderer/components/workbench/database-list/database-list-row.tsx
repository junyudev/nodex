import { useCallback, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { PropertyOptionPicker } from "@/components/database/property-option-picker";
import { NodexButton } from "@/components/ui/button";
import { NodexCheckbox } from "@/components/ui/settings";
import { NodexTooltip } from "@/components/ui/tooltip";
import { StatusIcon } from "@/lib/status-presentation";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";
import { cn } from "@/lib/utils";
import { isPriority } from "../../../../shared/priority";
import type { DatabaseListPageIdentity } from "./database-list-grid";
import { DatabaseListPriorityIcon } from "./database-list-icons";
import type { DatabaseListPageRow } from "./database-list-model";
import { databaseViewConditionalColorBackground } from "@/lib/database-view-render-model";
import {
  databaseListDropIndicatorLeft,
  DatabaseListNestingLines,
  DATABASE_LIST_NESTING_DEPTH_PX,
} from "./database-list-nesting-lines";
import {
  DATABASE_LIST_DND_INTERACTIVE_SELECTOR,
  useDatabaseListPageDnd,
} from "./database-list-dnd";
import type { BoardCardDragData } from "@/components/board/pragmatic-drag-data";
import { useDatabaseViewPageDragSource } from "../database-view-page-drag";
import type { DatabaseViewPageOpenMode } from "../database-view-page-open";
import { PageChatActivityControl } from "../page-chat-activity-control";
import type { PageChatActivitySummary } from "@/lib/types";

export const DATABASE_LIST_INTERACTIVE_SELECTOR = DATABASE_LIST_DND_INTERACTIVE_SELECTOR;

export function DatabaseListRow({
  item,
  libraryId,
  selected,
  selectedBefore,
  selectedAfter,
  active,
  presented,
  inlineProperties,
  trailingCells,
  onSelect,
  onActivate,
  onOpen,
  statusOptions,
  priorityOptions,
  onSetStatus,
  onSetPriority,
  statusMutationDisabled,
  priorityMutationDisabled,
  showPriority,
  showStatus,
  identity,
  nestingContinuations,
  ariaRowIndex,
  externalDropEdge = null,
  pragmaticDragData = null,
  pageAccessProjectId,
  pageChatActivity,
  onOpenRelatedChat,
  onRemovePageChatRelation,
}: {
  readonly item: DatabaseListPageRow;
  readonly libraryId: string;
  readonly selected: boolean;
  readonly selectedBefore: boolean;
  readonly selectedAfter: boolean;
  readonly active: boolean;
  readonly presented: boolean;
  readonly inlineProperties: ReactNode;
  readonly trailingCells: ReactNode;
  readonly onSelect: (mode: "replace" | "toggle" | "range") => void;
  readonly onActivate: () => void;
  readonly onOpen: (titleSnapshot: string, openMode: DatabaseViewPageOpenMode) => void;
  readonly statusOptions: readonly { readonly id: string; readonly name: string }[];
  readonly priorityOptions: readonly { readonly id: string; readonly name: string }[];
  readonly onSetStatus: (optionId: string | null) => void;
  readonly onSetPriority: (optionId: string | null) => void;
  readonly statusMutationDisabled: boolean;
  readonly priorityMutationDisabled: boolean;
  readonly showPriority: boolean;
  readonly showStatus: boolean;
  readonly identity: DatabaseListPageIdentity;
  readonly nestingContinuations: readonly boolean[];
  readonly ariaRowIndex: number;
  readonly externalDropEdge?: "before" | "after" | null;
  readonly pragmaticDragData?: BoardCardDragData | null;
  readonly pageAccessProjectId?: string | null;
  readonly pageChatActivity?: PageChatActivitySummary;
  readonly onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  readonly onRemovePageChatRelation?: (sessionId: string) => Promise<void> | void;
}) {
  const dnd = useDatabaseListPageDnd(item);
  const setListDndNodeRef = dnd.setNodeRef;
  const [pageDragHandle, setPageDragHandle] = useState<HTMLButtonElement | null>(null);
  const { setElementRef: setPageDragSourceRef } = useDatabaseViewPageDragSource(pragmaticDragData, {
    dragHandle: pageDragHandle,
    nativePreview: "source",
  });
  const setRowRef = useCallback(
    (element: HTMLDivElement | null): void => {
      setListDndNodeRef(element);
      setPageDragSourceRef(element);
    },
    [setListDndNodeRef, setPageDragSourceRef],
  );
  const dropEdge = dnd.target?.kind === "page" ? dnd.target.indicatorEdge : externalDropEdge;
  const presentedTitle = usePresentedPageTitle(item.pageId, item.row.title, libraryId, {
    generation: item.row.documentGeneration,
    headSeq: item.row.documentHeadSeq,
  });
  const selectionMode = (event: MouseEvent): "replace" | "toggle" | "range" => {
    if (event.shiftKey) return "range";
    if (event.metaKey || event.ctrlKey) return "toggle";
    return "replace";
  };
  const depthOffset = item.depth * DATABASE_LIST_NESTING_DEPTH_PX;
  return (
    <div
      {...dnd.attributes}
      {...dnd.listeners}
      ref={setRowRef}
      role="row"
      aria-rowindex={ariaRowIndex}
      aria-selected={selected}
      tabIndex={active ? 0 : -1}
      data-list-row="true"
      data-list-key={item.key}
      data-database-view-page-id={item.pageId}
      data-database-view-page-menu-target={item.key}
      data-selected={selected || undefined}
      data-previous-selected={selectedBefore || undefined}
      data-next-selected={selectedAfter || undefined}
      data-first-selected={selected && !selectedBefore ? "true" : undefined}
      data-last-selected={selected && !selectedAfter ? "true" : undefined}
      data-selection-start={selected && !selectedBefore ? "true" : undefined}
      data-selection-end={selected && !selectedAfter ? "true" : undefined}
      data-active={active || undefined}
      data-keyboard-active={active || undefined}
      data-first-in-group={item.firstInGroup || undefined}
      data-last-in-group={item.lastInGroup || undefined}
      data-apply-background="true"
      data-raise-row={active || dnd.active || undefined}
      data-drop-position={dropEdge ?? undefined}
      data-database-view-page-presented={presented ? "true" : undefined}
      data-list-transient-kind={item.transientKind === "none" ? undefined : item.transientKind}
      style={
        item.row.conditionalColor
          ? ({
              "--database-list-conditional-bg": databaseViewConditionalColorBackground(
                item.row.conditionalColor,
              ),
            } as CSSProperties)
          : undefined
      }
      className={cn(
        "group/list-row relative grid h-11 min-h-11 min-w-0 items-center gap-x-2 rounded-lg outline-none [grid-template-columns:subgrid] [grid-column:1/-1]",
        "before:absolute before:inset-x-2 before:inset-y-0 before:-z-0 before:rounded-lg before:content-['']",
        "hover:before:bg-[var(--database-list-row-hover)]",
        item.row.conditionalColor &&
          "before:bg-[var(--database-list-conditional-bg)] hover:before:bg-[color-mix(in_srgb,var(--foreground-tertiary)_5%,var(--database-list-conditional-bg))]",
        selected &&
          "before:bg-[var(--database-list-row-selected)] hover:before:bg-[var(--database-list-row-selected)]",
        selected && selectedBefore && "before:rounded-t-none",
        selected && selectedAfter && "before:rounded-b-none",
        active &&
          "focus-visible:before:ring-1 focus-visible:before:ring-inset focus-visible:before:ring-[var(--database-list-focus)]",
        item.transientKind !== "none" && "before:opacity-60 [&>[role=gridcell]]:opacity-60",
        dnd.active && "opacity-70",
        dnd.target?.kind === "page" &&
          dnd.target.indicatorEdge === "inside" &&
          "before:ring-1 before:ring-inset before:ring-[var(--database-list-drop-indicator)]",
      )}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onActivate();
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest(DATABASE_LIST_INTERACTIVE_SELECTOR)) return;
        onActivate();
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest(DATABASE_LIST_INTERACTIVE_SELECTOR)) return;
        if (event.shiftKey) {
          event.preventDefault();
          onSelect(selectionMode(event));
          return;
        }
        if (dnd.active || dnd.suppressesNextClick()) return;
        onActivate();
        onOpen(presentedTitle, "preview");
      }}
      onDoubleClick={(event) => {
        if (event.shiftKey) return;
        const target = event.target as HTMLElement;
        if (
          target.closest(DATABASE_LIST_INTERACTIVE_SELECTOR) &&
          !target.closest("[data-database-view-page-open]")
        )
          return;
        if (dnd.active || dnd.suppressesNextClick()) return;
        onActivate();
        onOpen(presentedTitle, "durable");
      }}
    >
      {dropEdge === "before" || dropEdge === "after" ? (
        <span
          aria-hidden="true"
          data-list-drop-indicator="true"
          data-prospective-depth={dnd.target?.kind === "page" ? dnd.target.prospectiveDepth : 0}
          className={cn(
            "pointer-events-none absolute right-2 z-[3] h-0.5 rounded-full bg-[var(--database-list-drop-indicator)]",
            dropEdge === "before" ? "top-0" : "bottom-0",
          )}
          style={{
            left: databaseListDropIndicatorLeft(
              dnd.target?.kind === "page" ? dnd.target.prospectiveDepth : 0,
            ),
          }}
        >
          <span
            data-list-drop-indicator-anchor="true"
            className="absolute left-0 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--database-list-drop-indicator)] bg-[var(--database-list-surface)]"
          />
        </span>
      ) : null}
      <div
        role="gridcell"
        aria-hidden="true"
        data-list-grid-column="indent"
        className="relative z-[1] h-full min-w-0"
        style={{ gridColumn: "indent" }}
      />
      <DatabaseListNestingLines
        depth={item.depth}
        continuations={nestingContinuations}
        hasChildren={item.hasChildren}
      />
      <div
        role="gridcell"
        data-list-grid-column="checkbox"
        className="relative z-[1] flex items-center justify-center"
        style={{ gridColumn: "checkbox" }}
      >
        <NodexCheckbox
          ariaLabel={`${selected ? "Deselect" : "Select"} ${presentedTitle}`}
          checked={selected}
          onCheckedChange={() => onSelect("toggle")}
          className="rounded-[3px] border-[var(--database-list-checkbox-border)] opacity-0 shadow-none transition-none group-hover/list-row:opacity-100 group-focus-within/list-row:opacity-100 data-[state=checked]:opacity-100 focus-visible:border-[var(--database-list-focus)] focus-visible:ring-[var(--database-list-focus)]"
        />
      </div>
      {showPriority ? (
        <div
          role="gridcell"
          data-list-grid-column="priority"
          className="relative z-[1] flex min-w-0 items-center justify-center text-[var(--database-list-text-muted)]"
          style={{
            gridColumn: "priority",
            transform: `translateX(${depthOffset}px)`,
          }}
        >
          <PropertyOptionPicker
            label="Priority"
            mode="single"
            options={priorityOptions}
            selectedIds={item.row.priority ? [item.row.priority] : []}
            disabled={priorityMutationDisabled}
            allowClear
            emptyOptionLabel="No priority"
            searchPlaceholder="Change priority to…"
            searchLeading={null}
            contentClassName="w-[min(220px,calc(100vw-16px))]"
            triggerButton={
              <NodexButton
                variant="ghost"
                size="icon-xs"
                aria-label={`Change priority for ${presentedTitle}`}
                className="size-5 rounded text-[var(--database-list-text-muted)] disabled:opacity-100"
              >
                <DatabaseListPriorityIcon priority={item.row.priority ?? null} />
              </NodexButton>
            }
            onSelectedIdsChange={(selectedIds) => onSetPriority(selectedIds[0] ?? null)}
            renderOption={(option) => (
              <span className="flex min-w-0 items-center gap-2">
                <DatabaseListPriorityIcon priority={isPriority(option.id) ? option.id : null} />
                <span className="truncate">{option.name}</span>
              </span>
            )}
          />
        </div>
      ) : null}
      {identity.label.length > 0 ? (
        <NodexTooltip tooltipContent={identity.title}>
          <div
            role="gridcell"
            data-list-grid-column="identifier"
            className="relative z-[1] min-w-0 truncate text-[13px] font-[450] leading-[normal] tracking-[-0.02em] tabular-nums text-[var(--database-list-text-muted)]"
            style={{
              gridColumn: "identifier",
              transform: `translateX(${depthOffset}px)`,
            }}
          >
            {identity.label}
          </div>
        </NodexTooltip>
      ) : null}
      {showStatus ? (
        <div
          role="gridcell"
          data-list-grid-column="status"
          className="relative z-[1] flex min-w-0 items-center justify-center text-[var(--database-list-text-muted)]"
          style={{
            gridColumn: "status",
            transform: `translateX(${depthOffset}px)`,
          }}
        >
          <PropertyOptionPicker
            label="Status"
            mode="single"
            options={statusOptions}
            selectedIds={item.row.status ? [item.row.status] : []}
            disabled={statusMutationDisabled}
            allowClear={false}
            searchPlaceholder="Change status…"
            searchLeading={null}
            contentClassName="w-[min(220px,calc(100vw-16px))]"
            triggerButton={
              <NodexButton
                variant="ghost"
                size="icon-xs"
                aria-label={`Change status for ${presentedTitle}`}
                className="size-5 rounded text-[var(--database-list-text-muted)] disabled:opacity-100"
              >
                {item.row.status ? (
                  <StatusIcon statusId={item.row.status} className="size-4" />
                ) : (
                  <span className="size-2 rounded-full ring-[1px] ring-[var(--database-list-icon-muted)]" />
                )}
              </NodexButton>
            }
            onSelectedIdsChange={(selectedIds) => onSetStatus(selectedIds[0] ?? null)}
            renderOption={(option) => (
              <span className="flex min-w-0 items-center gap-2">
                <StatusIcon statusId={option.id} label={option.name} className="size-4" />
                <span className="truncate">{option.name}</span>
              </span>
            )}
          />
        </div>
      ) : null}
      <div
        role="gridcell"
        data-list-grid-column="title"
        className="relative z-[1] -mr-[5px] flex min-w-0 items-center overflow-hidden"
        style={{
          gridColumn: "title",
          transform: `translateX(${depthOffset}px)`,
          marginRight: `${depthOffset - 5}px`,
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <button
            ref={setPageDragHandle}
            type="button"
            data-database-view-page-open="true"
            data-database-view-page-drag-handle="true"
            className="min-w-0 shrink truncate text-left text-sm font-medium leading-[normal] text-[var(--database-list-text-primary)] outline-none"
            aria-label={`Open Page ${presentedTitle}`}
            onClick={() => {
              onActivate();
              onOpen(presentedTitle, "preview");
            }}
          >
            {presentedTitle}
          </button>
          {pageAccessProjectId && pageChatActivity && onOpenRelatedChat ? (
            <PageChatActivityControl
              pageAccessProjectId={pageAccessProjectId}
              pageId={item.pageId}
              summary={pageChatActivity}
              onOpenChat={onOpenRelatedChat}
              onRemoveRelation={onRemovePageChatRelation}
              idleVisibilityClassName="group-hover/list-row:opacity-100 group-focus-within/list-row:opacity-100"
            />
          ) : null}
          {inlineProperties}
        </div>
      </div>
      {trailingCells}
      <div
        role="gridcell"
        data-list-grid-column="end-padding"
        className="relative z-[1]"
        style={{ gridColumn: "end-padding" }}
      />
    </div>
  );
}
