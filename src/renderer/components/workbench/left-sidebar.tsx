import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Collapsible as CollapsiblePrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  Tabs as TabsPrimitive,
} from "radix-ui";
import { cn } from "@/lib/utils";
import { invoke } from "@/lib/api";
import type { Project } from "@/lib/types";
import type { SpaceRef } from "@/lib/use-workbench-state";
import { resolveStageSidebarSectionRenderState } from "./left-sidebar-section-state";
import { LeftSidebarProjectManager } from "./left-sidebar-project-manager";
import { SIDEBAR_SECTION_ITEM_LIMITS, type SidebarSectionItemLimit } from "../../lib/sidebar-section-prefs";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FolderOpen,
  Hash,
  MoreHorizontal,
} from "lucide-react";

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
  accentColor?: string;
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
  spaces: SpaceRef[];
  activeProjectId: string;
  stageGroups: StageSidebarGroup[];
  utilityActions?: React.ReactNode;
  collapsed: boolean;
  width: number;
  expandedSections: Record<string, boolean>;
  showAllItemsBySection: Record<string, boolean>;
  onResizeWidth: (width: number) => void;
  onSetSectionExpanded: (sectionId: string, expanded: boolean) => void;
  onSetSectionShowAll: (sectionId: string, showAll: boolean) => void;
  onSelectSpace: (projectId: string) => void;
  onOpenSettings: () => void;
  projectPickerOpenTick: number;
  onCreateProject: (
    id: string,
    name: string,
    description?: string,
    icon?: string,
    workspacePath?: string | null,
  ) => Promise<Project | null>;
  onDeleteProject: (projectId: string) => Promise<boolean>;
  onRenameProject: (
    oldId: string,
    newId: string,
    name?: string,
    icon?: string,
    workspacePath?: string | null,
  ) => Promise<Project | null>;
}

const STAGE_ITEM_COLLAPSE_LIMIT = 10;
const SIDEBAR_ELAPSED_REFRESH_MS = 30_000;

function isFiniteTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatElapsedSince(updatedAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(Math.floor((nowMs - updatedAtMs) / 1_000), 0);

  if (elapsedSeconds < 60) return "now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  if (elapsedDays < 30) return `${Math.floor(elapsedDays / 7)}w`;
  if (elapsedDays < 365) return `${Math.floor(elapsedDays / 30)}mo`;
  return `${Math.floor(elapsedDays / 365)}y`;
}

function SidebarDbViewSelector({
  activeGroup,
  items,
}: {
  activeGroup: boolean;
  items: StageSidebarItem[];
}) {
  const activeItem = items.find((item) => item.active) ?? items[0] ?? null;
  if (!activeItem) return null;

  return (
    <TabsPrimitive.Root
      value={activeItem.id}
      onValueChange={(value) => {
        const nextItem = items.find((item) => item.id === value);
        nextItem?.onSelect();
      }}
    >
      <TabsPrimitive.List
        aria-label="Database views"
        className="hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto pr-px"
      >
        {items.map((item) => {
          const isActive = item.id === activeItem.id;
          const Icon = item.icon;

          return (
            <TabsPrimitive.Trigger
              key={item.id}
              value={item.id}
              aria-label={item.label}
              title={item.label}
              className={cn(
                "group/view inline-flex h-8 shrink-0 items-center justify-center rounded-full",
                "text-[13px] font-medium leading-none whitespace-nowrap",
                "outline-none focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/45",
                "data-[state=active]:px-3 data-[state=inactive]:w-8",
                activeGroup
                  ? [
                    "data-[state=active]:bg-[color-mix(in_srgb,var(--sidebar-foreground)_12%,transparent)]",
                    "data-[state=active]:text-(--sidebar-foreground)",
                  ]
                  : [
                    "data-[state=active]:bg-[color-mix(in_srgb,var(--sidebar-foreground)_9%,transparent)]",
                    "data-[state=active]:text-(--sidebar-foreground)",
                  ],
                "data-[state=inactive]:text-(--sidebar-foreground-secondary)",
                "data-[state=inactive]:hover:bg-[color-mix(in_srgb,var(--sidebar-foreground)_7%,transparent)]",
                "data-[state=inactive]:hover:text-(--sidebar-foreground)",
              )}
            >
              {Icon ? (
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    isActive
                      ? "text-current"
                      : "text-[color-mix(in_srgb,var(--sidebar-foreground)_72%,transparent)] group-hover/view:text-current",
                  )}
                />
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  "grid min-w-0 overflow-hidden",
                  isActive ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
                )}
              >
                <span className="min-w-0 overflow-hidden">
                  <span className="block pl-1.5 text-left">{item.label}</span>
                </span>
              </span>
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

const SIDEBAR_ACTION_MENU_CONTENT_CLASS = cn(
  "z-50 min-w-54 rounded-xl p-1 no-drag outline-none select-none",
  "bg-[color-mix(in_srgb,var(--background)_92%,transparent)] text-(--foreground)",
  "shadow-[0_18px_48px_rgba(0,0,0,0.2)] ring-[0.5px] ring-[color-mix(in_srgb,var(--foreground)_10%,transparent)] backdrop-blur-xl",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.985]",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.985]",
);

function SidebarSectionActionItem({
  icon: Icon,
  children,
  disabled = false,
  danger = false,
}: {
  icon: ComponentType<{ className?: string }>;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <>
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center",
          danger ? "text-(--red-text)" : "text-(--sidebar-foreground-secondary)",
          disabled && "opacity-40",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className={cn("min-w-0 flex-1 truncate", disabled && "opacity-40")}>{children}</span>
    </>
  );
}

function SidebarSectionMoreActionsMenu({
  group,
  onBeforeItemLimitChange,
}: {
  group: StageSidebarGroup;
  onBeforeItemLimitChange: () => void;
}) {
  if (!group.moreActions) return null;

  const {
    itemLimit,
    canMoveUp,
    canMoveDown,
    onItemLimitChange,
    onMoveUp,
    onMoveDown,
    onHide,
  } = group.moreActions;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`${group.label} actions`}
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none",
            "text-(--sidebar-foreground-tertiary) opacity-0 group-hover/top-header:opacity-100",
            "group-focus-within/top-header:opacity-100 data-[state=open]:opacity-100",
            "hover:bg-[color-mix(in_srgb,var(--sidebar-foreground)_8%,transparent)] hover:text-(--sidebar-foreground)",
            "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          sideOffset={8}
          align="end"
          collisionPadding={8}
          className={SIDEBAR_ACTION_MENU_CONTENT_CLASS}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              className={cn(
                "flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
                "data-highlighted:bg-(--sidebar-accent) data-highlighted:text-(--foreground)",
              )}
            >
              <SidebarSectionActionItem icon={Hash}>
                Show
              </SidebarSectionActionItem>
              <span className="ml-auto shrink-0 text-xs text-(--sidebar-foreground-tertiary) tabular-nums">
                {itemLimit}
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-(--sidebar-foreground-tertiary)" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(SIDEBAR_ACTION_MENU_CONTENT_CLASS, "min-w-40")}
              >
                <DropdownMenuPrimitive.RadioGroup
                  value={String(itemLimit)}
                  onValueChange={(value) => {
                    const nextLimit = Number.parseInt(value, 10);
                    if (!SIDEBAR_SECTION_ITEM_LIMITS.includes(nextLimit as SidebarSectionItemLimit)) return;
                    onBeforeItemLimitChange();
                    onItemLimitChange(nextLimit as SidebarSectionItemLimit);
                  }}
                >
                  {SIDEBAR_SECTION_ITEM_LIMITS.map((limit) => (
                    <DropdownMenuPrimitive.RadioItem
                      key={limit}
                      value={String(limit)}
                      className={cn(
                        "flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none",
                        "data-highlighted:bg-(--sidebar-accent) data-highlighted:text-(--foreground)",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{limit} items</span>
                      {itemLimit === limit ? <Check className="size-4 shrink-0 text-(--foreground)" /> : null}
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>

          <DropdownMenuPrimitive.Item
            onSelect={onMoveUp}
            disabled={!canMoveUp}
            className={cn(
              "mt-0.5 flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
              "data-highlighted:bg-(--sidebar-accent) data-highlighted:text-(--foreground)",
              "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
            )}
          >
            <SidebarSectionActionItem icon={ArrowUp} disabled={!canMoveUp}>
              Move up
            </SidebarSectionActionItem>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Item
            onSelect={onMoveDown}
            disabled={!canMoveDown}
            className={cn(
              "flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
              "data-highlighted:bg-(--sidebar-accent) data-highlighted:text-(--foreground)",
              "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
            )}
          >
            <SidebarSectionActionItem icon={ArrowDown} disabled={!canMoveDown}>
              Move down
            </SidebarSectionActionItem>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Separator className="mx-2 my-1 h-px bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]" />

          <DropdownMenuPrimitive.Item
            onSelect={onHide}
            className={cn(
              "flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
              "data-highlighted:bg-[color-mix(in_srgb,var(--red-text)_12%,transparent)] data-highlighted:text-(--red-text)",
            )}
          >
            <SidebarSectionActionItem icon={EyeOff} danger>
              Hide section
            </SidebarSectionActionItem>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function LeftSidebar({
  projects,
  spaces,
  activeProjectId,
  stageGroups,
  utilityActions,
  collapsed,
  width,
  expandedSections,
  showAllItemsBySection,
  onResizeWidth,
  onSetSectionExpanded,
  onSetSectionShowAll,
  onSelectSpace,
  onOpenSettings,
  projectPickerOpenTick,
  onCreateProject,
  onDeleteProject,
  onRenameProject,
}: LeftSidebarProps) {
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const activeProject = projectById.get(activeProjectId);
  const activeProjectName = activeProject?.name ?? activeProjectId;
  const activeWorkspacePath = activeProject?.workspacePath?.trim() ?? "";
  const activeWorkspacePathLabel = activeWorkspacePath || "Set workspace path";
  const activeWorkspacePathTitle = activeWorkspacePath || "Set workspace path for Codex threads";
  const dbViewGroup = useMemo(
    () => stageGroups.find((group) => group.id === "db") ?? null,
    [stageGroups],
  );
  const visibleStageGroups = useMemo(
    () => stageGroups.filter((group) => group.id !== "db"),
    [stageGroups],
  );
  const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());
  const hasElapsedSidebarItems = useMemo(
    () => visibleStageGroups.some((group) =>
      group.sections.some((section) => section.items.some((item) => isFiniteTimestamp(item.updatedAtMs))),
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

  const handleSetActiveWorkspacePath = async () => {
    if (!activeProject) return;

    try {
      const pickedPath = (await invoke("pty:pick-cwd")) as string | null;
      if (!pickedPath) return;

      const updatedProject = await onRenameProject(
        activeProject.id,
        activeProject.id,
        activeProject.name,
        undefined,
        pickedPath,
      );
      if (!updatedProject) return;
    } catch {
      // Keep the text input path editor available as fallback.
    }
  };

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
      {/* Project header — drag region is an overlay so traffic lights stay clickable */}
      <header className="relative shrink-0 px-[calc(var(--sidebar-shell-padding-x)+var(--sidebar-row-padding-x))] pt-11 pb-2">
        <div
          className="absolute inset-x-0 top-0 h-9"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
        <div className="flex items-baseline gap-2">
          <h2 className="min-w-0 flex-1 truncate font-semibold text-(--sidebar-foreground)">
            {activeProjectName}
          </h2>
          {utilityActions && (
            <div className="flex shrink-0 items-center gap-0.5">{utilityActions}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleSetActiveWorkspacePath()}
          disabled={!activeProject}
          className={cn(
            "group/path mt-0.5 flex min-w-0 items-center gap-1 rounded-sm",
            "disabled:cursor-not-allowed disabled:opacity-70",
          )}
          title={activeWorkspacePathTitle}
          aria-label={activeWorkspacePathTitle}
        >
          <FolderOpen className="size-3 shrink-0 text-(--sidebar-foreground-tertiary) group-hover/path:text-(--sidebar-foreground-secondary)" />
          <span
            className={cn(
              "truncate font-mono text-xs/4",
              activeWorkspacePath
                ? "text-(--sidebar-foreground-secondary)"
                : "text-(--sidebar-foreground-tertiary)",
            )}
          >
            {activeWorkspacePathLabel}
          </span>
        </button>
        {dbViewGroup?.items && dbViewGroup.items.length > 0 ? (
          <div className="mt-2.5 -mx-(--sidebar-row-padding-x)">
            <SidebarDbViewSelector activeGroup={dbViewGroup.active} items={dbViewGroup.items} />
          </div>
        ) : null}
      </header>

      {/* Stage groups */}
      <div className="scrollbar-token min-h-0 flex-1 overflow-y-auto px-(--sidebar-shell-padding-x) py-1">
        {visibleStageGroups.map((group) => {
          const groupExpanded = group.hideHeader ? true : group.expanded;
          const groupItemPaddingClass = group.hideHeader
            ? "px-[var(--sidebar-row-padding-x)]"
            : "pr-[var(--sidebar-row-padding-x)] pl-[calc(var(--sidebar-row-padding-x)+0.875rem+0.375rem)]";
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
            const elapsedLabel = itemUpdatedAtMs === null ? null : formatElapsedSince(itemUpdatedAtMs, elapsedNowMs);
            const elapsedTitle = itemUpdatedAtMs === null
              ? undefined
              : `Updated ${new Date(itemUpdatedAtMs).toLocaleString()}`;
            const itemPaddingClass = group.hideHeader
              ? "px-[var(--sidebar-row-padding-x)]"
              : item.icon
                ? "px-[var(--sidebar-row-padding-x)]"
                : "pr-[var(--sidebar-row-padding-x)] pl-[calc(var(--sidebar-row-padding-x)+0.875rem+0.375rem)]";

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
                <span className={cn("truncate", elapsedLabel && "min-w-0 flex-1")}>{item.label}</span>
                {elapsedLabel && (
                  <span
                    title={elapsedTitle}
                    className="ml-auto shrink-0 text-xs/4 text-(--sidebar-foreground-tertiary) tabular-nums"
                  >
                    {elapsedLabel}
                  </span>
                )}
                {item.closable && item.onClose && (
                  <span
                    role="button"
                    tabIndex={-1}
                    className={cn(
                      "inline-flex h-4 w-4 items-center justify-center text-(--sidebar-foreground-tertiary) opacity-0 group-hover:opacity-100 hover:text-(--sidebar-foreground)",
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
                  <CollapsiblePrimitive.Root
                    open={sectionExpanded}
                    onOpenChange={(open) => {
                      onSetSectionExpanded(section.id, open);
                    }}
                  >
                    <CollapsiblePrimitive.Trigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "group/status inline-flex min-h-7.5 w-full items-center gap-1.5 rounded-lg px-(--sidebar-row-padding-x) py-(--sidebar-row-padding-tight-y) text-left hover:bg-(--sidebar-accent)",
                          sectionExpanded
                            ? "text-(--sidebar-foreground)"
                            : "text-(--sidebar-foreground-secondary) hover:text-(--sidebar-foreground)",
                        )}
                      >
                        <span className="relative size-3.5 shrink-0">
                          {section.accentColor ? (
                            <span
                              aria-hidden
                              className={cn(
                                "absolute inset-0 m-auto size-1.5 rounded-full transition-opacity duration-150",
                                "opacity-100 group-hover/status:opacity-0 group-focus-visible:opacity-0",
                              )}
                              style={{ backgroundColor: section.accentColor }}
                            />
                          ) : null}
                          <ChevronDown
                            className={cn(
                              "absolute inset-0 m-auto size-3 transition-all duration-150",
                              "opacity-0 group-hover/status:opacity-100 group-focus-visible:opacity-100",
                              !sectionExpanded && "-rotate-90",
                            )}
                          />
                        </span>
                        <span className="mr-auto inline-flex min-w-0 items-baseline gap-2.5">
                          <span className="truncate">{section.label}</span>
                          {typeof section.count === "number" ? (
                            <span className="shrink-0 text-[calc(var(--text-sm)-1px)]/5 text-(--sidebar-foreground-tertiary)">
                              {section.count}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </CollapsiblePrimitive.Trigger>
                    <CollapsiblePrimitive.Content
                      className={cn(
                        "overflow-hidden",
                        "data-[state=closed]:hidden",
                      )}
                    >
                      <div className="mt-px flex flex-col gap-px">
                        {visibleItems.map((item) => (
                          <div key={item.id}>{renderStageItem(item)}</div>
                        ))}
                        {hasOverflow && (
                          <CollapsiblePrimitive.Root
                            open={showAllItems}
                            onOpenChange={(open) => {
                              onSetSectionShowAll(section.id, open);
                            }}
                          >
                            <CollapsiblePrimitive.Content
                              className={cn(
                                "overflow-hidden",
                                "data-[state=closed]:hidden",
                              )}
                            >
                              <div className="flex flex-col gap-px">
                                {overflowItems.map((item) => (
                                  <div key={item.id}>{renderStageItem(item)}</div>
                                ))}
                              </div>
                            </CollapsiblePrimitive.Content>
                            <CollapsiblePrimitive.Trigger asChild>
                              <button
                                tabIndex={groupExpanded ? 0 : -1}
                                className={cn(
                                  "group inline-flex min-h-7.5 w-full items-center py-(--sidebar-row-padding-y) text-left",
                                  groupItemPaddingClass,
                                )}
                              >
                                <span className="-mx-(--sidebar-row-padding-x) rounded-full px-(--sidebar-row-padding-x) py-0.5 text-sm text-(--sidebar-foreground-tertiary) group-hover:bg-(--sidebar-accent) group-hover:text-(--sidebar-foreground-secondary)">
                                  {showAllItems ? "Show less" : "Show more"}
                                </span>
                              </button>
                            </CollapsiblePrimitive.Trigger>
                          </CollapsiblePrimitive.Root>
                        )}
                      </div>
                    </CollapsiblePrimitive.Content>
                    {pinnedItems.length > 0 ? (
                      <div className="mt-px flex flex-col gap-px">
                        {pinnedItems.map((item) => (
                          <div key={item.id}>{renderStageItem(item)}</div>
                        ))}
                      </div>
                    ) : null}
                  </CollapsiblePrimitive.Root>
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
                      <CollapsiblePrimitive.Root
                        open={showAllItems}
                        onOpenChange={(open) => {
                          onSetSectionShowAll(section.id, open);
                        }}
                      >
                        <CollapsiblePrimitive.Content
                          className={cn(
                            "overflow-hidden",
                            "data-[state=closed]:hidden",
                          )}
                        >
                          <div className="flex flex-col gap-px">
                            {overflowItems.map((item) => (
                              <div key={item.id}>{renderStageItem(item)}</div>
                            ))}
                          </div>
                        </CollapsiblePrimitive.Content>
                        <CollapsiblePrimitive.Trigger asChild>
                          <button
                            tabIndex={groupExpanded ? 0 : -1}
                            className={cn(
                              "group inline-flex min-h-7.5 w-full items-center py-(--sidebar-row-padding-y) text-left",
                              groupItemPaddingClass,
                            )}
                          >
                            <span className="-mx-(--sidebar-row-padding-x) rounded-full px-(--sidebar-row-padding-x) py-0.5 text-sm text-(--sidebar-foreground-tertiary) group-hover:bg-(--sidebar-accent) group-hover:text-(--sidebar-foreground-secondary)">
                              {showAllItems ? "Show less" : "Show more"}
                            </span>
                          </button>
                        </CollapsiblePrimitive.Trigger>
                      </CollapsiblePrimitive.Root>
                    )}
                  </>
                )}
              </div>
            );
          };

          return (
            <section key={group.id} className={group.expanded ? "mb-2 last:mb-0" : "mb-1 last:mb-0"}>
              {!group.hideHeader && (
                <div
                  className={cn(
                    "group/top-header flex min-h-7.5 items-center gap-1 rounded-lg px-(--sidebar-row-padding-x) py-(--sidebar-row-padding-tight-y)",
                    "text-(--sidebar-foreground-secondary) opacity-75 hover:bg-sidebar-accent hover:text-(--sidebar-foreground)",
                  )}
                >
                  <button
                    type="button"
                    onClick={group.onToggleExpanded}
                    aria-expanded={group.expanded}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="truncate">{group.label}</span>
                      <ChevronDown
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

              <CollapsiblePrimitive.Root open={groupExpanded}>
                <CollapsiblePrimitive.Content
                  className={cn(
                    group.hideHeader ? "overflow-hidden" : "mt-px overflow-hidden",
                    "data-[state=closed]:hidden",
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
                </CollapsiblePrimitive.Content>
              </CollapsiblePrimitive.Root>
            </section>
          );
        })}
      </div>

      <LeftSidebarProjectManager
        projects={projects}
        spaces={spaces}
        activeProjectId={activeProjectId}
        onSelectSpace={onSelectSpace}
        onOpenSettings={onOpenSettings}
        projectPickerOpenTick={projectPickerOpenTick}
        onCreateProject={onCreateProject}
        onDeleteProject={onDeleteProject}
        onRenameProject={onRenameProject}
      />

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
