import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { SearchIcon } from "@/components/shared/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { XCircle } from "@/components/shared/icons/generic-icons";
import { NodexIconButton } from "@/components/ui/button";
import { NodexContextMenuRoot, NodexContextMenuTrigger } from "@/components/ui/context-menu";
import {
  ContinuousSortableDragOverlay,
  useContinuousSortable,
  useContinuousSortableDnd,
} from "@/components/ui/continuous-sortable";
import { NodexTabsList, NodexTabsRoot, NodexTabsTab } from "@/components/ui/tabs";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  DatabaseViewActionMenuOverlay,
  type DatabaseViewActionMenuSession,
} from "./database-view-action-menu";

export const DB_VIEW_TOOLBAR_TEST_ID = "db-view-toolbar";

export interface DbViewToolbarItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  onSelect: () => void;
  actionMenu?: DatabaseViewActionMenuSession;
}

interface DbViewToolbarProps {
  items: readonly DbViewToolbarItem[];
  destinationItems?: readonly DbViewToolbarItem[];
  activeSearchQuery: string;
  taskSearchOpen: boolean;
  searchShortcutLabel: string;
  taskSearchInputRef: RefObject<HTMLInputElement | null>;
  viewContextLabel?: ReactNode;
  managementControl?: ReactNode;
  databaseViewControls?: ReactNode;
  rulesBar?: ReactNode;
  showSearchControls?: boolean;
  onSearchQueryChange: (value: string) => void;
  onOpenTaskSearch: (selectQuery?: boolean) => void;
  onCloseTaskSearch: () => void;
  onReorderViews?: (
    movedViewId: string,
    orderedViewIds: readonly string[],
  ) => boolean | Promise<boolean>;
}

const EMPTY_DESTINATION_ITEMS: readonly DbViewToolbarItem[] = [];
const DATABASE_VIEW_TAB_TARGET_ATTRIBUTE = "data-database-view-tab-menu-target";

function DatabaseViewTabPill({
  item,
  active,
  menuOpen,
  overlay = false,
  onActiveClick,
  dragListeners,
}: {
  readonly item: DbViewToolbarItem;
  readonly active: boolean;
  readonly menuOpen: boolean;
  readonly overlay?: boolean;
  readonly onActiveClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly dragListeners?: DraggableSyntheticListeners;
}) {
  const Icon = item.icon;
  const displayMode = item.actionMenu?.displayMode ?? "icon_and_text";
  const showIcon = displayMode !== "text_only";
  const showLabel = displayMode !== "icon_only";
  const className = cn(
    "group/view inline-flex h-8 max-w-[220px] shrink-0 items-center justify-center rounded-[20px]",
    "px-3 text-sm font-medium leading-[16.8px] whitespace-nowrap outline-none",
    "focus-visible:ring-2 focus-visible:ring-(--ring)/35",
    overlay && "pointer-events-none shadow-none",
    active
      ? menuOpen
        ? "bg-token-foreground/10 text-token-text-primary"
        : "bg-token-foreground/5 text-token-text-primary"
      : "text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-text-primary",
  );
  const content = (
    <>
      {Icon && showIcon ? <Icon className="size-4 shrink-0 text-current" /> : null}
      {showLabel ? (
        <span
          data-tab-label-visible="true"
          className={cn("min-w-0 truncate text-left", showIcon && "ml-1.5")}
        >
          {item.label}
        </span>
      ) : null}
    </>
  );
  if (overlay) {
    return (
      <div className="flex h-10 items-center" aria-hidden>
        <div
          className={cn(className, "cursor-grabbing")}
          data-database-view-tab-drag-overlay={item.id}
        >
          {content}
        </div>
      </div>
    );
  }
  return (
    <NodexTabsTab
      value={item.id}
      aria-label={item.label}
      aria-haspopup={item.actionMenu ? "dialog" : undefined}
      aria-expanded={item.actionMenu ? menuOpen : undefined}
      title={item.label}
      {...{ [DATABASE_VIEW_TAB_TARGET_ATTRIBUTE]: item.id }}
      {...dragListeners}
      className={className}
      onClick={(event) => {
        if (!active) return;
        onActiveClick?.(event);
      }}
    >
      {content}
    </NodexTabsTab>
  );
}

function SortableDatabaseViewTab({
  item,
  active,
  menuOpen,
  dragDisabled,
  onActiveClick,
}: {
  readonly item: DbViewToolbarItem;
  readonly active: boolean;
  readonly menuOpen: boolean;
  readonly dragDisabled: boolean;
  readonly onActiveClick: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const sortable = useContinuousSortable({
    id: item.id,
    disabled: dragDisabled,
  });
  return (
    <div
      ref={sortable.setNodeRef}
      style={sortable.style}
      className={cn(
        "flex h-10 shrink-0 items-center",
        dragDisabled ? "cursor-default" : sortable.isDragging ? "cursor-grabbing" : "cursor-grab",
        sortable.isDragging && "opacity-0",
      )}
      data-database-view-tab-sortable={item.id}
      data-database-view-tab-dragging={sortable.isDragging ? "true" : "false"}
    >
      <DatabaseViewTabPill
        item={item}
        active={active}
        menuOpen={menuOpen}
        onActiveClick={onActiveClick}
        dragListeners={sortable.listeners}
      />
    </div>
  );
}

export function resolveDbViewToolbarClearAction(hasActiveSearchQuery: boolean): {
  shouldClear: boolean;
  shouldClose: boolean;
} {
  if (!hasActiveSearchQuery) {
    return {
      shouldClear: false,
      shouldClose: true,
    };
  }

  return {
    shouldClear: true,
    shouldClose: true,
  };
}

export function DbViewToolbar({
  items,
  destinationItems = EMPTY_DESTINATION_ITEMS,
  activeSearchQuery,
  taskSearchOpen,
  searchShortcutLabel,
  taskSearchInputRef,
  viewContextLabel,
  managementControl,
  databaseViewControls,
  rulesBar,
  showSearchControls = true,
  onSearchQueryChange,
  onOpenTaskSearch,
  onCloseTaskSearch,
  onReorderViews,
}: DbViewToolbarProps) {
  const activeItem = items.find((item) => item.active) ?? items[0] ?? null;
  const canonicalItemIds = useMemo(() => items.map((item) => item.id), [items]);
  const canonicalOrderKey = canonicalItemIds.join("\u0000");
  const [orderedItemIds, setOrderedItemIds] = useState(canonicalItemIds);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
  const [menuTargetId, setMenuTargetId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabDnd = useContinuousSortableDnd({ axis: "horizontal", containerRef: tabListRef });
  useEffect(
    () => setOrderedItemIds(canonicalOrderKey ? canonicalOrderKey.split("\u0000") : []),
    [canonicalOrderKey],
  );
  const orderedItems = orderedItemIds.flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item ? [item] : [];
  });
  const draggedItem = draggedItemId
    ? (items.find((item) => item.id === draggedItemId) ?? null)
    : null;
  const menuTarget = menuTargetId ? (items.find((item) => item.id === menuTargetId) ?? null) : null;
  const dragDisabled =
    items.length < 2 || !onReorderViews || items.some((item) => item.actionMenu?.busy);

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open);
    if (!open) setMenuTargetId(null);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>(`[${DATABASE_VIEW_TAB_TARGET_ATTRIBUTE}]`);
    const viewId = target?.getAttribute(DATABASE_VIEW_TAB_TARGET_ATTRIBUTE);
    const nextItem = viewId ? items.find((item) => item.id === viewId) : null;
    if (!nextItem?.actionMenu) {
      event.stopPropagation();
      return;
    }
    setMenuTargetId(nextItem.id);
  };

  const openActiveTabMenu = (
    item: DbViewToolbarItem,
    event: ReactMouseEvent<HTMLElement>,
  ): void => {
    if (!item.actionMenu || draggedItemId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuTargetId(item.id);
    event.currentTarget.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        // Base UI offsets a pointer-anchored context surface by three pixels.
        // Compensate so an active-tab click aligns the menu with the pill edge.
        clientX: rect.left - 3,
        clientY: rect.bottom,
      }),
    );
  };

  const handleDragStart = (event: DragStartEvent): void => {
    setMenuOpen(false);
    setMenuTargetId(null);
    setDraggedItemId(String(event.active.id));
    setDragOverItemId(String(event.active.id));
    document.getSelection()?.removeAllRanges();
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    setDraggedItemId(null);
    setDragOverItemId(null);
    const movedViewId = String(event.active.id);
    const overViewId = event.over ? String(event.over.id) : null;
    if (!overViewId || movedViewId === overViewId) return;
    const fromIndex = orderedItemIds.indexOf(movedViewId);
    const toIndex = orderedItemIds.indexOf(overViewId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextOrder = arrayMove(orderedItemIds, fromIndex, toIndex);
    setOrderedItemIds(nextOrder);
    void Promise.resolve(onReorderViews?.(movedViewId, nextOrder)).then((committed) => {
      if (!committed) setOrderedItemIds(canonicalItemIds);
    });
  };

  if (!activeItem) return null;

  const hasActiveSearchQuery = activeSearchQuery.trim().length > 0;
  const showSearchField = showSearchControls && (taskSearchOpen || hasActiveSearchQuery);

  return (
    <header
      className={cn(
        "sticky top-0 z-20 shrink-0",
        "bg-[color-mix(in_srgb,var(--background)_94%,transparent)] backdrop-blur-sm",
      )}
      data-testid={DB_VIEW_TOOLBAR_TEST_ID}
      data-database-view-tab-drag-over={dragOverItemId ?? undefined}
    >
      <div className="h-10 pl-4 pr-2">
        <div className="flex h-10 items-center gap-2">
          <div className="flex min-w-0 shrink items-center">
            <NodexContextMenuRoot open={menuOpen} onOpenChange={handleMenuOpenChange}>
              <NodexContextMenuTrigger>
                <div className="min-w-0">
                  <div onContextMenu={handleContextMenu}>
                    <DndContext
                      sensors={tabDnd.sensors}
                      autoScroll={false}
                      modifiers={tabDnd.modifiers}
                      collisionDetection={tabDnd.collisionDetection}
                      onDragStart={handleDragStart}
                      onDragOver={(event) =>
                        setDragOverItemId(event.over ? String(event.over.id) : null)
                      }
                      onDragCancel={() => {
                        setDraggedItemId(null);
                        setDragOverItemId(null);
                      }}
                      onDragEnd={handleDragEnd}
                    >
                      <NodexTabsRoot
                        className="min-w-0"
                        value={activeItem.id}
                        onValueChange={(value) => {
                          if (draggedItemId) return;
                          const nextItem = items.find((item) => item.id === value);
                          nextItem?.onSelect();
                        }}
                      >
                        <NodexTabsList
                          ref={tabListRef}
                          aria-label="Database views"
                          className="hide-scrollbar -ml-1 flex min-w-0 items-center overflow-x-auto"
                        >
                          <SortableContext
                            items={orderedItemIds}
                            strategy={horizontalListSortingStrategy}
                          >
                            {orderedItems.map((item) => (
                              <SortableDatabaseViewTab
                                key={item.id}
                                item={item}
                                active={item.id === activeItem.id}
                                menuOpen={menuOpen && menuTargetId === item.id}
                                dragDisabled={dragDisabled}
                                onActiveClick={(event) => openActiveTabMenu(item, event)}
                              />
                            ))}
                          </SortableContext>
                        </NodexTabsList>
                      </NodexTabsRoot>
                      <ContinuousSortableDragOverlay>
                        {draggedItem ? (
                          <DatabaseViewTabPill
                            item={draggedItem}
                            active={draggedItem.id === activeItem.id}
                            menuOpen={false}
                            overlay
                          />
                        ) : null}
                      </ContinuousSortableDragOverlay>
                    </DndContext>
                  </div>
                </div>
              </NodexContextMenuTrigger>
              {menuTarget?.actionMenu ? (
                <DatabaseViewActionMenuOverlay
                  session={menuTarget.actionMenu}
                  onMenuOpenChange={handleMenuOpenChange}
                />
              ) : null}
            </NodexContextMenuRoot>
            {destinationItems.map((item) => {
              const Icon = item.icon;
              return (
                <NodexTooltip key={item.id} tooltipContent={item.label}>
                  <button
                    type="button"
                    aria-label={item.label}
                    className={cn(
                      "group/view mx-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full",
                      "text-(--foreground-secondary) outline-none",
                      "hover:bg-token-foreground/5 hover:text-(--foreground)",
                      "focus-visible:ring-2 focus-visible:ring-(--ring)/35",
                    )}
                    onClick={item.onSelect}
                  >
                    {Icon ? (
                      <Icon className="size-4 text-[color-mix(in_srgb,var(--foreground)_62%,transparent)] group-hover/view:text-current" />
                    ) : null}
                  </button>
                </NodexTooltip>
              );
            })}
          </div>

          {viewContextLabel ? (
            <div className="flex min-w-0 shrink items-center">{viewContextLabel}</div>
          ) : null}

          <div className="ml-auto flex h-full items-center justify-end gap-0.5">
            {managementControl}
            {databaseViewControls}

            {showSearchControls ? (
              <div className="flex items-center">
                <NodexIconButton
                  icon={SearchIcon}
                  size="sm"
                  ariaLabel="Search"
                  title={`Task search (${searchShortcutLabel})`}
                  onClick={() => onOpenTaskSearch(true)}
                />

                <div
                  aria-hidden={!showSearchField}
                  className={cn(
                    "overflow-hidden transition-[width,opacity,margin] duration-200 ease-out",
                    showSearchField ? "ml-1 w-[150px] opacity-100" : "ml-0 w-0 opacity-0",
                  )}
                >
                  <div className="flex items-center overflow-hidden">
                    <div className="mb-px flex w-full items-center pr-1 text-sm text-(--foreground)">
                      <input
                        ref={taskSearchInputRef}
                        type="text"
                        value={activeSearchQuery}
                        onChange={(event) => onSearchQueryChange(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          onCloseTaskSearch();
                        }}
                        placeholder="Type to search..."
                        aria-label="Search tasks"
                        tabIndex={showSearchField ? 0 : -1}
                        className={cn(
                          "w-full border-none bg-transparent p-0 text-sm text-(--foreground) outline-none",
                          "placeholder:text-(--foreground-tertiary)",
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const nextAction = resolveDbViewToolbarClearAction(hasActiveSearchQuery);
                          if (nextAction.shouldClear) {
                            onSearchQueryChange("");
                          }
                          if (nextAction.shouldClose) {
                            onCloseTaskSearch();
                          }
                        }}
                        aria-label={hasActiveSearchQuery ? "Clear search" : "Close search"}
                        className={cn(
                          "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
                          "text-(--foreground-tertiary) hover:bg-token-foreground/5 hover:text-(--foreground-secondary)",
                        )}
                      >
                        <XCircle className="size-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {rulesBar}
    </header>
  );
}
