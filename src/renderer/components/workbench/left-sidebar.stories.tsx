import type { Meta, StoryObj } from "@storybook/react-vite";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CodexAccountSnapshot,
  CodexSidebarThreadItem,
  Project,
  ProjectSession,
} from "@/lib/types";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { AutomationsIcon, ComposerPluginsIcon } from "@/components/shared/icons";
import {
  codexSidebarProjectThreadContainerId,
  isCodexSidebarThreadContainerId,
  readCodexSidebarThreadContainerLocation,
} from "../../../shared/codex-sidebar-thread-move";
import { LeftSidebar, type StageSidebarGroup } from "./left-sidebar";
import { LeftSidebarFooter } from "./left-sidebar-footer";
import { SidebarProjectsSection } from "./left-sidebar-projects-section";
import {
  SIDEBAR_SCROLL_AREA_CLASS,
  SidebarExpandedHeader,
  SidebarProjectNewChatButton,
  useSidebarScrollChrome,
} from "./sidebar-new-chat-controls";
import {
  CodexProjectRow,
  CodexProjectSessionList,
  CodexSidebarThreadRow,
  CodexSidebarSection,
  CodexSidebarTopActionButton,
  CodexThreadRow,
  resolveCodexPageSearchShortcutLabel,
} from "./codex-sidebar";
import {
  replaceVisibleOrder,
  SidebarProjectSortableContext,
  useSidebarGroupReorderController,
  type SidebarGroupDndController,
} from "./sidebar-project-group-dnd";
import { SidebarDropIndicator } from "./sidebar-drop-indicator";
import { SidebarReorderDndProvider } from "./sidebar-reorder-dnd";
import {
  SidebarThreadDropContainer,
  SidebarThreadDropIndicator,
  SidebarThreadReorderRows,
  SidebarThreadSortableContext,
  SidebarThreadSortableItem,
  useSidebarPinnedDropContainer,
  useSidebarThreadReorderController,
  type SidebarThreadDropRequest,
} from "./sidebar-thread-reorder";
import {
  isCodexSidebarThreadItemVisible,
  replaceVisibleCodexSidebarThreadKeyOrder,
} from "@/lib/codex-sidebar-thread-sync";
import {
  CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS,
  CODEX_SIDEBAR_PAGER_BUTTON_CLASS,
  CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS,
  CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
  paginateCodexSidebarItems,
} from "@/lib/codex-sidebar-pagination";

const PROJECTS: Project[] = [
  {
    id: "default",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Nodex",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/nodex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-03-01T00:00:00.000Z"),
    updated: new Date("2026-03-01T00:00:00.000Z"),
  },
  {
    id: "bundle",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Codex bundle",
    description: "",
    appearance: { color: "green", marker: { kind: "icon", icon: "book" } },
    sources: [{ root: "/Users/asc/repo/devtools-codex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-03-02T00:00:00.000Z"),
    updated: new Date("2026-03-02T00:00:00.000Z"),
  },
];

const PROJECT_ORDER = ["default", "bundle"];

const SIDEBAR_PARITY_PROJECTS: Project[] = [
  {
    id: "nodex",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Nodex",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/nodex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-06-01T00:00:00.000Z"),
    updated: new Date("2026-06-01T00:00:00.000Z"),
  },
  {
    id: "codex-electron-readable-bundle-with-a-very-long-name",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Codex Electron readable bundle with a very long project label",
    description: "",
    appearance: { color: "purple", marker: { kind: "icon", icon: "book" } },
    sources: [
      {
        root: "/Users/asc/repo/devtools-codex/codex_electron_26.519.81530_to_be_readable",
        order: 0,
      },
    ],
    primaryWorkspaceRoot:
      "/Users/asc/repo/devtools-codex/codex_electron_26.519.81530_to_be_readable",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-06-02T00:00:00.000Z"),
    updated: new Date("2026-06-02T00:00:00.000Z"),
  },
  {
    id: "missing-workspace",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Missing workspace path",
    description: "",
    appearance: { color: "orange", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-06-03T00:00:00.000Z"),
    updated: new Date("2026-06-03T00:00:00.000Z"),
  },
];

const STORY_TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;

const SIDEBAR_PARITY_PROJECT_ORDER = [
  "nodex",
  "codex-electron-readable-bundle-with-a-very-long-name",
  "missing-workspace",
];

const FOOTER_QUOTA_ACCOUNT: CodexAccountSnapshot = {
  account: { type: "chatgpt", email: "dev@example.com", planType: "Plus" },
  requiresOpenAiAuth: false,
  pendingLogin: null,
  rateLimits: {
    primary: {
      usedPercent: 18,
      windowDurationMins: 300,
    },
    secondary: {
      usedPercent: 39,
      windowDurationMins: 7 * 24 * 60,
    },
  },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      {
        id: "reset-credit-story-1",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1_784_246_400,
        expiresAt: 1_810_166_400,
        title: "Quota reset",
        description: "Reset an eligible Codex quota window.",
      },
    ],
  },
};

const FOOTER_LOW_QUOTA_ACCOUNT: CodexAccountSnapshot = {
  account: { type: "chatgpt", email: "dev@example.com", planType: "Plus" },
  requiresOpenAiAuth: false,
  pendingLogin: null,
  rateLimits: {
    primary: {
      usedPercent: 91,
      windowDurationMins: 300,
    },
    secondary: {
      usedPercent: 72,
      windowDurationMins: 7 * 24 * 60,
    },
  },
};

const FOOTER_NO_LIMITS_ACCOUNT: CodexAccountSnapshot = {
  account: { type: "chatgpt", email: "dev@example.com", planType: "Plus" },
  requiresOpenAiAuth: false,
  pendingLogin: null,
  rateLimits: null,
};

const FOOTER_SIGNED_OUT_ACCOUNT: CodexAccountSnapshot = {
  account: null,
  requiresOpenAiAuth: true,
  pendingLogin: null,
  rateLimits: null,
};

function SidebarSectionMenuHarness() {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [showAllItemsBySection, setShowAllItemsBySection] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>("[aria-label='Threads actions']");
      trigger?.click();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const groups: StageSidebarGroup[] = [
    {
      id: "threads",
      label: "Threads",
      active: true,
      expanded: true,
      onFocus: () => {},
      onToggleExpanded: () => {},
      moreActions: {
        itemLimit: 10,
        canMoveUp: false,
        canMoveDown: true,
        onItemLimitChange: () => {},
        onMoveUp: () => {},
        onMoveDown: () => {},
        onHide: () => {},
      },
      sections: [
        {
          id: "recent-threads",
          label: "Recent",
          items: [
            { id: "1", label: "Settings parity", onSelect: () => {}, active: true },
            { id: "2", label: "Storybook regressions", onSelect: () => {} },
          ],
        },
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-(--background)">
      <LeftSidebar
        projects={PROJECTS}
        projectOrder={PROJECT_ORDER}
        activeProjectId="default"
        stageGroups={groups}
        collapsed={false}
        width={280}
        expandedSections={expandedSections}
        showAllItemsBySection={showAllItemsBySection}
        onResizeWidth={() => {}}
        onSetSectionExpanded={(sectionId, expanded) => {
          setExpandedSections((current) => ({ ...current, [sectionId]: expanded }));
        }}
        onSetSectionShowAll={(sectionId, showAll) => {
          setShowAllItemsBySection((current) => ({ ...current, [sectionId]: showAll }));
        }}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        projectPickerOpenTick={0}
        onCreateProject={async () => PROJECTS[0]}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onUpdateProject={async () => PROJECTS[0]}
      />
    </div>
  );
}

function StatusGroupOrderHarness() {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    "pages:status:done": true,
    "pages:status:in_review": true,
    "pages:status:in_progress": true,
  });
  const [showAllItemsBySection, setShowAllItemsBySection] = useState<Record<string, boolean>>({});

  const groups: StageSidebarGroup[] = [
    {
      id: "pages",
      label: "Pages",
      active: true,
      expanded: true,
      onFocus: () => {},
      onToggleExpanded: () => {},
      sections: [
        {
          id: "pages:status:done",
          label: "Done",
          count: 2,
          collapsible: true,
          items: [
            { id: "done-1", label: "Release notarized build", onSelect: () => {}, active: true },
            { id: "done-2", label: "Archive completed sync job", onSelect: () => {} },
          ],
        },
        {
          id: "pages:status:in_review",
          label: "In Review",
          count: 1,
          collapsible: true,
          items: [{ id: "review-1", label: "Check thread transcript parity", onSelect: () => {} }],
        },
        {
          id: "pages:status:in_progress",
          label: "In Progress",
          count: 2,
          collapsible: true,
          items: [
            { id: "progress-1", label: "Tune sidebar density", onSelect: () => {} },
            { id: "progress-2", label: "Wire card search filters", onSelect: () => {} },
          ],
        },
        {
          id: "pages:status:backlog",
          label: "Backlog",
          count: 1,
          collapsible: true,
          items: [{ id: "backlog-1", label: "Investigate branch selector", onSelect: () => {} }],
        },
        {
          id: "pages:status:draft",
          label: "Draft",
          count: 1,
          collapsible: true,
          items: [{ id: "draft-1", label: "Sketch dependency audit", onSelect: () => {} }],
        },
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-(--background)">
      <LeftSidebar
        projects={PROJECTS}
        projectOrder={PROJECT_ORDER}
        activeProjectId="default"
        stageGroups={groups}
        collapsed={false}
        width={280}
        expandedSections={expandedSections}
        showAllItemsBySection={showAllItemsBySection}
        onResizeWidth={() => {}}
        onSetSectionExpanded={(sectionId, expanded) => {
          setExpandedSections((current) => ({ ...current, [sectionId]: expanded }));
        }}
        onSetSectionShowAll={(sectionId, showAll) => {
          setShowAllItemsBySection((current) => ({ ...current, [sectionId]: showAll }));
        }}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        projectPickerOpenTick={0}
        onCreateProject={async () => PROJECTS[0]}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onUpdateProject={async () => PROJECTS[0]}
      />
    </div>
  );
}

function SidebarNewChatControlsHarness() {
  const sidebarScrollChrome = useSidebarScrollChrome();

  return (
    <NodexTooltipProvider>
      <div className="min-h-screen bg-(--background) p-8">
        <div
          className="flex h-[260px] w-[280px] flex-col bg-(--background-secondary) py-1 [--height-token-nav-row:30px] [--padding-row-cell-x:8px] [--padding-row-x:8px] [--radius-token-row:10px]"
          style={sidebarScrollChrome.scrollChromeStyle}
        >
          <SidebarExpandedHeader
            productName="Nodex"
            productStatusLabel="Beta"
            searchShortcutLabel={resolveCodexPageSearchShortcutLabel()}
            newChatShortcutLabel="⌘N"
            scrolledContentUnderHeader={sidebarScrollChrome.scrolledContentUnderHeader}
            onSearch={() => {}}
            onNewChat={() => {}}
          />
          <div
            ref={sidebarScrollChrome.scrollAreaRef}
            data-app-action-sidebar-scroll=""
            data-content-below={sidebarScrollChrome.hasContentBelow ? "true" : "false"}
            className={SIDEBAR_SCROLL_AREA_CLASS}
            onScroll={sidebarScrollChrome.syncScrollChrome}
          >
            <div
              className="flex shrink-0 flex-col gap-2"
              data-app-action-sidebar-scroll-top-actions=""
            >
              <div className="shrink-0 px-row-x">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-col gap-px">
                    <CodexSidebarTopActionButton
                      label="Scheduled"
                      icon={<AutomationsIcon />}
                      active
                      onClick={() => {}}
                    />
                    <CodexSidebarTopActionButton
                      label="Plugins"
                      icon={<ComposerPluginsIcon className="icon-xs" />}
                      onClick={() => {}}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="px-(--sidebar-shell-padding-x)">
              <div className="group/folder-row flex min-h-7.5 items-center gap-1.5 rounded-xl pl-(--sidebar-row-padding-x) pr-(--sidebar-header-padding-x) py-1 text-(--sidebar-foreground) hover:bg-(--sidebar-accent)">
                <span className="min-w-0 flex-1 truncate text-sm">Codex bundle</span>
                <SidebarProjectNewChatButton
                  label="Start new chat in Codex bundle"
                  className="opacity-100"
                  onClick={() => {}}
                />
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-px px-row-x">
              {Array.from({ length: 8 }, (_, index) => (
                <div
                  key={index}
                  className="flex h-token-nav-row items-center truncate rounded-lg px-row-x text-base text-token-foreground"
                >
                  Sidebar parity thread {index + 1}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

function CodexProjectsHarness({
  expanded = true,
  activeProjectId = "nodex",
  openActionsFor,
  openEditFor,
  openSectionOptions = false,
  projects = SIDEBAR_PARITY_PROJECTS,
  revealProjectDisclosureChevrons = false,
}: {
  expanded?: boolean;
  activeProjectId?: string;
  openActionsFor?: string;
  openEditFor?: string;
  openSectionOptions?: boolean;
  projects?: Project[];
  revealProjectDisclosureChevrons?: boolean;
}) {
  useEffect(() => {
    const projectName = openEditFor ?? openActionsFor;
    if (!projectName) return;
    let editFrameId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>(
        `[aria-label='Project actions for ${projectName}']`,
      );
      if (!trigger) return;
      const event =
        typeof PointerEvent === "function"
          ? new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
          : new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false });
      trigger.dispatchEvent(event);
      if (!openEditFor) return;
      editFrameId = window.requestAnimationFrame(() => {
        const editItem = Array.from(
          document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ).find((item) => item.textContent?.trim() === "Edit project");
        editItem?.click();
      });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (editFrameId !== null) window.cancelAnimationFrame(editFrameId);
    };
  }, [openActionsFor, openEditFor]);

  useEffect(() => {
    if (!openSectionOptions) return;
    const frameId = window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>("[aria-label='Project sidebar options']");
      if (!trigger) return;
      const event =
        typeof PointerEvent === "function"
          ? new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
          : new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false });
      trigger.dispatchEvent(event);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [openSectionOptions]);

  return (
    <NodexTooltipProvider>
      <div
        data-codex-window-type="electron"
        data-story-project-chevron-reveal={revealProjectDisclosureChevrons ? "" : undefined}
        className="min-h-screen bg-token-bg-primary p-8"
      >
        {revealProjectDisclosureChevrons ? (
          <style>
            {
              "[data-story-project-chevron-reveal] [data-app-action-sidebar-project-marker] { visibility: hidden; } [data-story-project-chevron-reveal] [data-app-action-sidebar-project-toggle-chevron] { opacity: 1; pointer-events: auto; }"
            }
          </style>
        ) : null}
        <div className="app-shell-left-panel w-[300px] overflow-visible py-4">
          <SidebarProjectsSection
            projects={projects}
            projectOrder={SIDEBAR_PARITY_PROJECT_ORDER}
            activeProjectId={activeProjectId}
            expanded={expanded}
            onToggleExpanded={() => {}}
            onSelectProject={() => {}}
            onCreateProject={async () => projects[0] ?? null}
            onArchiveProject={async () => ({ kind: "not-found" })}
            onUpdateProject={async () =>
              projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null
            }
            projectPickerOpenTick={0}
          />
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

function sortPinnedStoryProjects(projects: Project[]) {
  return [...projects]
    .filter((project) => project.pinned)
    .sort(
      (a, b) =>
        (a.pinnedOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinnedOrder ?? Number.MAX_SAFE_INTEGER),
    );
}

function CodexSortableProjectSections({
  projects,
  onProjectsChange,
  forceDropIndicator = false,
  forceEmptyPinnedDropTarget = false,
}: {
  projects: Project[];
  onProjectsChange: (projects: Project[]) => void;
  forceDropIndicator?: boolean;
  forceEmptyPinnedDropTarget?: boolean;
}) {
  const projectOrderIds = useMemo(() => projects.map((project) => project.id), [projects]);
  const pinnedProjects = useMemo(() => sortPinnedStoryProjects(projects), [projects]);
  const unpinnedProjects = useMemo(() => projects.filter((project) => !project.pinned), [projects]);
  const pinnedProjectIds = useMemo(
    () => pinnedProjects.map((project) => project.id),
    [pinnedProjects],
  );
  const unpinnedProjectIds = useMemo(
    () => unpinnedProjects.map((project) => project.id),
    [unpinnedProjects],
  );
  const pinnedDroppable = useSidebarPinnedDropContainer();

  const reorderUnpinned = useCallback(
    (nextIds: string[]) => {
      const nextOrderIds = replaceVisibleOrder(projectOrderIds, unpinnedProjectIds, nextIds);
      const byId = new Map(projects.map((project) => [project.id, project]));
      onProjectsChange(
        nextOrderIds
          .map((id) => byId.get(id))
          .filter((project): project is Project => Boolean(project)),
      );
    },
    [onProjectsChange, projectOrderIds, projects, unpinnedProjectIds],
  );

  const reorderPinned = useCallback(
    (nextIds: string[]) => {
      const pinnedOrderById = new Map(nextIds.map((id, index) => [id, index]));
      onProjectsChange(
        projects.map((project) => ({
          ...project,
          pinnedOrder: pinnedOrderById.get(project.id) ?? project.pinnedOrder,
        })),
      );
    },
    [onProjectsChange, projects],
  );

  const pinnedReorder = useSidebarGroupReorderController({
    groupIds: pinnedProjectIds,
    reorderGroups: reorderPinned,
  });
  const unpinnedReorder = useSidebarGroupReorderController({
    groupIds: unpinnedProjectIds,
    reorderGroups: reorderUnpinned,
  });
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const orderedPinnedProjects = pinnedReorder.groupIds
    .map((projectId) => projectById.get(projectId))
    .filter((project): project is Project => Boolean(project));
  const orderedUnpinnedProjects = unpinnedReorder.groupIds
    .map((projectId) => projectById.get(projectId))
    .filter((project): project is Project => Boolean(project));

  const renderProjectRow = (project: Project, controller: SidebarGroupDndController) => (
    <CodexProjectRow
      key={project.id}
      project={project}
      active={project.id === "nodex"}
      expanded={project.id === "nodex"}
      dnd={{ controller }}
      onActivate={() => {}}
      onSelectProject={() => {}}
      onUpdateProject={async () => project}
      onArchiveProject={async () => ({ kind: "not-found" })}
      onSetProjectPinned={async (_projectId, input) => {
        onProjectsChange(
          projects.map((candidate) =>
            candidate.id === project.id
              ? {
                  ...candidate,
                  pinned: input.pinned,
                  pinnedOrder: input.pinned ? pinnedProjects.length : null,
                }
              : candidate,
          ),
        );
        return project;
      }}
    />
  );

  return (
    <>
      {pinnedProjects.length > 0 ? (
        <div ref={pinnedDroppable.setNodeRef} className="relative">
          <CodexSidebarSection heading="Pinned" collapsed={false} onToggle={() => {}}>
            <div className="isolate flex flex-col [contain:layout]">
              <SidebarProjectSortableContext groupIds={pinnedReorder.groupIds}>
                <div className="flex flex-col" role="list" aria-label="Pinned">
                  {orderedPinnedProjects.map((project, index) => (
                    <Fragment key={project.id}>
                      {forceDropIndicator && index === 1 ? <SidebarDropIndicator /> : null}
                      {renderProjectRow(project, pinnedReorder.controller)}
                    </Fragment>
                  ))}
                </div>
              </SidebarProjectSortableContext>
            </div>
          </CodexSidebarSection>
        </div>
      ) : forceEmptyPinnedDropTarget ? (
        <div ref={pinnedDroppable.setNodeRef} className="absolute inset-x-0 top-0 px-row-x">
          <SidebarDropIndicator />
          <div className="h-4" />
        </div>
      ) : null}

      <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
        <div className="isolate flex flex-col [contain:layout]">
          <SidebarProjectSortableContext groupIds={unpinnedReorder.groupIds}>
            <div className="flex flex-col" role="list" aria-label="Projects">
              {orderedUnpinnedProjects.map((project, index) => (
                <Fragment key={project.id}>
                  {forceDropIndicator && pinnedProjects.length === 0 && index === 1 ? (
                    <SidebarDropIndicator />
                  ) : null}
                  {renderProjectRow(project, unpinnedReorder.controller)}
                </Fragment>
              ))}
            </div>
          </SidebarProjectSortableContext>
        </div>
      </CodexSidebarSection>
    </>
  );
}

function CodexSortableProjectsHarness({
  pinned = false,
  emptyPinnedDropTarget = false,
  dropIndicator = false,
}: {
  pinned?: boolean;
  emptyPinnedDropTarget?: boolean;
  dropIndicator?: boolean;
}) {
  const [projects, setProjects] = useState(() =>
    SIDEBAR_PARITY_PROJECTS.map((project, index) => ({
      ...project,
      pinned: pinned && index < 1,
      pinnedOrder: pinned && index < 1 ? index : null,
    })),
  );

  return (
    <NodexTooltipProvider>
      <div data-codex-window-type="electron" className="min-h-screen bg-token-bg-primary p-8">
        <div className="app-shell-left-panel relative w-[300px] overflow-visible py-4">
          <SidebarReorderDndProvider
            onProjectDrop={(drop) => {
              setProjects((current) =>
                current.map((project) =>
                  project.id === drop.projectId
                    ? {
                        ...project,
                        pinned: true,
                        pinnedOrder: sortPinnedStoryProjects(current).length,
                      }
                    : project,
                ),
              );
            }}
          >
            <CodexSortableProjectSections
              projects={
                emptyPinnedDropTarget
                  ? projects.map((project) => ({ ...project, pinned: false, pinnedOrder: null }))
                  : projects
              }
              onProjectsChange={setProjects}
              forceDropIndicator={dropIndicator}
              forceEmptyPinnedDropTarget={emptyPinnedDropTarget}
            />
          </SidebarReorderDndProvider>
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

function makeStorySession(input: {
  id: string;
  title: string;
  pinned?: boolean;
  pinnedOrder?: number | null;
  unread?: boolean;
  threadId?: string;
  rightFullWidth?: boolean;
}): ProjectSession {
  return {
    id: input.id,
    projectId: "nodex",
    noThreadFallbackTitle: input.title,
    displayTitle: input.title,
    order: 0,
    pinned: input.pinned ?? false,
    pinnedOrder: input.pinnedOrder ?? null,
    archived: false,
    archivedAt: null,
    unread: input.unread ?? false,
    thread: input.threadId
      ? {
          sessionId: input.id,
          projectId: "nodex",
          threadId: input.threadId,
          parentThreadId: undefined,
          threadName: input.title,
          threadPreview: "",
          modelProvider: "openai",
          executionHostId: "local",
          cwd: "/Users/asc/repo/nodex",
          statusType: "notLoaded",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1_780_800_000_000,
          updatedAt: 1_780_800_000_000,
          recencyAt: 1_780_800_000_000,
          linkedAt: "2026-06-07T00:00:00.000Z",
        }
      : null,
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };
}

function CodexProjectSessionRowsHarness() {
  const project = SIDEBAR_PARITY_PROJECTS[0]!;
  const sessions = [
    makeStorySession({
      id: "session:nodex:database-view",
      title: "Database View",
      pinned: true,
      pinnedOrder: 0,
      rightFullWidth: true,
    }),
    makeStorySession({
      id: "thread:nodex:pinned",
      title: "Pinned architecture notes",
      pinned: true,
      pinnedOrder: 1,
      threadId: "local:pinned",
    }),
    makeStorySession({
      id: "thread:nodex:parity",
      title: "Mirror Codex Electron layout",
      unread: true,
      threadId: "local:sidebar-parity",
    }),
    makeStorySession({
      id: "thread:nodex:unread-idle",
      title: "Unread accent idle",
      unread: true,
      threadId: "local:unread-idle",
    }),
    makeStorySession({
      id: "thread:nodex:long",
      title: "Very long session title that should truncate before colliding with row actions",
      threadId: "local:long-title",
    }),
  ];

  return (
    <NodexTooltipProvider>
      <div data-codex-window-type="electron" className="min-h-screen bg-token-bg-primary p-8">
        <div className="app-shell-left-panel w-[300px] overflow-visible py-4">
          <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
            <div className="isolate flex flex-col [contain:layout]">
              <div className="flex flex-col" role="list" aria-label="Projects">
                <CodexProjectRow
                  project={project}
                  active
                  expanded
                  onActivate={() => {}}
                  onStartNewChat={() => {}}
                  onUpdateProject={async () => project}
                  onArchiveProject={async () => ({ kind: "not-found" })}
                >
                  <CodexProjectSessionList project={project}>
                    {sessions.map((session, index) => (
                      <CodexThreadRow
                        key={session.id}
                        session={session}
                        active={index === 2}
                        contextMenuOpen={index === 3}
                        onSelect={() => {}}
                        onOpenContextMenu={() => {}}
                        onTogglePinned={() => {}}
                      />
                    ))}
                  </CodexProjectSessionList>
                </CodexProjectRow>
              </div>
            </div>
          </CodexSidebarSection>
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

function makeSidebarThreadItem(input: {
  key: string;
  threadId: string;
  parentThreadId?: string | null;
  title: string;
  projectId?: string | null;
  sessionId?: string | null;
  kind?: CodexSidebarThreadItem["kind"];
  runLocation?: CodexSidebarThreadItem["runLocation"];
  hostId?: string;
  pinned?: boolean;
  pinnedOrder?: number | null;
  unread?: boolean;
  archived?: boolean;
  projectless?: boolean;
  disabled?: boolean;
  cwd?: string | null;
  updatedAt?: number;
  recencyAt?: number | null;
  statusType?: CodexSidebarThreadItem["statusType"];
}): CodexSidebarThreadItem {
  const kind = input.kind ?? "local";
  const hostId = input.hostId ?? "local";
  return {
    key: input.key,
    kind,
    runLocation:
      input.runLocation ??
      (kind === "pending-worktree"
        ? hostId === "local"
          ? { kind: "local-worktree", path: null, phase: "pending" }
          : { kind: "remote-worktree", hostId, path: null, phase: "pending" }
        : kind === "remote"
          ? { kind: "remote-checkout", hostId }
          : { kind: "local-checkout" }),
    hostId,
    threadId: input.threadId,
    parentThreadId: input.parentThreadId ?? null,
    sessionId: input.sessionId ?? input.threadId,
    projectId: input.projectId ?? null,
    title: input.title,
    preview: "",
    cwd: input.cwd ?? null,
    updatedAt: input.updatedAt ?? 1_780_800_000_000,
    recencyAt:
      input.recencyAt === undefined
        ? kind === "pending-worktree"
          ? null
          : (input.updatedAt ?? 1_780_800_000_000)
        : input.recencyAt,
    createdAt: 1_780_700_000_000,
    pinned: input.pinned ?? false,
    pinnedOrder: input.pinnedOrder ?? null,
    unread: input.unread ?? false,
    archived: input.archived ?? false,
    statusType: input.statusType ?? "notLoaded",
    statusActiveFlags: [],
    projectless: input.projectless ?? input.projectId == null,
    disabled: input.disabled ?? false,
  };
}

function SidebarProjectsChrome({ children }: { children: ReactNode }) {
  return (
    <NodexTooltipProvider>
      <div data-codex-window-type="electron" className="min-h-screen bg-token-bg-primary p-8">
        <div className="app-shell-left-panel w-[300px] overflow-visible py-4">{children}</div>
      </div>
    </NodexTooltipProvider>
  );
}

function ThreadRowsList({
  label,
  items,
  activeKey,
  openKey,
}: {
  label: string;
  items: CodexSidebarThreadItem[];
  activeKey?: string;
  openKey?: string;
}) {
  return (
    <div className="isolate flex flex-col [contain:layout]">
      <div className="flex flex-col" role="list" aria-label={label}>
        {items.map((item) => (
          <CodexSidebarThreadRow
            key={item.key}
            item={item}
            active={item.key === activeKey}
            contextMenuOpen={item.key === openKey}
            onSelect={() => {}}
            onArchive={() => {}}
            onOpenContextMenu={() => {}}
            onTogglePinned={() => {}}
          />
        ))}
      </div>
    </div>
  );
}

function CodexPinnedThreadsSortableHarness() {
  const items = useMemo(() => {
    const first = makeSidebarThreadItem({
      key: "local:thread-a",
      threadId: "thread-a",
      title: "Pinned conversation A",
      pinned: true,
      pinnedOrder: 0,
    });
    const pending: CodexSidebarThreadItem = {
      ...makeSidebarThreadItem({
        key: "local:client-new-thread:pending",
        threadId: "client-new-thread:pending",
        title: "Pending delegated conversation",
        kind: "pending-worktree",
        pinned: true,
      }),
      pendingWorktreeId: "pending-worktree:story",
      clientThreadId: "client-new-thread:pending",
      pinnedBeforeThreadId: "thread-b",
      sessionId: null,
    };
    const second = makeSidebarThreadItem({
      key: "local:thread-b",
      threadId: "thread-b",
      title: "Pinned conversation B",
      pinned: true,
      pinnedOrder: 1,
    });
    return [first, pending, second];
  }, []);
  const itemsByKey = useMemo(
    () => new Map(items.map((item) => [item.key, item] as const)),
    [items],
  );
  const [visibleThreadKeys, setVisibleThreadKeys] = useState(() => items.map((item) => item.key));
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys,
    onVisibleThreadOrderChange: async ({ nextVisibleThreadKeys }) => {
      setVisibleThreadKeys(nextVisibleThreadKeys);
    },
  });

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Pinned" collapsed={false} onToggle={() => {}}>
        <SidebarReorderDndProvider>
          <SidebarThreadSortableContext threadKeys={reorder.displayedVisibleThreadKeys}>
            <div className="isolate flex flex-col [contain:layout]">
              <div className="flex flex-col" role="list" aria-label="Pinned chats">
                {reorder.displayedVisibleThreadKeys.map((threadKey) => {
                  const item = itemsByKey.get(threadKey);
                  if (!item) return null;
                  return (
                    <Fragment key={threadKey}>
                      {reorder.dropIndicatorTarget?.beforeThreadKey === threadKey ? (
                        <SidebarThreadDropIndicator />
                      ) : null}
                      <SidebarThreadSortableItem
                        threadKey={threadKey}
                        controller={reorder.controller}
                      >
                        <CodexSidebarThreadRow
                          item={item}
                          active={false}
                          onSelect={() => {}}
                          onArchive={() => {}}
                          onTogglePinned={() => {}}
                        />
                      </SidebarThreadSortableItem>
                    </Fragment>
                  );
                })}
                {reorder.dropIndicatorTarget?.beforeThreadKey === null ? (
                  <SidebarThreadDropIndicator />
                ) : null}
              </div>
            </div>
          </SidebarThreadSortableContext>
        </SidebarReorderDndProvider>
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexPinnedProjectThreadsSortableHarness() {
  const project = useMemo(
    () => ({
      ...SIDEBAR_PARITY_PROJECTS[0]!,
      pinned: true,
      pinnedOrder: 0,
    }),
    [],
  );
  const items = useMemo(() => {
    const first = makeSidebarThreadItem({
      key: "local:project-thread-a",
      threadId: "project-thread-a",
      sessionId: "project-session-a",
      projectId: project.id,
      title: "Project-local conversation A",
    });
    const pending: CodexSidebarThreadItem = {
      ...makeSidebarThreadItem({
        key: "local:project-pending",
        threadId: "client-new-thread:project-pending",
        sessionId: null,
        projectId: project.id,
        kind: "pending-worktree",
        title: "Pending worktree (visible, fixed)",
      }),
      pendingWorktreeId: "pending-worktree:project-story",
      clientThreadId: "client-new-thread:project-pending",
      pinnedBeforeThreadId: null,
      sessionId: null,
    };
    const second = makeSidebarThreadItem({
      key: "local:project-thread-b",
      threadId: "project-thread-b",
      sessionId: "project-session-b",
      projectId: project.id,
      title: "Project-local conversation B",
    });
    return [first, pending, second];
  }, [project.id]);
  const itemsByKey = useMemo(
    () => new Map(items.map((item) => [item.key, item] as const)),
    [items],
  );
  const sortableThreadKeys = useMemo(
    () => items.filter((item) => item.sessionId !== null).map((item) => item.key),
    [items],
  );
  const [threadKeys, setThreadKeys] = useState(() => items.map((item) => item.key));

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Pinned" collapsed={false} onToggle={() => {}}>
        <SidebarReorderDndProvider>
          <div className="isolate flex flex-col [contain:layout]">
            <div className="flex flex-col" role="list" aria-label="Pinned projects">
              <CodexProjectRow
                project={project}
                active
                expanded
                onActivate={() => {}}
                onStartNewChat={() => {}}
                onUpdateProject={async () => project}
                onArchiveProject={async () => ({ kind: "not-found" })}
              >
                <CodexProjectSessionList project={project}>
                  <SidebarThreadReorderRows
                    visibleThreadKeys={threadKeys}
                    sortableThreadKeys={sortableThreadKeys}
                    onVisibleThreadOrderChange={async ({
                      visibleThreadKeys,
                      nextVisibleThreadKeys,
                    }) => {
                      setThreadKeys((current) =>
                        replaceVisibleCodexSidebarThreadKeyOrder({
                          threadKeysInDisplayOrder: current,
                          visibleThreadKeys,
                          nextVisibleThreadKeys,
                        }),
                      );
                    }}
                    renderThread={(threadKey) => {
                      const item = itemsByKey.get(threadKey);
                      if (!item) return null;
                      return (
                        <CodexSidebarThreadRow
                          item={item}
                          active={false}
                          onSelect={() => {}}
                          onArchive={() => {}}
                          onTogglePinned={() => {}}
                        />
                      );
                    }}
                  />
                </CodexProjectSessionList>
              </CodexProjectRow>
            </div>
          </div>
        </SidebarReorderDndProvider>
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexCrossProjectThreadDropHarness() {
  const projects = useMemo(() => SIDEBAR_PARITY_PROJECTS.slice(0, 2), []);
  const items = useMemo(
    () => [
      makeSidebarThreadItem({
        key: "local:cross-alpha",
        threadId: "cross-alpha",
        sessionId: "session-cross-alpha",
        projectId: projects[0]?.id ?? "nodex",
        title: "Drag me between projects",
      }),
      makeSidebarThreadItem({
        key: "local:cross-alpha-pinned",
        threadId: "cross-alpha-pinned",
        sessionId: "session-cross-alpha-pinned",
        projectId: projects[0]?.id ?? "nodex",
        pinned: true,
        pinnedOrder: 0,
        title: "Pinned inside this project",
      }),
      makeSidebarThreadItem({
        key: "local:cross-beta",
        threadId: "cross-beta",
        sessionId: "session-cross-beta",
        projectId: projects[1]?.id ?? "codex-electron",
        title: "Destination anchor task",
      }),
      makeSidebarThreadItem({
        key: "local:cross-chats",
        threadId: "cross-chats",
        sessionId: "session-cross-chats",
        projectId: null,
        projectless: true,
        title: "Projectless Chats task",
      }),
      makeSidebarThreadItem({
        key: "local:cross-projectless-pinned",
        threadId: "cross-projectless-pinned",
        sessionId: "session-cross-projectless-pinned",
        projectId: null,
        projectless: true,
        pinned: true,
        pinnedOrder: 1,
        title: "Global projectless pin",
      }),
    ],
    [projects],
  );
  const itemsByKey = useMemo(
    () => new Map(items.map((item) => [item.key, item] as const)),
    [items],
  );
  const threadKeyById = useMemo(
    () => new Map(items.map((item) => [item.threadId, item.key] as const)),
    [items],
  );
  const firstProjectContainerId = `project:${projects[0]?.id ?? "nodex"}`;
  const firstProjectPinnedContainerId = `project-pinned:${projects[0]?.id ?? "nodex"}`;
  const secondProjectContainerId = `project:${projects[1]?.id ?? "codex-electron"}`;
  const secondProjectPinnedContainerId = `project-pinned:${projects[1]?.id ?? "codex-electron"}`;
  const [threadKeysByContainer, setThreadKeysByContainer] = useState<Record<string, string[]>>({
    [firstProjectContainerId]: ["local:cross-alpha"],
    [firstProjectPinnedContainerId]: ["local:cross-alpha-pinned"],
    [secondProjectContainerId]: ["local:cross-beta"],
    [secondProjectPinnedContainerId]: [],
    chats: ["local:cross-chats"],
    pinned: ["local:cross-projectless-pinned"],
  });
  const getThreadId = useCallback(
    (threadKey: string) => itemsByKey.get(threadKey)?.threadId ?? null,
    [itemsByKey],
  );
  const homeContainerIdByThreadId = useMemo(
    () =>
      new Map(
        Object.entries(threadKeysByContainer).flatMap(([containerId, threadKeys]) =>
          threadKeys.flatMap((threadKey) => {
            const threadId = getThreadId(threadKey);
            return threadId ? [[threadId, containerId] as const] : [];
          }),
        ),
      ),
    [getThreadId, threadKeysByContainer],
  );
  const handleThreadDrop = useCallback(
    async (drop: SidebarThreadDropRequest) => {
      const threadKey = threadKeyById.get(drop.threadId);
      if (!threadKey) return null;
      setThreadKeysByContainer((current) => {
        const next = Object.fromEntries(
          Object.entries(current).map(([containerId, threadKeys]) => [
            containerId,
            threadKeys.filter((candidate) => candidate !== threadKey),
          ]),
        );
        const targetThreadKeys = next[drop.targetContainerId] ?? [];
        const beforeThreadKey = drop.beforeThreadId
          ? (threadKeyById.get(drop.beforeThreadId) ?? null)
          : null;
        const rawInsertionIndex =
          drop.insertAtEnd || drop.useDefaultOrder
            ? targetThreadKeys.length
            : beforeThreadKey === null
              ? 0
              : targetThreadKeys.indexOf(beforeThreadKey);
        const insertionIndex = rawInsertionIndex < 0 ? targetThreadKeys.length : rawInsertionIndex;
        next[drop.targetContainerId] = [
          ...targetThreadKeys.slice(0, insertionIndex),
          threadKey,
          ...targetThreadKeys.slice(insertionIndex),
        ];
        return next;
      });
      return { operationId: `story:${drop.threadId}`, projectionRevision: 1 };
    },
    [threadKeyById],
  );
  const renderRows = (containerId: string) => {
    const threadKeys = threadKeysByContainer[containerId] ?? [];
    return (
      <SidebarThreadReorderRows
        containerId={containerId}
        getThreadId={getThreadId}
        visibleThreadKeys={threadKeys}
        sortableThreadKeys={threadKeys}
        sourceProjectKind="local"
        targetProjectKind="local"
        onVisibleThreadOrderChange={async ({ nextVisibleThreadKeys }) => {
          setThreadKeysByContainer((current) => ({
            ...current,
            [containerId]: nextVisibleThreadKeys,
          }));
        }}
        renderThread={(threadKey) => {
          const item = itemsByKey.get(threadKey);
          if (!item) return null;
          if (!isCodexSidebarThreadContainerId(containerId)) return null;
          const location = readCodexSidebarThreadContainerLocation(containerId);
          if (location === null) return null;
          return (
            <CodexSidebarThreadRow
              item={{
                ...item,
                pinned: location.pinned,
                projectId: location.projectId,
                projectless: location.projectId === null,
              }}
              active={false}
              onSelect={() => {}}
              onArchive={() => {}}
              onTogglePinned={() => {}}
            />
          );
        }}
      />
    );
  };

  return (
    <SidebarProjectsChrome>
      <SidebarReorderDndProvider
        getThreadIdByThreadKey={getThreadId}
        homeContainerIdByThreadId={homeContainerIdByThreadId}
        onThreadDrop={handleThreadDrop}
      >
        <CodexSidebarSection heading="Pinned" collapsed={false} onToggle={() => {}}>
          <SidebarThreadDropContainer containerId="pinned" targetProjectKind="local">
            <div className="flex flex-col" role="list" aria-label="Projectless pinned chats">
              {renderRows("pinned")}
            </div>
          </SidebarThreadDropContainer>
        </CodexSidebarSection>
        <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
          <div className="isolate flex flex-col [contain:layout]">
            <div className="flex flex-col" role="list" aria-label="Projects">
              {projects.map((project) => {
                const pinnedContainerId = codexSidebarProjectThreadContainerId(project.id, true);
                const regularContainerId = codexSidebarProjectThreadContainerId(project.id, false);
                return (
                  <CodexProjectRow
                    key={project.id}
                    project={project}
                    active={false}
                    expanded
                    onActivate={() => {}}
                    onStartNewChat={() => {}}
                    onUpdateProject={async () => project}
                    onArchiveProject={async () => ({ kind: "not-found" })}
                  >
                    <CodexProjectSessionList project={project}>
                      <SidebarThreadDropContainer
                        containerId={pinnedContainerId}
                        targetProjectKind="local"
                      >
                        {renderRows(pinnedContainerId)}
                      </SidebarThreadDropContainer>
                      <SidebarThreadDropContainer
                        containerId={regularContainerId}
                        targetProjectKind="local"
                      >
                        {renderRows(regularContainerId)}
                      </SidebarThreadDropContainer>
                    </CodexProjectSessionList>
                  </CodexProjectRow>
                );
              })}
            </div>
          </div>
        </CodexSidebarSection>
        <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
          <SidebarThreadDropContainer containerId="chats" targetProjectKind="local">
            <div className="flex flex-col" role="list" aria-label="Chats">
              {renderRows("chats")}
            </div>
          </SidebarThreadDropContainer>
        </CodexSidebarSection>
      </SidebarReorderDndProvider>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarProjectsThreadSyncHarness() {
  const project = SIDEBAR_PARITY_PROJECTS[0]!;
  const projectRows = [
    makeSidebarThreadItem({
      key: "local:auto-assigned",
      threadId: "thread-auto-assigned",
      title: "Auto-assigned external Codex thread",
      projectId: project.id,
      sessionId: "session-auto-assigned",
      cwd: "/Users/asc/repo/nodex/src/renderer",
      updatedAt: 1_780_960_000_000,
    }),
  ];
  const chatsRows = [
    makeSidebarThreadItem({
      key: "local:projectless",
      threadId: "thread-projectless",
      title: "Projectless terminal chat",
      sessionId: "session-projectless",
      projectId: null,
      projectless: true,
      cwd: "/tmp/codex-scratch",
      updatedAt: 1_780_940_000_000,
    }),
  ];

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
        <div className="isolate flex flex-col [contain:layout]">
          <div className="flex flex-col" role="list" aria-label="Projects">
            <CodexProjectRow
              project={project}
              active
              expanded
              onActivate={() => {}}
              onStartNewChat={() => {}}
              onUpdateProject={async () => project}
              onArchiveProject={async () => ({ kind: "not-found" })}
            >
              <CodexProjectSessionList project={project}>
                {projectRows.map((item) => (
                  <CodexSidebarThreadRow
                    key={item.key}
                    item={item}
                    active
                    onSelect={() => {}}
                    onArchive={() => {}}
                    onOpenContextMenu={() => {}}
                    onTogglePinned={() => {}}
                  />
                ))}
              </CodexProjectSessionList>
            </CodexProjectRow>
          </div>
        </div>
      </CodexSidebarSection>
      <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
        <ThreadRowsList label="Projectless chats" items={chatsRows} />
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarProjectlessChatsHarness() {
  const items = [
    makeSidebarThreadItem({
      key: "local:scratch",
      threadId: "thread-scratch",
      title: "Scratch workspace follow-up",
      sessionId: "session-scratch",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/Desktop/scratch",
      updatedAt: 1_780_930_000_000,
    }),
    makeSidebarThreadItem({
      key: "local:downloads",
      threadId: "thread-downloads",
      title: "Downloads folder cleanup",
      sessionId: "session-downloads",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/Downloads",
      updatedAt: 1_780_820_000_000,
    }),
    makeSidebarThreadItem({
      key: "local:scratch-subagent",
      threadId: "thread-scratch-subagent",
      parentThreadId: "thread-scratch",
      title: "Hidden scratch subagent",
      sessionId: "session-scratch-subagent",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/Desktop/scratch",
      updatedAt: 1_780_810_000_000,
    }),
  ].filter(isCodexSidebarThreadItemVisible);

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
        <ThreadRowsList label="Chats" items={items} activeKey="local:scratch" />
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarProjectlessChatsPagedHarness() {
  const [expanded, setExpanded] = useState(false);
  const [extraPageCount, setExtraPageCount] = useState(1);
  const items = useMemo(
    () =>
      Array.from({ length: 52 }, (_, index) =>
        makeSidebarThreadItem({
          key: `local:projectless-paged-${index + 1}`,
          threadId: `thread-projectless-paged-${index + 1}`,
          title: `Projectless chat ${index + 1}`,
          sessionId: `session-projectless-paged-${index + 1}`,
          projectId: null,
          projectless: true,
          cwd: "/Users/asc/Desktop/scratch",
          updatedAt: 1_780_930_000_000 - index,
        }),
      ),
    [],
  );
  const pagination = paginateCodexSidebarItems({
    items,
    getKey: (item) => item.key,
    maxItems: CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
    expanded,
    extraPageCount,
    forcedVisibleKey: null,
  });
  const showMore = () => {
    if (!expanded) {
      setExtraPageCount(1);
      setExpanded(true);
      return;
    }
    setExtraPageCount((current) => current + 1);
  };
  const showLess = () => {
    setExtraPageCount(1);
    setExpanded(false);
  };

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
        <ThreadRowsList
          label="Chats"
          items={pagination.visibleItems}
          activeKey="local:projectless-paged-1"
        />
        {pagination.showPager ? (
          <div className={CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS} role="listitem">
            {pagination.hasOverflow ? (
              <button type="button" className={CODEX_SIDEBAR_PAGER_BUTTON_CLASS} onClick={showMore}>
                Show more
              </button>
            ) : null}
            {expanded ? (
              <button type="button" className={CODEX_SIDEBAR_PAGER_BUTTON_CLASS} onClick={showLess}>
                Show less
              </button>
            ) : null}
          </div>
        ) : null}
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarArchivedHiddenHarness() {
  const project = SIDEBAR_PARITY_PROJECTS[0]!;
  const visibleItems = [
    makeSidebarThreadItem({
      key: "local:active",
      threadId: "thread-active",
      title: "Visible active thread",
      projectId: "nodex",
      cwd: "/Users/asc/repo/nodex",
    }),
  ];

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
        <div className="isolate flex flex-col [contain:layout]">
          <div className="flex flex-col" role="list" aria-label="Projects">
            <CodexProjectRow
              project={project}
              active
              expanded
              onActivate={() => {}}
              onStartNewChat={() => {}}
              onUpdateProject={async () => project}
              onArchiveProject={async () => ({ kind: "not-found" })}
            >
              <CodexProjectSessionList project={project}>
                {visibleItems.map((item) => (
                  <CodexSidebarThreadRow
                    key={item.key}
                    item={item}
                    active={item.key === "local:active"}
                    onSelect={() => {}}
                    onArchive={() => {}}
                    onOpenContextMenu={() => {}}
                    onTogglePinned={() => {}}
                  />
                ))}
              </CodexProjectSessionList>
            </CodexProjectRow>
          </div>
        </div>
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarThreadArchiveActionHarness() {
  const items = [
    makeSidebarThreadItem({
      key: "local:archive-hover",
      threadId: "thread-archive-hover",
      title: "Hover archive action visible",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/repo/nodex",
    }),
  ];

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
        <ThreadRowsList
          label="Chats"
          items={items}
          activeKey="local:archive-hover"
          openKey="local:archive-hover"
        />
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarThreadStatusActionRailHarness() {
  const items = [
    makeSidebarThreadItem({
      key: "local:status-long",
      threadId: "thread-status-long",
      title: "Running sidebar investigation with enough text to test truncation",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/repo/nodex",
      statusType: "active",
    }),
    makeSidebarThreadItem({
      key: "local:status-pinned",
      threadId: "thread-status-pinned",
      title: "Pinned thread with resting status",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/repo/nodex",
      pinned: true,
    }),
    makeSidebarThreadItem({
      key: "local:status-unread",
      threadId: "thread-status-unread",
      title: "Unread thread keeps the indicator while actions reveal",
      projectId: null,
      projectless: true,
      cwd: "/Users/asc/repo/nodex",
      unread: true,
    }),
  ];

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
        <ThreadRowsList
          label="Chats"
          items={items}
          activeKey="local:status-long"
          openKey="local:status-long"
        />
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarThreadHoverCardHarness() {
  const project = SIDEBAR_PARITY_PROJECTS[0]!;
  const item = makeSidebarThreadItem({
    key: "local:hover-card",
    threadId: "thread-hover-card",
    title: "X Plan Codex terminal reverse engineer",
    projectId: project.id,
    sessionId: "session-hover-card",
    cwd: "/Users/asc/repo/nodex",
    updatedAt: Date.now() - STORY_TWO_DAYS_MS,
  });

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
        <div className="isolate flex flex-col [contain:layout]">
          <div className="flex flex-col" role="list" aria-label="Chats">
            <CodexSidebarThreadRow
              item={item}
              active
              hoverCardOpen
              hoverCardProjectLabel="nodex"
              hoverCardBranchName="feat/thread-tools"
              onSelect={() => {}}
              onArchive={() => {}}
              onOpenContextMenu={() => {}}
              onTogglePinned={() => {}}
            />
          </div>
        </div>
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarProjectHoverCardHarness() {
  const [project, setProject] = useState<Project>({
    ...SIDEBAR_PARITY_PROJECTS[0]!,
    sources: [
      { root: "/Users/nodex/repo/nodex", order: 0 },
      { root: "/Users/nodex/repo/shared-design-system", order: 1 },
    ],
    primaryWorkspaceRoot: "/Users/nodex/repo/nodex",
  });

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
        <div className="isolate flex flex-col [contain:layout]">
          <div className="flex flex-col" role="list" aria-label="Projects">
            <CodexProjectRow
              project={project}
              activity={{
                projectId: project.id,
                taskCount: 66,
                waitingCount: 2,
                unreadCount: 3,
                activeCount: 1,
              }}
              active
              expanded
              hoverCardOpen
              onActivate={() => {}}
              onUpdateProject={async (_projectId, updates) => {
                const nextProject = {
                  ...project,
                  ...updates,
                  sources: updates.sources
                    ? updates.sources.map((root, order) => ({ root, order }))
                    : project.sources,
                  updated: new Date(),
                };
                setProject(nextProject);
                return nextProject;
              }}
              onArchiveProject={async () => ({ kind: "not-found" })}
              onSetProjectPinned={async (_projectId, input) => {
                const nextProject = { ...project, pinned: input.pinned };
                setProject(nextProject);
                return nextProject;
              }}
            />
          </div>
        </div>
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarShowMoreHarness({ initialExpanded = false }: { initialExpanded?: boolean }) {
  const project = SIDEBAR_PARITY_PROJECTS[0]!;
  const [expanded, setExpanded] = useState(initialExpanded);
  const [extraPageCount, setExtraPageCount] = useState(1);
  const items = useMemo(
    () =>
      Array.from({ length: 16 }, (_, index) =>
        makeSidebarThreadItem({
          key: `local:paged-${index + 1}`,
          threadId: `thread-paged-${index + 1}`,
          title: `Paged chat ${index + 1}`,
          projectId: project.id,
          cwd: "/Users/asc/repo/nodex",
          updatedAt: 1_780_960_000_000 - index,
        }),
      ),
    [project.id],
  );
  const pagination = paginateCodexSidebarItems({
    items,
    getKey: (item) => item.key,
    maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
    expanded,
    extraPageCount,
    forcedVisibleKey: null,
  });

  const showMore = () => {
    if (!expanded) {
      setExtraPageCount(1);
      setExpanded(true);
      return;
    }
    setExtraPageCount((current) => current + 1);
  };

  const showLess = () => {
    setExtraPageCount(1);
    setExpanded(false);
  };

  return (
    <SidebarProjectsChrome>
      <CodexSidebarSection heading="Projects" collapsed={false} onToggle={() => {}}>
        <div className="isolate flex flex-col [contain:layout]">
          <div className="flex flex-col" role="list" aria-label="Projects">
            <CodexProjectRow
              project={project}
              active
              expanded
              onActivate={() => {}}
              onStartNewChat={() => {}}
              onUpdateProject={async () => project}
              onArchiveProject={async () => ({ kind: "not-found" })}
            >
              <CodexProjectSessionList project={project} showAll={expanded}>
                {pagination.visibleItems.map((item, index) => (
                  <CodexSidebarThreadRow
                    key={item.key}
                    item={item}
                    active={index === 0}
                    onSelect={() => {}}
                    onArchive={() => {}}
                    onOpenContextMenu={() => {}}
                    onTogglePinned={() => {}}
                  />
                ))}
                {pagination.showPager ? (
                  <div className={CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS} role="listitem">
                    {pagination.hasOverflow ? (
                      <button
                        type="button"
                        className={CODEX_SIDEBAR_PAGER_BUTTON_CLASS}
                        onClick={showMore}
                      >
                        Show more
                      </button>
                    ) : null}
                    {expanded ? (
                      <button
                        type="button"
                        className={CODEX_SIDEBAR_PAGER_BUTTON_CLASS}
                        onClick={showLess}
                      >
                        Show less
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </CodexProjectSessionList>
            </CodexProjectRow>
          </div>
        </div>
      </CodexSidebarSection>
    </SidebarProjectsChrome>
  );
}

function CodexSidebarWorktreeRunLocationsHarness({
  narrow = false,
  hoverCard = false,
}: {
  narrow?: boolean;
  hoverCard?: boolean;
}) {
  const items = [
    makeSidebarThreadItem({
      key: "local:checkout",
      threadId: "checkout",
      title: "Local checkout",
    }),
    makeSidebarThreadItem({
      key: "local:pending-worktree",
      threadId: "pending-worktree",
      kind: "pending-worktree",
      title: "Creating a new worktree",
      statusType: "active",
      runLocation: { kind: "local-worktree", path: null, phase: "pending" },
    }),
    makeSidebarThreadItem({
      key: "local:ready-worktree",
      threadId: "ready-worktree",
      title: "A very long local worktree task title that stays stable beside its trailing identity",
      cwd: "/Users/asc/.codex/worktrees/91a6/nodex",
      runLocation: {
        kind: "local-worktree",
        path: "/Users/asc/.codex/worktrees/91a6/nodex",
        phase: "ready",
      },
    }),
    makeSidebarThreadItem({
      key: "remote:checkout",
      threadId: "remote-checkout",
      kind: "remote",
      hostId: "build-host",
      title: "Remote checkout",
      runLocation: { kind: "remote-checkout", hostId: "build-host" },
    }),
    makeSidebarThreadItem({
      key: "remote:pending-worktree",
      threadId: "remote-pending-worktree",
      kind: "pending-worktree",
      hostId: "build-host",
      title: "Creating a remote worktree",
      statusType: "active",
      runLocation: {
        kind: "remote-worktree",
        hostId: "build-host",
        path: null,
        phase: "pending",
      },
    }),
    makeSidebarThreadItem({
      key: "remote:ready-worktree",
      threadId: "remote-ready-worktree",
      kind: "remote",
      hostId: "build-host",
      title: "Remote worktree",
      cwd: "/srv/.codex/worktrees/91a6/nodex",
      runLocation: {
        kind: "remote-worktree",
        hostId: "build-host",
        path: "/srv/.codex/worktrees/91a6/nodex",
        phase: "ready",
      },
    }),
  ];

  return (
    <NodexTooltipProvider>
      <div data-codex-window-type="electron" className="min-h-screen bg-token-bg-primary p-8">
        <div
          className={`app-shell-left-panel overflow-visible py-4 ${narrow ? "w-[228px]" : "w-[300px]"}`}
        >
          <CodexSidebarSection heading="Chats" collapsed={false} onToggle={() => {}}>
            <div className="isolate flex flex-col [contain:layout]">
              <div className="flex flex-col" role="list" aria-label="Worktree execution locations">
                {items.map((item) => (
                  <CodexSidebarThreadRow
                    key={item.key}
                    item={item}
                    active={item.key === "local:ready-worktree"}
                    contextMenuOpen={!hoverCard && item.key === "remote:ready-worktree"}
                    hoverCardOpen={hoverCard && item.key === "remote:ready-worktree"}
                    hoverCardProjectLabel="Nodex"
                    hoverCardBranchName="feat/worktree-parity"
                    onSelect={() => {}}
                    onArchive={() => {}}
                    onOpenContextMenu={() => {}}
                    onTogglePinned={() => {}}
                  />
                ))}
              </div>
            </div>
          </CodexSidebarSection>
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

function SettingsFooterHarness({
  account = FOOTER_QUOTA_ACCOUNT,
}: {
  account?: CodexAccountSnapshot | null;
}) {
  return (
    <NodexTooltipProvider>
      <div className="flex min-h-screen items-end bg-(--background) p-8">
        <div className="w-[280px] bg-(--background-secondary)">
          <LeftSidebarFooter
            onOpenSettings={() => {}}
            account={account}
            connection={{ status: "connected", retries: 0 }}
            onRefreshAccount={async () => account ?? FOOTER_SIGNED_OUT_ACCOUNT}
            onConsumeRateLimitReset={async () => ({
              outcome: "reset",
              account: account ?? FOOTER_SIGNED_OUT_ACCOUNT,
            })}
            onStartChatGptLogin={async () => ({ type: "apiKey" })}
            onStartApiKeyLogin={async () => ({ type: "apiKey" })}
            onCancelLogin={async () => ({ status: "canceled" })}
            onLogout={async () => undefined}
          />
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

const meta = {
  title: "Workbench/Sidebar",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const SectionMenuOpen: Story = {
  render: () => <SidebarSectionMenuHarness />,
};

export const StatusGroupsReversed: Story = {
  render: () => <StatusGroupOrderHarness />,
};

export const NewChatControls: Story = {
  render: () => <SidebarNewChatControlsHarness />,
  parameters: {
    docs: {
      description: {
        story:
          "The fixed sidebar header pairs the Nodex wordmark with a compact beta chip while retaining its top-edge treatment; the bottom fade appears only when additional rows remain below the scroll viewport.",
      },
    },
  },
};

export const CodexProjectsExpanded: Story = {
  render: () => <CodexProjectsHarness expanded activeProjectId="nodex" />,
};

export const CodexProjectDisclosureChevronsRevealed: Story = {
  render: () => (
    <CodexProjectsHarness expanded activeProjectId="nodex" revealProjectDisclosureChevrons />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Project-row hover state: the optically inset disclosure chevron replaces the marker in the same fixed leading slot, while the Project name keeps its Session-aligned position as a separate navigation control.",
      },
    },
  },
};

export const CodexProjectsCollapsed: Story = {
  render: () => <CodexProjectsHarness expanded={false} activeProjectId="nodex" />,
};

export const CodexProjectActionsMenuOpen: Story = {
  render: () => <CodexProjectsHarness expanded activeProjectId="nodex" openActionsFor="Nodex" />,
};

export const CodexProjectEditDialogOpen: Story = {
  render: () => <CodexProjectsHarness expanded activeProjectId="nodex" openEditFor="Nodex" />,
};

export const CodexProjectsOptionsMenuOpen: Story = {
  render: () => <CodexProjectsHarness expanded activeProjectId="nodex" openSectionOptions />,
};

export const CodexProjectsMissingWorkspacePath: Story = {
  render: () => <CodexProjectsHarness expanded activeProjectId="missing-workspace" />,
};

export const CodexProjectsLongLabels: Story = {
  render: () => (
    <CodexProjectsHarness
      expanded
      activeProjectId="codex-electron-readable-bundle-with-a-very-long-name"
    />
  ),
};

export const CodexProjectsSortable: Story = {
  render: () => <CodexSortableProjectsHarness />,
  parameters: {
    docs: {
      description: {
        story:
          "Interactive project-folder reorder using the production sidebar gesture coordinator. Drag a project label to inspect the compact body-level folder ghost, inert 20% source, suppressed sibling transforms, and line-and-dot insertion boundary.",
      },
    },
  },
};

export const CodexProjectsDraggingOverProject: Story = {
  render: () => <CodexSortableProjectsHarness dropIndicator />,
  parameters: {
    docs: {
      description: {
        story:
          "Non-layout-shifting project insertion indicator with the link-blue rail and sidebar-filled leading dot. The interactive sortable story uses the same 6px activation and same-row midpoint refresh contract as production.",
      },
    },
  },
};

export const CodexPinnedProjects: Story = {
  render: () => <CodexSortableProjectsHarness pinned />,
};

export const CodexPinnedThreadsSortable: Story = {
  render: () => <CodexPinnedThreadsSortableHarness />,
};

export const CodexPinnedProjectThreadsSortable: Story = {
  render: () => <CodexPinnedProjectThreadsSortableHarness />,
};

export const CodexCrossProjectThreadDrop: Story = {
  render: () => <CodexCrossProjectThreadDropHarness />,
  parameters: {
    docs: {
      description: {
        story:
          "Interactive lane-aware transfer across project-local pinned and regular rows, plus projectless Pinned and Chats. Hover a chat until its rich preview opens, then drag it to exercise the stable tooltip/ref lifecycle.",
      },
    },
  },
};

export const CodexPinnedProjectsEmptyDropTarget: Story = {
  render: () => <CodexSortableProjectsHarness emptyPinnedDropTarget />,
};

export const CodexProjectSessionRows: Story = {
  render: () => <CodexProjectSessionRowsHarness />,
};

export const CodexSidebarProjectsWithAutoAssignedThread: Story = {
  render: () => <CodexSidebarProjectsThreadSyncHarness />,
};

export const CodexSidebarProjectlessChats: Story = {
  render: () => <CodexSidebarProjectlessChatsHarness />,
};

export const CodexSidebarProjectlessChatsPaged: Story = {
  render: () => <CodexSidebarProjectlessChatsPagedHarness />,
};

export const CodexSidebarArchivedHidden: Story = {
  render: () => <CodexSidebarArchivedHiddenHarness />,
};

export const CodexSidebarThreadArchiveAction: Story = {
  render: () => <CodexSidebarThreadArchiveActionHarness />,
};

export const CodexSidebarThreadStatusActionRail: Story = {
  render: () => <CodexSidebarThreadStatusActionRailHarness />,
};

export const CodexSidebarThreadHoverCard: Story = {
  render: () => <CodexSidebarThreadHoverCardHarness />,
};

export const CodexSidebarWorktreeRunLocations: Story = {
  render: () => <CodexSidebarWorktreeRunLocationsHarness />,
  parameters: {
    docs: {
      description: {
        story:
          "Local and remote checkout/worktree identities, including pending pulse, selected state, long-title clipping, and an open action rail replacing resting environment glyphs.",
      },
    },
  },
};

export const CodexSidebarWorktreeRunLocationsNarrow: Story = {
  render: () => <CodexSidebarWorktreeRunLocationsHarness narrow />,
};

export const CodexSidebarRemoteWorktreeHoverCard: Story = {
  render: () => <CodexSidebarWorktreeRunLocationsHarness hoverCard />,
};

export const CodexSidebarProjectHoverCard: Story = {
  render: () => <CodexSidebarProjectHoverCardHarness />,
};

export const CodexSidebarShowMore: Story = {
  render: () => <CodexSidebarShowMoreHarness />,
};

export const CodexSidebarShowLess: Story = {
  render: () => <CodexSidebarShowMoreHarness initialExpanded />,
};

export const SettingsFooterWithQuota: Story = {
  render: () => <SettingsFooterHarness account={FOOTER_QUOTA_ACCOUNT} />,
};

export const SettingsFooterLowQuota: Story = {
  render: () => <SettingsFooterHarness account={FOOTER_LOW_QUOTA_ACCOUNT} />,
};

export const SettingsFooterNoRateLimits: Story = {
  render: () => <SettingsFooterHarness account={FOOTER_NO_LIMITS_ACCOUNT} />,
};

export const SettingsFooterSignedOut: Story = {
  render: () => <SettingsFooterHarness account={FOOTER_SIGNED_OUT_ACCOUNT} />,
};
