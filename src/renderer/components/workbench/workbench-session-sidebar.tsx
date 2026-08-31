import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, type MotionValue } from "motion/react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { codexSidebarProjectThreadContainerId } from "../../../shared/codex-sidebar-thread-move";
import type { LibraryResourceTarget } from "../../../shared/library-module";
import type { LibraryResourceTarget as ActionableLibraryResourceTarget } from "../library/library-resource-actions";
import {
  CodexProjectRow,
  CodexProjectSessionList,
  CodexSidebarActionButton,
  CodexSidebarSection,
  CodexSidebarThreadRow,
  CodexSidebarTopActionButton,
  resolveCodexNewChatShortcutLabel,
  resolveCodexPageSearchShortcutLabel,
  type CodexProjectRowDndCapability,
} from "./codex-sidebar";
import { LeftSidebarFooter } from "./left-sidebar-footer";
import { SidebarDropIndicator } from "./sidebar-drop-indicator";
import type { SidebarLibraryDragResource } from "./sidebar-library-dnd";
import { SidebarPagesSection } from "./sidebar-pages-section";
import {
  SIDEBAR_SCROLL_AREA_CLASS,
  SidebarExpandedHeader,
  useSidebarScrollChrome,
} from "./sidebar-new-chat-controls";
import {
  SidebarProjectSortableContext,
  replaceVisibleOrder,
  useSidebarGroupReorderController,
  type SidebarGroupDndController,
} from "./sidebar-project-group-dnd";
import { SidebarProjectsSectionActions } from "./sidebar-projects-section-actions";
import { SidebarReorderDndProvider, type SidebarProjectDropRequest } from "./sidebar-reorder-dnd";
import { resolveSidebarSectionItemPlacement } from "./sidebar-section-item-dnd";
import {
  SidebarThreadDropContainer,
  SidebarThreadReorderRows,
  SidebarThreadSortableRows,
  resolveSidebarThreadKeysWithPendingDrops,
  usePendingSidebarThreadDrops,
  useReportSidebarThreadCanonicalLanes,
  useSidebarPinnedDropContainer,
  useSidebarThreadReorderController,
  type SidebarThreadCanonicalLanes,
  type SidebarThreadDropCommit,
  type SidebarThreadDropRequest,
} from "./sidebar-thread-reorder";
import type { StableWorktreeEntry } from "./stable-worktree-production";
import { StableWorktreeSidebarRows } from "./stable-worktree-sidebar-row";
import {
  AutomationsIcon,
  NewChatIcon,
  ThreadIcon,
  ComposerPluginsIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { invoke, invokeCoreResult } from "@/lib/api";
import {
  CODEX_SIDEBAR_FLOATING_ASIDE_CLASS,
  CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
} from "@/lib/codex-sidebar-auto-reveal";
import {
  CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS,
  CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS,
} from "@/lib/codex-sidebar-pagination";
import {
  buildCodexSidebarPinnedReorderMutation,
  isCodexSidebarRootThread,
  listReorderableCodexSidebarChatKeys,
  replaceVisibleCodexSidebarThreadKeyOrder,
  resolveCodexSidebarThreadHomeContainerId,
  sortSidebarThreadKeysForDisplay,
  type CodexSidebarProjectGroup,
  type CodexSidebarThreadSyncModel,
} from "@/lib/codex-sidebar-thread-sync";
import {
  buildLibraryMoveOperation,
  buildLibraryProjectGrantOperation,
} from "@/lib/library-operations";
import { projectActivitySummariesQueryOptions } from "@/lib/query-options";
import {
  listExpandedVisibleProjectGroupIds,
  listReopenableVisibleProjectGroupIds,
  resolveSidebarProjectGroupCollapseAction,
  type SidebarProjectGroupCollapseAction,
} from "@/lib/sidebar-project-group-collapse-action";
import type {
  CodexAccountSnapshot,
  CodexConnectionState,
  CodexSidebarThreadItem,
  Project,
  ProjectCreateInput,
  ProjectLifecycleMutationResult,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectSession as ProjectSessionDomain,
  ProjectUpdateInput,
} from "@/lib/types";
import { useCodexAccountActions } from "@/lib/use-codex-account-actions";
import { useApplyLibraryOperation } from "@/lib/use-library-navigation";
import { cn } from "@/lib/utils";
import {
  projectSessionProjectionsByProject,
  type WorkbenchSessionCollection,
  type WorkbenchSessionCollectionState,
} from "@/lib/use-workbench-session-catalog";
import { projectSessionSummaryToDomain } from "@/lib/workbench-session-presentation";
import type { SidebarCollapsibleSectionsState } from "@/lib/sidebar-section-prefs";
import { SidebarPaginatedItems } from "./sidebar-paginated-items";
import {
  SidebarCustomSections,
  SidebarProjectSectionMenu,
  SIDEBAR_SECTIONS_QUERY_KEY,
  useSidebarSectionsCatalog,
} from "./sidebar-custom-sections";
import {
  readSidebarSectionContainerId,
  sidebarSectionContainerId,
} from "../../../shared/sidebar-sections";
type ProjectSession = ProjectSessionDomain;
const IDLE_SESSION_COLLECTION_STATE = { kind: "idle" } as const;

function SidebarSessionCollectionFallback({
  state,
  loadingText,
  emptyText,
  placement,
  onRetry,
}: {
  state: WorkbenchSessionCollectionState;
  loadingText: string | null;
  emptyText: string | null;
  placement: "section" | "project-child";
  onRetry: () => void | Promise<void>;
}) {
  const rowClassName = cn(
    "py-row-y text-sm",
    placement === "project-child" ? "pr-row-x pl-8" : "px-row-x",
  );

  if (state.kind === "loading") {
    if (!loadingText) return null;
    return (
      <div className={cn(rowClassName, "text-token-description-foreground")} role="listitem">
        {loadingText}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className={rowClassName} role="listitem">
        <NodexTooltip tooltipContent={state.message} side="top">
          <button
            type="button"
            className="text-token-description-foreground hover:text-token-foreground"
            aria-label={`Retry chats: ${state.message}`}
            onClick={() => void onRetry()}
          >
            Retry chats
          </button>
        </NodexTooltip>
      </div>
    );
  }

  if (state.kind !== "ready" || !emptyText) return null;

  return (
    <div className={cn(rowClassName, "text-token-description-foreground")} role="listitem">
      {emptyText}
    </div>
  );
}

export type SidebarResizePhase = "live" | "end" | "reset";
export type SidebarResizeSurface = "inline" | "floating";

function reportSidebarThreadReorderError(): void {
  toast.danger("Couldn’t reorder task");
}

function reportSidebarProjectReorderError(): void {
  toast.danger("Couldn’t reorder project");
}

function SidebarProjectGroupRowsContent({
  visibleItems,
  pager,
  emptyText,
  loading,
  reorderGroups,
  renderProjectGroup,
}: {
  visibleItems: CodexSidebarProjectGroup[];
  pager: ReactNode;
  emptyText: string;
  loading: boolean;
  reorderGroups: (nextVisibleGroupIds: string[]) => void | Promise<void>;
  renderProjectGroup: (
    group: CodexSidebarProjectGroup,
    controller: SidebarGroupDndController,
  ) => ReactNode;
}) {
  const visibleGroupIds = useMemo(
    () => visibleItems.map((group) => group.project.id),
    [visibleItems],
  );
  const visibleGroupById = useMemo(
    () => new Map(visibleItems.map((group) => [group.project.id, group] as const)),
    [visibleItems],
  );
  const reorder = useSidebarGroupReorderController({
    groupIds: visibleGroupIds,
    reorderGroups,
  });
  const orderedVisibleItems = useMemo(
    () =>
      reorder.groupIds
        .map((projectId) => visibleGroupById.get(projectId))
        .filter((group): group is CodexSidebarProjectGroup => Boolean(group)),
    [reorder.groupIds, visibleGroupById],
  );

  return (
    <div className="isolate flex flex-col [contain:layout]">
      <SidebarProjectSortableContext groupIds={reorder.groupIds}>
        <div className="flex flex-col" role="list" aria-label="Projects">
          {orderedVisibleItems.length > 0 ? (
            orderedVisibleItems.map((group, index) => (
              <Fragment key={group.project.id}>
                {reorder.dropIndicatorIndex === index ? <SidebarDropIndicator /> : null}
                {renderProjectGroup(group, reorder.controller)}
              </Fragment>
            ))
          ) : (
            <div
              className="px-row-x py-row-y text-sm text-token-description-foreground"
              role="listitem"
            >
              {loading ? "Loading projects..." : emptyText}
            </div>
          )}
          {reorder.dropIndicatorIndex === orderedVisibleItems.length ? (
            <SidebarDropIndicator />
          ) : null}
          {pager}
        </div>
      </SidebarProjectSortableContext>
    </div>
  );
}

function SidebarPinnedThreadRowsContent({
  containerId,
  getThreadId,
  visibleThreadKeys,
  itemsByKey,
  ariaLabel,
  onVisibleThreadOrderChange,
  renderThread,
}: {
  containerId: "pinned";
  getThreadId: (threadKey: string) => string | null;
  visibleThreadKeys: string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  ariaLabel: string;
  onVisibleThreadOrderChange: (change: {
    visibleThreadKeys: string[];
    nextVisibleThreadKeys: string[];
  }) => Promise<void>;
  renderThread: (threadKey: string) => ReactNode;
}) {
  const pendingThreadDrops = usePendingSidebarThreadDrops();
  const optimisticThreadKeys = resolveSidebarThreadKeysWithPendingDrops({
    containerId,
    pendingThreadDrops,
    threadKeys: visibleThreadKeys,
    getThreadId,
  });
  return (
    <div className="isolate flex flex-col [contain:layout]">
      <div className="flex flex-col" role="list" aria-label={ariaLabel}>
        <SidebarThreadReorderRows
          containerId={containerId}
          getThreadId={getThreadId}
          visibleThreadKeys={optimisticThreadKeys}
          sortableThreadKeys={optimisticThreadKeys}
          onVisibleThreadOrderChange={onVisibleThreadOrderChange}
          renderThread={renderThread}
          renderDragOverlay={(threadKey) => {
            const item = itemsByKey.get(threadKey);
            if (!item) return null;
            return (
              <div className="flex h-[var(--height-token-nav-row)] max-w-80 items-center gap-2 px-2 text-base text-token-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <ThreadIcon className="icon-xs" />
                </span>
                <span className="min-w-0 truncate">{item.title}</span>
              </div>
            );
          }}
          sourceProjectKind="local"
          targetProjectKind="local"
        />
      </div>
    </div>
  );
}

function SidebarThreadContainerRowsContent({
  containerId,
  threadKeys,
  getSessionId,
  getThreadId,
  itemsByKey,
  expanded,
  onExpandedChange,
  forcedVisibleKey,
  suppressedKeys,
  collectionState,
  hasMoreAtSource,
  onLoadMore,
  onRetry,
  onVisibleSessionOrderChange,
  renderThread,
}: {
  containerId: "chats";
  threadKeys: string[];
  getSessionId: (threadKey: string) => string | null;
  getThreadId: (threadKey: string) => string | null;
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  forcedVisibleKey: string | null;
  suppressedKeys: ReadonlySet<string>;
  collectionState: WorkbenchSessionCollectionState;
  hasMoreAtSource: boolean;
  onLoadMore: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onVisibleSessionOrderChange: (orderedSessionIds: string[]) => Promise<void>;
  renderThread: (threadKey: string) => ReactNode;
}) {
  const pendingThreadDrops = usePendingSidebarThreadDrops();
  const optimisticThreadKeys = resolveSidebarThreadKeysWithPendingDrops({
    containerId,
    pendingThreadDrops,
    threadKeys,
    threadKeysInDisplayOrder: threadKeys,
    getThreadId,
  });
  const sortableThreadKeys = optimisticThreadKeys.filter(
    (threadKey) => getSessionId(threadKey) !== null && !suppressedKeys.has(threadKey),
  );
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys: sortableThreadKeys,
    onVisibleThreadOrderChange: async ({ nextVisibleThreadKeys }) => {
      await onVisibleSessionOrderChange(
        nextVisibleThreadKeys.flatMap((threadKey) => {
          const sessionId = getSessionId(threadKey);
          return sessionId === null ? [] : [sessionId];
        }),
      );
    },
  });
  const displayedThreadKeys = replaceVisibleCodexSidebarThreadKeyOrder({
    threadKeysInDisplayOrder: optimisticThreadKeys,
    visibleThreadKeys: sortableThreadKeys,
    nextVisibleThreadKeys: reorder.displayedVisibleThreadKeys,
  });

  return (
    <SidebarThreadDropContainer containerId={containerId} targetProjectKind="local">
      <SidebarPaginatedItems
        items={displayedThreadKeys}
        getKey={(threadKey) => threadKey}
        maxItems={CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        forcedVisibleKey={forcedVisibleKey}
        suppressedKeys={suppressedKeys}
        hasMoreAtSource={hasMoreAtSource}
        onLoadMore={onLoadMore}
      >
        {(pagination, pager) => (
          <div className="isolate flex flex-col [contain:layout]">
            <div className="flex flex-col" role="list" aria-label="Chats">
              {pagination.visibleItems.length > 0 ? (
                <SidebarThreadSortableRows
                  containerId={containerId}
                  getItemId={(threadKey) => getSessionId(threadKey) ?? undefined}
                  getThreadId={getThreadId}
                  itemIds={reorder.displayedVisibleThreadKeys.flatMap((threadKey) => {
                    const sessionId = getSessionId(threadKey);
                    return sessionId === null ? [] : [sessionId];
                  })}
                  visibleThreadKeys={pagination.visibleItems}
                  sortableThreadKeysInDisplayOrder={reorder.displayedVisibleThreadKeys}
                  controller={reorder.controller}
                  dropIndicatorTarget={reorder.dropIndicatorTarget}
                  renderThread={renderThread}
                  renderDragOverlay={(threadKey) => {
                    const item = itemsByKey.get(threadKey);
                    if (!item) return null;
                    return (
                      <div className="flex h-[var(--height-token-nav-row)] max-w-80 items-center gap-2 px-2 text-base text-token-foreground">
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <ThreadIcon className="icon-xs" />
                        </span>
                        <span className="min-w-0 truncate">{item.title}</span>
                      </div>
                    );
                  }}
                  sourceProjectKind="local"
                  targetProjectKind="local"
                />
              ) : null}
              {pagination.visibleItems.length === 0 || collectionState.kind === "error" ? (
                <SidebarSessionCollectionFallback
                  state={collectionState}
                  loadingText="Loading chats..."
                  emptyText="No projectless chats"
                  placement="section"
                  onRetry={onRetry}
                />
              ) : null}
              {pager}
            </div>
          </div>
        )}
      </SidebarPaginatedItems>
    </SidebarThreadDropContainer>
  );
}

function SidebarProjectThreadRowsContent({
  project,
  pinnedThreadKeys,
  sortablePinnedThreadKeys,
  threadKeys,
  expanded,
  forcedVisibleKey,
  suppressedKeys,
  collectionState,
  hasMoreAtSource,
  onLoadMore,
  onRetry,
  onExpandedChange,
  onPinnedThreadOrderChange,
  onRegularSessionOrderChange,
  getSessionId,
  getThreadId,
  itemsByKey,
  renderThread,
}: {
  project: Project;
  pinnedThreadKeys: string[];
  sortablePinnedThreadKeys: string[];
  threadKeys: string[];
  expanded: boolean;
  forcedVisibleKey: string | null;
  suppressedKeys: ReadonlySet<string>;
  collectionState: WorkbenchSessionCollectionState;
  hasMoreAtSource: boolean;
  onLoadMore: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onExpandedChange: (expanded: boolean) => void;
  onPinnedThreadOrderChange: (change: {
    visibleThreadKeys: string[];
    nextVisibleThreadKeys: string[];
  }) => Promise<void>;
  onRegularSessionOrderChange: (orderedSessionIds: string[]) => Promise<void>;
  getSessionId: (threadKey: string) => string | null;
  getThreadId: (threadKey: string) => string | null;
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  renderThread: (threadKey: string) => ReactNode;
}) {
  const pinnedContainerId = codexSidebarProjectThreadContainerId(project.id, true);
  const regularContainerId = codexSidebarProjectThreadContainerId(project.id, false);
  const pendingThreadDrops = usePendingSidebarThreadDrops();
  const optimisticPinnedThreadKeys = useMemo(
    () =>
      resolveSidebarThreadKeysWithPendingDrops({
        containerId: pinnedContainerId,
        pendingThreadDrops,
        threadKeys: pinnedThreadKeys,
        getThreadId,
      }),
    [getThreadId, pendingThreadDrops, pinnedContainerId, pinnedThreadKeys],
  );
  const optimisticRegularThreadKeys = useMemo(
    () =>
      resolveSidebarThreadKeysWithPendingDrops({
        containerId: regularContainerId,
        pendingThreadDrops,
        threadKeys,
        threadKeysInDisplayOrder: threadKeys,
        getThreadId,
      }),
    [getThreadId, pendingThreadDrops, regularContainerId, threadKeys],
  );
  const sortablePinnedThreadKeySet = useMemo(
    () => new Set(sortablePinnedThreadKeys),
    [sortablePinnedThreadKeys],
  );
  const optimisticSortablePinnedThreadKeys = useMemo(
    () =>
      optimisticPinnedThreadKeys.filter(
        (threadKey) => sortablePinnedThreadKeySet.has(threadKey) && !suppressedKeys.has(threadKey),
      ),
    [optimisticPinnedThreadKeys, sortablePinnedThreadKeySet, suppressedKeys],
  );
  const sortableRegularThreadKeys = useMemo(
    () =>
      listReorderableCodexSidebarChatKeys({
        visibleThreadKeys: optimisticRegularThreadKeys.filter(
          (threadKey) => !suppressedKeys.has(threadKey),
        ),
        getSessionId,
      }),
    [getSessionId, optimisticRegularThreadKeys, suppressedKeys],
  );
  const pinnedReorder = useSidebarThreadReorderController({
    visibleThreadKeys: optimisticSortablePinnedThreadKeys,
    onVisibleThreadOrderChange: onPinnedThreadOrderChange,
  });
  const regularReorder = useSidebarThreadReorderController({
    visibleThreadKeys: sortableRegularThreadKeys,
    onVisibleThreadOrderChange: async ({ nextVisibleThreadKeys }) => {
      await onRegularSessionOrderChange(
        nextVisibleThreadKeys.flatMap((threadKey) => {
          const sessionId = getSessionId(threadKey);
          return sessionId === null ? [] : [sessionId];
        }),
      );
    },
  });
  const displayedPinnedThreadKeys = useMemo(
    () =>
      replaceVisibleCodexSidebarThreadKeyOrder({
        threadKeysInDisplayOrder: optimisticPinnedThreadKeys,
        visibleThreadKeys: optimisticSortablePinnedThreadKeys,
        nextVisibleThreadKeys: pinnedReorder.displayedVisibleThreadKeys,
      }),
    [
      optimisticPinnedThreadKeys,
      optimisticSortablePinnedThreadKeys,
      pinnedReorder.displayedVisibleThreadKeys,
    ],
  );
  const displayedRegularThreadKeys = useMemo(
    () =>
      replaceVisibleCodexSidebarThreadKeyOrder({
        threadKeysInDisplayOrder: optimisticRegularThreadKeys,
        visibleThreadKeys: sortableRegularThreadKeys,
        nextVisibleThreadKeys: regularReorder.displayedVisibleThreadKeys,
      }),
    [
      optimisticRegularThreadKeys,
      regularReorder.displayedVisibleThreadKeys,
      sortableRegularThreadKeys,
    ],
  );
  const displayedThreadKeys = useMemo(
    () => [...displayedPinnedThreadKeys, ...displayedRegularThreadKeys],
    [displayedPinnedThreadKeys, displayedRegularThreadKeys],
  );
  const renderDragOverlay = (threadKey: string) => {
    const item = itemsByKey.get(threadKey);
    if (!item) return null;
    return (
      <div className="flex h-[var(--height-token-nav-row)] max-w-80 items-center gap-2 px-2 text-base text-token-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <ThreadIcon className="icon-xs" />
        </span>
        <span className="min-w-0 truncate">{item.title}</span>
      </div>
    );
  };

  return (
    <SidebarPaginatedItems
      items={displayedThreadKeys}
      getKey={(threadKey) => threadKey}
      maxItems={CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      forcedVisibleKey={forcedVisibleKey}
      suppressedKeys={suppressedKeys}
      pagerClassName={CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS}
      hasMoreAtSource={hasMoreAtSource}
      onLoadMore={onLoadMore}
    >
      {(pagination, pager) => {
        const pinnedThreadKeySet = new Set(displayedPinnedThreadKeys);
        const visiblePinnedThreadKeys = pagination.visibleItems.filter((threadKey) =>
          pinnedThreadKeySet.has(threadKey),
        );
        const visibleRegularThreadKeys = pagination.visibleItems.filter(
          (threadKey) => !pinnedThreadKeySet.has(threadKey),
        );

        return (
          <CodexProjectSessionList project={project} showAll={expanded}>
            <SidebarThreadDropContainer containerId={pinnedContainerId} targetProjectKind="local">
              <SidebarThreadSortableRows
                containerId={pinnedContainerId}
                getThreadId={getThreadId}
                visibleThreadKeys={visiblePinnedThreadKeys}
                sortableThreadKeysInDisplayOrder={pinnedReorder.displayedVisibleThreadKeys}
                controller={pinnedReorder.controller}
                dropIndicatorTarget={pinnedReorder.dropIndicatorTarget}
                renderThread={renderThread}
                renderDragOverlay={renderDragOverlay}
                sourceProjectKind="local"
                targetProjectKind="local"
              />
            </SidebarThreadDropContainer>
            <SidebarThreadDropContainer containerId={regularContainerId} targetProjectKind="local">
              <SidebarThreadSortableRows
                containerId={regularContainerId}
                getItemId={(threadKey) => getSessionId(threadKey) ?? undefined}
                getThreadId={getThreadId}
                itemIds={regularReorder.displayedVisibleThreadKeys.flatMap((threadKey) => {
                  const sessionId = getSessionId(threadKey);
                  return sessionId === null ? [] : [sessionId];
                })}
                visibleThreadKeys={visibleRegularThreadKeys}
                sortableThreadKeysInDisplayOrder={regularReorder.displayedVisibleThreadKeys}
                controller={regularReorder.controller}
                dropIndicatorTarget={regularReorder.dropIndicatorTarget}
                renderThread={renderThread}
                renderDragOverlay={renderDragOverlay}
                sourceProjectKind="local"
                targetProjectKind="local"
              />
            </SidebarThreadDropContainer>
            {pagination.visibleItems.length === 0 || collectionState.kind === "error" ? (
              <SidebarSessionCollectionFallback
                state={collectionState}
                loadingText={null}
                emptyText="No chats inside"
                placement="project-child"
                onRetry={onRetry}
              />
            ) : null}
            <SidebarThreadDropContainer
              containerId={regularContainerId}
              projectDropZone="project-pagination"
              targetProjectKind="local"
            >
              {pager}
            </SidebarThreadDropContainer>
          </CodexProjectSessionList>
        );
      }}
    </SidebarPaginatedItems>
  );
}

function SidebarThreadOrganizerSections({
  activeProjectId,
  activeSessionId,
  activePendingClientThreadId,
  contextMenuSessionId,
  sessionCollectionsByProject,
  projectlessSessionCollection,
  expandedProjectIds,
  pinnedThreadsSectionCollapsed,
  pagesSectionCollapsed,
  projectsSectionCollapsed,
  chatsSectionCollapsed,
  sidebarCollapsibleSections,
  onLoadMoreTaskWindow,
  onRetryTaskWindow,
  model,
  onHoverSurfaceOpenChange,
  onTogglePinnedThreadsSectionCollapsed,
  onTogglePagesSectionCollapsed,
  onToggleProjectsSectionCollapsed,
  onToggleChatsSectionCollapsed,
  onSetSidebarSectionCollapsed,
  onToggleProjectExpanded,
  onSelectProject,
  onSelectSession,
  onSelectSidebarThread,
  onPreviewSidebarThread,
  onOpenSessionContextMenu,
  onSessionTitleDoubleClick,
  onPendingWorktreeTitleDoubleClick,
  onArchiveSidebarThread,
  onArchiveThreadItem,
  onMarkThreadItemRead,
  onThreadsChanged,
  onToggleSessionPinned,
  onToggleSidebarThreadPinned,
  onStartNewChatInProject,
  pendingStableWorktrees,
  onOpenStableWorktree,
  onCreateStableWorktree,
  projectPickerOpenTick,
  onCreateProject,
  onUpdateProject,
  onArchiveProject,
  onReorderProjects,
  onSetProjectPinned,
  onSetPinnedProjectOrder,
  onReorderSessions,
  onReorderPinnedThreads,
  sidebarArchivePendingKeys,
  onOpenResourceTarget,
  onOpenResourceTargetInProject,
  activeResourceTarget,
  hasMoreProjects,
  loadingMoreProjects,
  onLoadMoreProjects,
}: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  activePendingClientThreadId?: string | null;
  contextMenuSessionId?: string | null;
  sessionCollectionsByProject: Readonly<Record<string, WorkbenchSessionCollection>>;
  projectlessSessionCollection: WorkbenchSessionCollection;
  expandedProjectIds: Set<string>;
  pinnedThreadsSectionCollapsed: boolean;
  pagesSectionCollapsed: boolean;
  projectsSectionCollapsed: boolean;
  chatsSectionCollapsed: boolean;
  sidebarCollapsibleSections: SidebarCollapsibleSectionsState;
  onLoadMoreTaskWindow: (projectId: string | null) => Promise<void>;
  onRetryTaskWindow: (projectId: string | null) => Promise<void>;
  model: CodexSidebarThreadSyncModel;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
  onTogglePinnedThreadsSectionCollapsed: () => void;
  onTogglePagesSectionCollapsed: () => void;
  onToggleProjectsSectionCollapsed: () => void;
  onToggleChatsSectionCollapsed: () => void;
  onSetSidebarSectionCollapsed: (sectionId: `custom:${string}`, collapsed: boolean) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (session: ProjectSessionDomain) => void;
  onSelectSidebarThread: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onPreviewSidebarThread?: (item: CodexSidebarThreadItem) => void;
  onOpenSessionContextMenu?: (session: ProjectSession, event: ReactMouseEvent<HTMLElement>) => void;
  onSessionTitleDoubleClick?: (
    session: ProjectSession,
    event: ReactMouseEvent<HTMLElement>,
  ) => void;
  onPendingWorktreeTitleDoubleClick?: (
    item: CodexSidebarThreadItem,
    event: ReactMouseEvent<HTMLElement>,
  ) => void;
  onArchiveSidebarThread?: (
    item: CodexSidebarThreadItem,
    session?: ProjectSessionDomain,
  ) => void | Promise<void>;
  onArchiveThreadItem?: (item: CodexSidebarThreadItem) => Promise<boolean>;
  onMarkThreadItemRead?: (item: CodexSidebarThreadItem) => Promise<void>;
  onThreadsChanged?: () => Promise<unknown> | void;
  onToggleSessionPinned?: (session: ProjectSession) => void | Promise<void>;
  onToggleSidebarThreadPinned?: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onStartNewChatInProject: (projectId: string | null) => void | Promise<void>;
  pendingStableWorktrees: readonly StableWorktreeEntry[];
  onOpenStableWorktree: (pendingWorktreeId: string) => void;
  onCreateStableWorktree: (project: Project, projectName: string) => Promise<void>;
  projectPickerOpenTick: number;
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onReorderProjects: (input: ProjectOrderInput) => Promise<void>;
  onSetProjectPinned: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onSetPinnedProjectOrder: (input: ProjectPinnedOrderInput) => Promise<void>;
  onReorderSessions: (
    projectId: string | null,
    orderedSessionIds: readonly string[],
  ) => Promise<void>;
  onReorderPinnedThreads: (orderedThreadIds: readonly string[]) => Promise<unknown>;
  sidebarArchivePendingKeys: ReadonlySet<string>;
  onOpenResourceTarget: (target: LibraryResourceTarget) => void;
  onOpenResourceTargetInProject?: (
    projectId: string,
    target: ActionableLibraryResourceTarget,
    title: string,
  ) => void | Promise<void>;
  activeResourceTarget: LibraryResourceTarget | null;
  hasMoreProjects: boolean;
  loadingMoreProjects: boolean;
  onLoadMoreProjects?: () => Promise<void>;
}) {
  const sectionCatalog = useSidebarSectionsCatalog();
  const sectionSessionsByProject = useMemo<Record<string, ProjectSession[]>>(
    () =>
      Object.fromEntries(
        Object.entries(projectSessionProjectionsByProject(sessionCollectionsByProject)).map(
          ([projectId, sessions]) => [
            projectId,
            sessions.filter((session) => isCodexSidebarRootThread(session.thread)),
          ],
        ),
      ),
    [sessionCollectionsByProject],
  );
  const sessionsByProject = useMemo<Record<string, ProjectSession[]>>(
    () =>
      Object.fromEntries(
        Object.entries(sectionSessionsByProject).map(([projectId, sessions]) => [
          projectId,
          sessions.filter((session) => !sectionCatalog.directSessionIds.has(session.id)),
        ]),
      ),
    [sectionCatalog.directSessionIds, sectionSessionsByProject],
  );
  const rootProjectlessSessions = useMemo(
    () =>
      projectlessSessionCollection.projections.filter((session) =>
        isCodexSidebarRootThread(session.thread),
      ),
    [projectlessSessionCollection.projections],
  );
  const projectlessSessions = useMemo(
    () =>
      rootProjectlessSessions.filter((session) => !sectionCatalog.directSessionIds.has(session.id)),
    [rootProjectlessSessions, sectionCatalog.directSessionIds],
  );
  const directSectionSessions = useMemo(
    () =>
      [...sectionCatalog.itemsBySectionId.values()].flatMap((items) =>
        items.flatMap((item) =>
          item.kind === "session" ? [projectSessionSummaryToDomain(item.session)] : [],
        ),
      ),
    [sectionCatalog.itemsBySectionId],
  );
  const [pinnedProjectsExpanded, setPinnedProjectsExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [expandedProjectThreadListIds, setExpandedProjectThreadListIds] = useState<Set<string>>(
    new Set(),
  );
  const [projectlessThreadListExpanded, setProjectlessThreadListExpanded] = useState(false);
  const [previouslyExpandedProjectGroupIds, setPreviouslyExpandedProjectGroupIds] = useState<
    string[]
  >([]);
  const openHoverSurfaceKeysRef = useRef(new Set<string>());
  const setSidebarHoverSurfaceOpen = useCallback(
    (key: string, open: boolean) => {
      const openKeys = openHoverSurfaceKeysRef.current;
      if (open) {
        openKeys.add(key);
      } else {
        openKeys.delete(key);
      }
      onHoverSurfaceOpenChange?.(openKeys.size > 0);
    },
    [onHoverSurfaceOpenChange],
  );
  const pinnedDropTarget = useSidebarPinnedDropContainer();
  const knownSessions = useMemo(() => {
    const sessions = new Map(directSectionSessions.map((session) => [session.id, session]));
    for (const session of [
      ...Object.values(sectionSessionsByProject).flat(),
      ...rootProjectlessSessions,
    ]) {
      sessions.set(session.id, session);
    }
    return [...sessions.values()];
  }, [directSectionSessions, rootProjectlessSessions, sectionSessionsByProject]);
  const sessionsById = useMemo(
    () => new Map(knownSessions.map((session) => [session.id, session])),
    [knownSessions],
  );
  const sessionsByThreadId = useMemo(() => {
    const entries = knownSessions
      .filter((session) => session.thread)
      .map((session) => [session.thread?.threadId ?? "", session] as const);
    return new Map(entries);
  }, [knownSessions]);
  const fallbackThreadItems = useMemo(() => {
    const existingSessionIds = new Set(
      model.snapshot.items
        .map((item) => item.sessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );
    const existingThreadIds = new Set(model.snapshot.items.map((item) => item.threadId));
    return knownSessions
      .filter((session) => !session.archived)
      .filter((session) => {
        if (existingSessionIds.has(session.id)) return false;
        if (session.thread && existingThreadIds.has(session.thread.threadId)) return false;
        return true;
      })
      .map((session): CodexSidebarThreadItem => {
        const threadId = session.thread?.threadId ?? session.id;
        const hostId = session.thread?.executionHostId ?? "local";
        const local = hostId === "local";
        const managedWorktreePath = session.thread?.managedWorktreePath ?? null;
        return {
          key: `${local ? "local" : "remote"}:session:${session.id}`,
          kind: local ? "local" : "remote",
          runLocation: managedWorktreePath
            ? local
              ? { kind: "local-worktree", path: managedWorktreePath, phase: "ready" }
              : { kind: "remote-worktree", hostId, path: managedWorktreePath, phase: "ready" }
            : local
              ? { kind: "local-checkout" }
              : { kind: "remote-checkout", hostId },
          hostId,
          threadId,
          parentThreadId: session.thread?.parentThreadId ?? null,
          sessionId: session.id,
          projectId: session.projectId,
          title: session.displayTitle,
          preview: session.thread?.threadPreview ?? "",
          cwd: session.thread?.cwd ?? null,
          updatedAt: session.thread?.updatedAt ?? Date.parse(session.updatedAt),
          recencyAt: session.thread?.recencyAt ?? null,
          createdAt: session.thread?.createdAt ?? Date.parse(session.createdAt),
          pinned: session.pinned,
          pinnedOrder: session.pinnedOrder,
          unread: session.unread,
          archived: session.archived || session.thread?.archived === true,
          statusType: (session.thread?.statusType ??
            "notLoaded") as CodexSidebarThreadItem["statusType"],
          statusActiveFlags: (session.thread?.statusActiveFlags ??
            []) as CodexSidebarThreadItem["statusActiveFlags"],
          projectless: session.projectId === null,
          disabled: false,
        };
      });
  }, [knownSessions, model.snapshot.items]);
  const sidebarThreadItemsByKey = useMemo(() => {
    const itemsByKey = new Map(model.threadItemsByKey);
    for (const item of fallbackThreadItems) {
      itemsByKey.set(item.key, item);
    }
    return itemsByKey;
  }, [fallbackThreadItems, model.threadItemsByKey]);
  const getSidebarRealThreadId = useCallback(
    (threadKey: string) => {
      const item = sidebarThreadItemsByKey.get(threadKey);
      if (!item || item.pendingWorktreeId) return null;
      if (model.threadItemsByKey.has(threadKey)) return item.threadId;
      const session = item.sessionId
        ? sessionsById.get(item.sessionId)
        : sessionsByThreadId.get(item.threadId);
      return session?.thread?.threadId ?? null;
    },
    [model.threadItemsByKey, sessionsById, sessionsByThreadId, sidebarThreadItemsByKey],
  );
  const getSidebarSessionId = useCallback(
    (threadKey: string) => {
      const item = sidebarThreadItemsByKey.get(threadKey);
      if (!item || item.pendingWorktreeId) return null;
      if (item.sessionId) return item.sessionId;
      return sessionsByThreadId.get(item.threadId)?.id ?? null;
    },
    [sessionsByThreadId, sidebarThreadItemsByKey],
  );
  const sidebarThreadKeyBySessionId = useMemo(() => {
    const entries: Array<readonly [string, string]> = [];
    for (const [threadKey, item] of sidebarThreadItemsByKey) {
      const sessionId = item.sessionId ?? sessionsByThreadId.get(item.threadId)?.id;
      if (sessionId) entries.push([sessionId, threadKey]);
    }
    return new Map(entries);
  }, [sessionsByThreadId, sidebarThreadItemsByKey]);
  const allPinnedThreadKeys = useMemo(() => {
    const fallbackPinnedThreadKeys = sortSidebarThreadKeysForDisplay({
      threadKeys: fallbackThreadItems.filter((item) => item.pinned).map((item) => item.key),
      itemsByKey: sidebarThreadItemsByKey,
      sessionsById,
    });
    return [...model.pinnedThreadKeys, ...fallbackPinnedThreadKeys];
  }, [fallbackThreadItems, model.pinnedThreadKeys, sessionsById, sidebarThreadItemsByKey]);
  const knownProjectIds = useMemo(
    () => new Set(model.projectGroups.map((group) => group.project.id)),
    [model.projectGroups],
  );
  const pinnedStandaloneThreadKeys = useMemo(
    () =>
      allPinnedThreadKeys.filter((threadKey) => {
        const projectId = sidebarThreadItemsByKey.get(threadKey)?.projectId ?? null;
        return projectId === null || !knownProjectIds.has(projectId);
      }),
    [allPinnedThreadKeys, knownProjectIds, sidebarThreadItemsByKey],
  );
  const sortablePinnedStandaloneThreadKeys = useMemo(
    () =>
      pinnedStandaloneThreadKeys.filter(
        (threadKey) =>
          model.threadItemsByKey.has(threadKey) && !sidebarArchivePendingKeys.has(threadKey),
      ),
    [model.threadItemsByKey, pinnedStandaloneThreadKeys, sidebarArchivePendingKeys],
  );
  const fallbackPinnedStandaloneThreadKeys = useMemo(
    () =>
      pinnedStandaloneThreadKeys.filter(
        (threadKey) =>
          !model.threadItemsByKey.has(threadKey) && !sidebarArchivePendingKeys.has(threadKey),
      ),
    [model.threadItemsByKey, pinnedStandaloneThreadKeys, sidebarArchivePendingKeys],
  );
  const reorderVisiblePinnedThreads = useCallback(
    async ({
      visibleThreadKeys,
      nextVisibleThreadKeys,
    }: {
      visibleThreadKeys: string[];
      nextVisibleThreadKeys: string[];
    }) => {
      const mutation = buildCodexSidebarPinnedReorderMutation({
        pinnedThreadIds: model.snapshot.pinnedThreadIds,
        visibleThreadKeys,
        nextVisibleThreadKeys,
        itemsByKey: sidebarThreadItemsByKey,
      });
      const pendingItemsById = new Map(
        nextVisibleThreadKeys.flatMap((threadKey) => {
          const item = sidebarThreadItemsByKey.get(threadKey);
          return item?.pendingWorktreeId ? [[item.pendingWorktreeId, item] as const] : [];
        }),
      );
      const pendingRequests = mutation.pendingUpdates.flatMap((update) => {
        const pendingItem = pendingItemsById.get(update.pendingWorktreeId);
        if (!pendingItem) return [];
        return [
          invoke(
            "codex:pending-worktree:set-pinned-before-thread",
            pendingItem.hostId,
            update.pendingWorktreeId,
            update.beforeThreadId,
          ).catch(() => {
            toast.danger("Failed to reorder pending chat");
          }),
        ];
      });

      try {
        const pinnedOrderRequest = onReorderPinnedThreads(mutation.pinnedThreadIds).then(
          () => undefined,
        );
        await Promise.all([pinnedOrderRequest, ...pendingRequests]);
      } catch (error) {
        toast.danger("Failed to reorder pinned chats");
        throw error;
      }
    },
    [model.snapshot.pinnedThreadIds, onReorderPinnedThreads, sidebarThreadItemsByKey],
  );
  const allProjectGroups = useMemo(
    () =>
      model.projectGroups.map((group) => {
        const projectPinnedThreadKeySet = new Set([
          ...group.pinnedThreadKeys,
          ...fallbackThreadItems
            .filter((item) => item.projectId === group.project.id && item.pinned)
            .map((item) => item.key),
        ]);
        const pinnedThreadKeys = allPinnedThreadKeys.filter((threadKey) =>
          projectPinnedThreadKeySet.has(threadKey),
        );
        const canonicalThreadKeys = (sessionsByProject[group.project.id] ?? [])
          .filter((session) => !session.pinned)
          .flatMap((session) => {
            const threadKey = sidebarThreadKeyBySessionId.get(session.id);
            return threadKey ? [threadKey] : [];
          });
        const canonicalThreadKeySet = new Set(canonicalThreadKeys);
        const threadKeys = [
          ...canonicalThreadKeys,
          ...group.threadKeys.filter((threadKey) => {
            if (canonicalThreadKeySet.has(threadKey)) return false;
            const sessionId = getSidebarSessionId(threadKey);
            return sessionId === null || !sectionCatalog.directSessionIds.has(sessionId);
          }),
        ];
        return {
          project: group.project,
          pinnedThreadKeys,
          threadKeys,
        };
      }),
    [
      allPinnedThreadKeys,
      fallbackThreadItems,
      model.projectGroups,
      getSidebarSessionId,
      sectionCatalog.directSessionIds,
      sessionsByProject,
      sidebarThreadKeyBySessionId,
    ],
  );
  const defaultProjectGroups = useMemo(
    () =>
      allProjectGroups.filter((group) => !sectionCatalog.directProjectIds.has(group.project.id)),
    [allProjectGroups, sectionCatalog.directProjectIds],
  );
  const projectGroupById = useMemo(
    () => new Map(allProjectGroups.map((group) => [group.project.id, group] as const)),
    [allProjectGroups],
  );
  const stableWorktreeWorkspaceRootOptions = useMemo(
    () => allProjectGroups.flatMap(({ project }) => project.sources.map((source) => source.root)),
    [allProjectGroups],
  );
  const stableWorktreeWorkspaceRootLabels = useMemo(
    () =>
      Object.fromEntries(
        allProjectGroups.flatMap(({ project }) =>
          project.sources.map((source) => [source.root, project.name] as const),
        ),
      ),
    [allProjectGroups],
  );
  const projectLabelById = useMemo(() => {
    const entries = allProjectGroups.map(({ project }) => [project.id, project.name] as const);
    return new Map(entries);
  }, [allProjectGroups]);
  const projectOrderIds = useMemo(
    () => defaultProjectGroups.map((group) => group.project.id),
    [defaultProjectGroups],
  );
  const allProjectIds = useMemo(
    () => allProjectGroups.map((group) => group.project.id),
    [allProjectGroups],
  );
  const projectActivityQuery = useQuery(projectActivitySummariesQueryOptions(allProjectIds));
  const projectActivityById = useMemo(
    () =>
      new Map(
        (projectActivityQuery.data?.summaries ?? []).map(
          (summary) => [summary.projectId, summary] as const,
        ),
      ),
    [projectActivityQuery.data?.summaries],
  );
  const pinnedProjectGroups = useMemo(
    () =>
      defaultProjectGroups
        .filter((group) => group.project.pinned)
        .sort(
          (left, right) =>
            (left.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER),
        ),
    [defaultProjectGroups],
  );
  const pinnedProjectIds = useMemo(
    () => pinnedProjectGroups.map((group) => group.project.id),
    [pinnedProjectGroups],
  );
  const unpinnedProjectGroups = useMemo(
    () => defaultProjectGroups.filter((group) => !group.project.pinned),
    [defaultProjectGroups],
  );
  const visibleProjectGroupIds = useMemo(
    () => unpinnedProjectGroups.map((group) => group.project.id),
    [unpinnedProjectGroups],
  );
  const projectGroupCollapseAction = useMemo(
    () =>
      resolveSidebarProjectGroupCollapseAction({
        visibleGroupIds: visibleProjectGroupIds,
        expandedGroupIds: expandedProjectIds,
        previouslyExpandedGroupIds: previouslyExpandedProjectGroupIds,
      }),
    [expandedProjectIds, previouslyExpandedProjectGroupIds, visibleProjectGroupIds],
  );
  const runProjectGroupCollapseAction = useCallback(
    (action: SidebarProjectGroupCollapseAction) => {
      if (action === "collapse-all") {
        const expandedVisibleProjectGroupIds = listExpandedVisibleProjectGroupIds(
          visibleProjectGroupIds,
          expandedProjectIds,
        );
        if (expandedVisibleProjectGroupIds.length === 0) return;

        setPreviouslyExpandedProjectGroupIds(expandedVisibleProjectGroupIds);
        for (const projectId of expandedVisibleProjectGroupIds) {
          onToggleProjectExpanded(projectId);
        }
        return;
      }

      const reopenableProjectGroupIds = listReopenableVisibleProjectGroupIds(
        visibleProjectGroupIds,
        previouslyExpandedProjectGroupIds,
      ).filter((projectId) => !expandedProjectIds.has(projectId));
      setPreviouslyExpandedProjectGroupIds([]);
      for (const projectId of reopenableProjectGroupIds) {
        onToggleProjectExpanded(projectId);
      }
    },
    [
      expandedProjectIds,
      onToggleProjectExpanded,
      previouslyExpandedProjectGroupIds,
      visibleProjectGroupIds,
    ],
  );
  const reorderVisibleProjectGroups = useCallback(
    (visibleGroupIds: string[], nextVisibleGroupIds: string[]) => {
      const orderedProjectIds = replaceVisibleOrder(
        projectOrderIds,
        visibleGroupIds,
        nextVisibleGroupIds,
      );
      return onReorderProjects({ orderedProjectIds }).then(() => undefined);
    },
    [onReorderProjects, projectOrderIds],
  );
  const reorderVisiblePinnedProjectGroups = useCallback(
    (visibleGroupIds: string[], nextVisibleGroupIds: string[]) => {
      const orderedProjectIds = replaceVisibleOrder(
        pinnedProjectIds,
        visibleGroupIds,
        nextVisibleGroupIds,
      );
      return onSetPinnedProjectOrder({ orderedProjectIds }).then(() => undefined);
    },
    [onSetPinnedProjectOrder, pinnedProjectIds],
  );
  const hasVisiblePinnedStandaloneThreads = pinnedStandaloneThreadKeys.some(
    (threadKey) => !sidebarArchivePendingKeys.has(threadKey),
  );
  const hasVisiblePinnedSectionItems =
    hasVisiblePinnedStandaloneThreads || pinnedProjectGroups.length > 0;
  const projectlessThreadKeys = useMemo(() => {
    const canonicalThreadKeys = projectlessSessions
      .filter((session) => !session.pinned)
      .flatMap((session) => {
        const threadKey = sidebarThreadKeyBySessionId.get(session.id);
        return threadKey ? [threadKey] : [];
      });
    const canonicalThreadKeySet = new Set(canonicalThreadKeys);
    return [
      ...canonicalThreadKeys,
      ...model.snapshot.items
        .filter((item) => item.projectless && !item.pinned && !canonicalThreadKeySet.has(item.key))
        .map((item) => item.key),
    ];
  }, [model.snapshot.items, projectlessSessions, sidebarThreadKeyBySessionId]);
  const canonicalThreadLanes = useMemo<SidebarThreadCanonicalLanes>(() => {
    const threadIdsForKeys = (threadKeys: readonly string[]) =>
      threadKeys.flatMap((threadKey) => {
        const threadId = getSidebarRealThreadId(threadKey);
        return threadId === null ? [] : [threadId];
      });
    const lanes = new Map<
      string,
      {
        projectionRevision: number | null;
        threadIds: readonly string[];
      }
    >();
    lanes.set("pinned", {
      projectionRevision: null,
      threadIds: threadIdsForKeys(pinnedStandaloneThreadKeys),
    });
    lanes.set("chats", {
      projectionRevision: projectlessSessionCollection.projectionRevision,
      threadIds: threadIdsForKeys(projectlessThreadKeys),
    });
    for (const group of allProjectGroups) {
      const projectionRevision =
        sessionCollectionsByProject[group.project.id]?.projectionRevision ?? null;
      lanes.set(codexSidebarProjectThreadContainerId(group.project.id, true), {
        projectionRevision,
        threadIds: threadIdsForKeys(group.pinnedThreadKeys),
      });
      lanes.set(codexSidebarProjectThreadContainerId(group.project.id, false), {
        projectionRevision,
        threadIds: threadIdsForKeys(group.threadKeys),
      });
    }
    return lanes;
  }, [
    getSidebarRealThreadId,
    pinnedStandaloneThreadKeys,
    allProjectGroups,
    projectlessSessionCollection.projectionRevision,
    projectlessThreadKeys,
    sessionCollectionsByProject,
  ]);
  useReportSidebarThreadCanonicalLanes(canonicalThreadLanes);
  const activeThreadKey = useMemo(() => {
    if (activePendingClientThreadId) {
      for (const [key, item] of sidebarThreadItemsByKey) {
        if ((item.clientThreadId ?? item.threadId) === activePendingClientThreadId) return key;
      }
    }
    if (!activeSessionId) return null;
    const activeSession = sessionsById.get(activeSessionId);

    for (const [key, item] of sidebarThreadItemsByKey) {
      if (item.sessionId === activeSessionId) return key;
      if (activeSession?.thread && item.threadId === activeSession.thread.threadId) return key;
    }

    return activeSession ? `local:session:${activeSession.id}` : null;
  }, [activePendingClientThreadId, activeSessionId, sessionsById, sidebarThreadItemsByKey]);

  const setProjectThreadListExpanded = useCallback((projectId: string, expanded: boolean) => {
    setExpandedProjectThreadListIds((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(projectId);
      } else {
        next.delete(projectId);
      }
      return next;
    });
  }, []);

  const resolveSessionForItem = useCallback(
    (item: CodexSidebarThreadItem) => {
      if (item.sessionId) {
        const session = sessionsById.get(item.sessionId);
        if (session) return session;
      }
      return sessionsByThreadId.get(item.threadId) ?? null;
    },
    [sessionsById, sessionsByThreadId],
  );

  const renderThreadRow = useCallback(
    (
      threadKey: string,
      options: {
        hoverCardProjectLabel?: string | null;
        grouped?: boolean;
      } = {},
    ) => {
      const item = sidebarThreadItemsByKey.get(threadKey);
      if (!item) return null;
      const session = resolveSessionForItem(item);
      const sessionId = item.sessionId ?? session?.id ?? null;
      const hoverCardProjectLabel =
        options.hoverCardProjectLabel ??
        (item.projectId ? (projectLabelById.get(item.projectId) ?? null) : null);

      return (
        <CodexSidebarThreadRow
          key={item.key}
          item={item}
          grouped={options.grouped}
          active={
            (item.clientThreadId ?? item.threadId) === activePendingClientThreadId ||
            Boolean(sessionId && activeSessionId === sessionId)
          }
          contextMenuOpen={Boolean(sessionId && contextMenuSessionId === sessionId)}
          hoverCardProjectLabel={hoverCardProjectLabel}
          onHoverCardOpenChange={(open) => {
            setSidebarHoverSurfaceOpen(`thread:${item.key}`, open);
          }}
          onSelect={() => {
            if (session) {
              onSelectSession(session);
              return;
            }
            void onSelectSidebarThread(item);
          }}
          onPreview={() => onPreviewSidebarThread?.(item)}
          onOpenContextMenu={
            session && onOpenSessionContextMenu
              ? (_item, event) => onOpenSessionContextMenu(session, event)
              : undefined
          }
          onRenameFromTitleDoubleClick={
            session && onSessionTitleDoubleClick
              ? (_item, event) => onSessionTitleDoubleClick(session, event)
              : item.kind === "pending-worktree" && onPendingWorktreeTitleDoubleClick
                ? (_item, event) => onPendingWorktreeTitleDoubleClick(item, event)
                : undefined
          }
          archivePending={sidebarArchivePendingKeys.has(item.key)}
          onArchive={
            onArchiveSidebarThread
              ? (rowItem) => onArchiveSidebarThread(rowItem, session ?? undefined)
              : undefined
          }
          onTogglePinned={
            session && onToggleSessionPinned
              ? () => onToggleSessionPinned(session)
              : onToggleSidebarThreadPinned
          }
        />
      );
    },
    [
      activeSessionId,
      activePendingClientThreadId,
      contextMenuSessionId,
      onOpenSessionContextMenu,
      onArchiveSidebarThread,
      onSelectSession,
      onSelectSidebarThread,
      onPreviewSidebarThread,
      onSessionTitleDoubleClick,
      onPendingWorktreeTitleDoubleClick,
      onToggleSessionPinned,
      onToggleSidebarThreadPinned,
      projectLabelById,
      resolveSessionForItem,
      setSidebarHoverSurfaceOpen,
      sidebarArchivePendingKeys,
      sidebarThreadItemsByKey,
    ],
  );

  const renderThreadList = useCallback(
    (
      threadKeys: string[],
      emptyText: string,
      options: {
        ariaLabel?: string;
        maxItems?: number | null;
        expanded?: boolean;
        onExpandedChange?: (expanded: boolean) => void;
        forcedVisibleKey?: string | null;
      } = {},
    ) => (
      <SidebarPaginatedItems
        items={threadKeys}
        getKey={(threadKey) => threadKey}
        maxItems={options.maxItems}
        expanded={options.expanded ?? false}
        onExpandedChange={options.onExpandedChange}
        forcedVisibleKey={options.forcedVisibleKey ?? null}
        suppressedKeys={sidebarArchivePendingKeys}
      >
        {(pagination, pager) => (
          <div className="isolate flex flex-col [contain:layout]">
            <div className="flex flex-col" role="list" aria-label={options.ariaLabel}>
              {pagination.visibleItems.length > 0 ? (
                pagination.visibleItems.map((threadKey) => renderThreadRow(threadKey))
              ) : (
                <div
                  className="px-row-x py-row-y text-sm text-token-description-foreground"
                  role="listitem"
                >
                  {emptyText}
                </div>
              )}
              {pager}
            </div>
          </div>
        )}
      </SidebarPaginatedItems>
    ),
    [renderThreadRow, sidebarArchivePendingKeys],
  );

  const renderProjectGroup = (
    { project, pinnedThreadKeys, threadKeys }: CodexSidebarProjectGroup,
    dnd: CodexProjectRowDndCapability,
    currentSectionId: string | null = null,
  ) => {
    const expanded = expandedProjectIds.has(project.id);
    const threadListExpanded = expandedProjectThreadListIds.has(project.id);
    const projectThreadItems = Array.from(new Set([...pinnedThreadKeys, ...threadKeys]))
      .map((threadKey) => sidebarThreadItemsByKey.get(threadKey))
      .filter((item): item is CodexSidebarThreadItem => item != null);

    return (
      <CodexProjectRow
        key={project.id}
        project={project}
        activity={
          projectActivityQuery.isPending
            ? undefined
            : projectActivityQuery.isError
              ? null
              : (projectActivityById.get(project.id) ?? null)
        }
        active={activeSessionId === null && activeProjectId === project.id}
        expanded={expanded}
        dnd={dnd}
        threadItems={projectThreadItems}
        onActivate={() => onToggleProjectExpanded(project.id)}
        onSelectProject={() => onSelectProject(project.id)}
        onStartNewChat={() => void onStartNewChatInProject(project.id)}
        onUpdateProject={onUpdateProject}
        onArchiveProject={onArchiveProject}
        onSetProjectPinned={onSetProjectPinned}
        onCreateStableWorktree={onCreateStableWorktree}
        stableWorktreeWorkspaceRootOptions={stableWorktreeWorkspaceRootOptions}
        stableWorktreeWorkspaceRootLabels={stableWorktreeWorkspaceRootLabels}
        onArchiveThreadItem={onArchiveThreadItem}
        onMarkThreadItemRead={onMarkThreadItemRead}
        onThreadsChanged={onThreadsChanged}
        sectionCatalog={sectionCatalog}
        currentSectionId={currentSectionId}
        sectionActions={
          <SidebarProjectSectionMenu
            projectId={project.id}
            catalog={sectionCatalog}
            currentSectionId={currentSectionId}
            pinned={project.pinned}
          />
        }
        onHoverCardOpenChange={(open) => {
          setSidebarHoverSurfaceOpen(`project:${project.id}`, open);
        }}
      >
        <SidebarProjectThreadRowsContent
          project={project}
          pinnedThreadKeys={pinnedThreadKeys}
          sortablePinnedThreadKeys={pinnedThreadKeys.filter(
            (threadKey) =>
              model.threadItemsByKey.has(threadKey) && !sidebarArchivePendingKeys.has(threadKey),
          )}
          threadKeys={threadKeys}
          expanded={threadListExpanded}
          onExpandedChange={(nextExpanded) => {
            setProjectThreadListExpanded(project.id, nextExpanded);
          }}
          forcedVisibleKey={activeThreadKey}
          suppressedKeys={sidebarArchivePendingKeys}
          collectionState={
            sessionCollectionsByProject[project.id]?.state ?? IDLE_SESSION_COLLECTION_STATE
          }
          hasMoreAtSource={sessionCollectionsByProject[project.id]?.hasMore === true}
          onLoadMore={() => onLoadMoreTaskWindow(project.id)}
          onRetry={() => onRetryTaskWindow(project.id)}
          onPinnedThreadOrderChange={reorderVisiblePinnedThreads}
          onRegularSessionOrderChange={(orderedSessionIds) =>
            onReorderSessions(project.id, orderedSessionIds)
          }
          getSessionId={getSidebarSessionId}
          getThreadId={getSidebarRealThreadId}
          itemsByKey={sidebarThreadItemsByKey}
          renderThread={(threadKey) =>
            renderThreadRow(threadKey, {
              hoverCardProjectLabel: project.name,
              grouped: true,
            })
          }
        />
      </CodexProjectRow>
    );
  };

  const renderProjectGroupRows = (
    groups: CodexSidebarProjectGroup[],
    options: {
      reorderScope: "projects" | "pinned";
      expanded: boolean;
      onExpandedChange: (expanded: boolean) => void;
      emptyText?: string;
      readsProjectWindow?: boolean;
    },
  ) => (
    <SidebarPaginatedItems
      items={groups}
      getKey={(group) => group.project.id}
      maxItems={CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS}
      expanded={options.expanded}
      onExpandedChange={options.onExpandedChange}
      forcedVisibleKey={activeProjectId}
      hasMoreAtSource={options.readsProjectWindow === true && hasMoreProjects}
      onLoadMore={options.readsProjectWindow ? onLoadMoreProjects : undefined}
    >
      {(pagination, pager) => {
        const visibleGroupIds = pagination.visibleItems.map((group) => group.project.id);
        return (
          <SidebarProjectGroupRowsContent
            visibleItems={pagination.visibleItems}
            pager={pager}
            emptyText={options.emptyText ?? "No projects"}
            loading={loadingMoreProjects}
            reorderGroups={(nextVisibleGroupIds) => {
              if (options.reorderScope === "pinned") {
                return reorderVisiblePinnedProjectGroups(visibleGroupIds, nextVisibleGroupIds);
              }
              return reorderVisibleProjectGroups(visibleGroupIds, nextVisibleGroupIds);
            }}
            renderProjectGroup={(group, groupDndController) =>
              renderProjectGroup(group, { controller: groupDndController })
            }
          />
        );
      }}
    </SidebarPaginatedItems>
  );

  const renderPinnedSection = () => {
    if (
      !hasVisiblePinnedSectionItems &&
      !pinnedDropTarget.projectDragActive &&
      !pinnedDropTarget.isExternalThreadDropTarget
    ) {
      return null;
    }

    if (!hasVisiblePinnedSectionItems) {
      return (
        <div
          ref={pinnedDropTarget.setNodeRef}
          className={cn(
            "-my-4 px-row-x",
            pinnedDropTarget.projectDragActive &&
              pinnedDropTarget.isOver &&
              "rounded-[10px] bg-token-bg-secondary/40 ring-1 ring-inset ring-token-border",
            pinnedDropTarget.isExternalThreadDropTarget &&
              pinnedDropTarget.isOver &&
              "rounded-[10px] bg-token-bg-secondary/40",
          )}
        >
          <div className="h-4">
            {pinnedDropTarget.projectDragActive && pinnedDropTarget.isOver ? (
              <SidebarDropIndicator />
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div
        ref={pinnedDropTarget.setNodeRef}
        className={cn(
          "relative",
          pinnedDropTarget.isExternalThreadDropTarget &&
            pinnedDropTarget.isOver &&
            "rounded-lg bg-token-list-hover-background",
        )}
      >
        <CodexSidebarSection
          heading="Pinned"
          collapsed={pinnedThreadsSectionCollapsed}
          onToggle={onTogglePinnedThreadsSectionCollapsed}
        >
          {sortablePinnedStandaloneThreadKeys.length > 0 ? (
            <SidebarPinnedThreadRowsContent
              containerId="pinned"
              getThreadId={getSidebarRealThreadId}
              visibleThreadKeys={sortablePinnedStandaloneThreadKeys}
              itemsByKey={sidebarThreadItemsByKey}
              ariaLabel="Pinned chats"
              onVisibleThreadOrderChange={reorderVisiblePinnedThreads}
              renderThread={renderThreadRow}
            />
          ) : null}
          {fallbackPinnedStandaloneThreadKeys.length > 0
            ? renderThreadList(fallbackPinnedStandaloneThreadKeys, "No pinned chats", {
                ariaLabel: "Pinned local views",
              })
            : null}
          {pinnedProjectGroups.length > 0
            ? renderProjectGroupRows(pinnedProjectGroups, {
                reorderScope: "pinned",
                expanded: pinnedProjectsExpanded,
                onExpandedChange: setPinnedProjectsExpanded,
              })
            : null}
        </CodexSidebarSection>
      </div>
    );
  };

  const renderProjectGroups = () => (
    <>
      {renderPinnedSection()}
      <SidebarPagesSection
        collapsed={pagesSectionCollapsed}
        activeRoot={activeResourceTarget}
        onToggle={onTogglePagesSectionCollapsed}
        onOpenRoot={onOpenResourceTarget}
        projects={allProjectGroups.map(({ project }) => ({
          id: project.id,
          name: project.name,
        }))}
        onOpenInProject={onOpenResourceTargetInProject}
      />
      <SidebarCustomSections
        catalog={sectionCatalog}
        sessionsByProject={sectionSessionsByProject}
        renderProject={({ controller, item, itemIds, nextItemId, sectionId }) => {
          const group = projectGroupById.get(item.project.projectId);
          if (!group) return null;
          return renderProjectGroup(
            group,
            {
              containerId: sidebarSectionContainerId(sectionId),
              controller,
              itemId: item.placementId,
              itemIds,
              nextItemId,
              sortableId: item.placementId,
            },
            sectionId,
          );
        }}
        renderSession={(session) => {
          // A Section owns placement only. Chat presentation and behavior must stay on the
          // same shared row used by Projects, Pinned, and Chats.
          const threadKey = sidebarThreadKeyBySessionId.get(session.id);
          return threadKey ? renderThreadRow(threadKey) : null;
        }}
        onSelectSession={onSelectSession}
        activeSessionId={activeSessionId}
        collapsedSections={sidebarCollapsibleSections}
        onSetCollapsed={onSetSidebarSectionCollapsed}
        onThreadsChanged={onThreadsChanged}
        getThreadKey={(sessionId) =>
          sidebarThreadKeyBySessionId.get(sessionId) ?? `section-session:${sessionId}`
        }
      />
      <CodexSidebarSection
        heading="Projects"
        collapsed={projectsSectionCollapsed}
        onToggle={onToggleProjectsSectionCollapsed}
        actions={
          <SidebarProjectsSectionActions
            projectGroupCollapseAction={projectGroupCollapseAction}
            onProjectGroupCollapseAction={runProjectGroupCollapseAction}
            onCreateProject={onCreateProject}
            openCreateDialogTick={projectPickerOpenTick}
          />
        }
      >
        <StableWorktreeSidebarRows entries={pendingStableWorktrees} onOpen={onOpenStableWorktree} />
        {renderProjectGroupRows(unpinnedProjectGroups, {
          reorderScope: "projects",
          expanded: projectsExpanded,
          onExpandedChange: setProjectsExpanded,
          readsProjectWindow: true,
        })}
      </CodexSidebarSection>
      <CodexSidebarSection
        heading="Chats"
        collapsed={chatsSectionCollapsed}
        onToggle={onToggleChatsSectionCollapsed}
        actions={
          <CodexSidebarActionButton
            label="New projectless chat"
            data-app-action-sidebar-projectless-new-chat=""
            onClick={() => void onStartNewChatInProject(null)}
          >
            <NewChatIcon />
          </CodexSidebarActionButton>
        }
      >
        <SidebarThreadContainerRowsContent
          containerId="chats"
          threadKeys={projectlessThreadKeys}
          getSessionId={getSidebarSessionId}
          getThreadId={getSidebarRealThreadId}
          itemsByKey={sidebarThreadItemsByKey}
          expanded={projectlessThreadListExpanded}
          onExpandedChange={setProjectlessThreadListExpanded}
          forcedVisibleKey={activeThreadKey}
          suppressedKeys={sidebarArchivePendingKeys}
          collectionState={projectlessSessionCollection.state}
          hasMoreAtSource={projectlessSessionCollection.hasMore}
          onLoadMore={() => onLoadMoreTaskWindow(null)}
          onRetry={() => onRetryTaskWindow(null)}
          onVisibleSessionOrderChange={(orderedSessionIds) =>
            onReorderSessions(null, orderedSessionIds)
          }
          renderThread={renderThreadRow}
        />
      </CodexSidebarSection>
    </>
  );

  return renderProjectGroups();
}

export interface ProjectSessionSidebarProps {
  floating?: boolean;
  header?: ReactNode;
  activeProjectId: string | null;
  activeSessionId: string | null;
  activePendingClientThreadId?: string | null;
  contextMenuSessionId?: string | null;
  sessionCollectionsByProject: Readonly<Record<string, WorkbenchSessionCollection>>;
  projectlessSessionCollection: WorkbenchSessionCollection;
  sidebarThreadModel: CodexSidebarThreadSyncModel;
  pendingStableWorktrees: readonly StableWorktreeEntry[];
  expandedProjectIds: Set<string>;
  pinnedProjectsSectionCollapsed: boolean;
  pagesSectionCollapsed: boolean;
  projectsSectionCollapsed: boolean;
  chatsSectionCollapsed: boolean;
  sidebarCollapsibleSections: SidebarCollapsibleSectionsState;
  onLoadMoreTaskWindow: (projectId: string | null) => Promise<void>;
  onRetryTaskWindow: (projectId: string | null) => Promise<void>;
  width: number;
  animatedWidth?: MotionValue<number>;
  contentOpacity?: MotionValue<number>;
  resizeDisabled?: boolean;
  getWindowZoom?: () => number;
  onResizeWidth: (
    width: number,
    phase?: SidebarResizePhase,
    surface?: SidebarResizeSurface,
  ) => void;
  onResizeActiveChange?: (active: boolean) => void;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
  onTogglePinnedProjectsSectionCollapsed: () => void;
  onTogglePagesSectionCollapsed: () => void;
  onToggleProjectsSectionCollapsed: () => void;
  onToggleChatsSectionCollapsed: () => void;
  onSetSidebarSectionCollapsed: (sectionId: `custom:${string}`, collapsed: boolean) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (session: ProjectSessionDomain) => void;
  onSelectSidebarThread: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onPreviewSidebarThread?: (item: CodexSidebarThreadItem) => void;
  onOpenSessionContextMenu?: (session: ProjectSession, event: ReactMouseEvent<HTMLElement>) => void;
  onSessionTitleDoubleClick?: (
    session: ProjectSession,
    event: ReactMouseEvent<HTMLElement>,
  ) => void;
  onPendingWorktreeTitleDoubleClick?: (
    item: CodexSidebarThreadItem,
    event: ReactMouseEvent<HTMLElement>,
  ) => void;
  onArchiveSidebarThread?: (
    item: CodexSidebarThreadItem,
    session?: ProjectSessionDomain,
  ) => void | Promise<void>;
  onArchiveThreadItem?: (item: CodexSidebarThreadItem) => Promise<boolean>;
  onMarkThreadItemRead?: (item: CodexSidebarThreadItem) => Promise<void>;
  onThreadsChanged?: () => Promise<unknown> | void;
  onToggleSessionPinned?: (session: ProjectSession) => void | Promise<void>;
  onToggleSidebarThreadPinned?: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onStartNewChatInProject: (projectId: string | null) => void | Promise<void>;
  onOpenStableWorktree: (pendingWorktreeId: string) => void;
  onCreateStableWorktree: (project: Project, projectName: string) => Promise<void>;
  onOpenCommandPalette: () => void;
  onShowUnavailableProduct: (label: string) => void;
  onOpenAutomations: () => void;
  onOpenResourceTarget: (target: LibraryResourceTarget) => void;
  onOpenResourceTargetInProject?: (
    projectId: string,
    target: ActionableLibraryResourceTarget,
    title: string,
  ) => void | Promise<void>;
  activeResourceTarget: LibraryResourceTarget | null;
  automationsActive: boolean;
  projectPickerOpenTick?: number;
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onReorderProjects: (input: ProjectOrderInput) => Promise<void>;
  onSetProjectPinned: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onSetPinnedProjectOrder: (input: ProjectPinnedOrderInput) => Promise<void>;
  onReorderSessions: (
    projectId: string | null,
    orderedSessionIds: readonly string[],
  ) => Promise<void>;
  onMoveSidebarThread: (drop: SidebarThreadDropRequest) => Promise<SidebarThreadDropCommit | null>;
  onReorderPinnedThreads: (orderedThreadIds: readonly string[]) => Promise<unknown>;
  onOpenSettings: () => void;
  account: CodexAccountSnapshot | null;
  connection: CodexConnectionState;
  onRefreshAccount: () => Promise<CodexAccountSnapshot>;
  onConsumeRateLimitReset: ReturnType<typeof useCodexAccountActions>["consumeRateLimitReset"];
  onStartChatGptLogin: ReturnType<typeof useCodexAccountActions>["startChatGptLogin"];
  onStartApiKeyLogin: ReturnType<typeof useCodexAccountActions>["startApiKeyLogin"];
  onCancelLogin: ReturnType<typeof useCodexAccountActions>["cancelLogin"];
  onLogout: () => Promise<void>;
  onAccountErrorMessage: (message: string | null) => void;
  sidebarArchivePendingKeys: ReadonlySet<string>;
  hasMoreProjects: boolean;
  loadingMoreProjects: boolean;
  onLoadMoreProjects?: () => Promise<void>;
}

export function ProjectSessionSidebar({
  floating = false,
  header,
  activeProjectId,
  activeSessionId,
  activePendingClientThreadId,
  contextMenuSessionId,
  sessionCollectionsByProject,
  projectlessSessionCollection,
  sidebarThreadModel,
  pendingStableWorktrees,
  expandedProjectIds,
  pinnedProjectsSectionCollapsed,
  pagesSectionCollapsed,
  projectsSectionCollapsed,
  chatsSectionCollapsed,
  sidebarCollapsibleSections,
  onLoadMoreTaskWindow,
  onRetryTaskWindow,
  width,
  animatedWidth,
  contentOpacity,
  resizeDisabled = false,
  getWindowZoom,
  onResizeWidth,
  onResizeActiveChange,
  onHoverSurfaceOpenChange,
  onTogglePinnedProjectsSectionCollapsed,
  onTogglePagesSectionCollapsed,
  onToggleProjectsSectionCollapsed,
  onToggleChatsSectionCollapsed,
  onSetSidebarSectionCollapsed,
  onToggleProjectExpanded,
  onSelectProject,
  onSelectSession,
  onSelectSidebarThread,
  onPreviewSidebarThread,
  onOpenSessionContextMenu,
  onSessionTitleDoubleClick,
  onPendingWorktreeTitleDoubleClick,
  onArchiveSidebarThread,
  onArchiveThreadItem,
  onMarkThreadItemRead,
  onThreadsChanged,
  onToggleSessionPinned,
  onToggleSidebarThreadPinned,
  onStartNewChatInProject,
  onOpenStableWorktree,
  onCreateStableWorktree,
  onOpenCommandPalette,
  onShowUnavailableProduct,
  onOpenAutomations,
  onOpenResourceTarget,
  onOpenResourceTargetInProject,
  activeResourceTarget,
  automationsActive,
  projectPickerOpenTick = 0,
  onCreateProject,
  onUpdateProject,
  onArchiveProject,
  onReorderProjects,
  onSetProjectPinned,
  onSetPinnedProjectOrder,
  onReorderSessions,
  onMoveSidebarThread,
  onReorderPinnedThreads,
  onOpenSettings,
  account,
  connection,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onStartChatGptLogin,
  onStartApiKeyLogin,
  onCancelLogin,
  onLogout,
  onAccountErrorMessage,
  sidebarArchivePendingKeys,
  hasMoreProjects,
  loadingMoreProjects,
  onLoadMoreProjects,
}: ProjectSessionSidebarProps) {
  const queryClient = useQueryClient();
  const sectionCatalog = useSidebarSectionsCatalog();
  const knownSidebarSessions = useMemo(() => {
    const sessions = new Map<string, ProjectSessionDomain>();
    for (const items of sectionCatalog.itemsBySectionId.values()) {
      for (const item of items) {
        if (item.kind !== "session") continue;
        const session = projectSessionSummaryToDomain(item.session);
        sessions.set(session.id, session);
      }
    }
    for (const session of [
      ...Object.values(sessionCollectionsByProject).flatMap((collection) => collection.projections),
      ...projectlessSessionCollection.projections,
    ]) {
      if (!isCodexSidebarRootThread(session.thread)) continue;
      sessions.set(session.id, session);
    }
    return [...sessions.values()];
  }, [
    projectlessSessionCollection.projections,
    sectionCatalog.itemsBySectionId,
    sessionCollectionsByProject,
  ]);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [pendingLibraryGrantDrop, setPendingLibraryGrantDrop] = useState<{
    readonly resource: SidebarLibraryDragResource;
    readonly projectId: string;
  } | null>(null);
  const [libraryGrantAccess, setLibraryGrantAccess] = useState<"read" | "read_write">("read_write");
  const { mutation: libraryMutation } = useApplyLibraryOperation();
  const sidebarScrollChrome = useSidebarScrollChrome();
  const sidebarResizeDisabled = resizeDisabled;
  const sidebarResizeSurface: SidebarResizeSurface = floating ? "floating" : "inline";
  const setSidebarResizeActive = (active: boolean) => {
    setSidebarResizing(active);
    onResizeActiveChange?.(active);
  };
  useEffect(
    () => () => {
      onHoverSurfaceOpenChange?.(false);
    },
    [onHoverSurfaceOpenChange],
  );
  const handleProjectDrop = useCallback(
    (drop: SidebarProjectDropRequest) => {
      const sectionId = readSidebarSectionContainerId(drop.targetContainerId);
      if (sectionId) {
        const targetItems = sectionCatalog.itemsBySectionId.get(sectionId) ?? [];
        void invokeCoreResult("sidebar-sections:item:move", {
          item: { kind: "project", projectId: drop.projectId },
          sectionId,
          placement: resolveSidebarSectionItemPlacement(targetItems, drop.beforeItemId),
        })
          .then(async () => {
            onSetSidebarSectionCollapsed(`custom:${sectionId}`, false);
            await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
          })
          .catch(() => toast.danger("Failed to move project to section"));
        return;
      }
      if (drop.targetContainerId === "pinned") {
        void onSetProjectPinned(drop.projectId, { pinned: true }).catch(() => {
          toast.danger("Failed to pin project");
        });
      }
    },
    [
      onSetProjectPinned,
      onSetSidebarSectionCollapsed,
      queryClient,
      sectionCatalog.itemsBySectionId,
    ],
  );
  const handleLibraryMove = useCallback(
    async ({
      resource,
      parent,
    }: {
      resource: SidebarLibraryDragResource;
      parent: import("../../../shared/library-module").LibraryWriteParent;
    }) => {
      try {
        await libraryMutation.mutateAsync(
          buildLibraryMoveOperation({
            target: resource.target,
            expectedLocationRevision: resource.expectedLocationRevision,
            parent,
          }),
        );
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : "Could not move Library item");
      }
    },
    [libraryMutation],
  );
  const confirmLibraryGrantDrop = useCallback(async () => {
    if (!pendingLibraryGrantDrop) return;
    const project = sidebarThreadModel.projectGroups.find(
      (group) => group.project.id === pendingLibraryGrantDrop.projectId,
    )?.project;
    if (!project) {
      toast.danger("The destination Project is no longer active");
      setPendingLibraryGrantDrop(null);
      return;
    }
    try {
      const receipt = await libraryMutation.mutateAsync(
        buildLibraryProjectGrantOperation({
          projectId: project.id,
          target: pendingLibraryGrantDrop.resource.target,
          access: libraryGrantAccess,
        }),
      );
      if (!receipt.didMutate) toast.info(`${project.name} already has this access`);
      setPendingLibraryGrantDrop(null);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not grant Project access");
    }
  }, [
    libraryGrantAccess,
    libraryMutation,
    pendingLibraryGrantDrop,
    sidebarThreadModel.projectGroups,
  ]);
  const pendingLibraryGrantProject = pendingLibraryGrantDrop
    ? (sidebarThreadModel.projectGroups.find(
        (group) => group.project.id === pendingLibraryGrantDrop.projectId,
      )?.project ?? null)
    : null;
  const sidebarThreadIdByKey = useMemo(() => {
    const entries: Array<readonly [string, string]> = [];
    for (const [threadKey, item] of sidebarThreadModel.threadItemsByKey) {
      if (item.pendingWorktreeId) continue;
      entries.push([threadKey, item.threadId]);
    }
    for (const session of knownSidebarSessions) {
      if (!session.thread) continue;
      entries.push([`local:session:${session.id}`, session.thread.threadId]);
    }
    return new Map(entries);
  }, [knownSidebarSessions, sidebarThreadModel.threadItemsByKey]);
  const knownSidebarProjectIds = useMemo(
    () => new Set(sidebarThreadModel.projectGroups.map((group) => group.project.id)),
    [sidebarThreadModel.projectGroups],
  );
  const homeContainerIdByThreadId = useMemo(() => {
    const entries: Array<readonly [string, string]> = [];
    for (const item of sidebarThreadModel.threadItemsByKey.values()) {
      if (item.pendingWorktreeId) continue;
      const containerId = resolveCodexSidebarThreadHomeContainerId({
        kind: item.kind,
        pinned: item.pinned,
        projectId: item.projectId,
        projectless: item.projectless,
        knownProjectIds: knownSidebarProjectIds,
      });
      if (containerId) entries.push([item.threadId, containerId]);
    }
    for (const session of knownSidebarSessions) {
      if (!session.thread) continue;
      const containerId = resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: session.pinned,
        projectId: session.projectId,
        projectless: session.projectId === null,
        knownProjectIds: knownSidebarProjectIds,
      });
      if (containerId === null) continue;
      entries.push([session.thread.threadId, containerId]);
    }
    for (const section of sectionCatalog.sections) {
      const items = sectionCatalog.itemsBySectionId.get(section.sectionId) ?? [];
      const directSessionIds = new Set(
        items.flatMap((item) => (item.kind === "session" ? [item.session.id] : [])),
      );
      const directProjectIds = new Set(
        items.flatMap((item) => (item.kind === "project" ? [item.project.projectId] : [])),
      );
      for (const session of knownSidebarSessions) {
        if (!session.thread) continue;
        const isDirect = directSessionIds.has(session.id);
        const isInherited =
          session.projectId !== null &&
          directProjectIds.has(session.projectId) &&
          !sectionCatalog.directSessionIds.has(session.id);
        if (!isDirect && !isInherited) continue;
        entries.push([session.thread.threadId, sidebarSectionContainerId(section.sectionId)]);
      }
    }
    return new Map(entries);
  }, [
    knownSidebarProjectIds,
    knownSidebarSessions,
    sectionCatalog.directSessionIds,
    sectionCatalog.itemsBySectionId,
    sectionCatalog.sections,
    sidebarThreadModel.threadItemsByKey,
  ]);
  const getSidebarThreadIdByKey = useCallback(
    (threadKey: string) => sidebarThreadIdByKey.get(threadKey) ?? null,
    [sidebarThreadIdByKey],
  );
  const handleSidebarThreadDrop = useCallback(
    async (drop: SidebarThreadDropRequest): Promise<SidebarThreadDropCommit | null> => {
      const targetSectionId = readSidebarSectionContainerId(drop.targetContainerId);
      const sourceSectionId = readSidebarSectionContainerId(drop.sourceContainerId);
      const session = knownSidebarSessions.find(
        (candidate) => candidate.thread?.threadId === drop.threadId,
      );
      if (!session || (!targetSectionId && !sourceSectionId)) {
        return await onMoveSidebarThread(drop);
      }

      if (targetSectionId) {
        const targetItems = sectionCatalog.itemsBySectionId.get(targetSectionId) ?? [];
        await invokeCoreResult("sidebar-sections:item:move", {
          item: { kind: "session", sessionId: session.id },
          sectionId: targetSectionId,
          placement: resolveSidebarSectionItemPlacement(targetItems, drop.beforeItemId),
        });
        onSetSidebarSectionCollapsed(`custom:${targetSectionId}`, false);
        await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
        await onThreadsChanged?.();
        return null;
      }

      const sourceItems = sectionCatalog.itemsBySectionId.get(sourceSectionId as string) ?? [];
      const directPlacement = sourceItems.some(
        (item) => item.kind === "session" && item.session.id === session.id,
      );
      if (directPlacement) {
        await invokeCoreResult("sidebar-sections:item:move", {
          item: { kind: "session", sessionId: session.id },
          sectionId: null,
          placement: { kind: "end" },
        });
        await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
      }
      return await onMoveSidebarThread(drop);
    },
    [
      knownSidebarSessions,
      onMoveSidebarThread,
      onSetSidebarSectionCollapsed,
      onThreadsChanged,
      queryClient,
      sectionCatalog.itemsBySectionId,
    ],
  );

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizeDisabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const resolveZoom = getWindowZoom ?? (() => 1);
    const startX = event.clientX / resolveZoom();
    const startWidth = width;
    let didMove = false;

    setSidebarResizeActive(true);

    const resolveNextWidth = (nextEvent: PointerEvent) =>
      startWidth + (nextEvent.clientX / resolveZoom() - startX);

    function stopResize() {
      setSidebarResizeActive(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    }

    function onPointerMove(nextEvent: PointerEvent) {
      nextEvent.preventDefault();
      didMove = didMove || nextEvent.clientX / resolveZoom() !== startX;
      onResizeWidth(resolveNextWidth(nextEvent), "live", sidebarResizeSurface);
    }

    function onPointerUp(nextEvent: PointerEvent) {
      nextEvent.preventDefault();
      if (didMove) {
        onResizeWidth(resolveNextWidth(nextEvent), "end", sidebarResizeSurface);
      }
      stopResize();
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  const handleResizeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (sidebarResizeDisabled) return;
    if (event.detail !== 2) return;
    event.preventDefault();
    setSidebarResizeActive(false);
    onResizeWidth(CODEX_SIDEBAR_WIDTH_DEFAULT_PX, "reset", sidebarResizeSurface);
  };

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-disabled={sidebarResizeDisabled || undefined}
      onClick={handleResizeClick}
      onPointerDown={handleResizePointerDown}
      data-testid="sidebar-resize-strip"
      className={cn(
        "group absolute flex touch-none select-none z-20 -top-toolbar right-0 bottom-0 w-4 translate-x-2",
        sidebarResizeDisabled
          ? "pointer-events-none"
          : "cursor-col-resize active:cursor-col-resize",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "sidebar-resize-handle-line pointer-events-none m-auto opacity-0",
          "h-full w-px bg-gradient-to-b from-transparent via-token-foreground/25 to-transparent",
          sidebarResizing ? "opacity-100" : "group-hover:opacity-100 group-active:opacity-100",
        )}
      />
    </div>
  );

  const sidebarShell = (
    <motion.aside
      className={cn(
        floating
          ? CODEX_SIDEBAR_FLOATING_ASIDE_CLASS
          : "app-shell-left-panel pointer-events-auto relative flex h-full min-h-0 shrink-0 flex-col overflow-visible browser:bg-token-main-surface-primary",
        sidebarResizing && "cursor-col-resize",
        "font-sans text-sm",
      )}
      style={{
        width: floating ? width : (animatedWidth ?? width),
        ...(!floating ? { paddingTop: "var(--height-toolbar)" } : {}),
      }}
      data-testid={floating ? "app-shell-floating-left-panel" : "project-session-sidebar"}
    >
      {header}
      <motion.div
        className="max-w-full min-h-0 flex-1 overflow-hidden"
        style={{ minWidth: width, width, opacity: floating ? undefined : contentOpacity }}
      >
        <div
          className="flex h-full min-h-0 flex-col overflow-hidden [--height-token-nav-row:30px] [--padding-row-cell-x:8px] [--padding-row-x:8px] [--radius-token-row:10px]"
          style={sidebarScrollChrome.scrollChromeStyle}
        >
          <nav
            className="sidebar-foreground-muted flex min-h-0 flex-1 flex-col"
            role="navigation"
            aria-label="Automation folders"
          >
            <SidebarExpandedHeader
              productName="Nodex"
              productStatusLabel="Beta"
              searchShortcutLabel={resolveCodexPageSearchShortcutLabel()}
              newChatShortcutLabel={resolveCodexNewChatShortcutLabel()}
              scrolledContentUnderHeader={sidebarScrollChrome.scrolledContentUnderHeader}
              onSearch={onOpenCommandPalette}
              onNewChat={() => void onStartNewChatInProject(activeProjectId)}
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
                        active={automationsActive}
                        onClick={() => onOpenAutomations()}
                      />
                      <CodexSidebarTopActionButton
                        label="Plugins"
                        icon={<ComposerPluginsIcon className="icon-xs" />}
                        onClick={() => onShowUnavailableProduct("Plugins")}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <SidebarReorderDndProvider
                getThreadIdByThreadKey={getSidebarThreadIdByKey}
                homeContainerIdByThreadId={homeContainerIdByThreadId}
                onProjectError={reportSidebarProjectReorderError}
                onProjectDrop={handleProjectDrop}
                onThreadError={reportSidebarThreadReorderError}
                onThreadDrop={handleSidebarThreadDrop}
                onLibraryMove={handleLibraryMove}
                onLibraryGrant={setPendingLibraryGrantDrop}
              >
                <SidebarThreadOrganizerSections
                  activeProjectId={activeProjectId}
                  activeSessionId={activeSessionId}
                  activePendingClientThreadId={activePendingClientThreadId}
                  contextMenuSessionId={contextMenuSessionId}
                  sessionCollectionsByProject={sessionCollectionsByProject}
                  projectlessSessionCollection={projectlessSessionCollection}
                  expandedProjectIds={expandedProjectIds}
                  pinnedThreadsSectionCollapsed={pinnedProjectsSectionCollapsed}
                  pagesSectionCollapsed={pagesSectionCollapsed}
                  projectsSectionCollapsed={projectsSectionCollapsed}
                  chatsSectionCollapsed={chatsSectionCollapsed}
                  sidebarCollapsibleSections={sidebarCollapsibleSections}
                  onLoadMoreTaskWindow={onLoadMoreTaskWindow}
                  onRetryTaskWindow={onRetryTaskWindow}
                  model={sidebarThreadModel}
                  onHoverSurfaceOpenChange={onHoverSurfaceOpenChange}
                  onTogglePinnedThreadsSectionCollapsed={onTogglePinnedProjectsSectionCollapsed}
                  onTogglePagesSectionCollapsed={onTogglePagesSectionCollapsed}
                  onToggleProjectsSectionCollapsed={onToggleProjectsSectionCollapsed}
                  onToggleChatsSectionCollapsed={onToggleChatsSectionCollapsed}
                  onSetSidebarSectionCollapsed={onSetSidebarSectionCollapsed}
                  onToggleProjectExpanded={onToggleProjectExpanded}
                  onSelectProject={onSelectProject}
                  onSelectSession={onSelectSession}
                  onSelectSidebarThread={onSelectSidebarThread}
                  onPreviewSidebarThread={onPreviewSidebarThread}
                  onOpenSessionContextMenu={onOpenSessionContextMenu}
                  onSessionTitleDoubleClick={onSessionTitleDoubleClick}
                  onPendingWorktreeTitleDoubleClick={onPendingWorktreeTitleDoubleClick}
                  onArchiveSidebarThread={onArchiveSidebarThread}
                  onArchiveThreadItem={onArchiveThreadItem}
                  onMarkThreadItemRead={onMarkThreadItemRead}
                  onThreadsChanged={onThreadsChanged}
                  onToggleSessionPinned={onToggleSessionPinned}
                  onToggleSidebarThreadPinned={onToggleSidebarThreadPinned}
                  onStartNewChatInProject={onStartNewChatInProject}
                  pendingStableWorktrees={pendingStableWorktrees}
                  onOpenStableWorktree={onOpenStableWorktree}
                  onCreateStableWorktree={onCreateStableWorktree}
                  projectPickerOpenTick={projectPickerOpenTick}
                  onCreateProject={onCreateProject}
                  onUpdateProject={onUpdateProject}
                  onArchiveProject={onArchiveProject}
                  onReorderProjects={onReorderProjects}
                  onSetProjectPinned={onSetProjectPinned}
                  onSetPinnedProjectOrder={onSetPinnedProjectOrder}
                  onReorderSessions={onReorderSessions}
                  onReorderPinnedThreads={onReorderPinnedThreads}
                  sidebarArchivePendingKeys={sidebarArchivePendingKeys}
                  onOpenResourceTarget={onOpenResourceTarget}
                  onOpenResourceTargetInProject={onOpenResourceTargetInProject}
                  activeResourceTarget={activeResourceTarget}
                  hasMoreProjects={hasMoreProjects}
                  loadingMoreProjects={loadingMoreProjects}
                  onLoadMoreProjects={onLoadMoreProjects}
                />
              </SidebarReorderDndProvider>
              <NodexDialog
                open={pendingLibraryGrantDrop !== null}
                onOpenChange={(open) => {
                  if (!open) setPendingLibraryGrantDrop(null);
                }}
              >
                <NodexDialogContent size="compact">
                  <NodexDialogFrame>
                    <NodexDialogHeader>
                      <NodexDialogTitle>Give Project access?</NodexDialogTitle>
                      <NodexDialogDescription>
                        {pendingLibraryGrantProject?.name ?? "This Project"} will receive recursive
                        access to {pendingLibraryGrantDrop?.resource.title ?? "this Library item"}.
                        Ownership and Database bindings will not change.
                      </NodexDialogDescription>
                    </NodexDialogHeader>
                    <NodexDialogBody>
                      <fieldset className="grid gap-2 text-sm text-token-text-primary">
                        <legend className="mb-1">Access</legend>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="library-drop-access"
                            checked={libraryGrantAccess === "read"}
                            onChange={() => setLibraryGrantAccess("read")}
                          />
                          Read
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="library-drop-access"
                            checked={libraryGrantAccess === "read_write"}
                            onChange={() => setLibraryGrantAccess("read_write")}
                          />
                          Read &amp; write
                        </label>
                      </fieldset>
                    </NodexDialogBody>
                    <NodexDialogFooter>
                      <NodexDialogAction onClick={() => setPendingLibraryGrantDrop(null)}>
                        Cancel
                      </NodexDialogAction>
                      <NodexDialogAction
                        tone="primary"
                        disabled={!pendingLibraryGrantProject || libraryMutation.isPending}
                        onClick={() => void confirmLibraryGrantDrop()}
                      >
                        Grant access
                      </NodexDialogAction>
                    </NodexDialogFooter>
                  </NodexDialogFrame>
                </NodexDialogContent>
              </NodexDialog>
            </div>

            <LeftSidebarFooter
              onOpenSettings={onOpenSettings}
              account={account}
              connection={connection}
              onRefreshAccount={onRefreshAccount}
              onConsumeRateLimitReset={onConsumeRateLimitReset}
              onStartChatGptLogin={onStartChatGptLogin}
              onStartApiKeyLogin={onStartApiKeyLogin}
              onCancelLogin={onCancelLogin}
              onLogout={onLogout}
              onErrorMessage={onAccountErrorMessage}
            />
          </nav>
        </div>
      </motion.div>

      {!floating ? resizeHandle : null}
    </motion.aside>
  );

  if (floating) {
    return (
      <>
        {sidebarShell}
        {resizeHandle}
      </>
    );
  }

  return sidebarShell;
}
