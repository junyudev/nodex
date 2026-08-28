import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckmarkIcon,
  MoveDownIcon,
  MoveUpIcon,
  ProjectActionsIcon,
  VisibilityOffIcon,
} from "@/components/shared/icons";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  NodexCollapsiblePanel,
  NodexCollapsibleRoot,
  NodexCollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";
import { formatElapsedSince } from "@/lib/elapsed-time";
import type {
  Project,
  ProjectCreateInput,
  ProjectLifecycleMutationResult,
  ProjectUpdateInput,
} from "@/lib/types";
import { resolveStageSidebarSectionRenderState } from "./left-sidebar-section-state";
import { LeftSidebarFooter, type LeftSidebarFooterProps } from "./left-sidebar-footer";
import { SidebarProjectsSection } from "./left-sidebar-projects-section";
import {
  SIDEBAR_SECTION_ITEM_LIMITS,
  type SidebarSectionItemLimit,
} from "../../lib/sidebar-section-prefs";
import { Hash } from "@/components/shared/icons/generic-icons";

export interface StageSidebarItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  updatedAtMs?: number;
  active?: boolean;
  onSelect: () => void;
  closable?: boolean;
  onClose?: () => void;
}

export interface StageSidebarSection {
  id: string;
  label?: string;
  count?: number;
  icon?: ComponentType<{ className?: string }>;
  collapsible?: boolean;
  items: StageSidebarItem[];
}

export interface StageSidebarGroup {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  active: boolean;
  expanded: boolean;
  hideHeader?: boolean;
  onFocus: () => void;
  onToggleExpanded: () => void;
  sections: StageSidebarSection[];
  items?: StageSidebarItem[];
  moreActions?: {
    itemLimit: SidebarSectionItemLimit;
    canMoveUp: boolean;
    canMoveDown: boolean;
    onItemLimitChange: (itemLimit: SidebarSectionItemLimit) => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onHide: () => void;
  };
}

interface LeftSidebarProps {
  projects: Project[];
  projectOrder: string[];
  activeProjectId: string | null;
  stageGroups: StageSidebarGroup[];
  collapsed: boolean;
  width: number;
  expandedSections: Record<string, boolean>;
  showAllItemsBySection: Record<string, boolean>;
  onResizeWidth: (width: number) => void;
  onSetSectionExpanded: (sectionId: string, expanded: boolean) => void;
  onSetSectionShowAll: (sectionId: string, showAll: boolean) => void;
  onSelectProject: (projectId: string) => void;
  onOpenSettings: () => void;
  projectPickerOpenTick: number;
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  footerAccount?: Omit<LeftSidebarFooterProps, "onOpenSettings">;
}

const STAGE_ITEM_COLLAPSE_LIMIT = 10;
const SIDEBAR_ELAPSED_REFRESH_MS = 30_000;

function isFiniteTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function SidebarSectionMoreActionsMenu({
  group,
  onBeforeItemLimitChange,
}: {
  group: StageSidebarGroup;
  onBeforeItemLimitChange: () => void;
}) {
  if (!group.moreActions) return null;

  const { itemLimit, canMoveUp, canMoveDown, onItemLimitChange, onMoveUp, onMoveDown, onHide } =
    group.moreActions;

  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="sm"
      triggerButton={
        <NodexDropdownButtonTrigger
          aria-label={`${group.label} actions`}
          showChevron={false}
          className={cn(
            "h-6 w-6 shrink-0 justify-center px-0",
            "text-(--sidebar-foreground-tertiary) opacity-0 group-hover/top-header:opacity-100",
            "group-focus-within/top-header:opacity-100 data-[state=open]:opacity-100",
            "hover:text-(--sidebar-foreground) focus-visible:opacity-100 focus-visible:ring-(--sidebar-ring)/35",
          )}
        >
          <ProjectActionsIcon className="size-4" />
        </NodexDropdownButtonTrigger>
      }
      finalFocus={false}
    >
      <NodexDropdownFlyoutSubmenuItem
        label="Show"
        contentClassName="min-w-[180px]"
        triggerContent={
          <div className="flex min-h-5 w-full items-center gap-2 text-sm">
            <Hash className="size-4 shrink-0 text-(--sidebar-foreground-secondary)" />
            <span className="min-w-0 flex-1 truncate">Show</span>
            <span className="ml-auto shrink-0 text-xs text-(--sidebar-foreground-tertiary) tabular-nums">
              {itemLimit}
            </span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-(--sidebar-foreground-tertiary)" />
          </div>
        }
      >
        {SIDEBAR_SECTION_ITEM_LIMITS.map((limit) => (
          <NodexDropdownItem
            key={limit}
            onSelect={() => {
              onBeforeItemLimitChange();
              onItemLimitChange(limit);
            }}
            rightSlot={
              itemLimit === limit ? (
                <CheckmarkIcon className="size-4 shrink-0 text-(--foreground)" />
              ) : null
            }
          >
            {limit} items
          </NodexDropdownItem>
        ))}
      </NodexDropdownFlyoutSubmenuItem>

      <NodexDropdownItem
        onSelect={onMoveUp}
        disabled={!canMoveUp}
        className="mt-0.5"
        leftSlot={<MoveUpIcon className="size-4 shrink-0 text-(--sidebar-foreground-secondary)" />}
      >
        Move up
      </NodexDropdownItem>

      <NodexDropdownItem
        onSelect={onMoveDown}
        disabled={!canMoveDown}
        leftSlot={
          <MoveDownIcon className="size-4 shrink-0 text-(--sidebar-foreground-secondary)" />
        }
      >
        Move down
      </NodexDropdownItem>

      <NodexDropdownSeparator />

      <NodexDropdownItem
        onSelect={onHide}
        leftSlot={<VisibilityOffIcon className="size-4 shrink-0 text-(--red-text)" />}
      >
        Hide section
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

export function LeftSidebar({
  projects,
  projectOrder,
  activeProjectId,
  stageGroups,
  collapsed,
  width,
  expandedSections,
  showAllItemsBySection,
  onResizeWidth,
  onSetSectionExpanded,
  onSetSectionShowAll,
  onSelectProject,
  onOpenSettings,
  projectPickerOpenTick,
  onCreateProject,
  onArchiveProject,
  onUpdateProject,
  footerAccount,
}: LeftSidebarProps) {
  const projectsStageGroup = useMemo(
    () => stageGroups.find((group) => group.id === "db"),
    [stageGroups],
  );
  const visibleStageGroups = useMemo(
    () => stageGroups.filter((group) => group.id !== "db"),
    [stageGroups],
  );
  const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());
  const hasElapsedSidebarItems = useMemo(
    () =>
      visibleStageGroups.some((group) =>
        group.sections.some((section) =>
          section.items.some((item) => isFiniteTimestamp(item.updatedAtMs)),
        ),
      ),
    [visibleStageGroups],
  );

  useEffect(() => {
    if (!hasElapsedSidebarItems) return;

    setElapsedNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setElapsedNowMs(Date.now());
    }, SIDEBAR_ELAPSED_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasElapsedSidebarItems]);

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = width;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (nextEvent: MouseEvent) => {
      const nextWidth = startWidth + (nextEvent.clientX - startX);
      onResizeWidth(nextWidth);
    };

    const onMouseUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  if (collapsed) return null;

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden font-sans text-sm"
      style={{
        width,
      }}
    >
      <header className="relative h-11 shrink-0">
        <div
          className="absolute inset-x-0 top-0 h-9"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
      </header>

      <div className="scrollbar-token min-h-0 flex-1 overflow-y-auto px-(--sidebar-shell-padding-x) py-1">
        <SidebarProjectsSection
          projects={projects}
          projectOrder={projectOrder}
          activeProjectId={activeProjectId}
          expanded={projectsStageGroup?.expanded ?? true}
          onToggleExpanded={projectsStageGroup?.onToggleExpanded ?? (() => undefined)}
          onSelectProject={onSelectProject}
          onCreateProject={onCreateProject}
          onArchiveProject={onArchiveProject}
          onUpdateProject={onUpdateProject}
          projectPickerOpenTick={projectPickerOpenTick}
        />

        {visibleStageGroups.map((group) => {
          const groupExpanded = group.hideHeader ? true : group.expanded;
          const groupItemPaddingClass = group.hideHeader
            ? "px-[var(--sidebar-row-padding-x)]"
            : "pr-1 pl-[calc(var(--sidebar-row-padding-x)+0.875rem+0.375rem)]";
          const sections = group.sections.filter((section) => section.items.length > 0);
          const groupItemLimit = group.moreActions?.itemLimit ?? STAGE_ITEM_COLLAPSE_LIMIT;

          const resetGroupOverflowExpansion = () => {
            if (sections.length === 0) return;
            sections.forEach((section) => {
              if (showAllItemsBySection[section.id] !== true) return;
              onSetSectionShowAll(section.id, false);
            });
          };

          const renderStageItem = (item: StageSidebarItem) => {
            const itemUpdatedAtMs = isFiniteTimestamp(item.updatedAtMs) ? item.updatedAtMs : null;
            const elapsedLabel =
              itemUpdatedAtMs === null ? null : formatElapsedSince(itemUpdatedAtMs, elapsedNowMs);
            const elapsedTitle =
              itemUpdatedAtMs === null
                ? undefined
                : `Updated ${new Date(itemUpdatedAtMs).toLocaleString()}`;
            const itemPaddingClass = group.hideHeader
              ? "px-[var(--sidebar-row-padding-x)]"
              : item.icon
                ? "px-[var(--sidebar-row-padding-x)]"
                : "pr-2 pl-[calc(var(--sidebar-row-padding-x)+0.875rem+0.375rem)]";

            return (
              <button
                onClick={item.onSelect}
                tabIndex={groupExpanded ? 0 : -1}
                data-active={item.active ? "true" : undefined}
                className={cn(
                  "group min-h-7.5 w-full rounded-lg py-(--sidebar-row-padding-y) text-left",
                  "inline-flex items-center",
                  item.icon && "gap-2",
                  itemPaddingClass,
                  item.active
                    ? group.active
                      ? "bg-(--sidebar-accent) text-(--sidebar-foreground) hover:bg-[color-mix(in_srgb,var(--sidebar-accent)_72%,var(--sidebar-foreground)_7%)]"
                      : "bg-[color-mix(in_srgb,var(--sidebar-accent)_55%,transparent)] text-(--sidebar-foreground) hover:bg-[color-mix(in_srgb,var(--sidebar-accent)_70%,transparent)] hover:text-(--sidebar-foreground)"
                    : "text-(--sidebar-foreground) hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground)",
                )}
              >
                {item.icon && <item.icon className="size-3.5 shrink-0 opacity-80" />}
                <span className={cn("truncate", elapsedLabel && "min-w-0 flex-1")}>
                  {item.label}
                </span>
                {elapsedLabel && (
                  <NodexTooltip tooltipContent={elapsedTitle} side="top">
                    <span className="ml-auto shrink-0 text-sm/4 text-(--sidebar-foreground-tertiary) tabular-nums">
                      {elapsedLabel}
                    </span>
                  </NodexTooltip>
                )}
                {item.closable && item.onClose && (
                  <span
                    role="button"
                    tabIndex={-1}
                    className={cn(
                      "inline-flex h-4 items-center justify-center text-(--sidebar-foreground-tertiary) opacity-0 group-hover:opacity-100 hover:text-(--sidebar-foreground)",
                      elapsedLabel ? "ml-1" : "ml-auto",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      item.onClose?.();
                    }}
                  >
                    &times;
                  </span>
                )}
              </button>
            );
          };

          const renderSection = (section: StageSidebarSection) => {
            const SectionIcon = section.icon;
            const {
              expanded: sectionExpanded,
              visibleItems,
              overflowItems,
              pinnedItems,
              hasOverflow,
            } = resolveStageSidebarSectionRenderState(
              section,
              expandedSections,
              showAllItemsBySection,
              groupItemLimit,
            );
            const showAllItems = showAllItemsBySection[section.id] ?? false;

            return (
              <div key={section.id} className="flex min-h-0 flex-col gap-px overflow-hidden">
                {section.collapsible ? (
                  <NodexCollapsibleRoot
                    open={sectionExpanded}
                    onOpenChange={(open) => {
                      onSetSectionExpanded(section.id, open);
                    }}
                  >
                    <NodexCollapsibleTrigger
                      render={
                        <button
                          type="button"
                          className={cn(
                            "group/status inline-flex min-h-7.5 w-full items-center gap-1 rounded-lg px-(--sidebar-row-padding-x) py-(--sidebar-row-padding-tight-y) text-left hover:bg-(--sidebar-accent)",
                            sectionExpanded
                              ? "text-(--sidebar-foreground)"
                              : "text-(--sidebar-foreground-secondary) hover:text-(--sidebar-foreground)",
                          )}
                        />
                      }
                    >
                      <span className="relative size-4 shrink-0">
                        {SectionIcon ? (
                          <SectionIcon
                            className={cn(
                              "absolute inset-0 my-auto ml-[-0.1rem] size-4.5",
                              "opacity-100 group-hover/status:opacity-0 group-focus-visible:opacity-0",
                            )}
                          />
                        ) : null}
                        <ChevronDownIcon
                          className={cn(
                            "absolute inset-0 m-auto size-3 transition-transform duration-150",
                            SectionIcon
                              ? "opacity-0 group-hover/status:opacity-100 group-focus-visible:opacity-100"
                              : "opacity-100",
                            !sectionExpanded && "-rotate-90",
                          )}
                        />
                      </span>
                      <span className="mr-auto inline-flex min-w-0 items-baseline gap-2.5 text-(--sidebar-foreground)">
                        <span className="truncate">{section.label}</span>
                        {typeof section.count === "number" ? (
                          <span className="shrink-0 text-[calc(var(--text-sm)-1px)]/5 text-(--sidebar-foreground-tertiary)">
                            {section.count}
                          </span>
                        ) : null}
                      </span>
                    </NodexCollapsibleTrigger>
                    <NodexCollapsiblePanel className="overflow-hidden data-[closed]:hidden">
                      <div className="mt-px flex flex-col gap-px">
                        {visibleItems.map((item) => (
                          <div key={item.id}>{renderStageItem(item)}</div>
                        ))}
                        {hasOverflow && (
                          <NodexCollapsibleRoot
                            open={showAllItems}
                            onOpenChange={(open) => {
                              onSetSectionShowAll(section.id, open);
                            }}
                          >
                            <NodexCollapsiblePanel className="overflow-hidden data-[closed]:hidden">
                              <div className="flex flex-col gap-px">
                                {overflowItems.map((item) => (
                                  <div key={item.id}>{renderStageItem(item)}</div>
                                ))}
                              </div>
                            </NodexCollapsiblePanel>
                            <NodexCollapsibleTrigger
                              render={
                                <button
                                  type="button"
                                  tabIndex={groupExpanded ? 0 : -1}
                                  className={cn(
                                    "group inline-flex min-h-7.5 w-full items-center py-(--sidebar-row-padding-y) text-left",
                                    groupItemPaddingClass,
                                  )}
                                />
                              }
                            >
                              <span className="-mx-(--sidebar-row-padding-x) rounded-full px-(--sidebar-row-padding-x) py-0.5 text-sm text-(--sidebar-foreground-tertiary) group-hover:bg-(--sidebar-accent) group-hover:text-(--sidebar-foreground-secondary)">
                                {showAllItems ? "Show less" : "Show more"}
                              </span>
                            </NodexCollapsibleTrigger>
                          </NodexCollapsibleRoot>
                        )}
                      </div>
                    </NodexCollapsiblePanel>
                    {pinnedItems.length > 0 ? (
                      <div className="mt-px flex flex-col gap-px">
                        {pinnedItems.map((item) => (
                          <div key={item.id}>{renderStageItem(item)}</div>
                        ))}
                      </div>
                    ) : null}
                  </NodexCollapsibleRoot>
                ) : (
                  <>
                    {section.label && (
                      <div
                        className={cn(
                          "flex min-h-6 items-center py-1 text-[11px]/5",
                          groupItemPaddingClass,
                        )}
                      >
                        <span className="inline-flex min-w-0 items-baseline gap-1 text-(--sidebar-foreground-secondary)">
                          <span className="truncate">{section.label}</span>
                          {typeof section.count === "number" ? (
                            <span className="shrink-0 text-(--sidebar-foreground-tertiary) tabular-nums">
                              {section.count}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    )}
                    {visibleItems.map((item) => (
                      <div key={item.id}>{renderStageItem(item)}</div>
                    ))}
                    {hasOverflow && (
                      <NodexCollapsibleRoot
                        open={showAllItems}
                        onOpenChange={(open) => {
                          onSetSectionShowAll(section.id, open);
                        }}
                      >
                        <NodexCollapsiblePanel className="overflow-hidden data-[closed]:hidden">
                          <div className="flex flex-col gap-px">
                            {overflowItems.map((item) => (
                              <div key={item.id}>{renderStageItem(item)}</div>
                            ))}
                          </div>
                        </NodexCollapsiblePanel>
                        <NodexCollapsibleTrigger
                          render={
                            <button
                              type="button"
                              tabIndex={groupExpanded ? 0 : -1}
                              className={cn(
                                "group inline-flex min-h-7.5 w-full items-center py-(--sidebar-row-padding-y) text-left",
                                groupItemPaddingClass,
                              )}
                            />
                          }
                        >
                          <span className="-mx-(--sidebar-row-padding-x) rounded-full px-(--sidebar-row-padding-x) py-0.5 text-sm text-(--sidebar-foreground-tertiary) group-hover:bg-(--sidebar-accent) group-hover:text-(--sidebar-foreground-secondary)">
                            {showAllItems ? "Show less" : "Show more"}
                          </span>
                        </NodexCollapsibleTrigger>
                      </NodexCollapsibleRoot>
                    )}
                  </>
                )}
              </div>
            );
          };

          return (
            <section
              key={group.id}
              className={group.expanded ? "mb-3 last:mb-0" : "mb-1 last:mb-0"}
            >
              {!group.hideHeader && (
                <div
                  className={cn(
                    "group/top-header flex min-h-7.5 items-center gap-1 rounded-lg pl-(--sidebar-header-padding-x) pr-1 py-(--sidebar-row-padding-tight-y)",
                    "text-token-input-placeholder-foreground hover:bg-sidebar-accent hover:text-(--sidebar-foreground) font-medium",
                  )}
                >
                  <button
                    type="button"
                    onClick={group.onToggleExpanded}
                    aria-expanded={group.expanded}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 text-left text-xs outline-none",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="truncate">{group.label}</span>
                      <ChevronDownIcon
                        aria-hidden
                        className={cn(
                          "size-3 shrink-0 text-(--sidebar-foreground) transition-all duration-150",
                          "opacity-0 group-hover/top-header:opacity-100 group-focus-visible/top-header:opacity-100",
                          !group.expanded && "-rotate-90",
                        )}
                      />
                    </div>
                  </button>
                  <SidebarSectionMoreActionsMenu
                    group={group}
                    onBeforeItemLimitChange={resetGroupOverflowExpansion}
                  />
                </div>
              )}

              <NodexCollapsibleRoot open={groupExpanded}>
                <NodexCollapsiblePanel
                  className={cn(
                    group.hideHeader ? "overflow-hidden" : "mt-px overflow-hidden",
                    "data-[closed]:hidden",
                  )}
                >
                  <div className="flex min-h-0 flex-col gap-px overflow-hidden">
                    {sections.length === 0 && (
                      <div
                        className={cn(
                          "py-(--sidebar-row-padding-y) text-(--sidebar-foreground-tertiary)",
                          groupItemPaddingClass,
                        )}
                      >
                        No entries
                      </div>
                    )}
                    {sections.map((section) => renderSection(section))}
                  </div>
                </NodexCollapsiblePanel>
              </NodexCollapsibleRoot>
            </section>
          );
        })}
      </div>

      <LeftSidebarFooter onOpenSettings={onOpenSettings} {...footerAccount} />

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="group absolute top-0 right-0 bottom-0 z-20 flex w-3 translate-x-1.5 cursor-col-resize touch-none select-none active:cursor-col-resize"
      >
        <div
          aria-hidden
          className="pointer-events-none m-auto h-full w-px bg-linear-to-b from-transparent via-(--border) to-transparent group-hover:via-(--foreground-tertiary) group-active:via-(--foreground-tertiary)"
        />
      </div>
    </aside>
  );
}
