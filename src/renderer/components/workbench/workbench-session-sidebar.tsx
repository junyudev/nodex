import { getIntl, useIntl } from "@/lib/i18n";
import { localProjectSourceRoots } from "../../../shared/project-sources";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { InboxCounts } from "../../../shared/inbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NodexTooltip } from "@/components/ui/tooltip";
import { codexSidebarProjectThreadContainerId } from "../../../shared/codex-sidebar-thread-move";
import {
  CodexProjectRow,
  CodexProjectSessionList,
  CodexSidebarActionButton,
  CodexSidebarSection,
  CodexSidebarThreadRow,
  resolveCodexNewChatShortcutLabel,
  resolveCodexInboxShortcutLabel,
  resolveCodexPageSearchShortcutLabel,
  type CodexProjectRowDndCapability,
} from "./codex-sidebar";
import { SidebarDropIndicator } from "./sidebar-drop-indicator";
import type { SidebarLibraryDragResource } from "./sidebar-library-dnd";
import {
  SIDEBAR_SCROLL_AREA_CLASS,
  SidebarInboxButton,
  SidebarNewChatButton,
  WorkbenchSidebarHeader,
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
import { NewChatIcon, ChatIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import { setPendingWorktreePinnedBeforeThread } from "@/lib/pending-worktree-runtime";
import { workspaceSidebarCommands } from "@/lib/workspace-catalog-commands";
import { useCurrentSpace } from "@/features/spaces/spaces-runtime";
import {
  CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS,
  CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS,
} from "@/lib/codex-sidebar-pagination";
import {
  buildCodexSidebarPinnedReorderMutation,
  isCodexSidebarRootThread,
  isCodexSidebarThreadItemReorderable,
  listReorderableCodexSidebarChatKeys,
  replaceVisibleCodexSidebarThreadKeyOrder,
  resolveCodexSidebarThreadHomeContainerId,
  orderSidebarPinnedSessionKeys,
  type CodexSidebarProjectGroup,
  type CodexSidebarThreadSyncModel,
} from "@/lib/codex-sidebar-thread-sync";
import { buildLibraryMoveOperation } from "@/lib/library-operations";
import { projectActivitySummariesQueryOptions } from "@/lib/query-options";
import { useSidebarRuntimeGroupActivity } from "@/lib/use-sidebar-runtime-group-activity";
import {
  hasSessionConversation,
  runtimeSessionLiveIndicator,
  runtimeSessionTarget,
  sessionExecutionThreadId,
} from "@/lib/session-execution";
import { useAgentRuntimeActivities } from "@/lib/agent-runtime-session-activity";
import {
  resolveSettleableReadChats,
  sidebarChatNeedsReader,
  type SidebarAutoSettleDays,
  type SidebarLifecycleChat,
  type SidebarOptionalShelf,
  type SidebarOrganize,
} from "@/lib/sidebar-chat-lifecycle";
import { resolveSidebarGroupStatus } from "@/lib/sidebar-status";
import { projectSidebarThreadRowLiveView } from "@/lib/sidebar-thread-row-live-view";
import {
  listExpandedVisibleProjectGroupIds,
  listReopenableVisibleProjectGroupIds,
  resolveSidebarProjectGroupCollapseAction,
  type SidebarProjectGroupCollapseAction,
} from "@/lib/sidebar-project-group-collapse-action";
import type {
  CodexSidebarThreadItem,
  Project,
  ProjectCreateInput,
  ProjectLifecycleMutationResult,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectSession as ProjectSessionDomain,
  ProjectSessionPlacement,
  ProjectUpdateInput,
} from "@/lib/types";
import type { SessionLinkedPage } from "@/lib/session-linked-page";
import { CODEX_AGENT_BACKEND_BINDING } from "../../../shared/agent-backend";
import { useApplyLibraryOperation } from "@/lib/use-library-navigation";
import { cn } from "@/lib/utils";
import {
  projectSessionProjectionsByProject,
  type WorkbenchLibrarySessionLane,
  type WorkbenchSessionCollection,
  type WorkbenchSessionCollectionState,
} from "@/lib/use-workbench-session-catalog";
import { projectSessionSummaryToDomain } from "@/lib/workbench-session-presentation";
import type {
  SidebarChatOrder,
  SidebarCollapsibleSectionsState,
  SidebarDisclosureSectionId,
  SidebarListExtraPagesState,
  SidebarListId,
} from "@/lib/sidebar-section-prefs";
import { resolveSidebarSessionPlacement } from "@/lib/sidebar-session-placement";
import { SidebarPaginatedItems, SidebarPaginatedRows } from "./sidebar-paginated-items";
import { SidebarChatLaneSection, SidebarSettleReadChatsButton } from "./sidebar-chat-lanes";
import { useSidebarChatLanes, useSidebarLaneHold } from "./use-sidebar-chat-lanes";
import { pageTurnPhrase, type PageTurnHolder } from "@/lib/page-turn-phrase";
import { sidebarSectionChatIds } from "@/lib/sidebar-section-navigation";
import { SidebarArrangeToggle, SidebarLaneViewMenu, SidebarScopeChip } from "./sidebar-view-menu";
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
import { WorkbenchSidebarFrame, type WorkbenchSidebarFrameProps } from "./workbench-sidebar-frame";
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
  const intl = useIntl();
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
            aria-label={intl.formatMessage(
              {
                id: "workbench.workbenchSessionSidebar.retryChatsLabel",
                defaultMessage: "Retry chats: {reason}",
              },
              { reason: state.message },
            )}
            onClick={() => void onRetry()}
          >
            {intl.formatMessage({
              id: "workbench.workbenchSessionSidebar.retryChats",
              defaultMessage: "Retry chats",
            })}
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

export type { SidebarResizePhase, SidebarResizeSurface } from "./workbench-sidebar-frame";

/** A chat the sidebar lists, in the order a person travels them with the keyboard. */
export interface SidebarVisibleChat {
  readonly sessionId: string;
  /** It asks something of its reader: an answer, an approval, or a look at its news. */
  readonly needsReader: boolean;
  /** It waits on its reader now, so it cannot be settled until they answer. */
  readonly waitsOnReader: boolean;
  /** It is still open for its reader, in a list that settling it would take it out of. */
  readonly open: boolean;
}

/** The reader's own chat lifecycle, as the sidebar shows and changes it. */
export interface SidebarChatLifecycle {
  readonly organize: SidebarOrganize;
  readonly onOrganizeChange: (organize: SidebarOrganize) => void;
  readonly autoSettleDays: SidebarAutoSettleDays;
  readonly onAutoSettleDaysChange: (days: SidebarAutoSettleDays) => void;
  /** Every Project's open chats by attention; read only while the sidebar arranges by it. */
  readonly openLane: WorkbenchLibrarySessionLane;
  /** Every Project's settled chats, read only while their shelf is open. */
  readonly settledLane: WorkbenchLibrarySessionLane;
  readonly onToggleSessionSettled: (session: ProjectSessionDomain) => void | Promise<void>;
  /** Snoozes a chat until a time, or wakes it with null. */
  readonly onSnoozeSession: (
    session: ProjectSessionDomain,
    snoozedUntil: string | null,
  ) => void | Promise<void>;
  /** Accepts the work a chat's Page waits for the reader to review; that settles the chat. */
  readonly onAcceptSessionWork: (session: ProjectSessionDomain) => void | Promise<void>;
  /** Settles every chat named at once, with one Undo for all of them. */
  readonly onSettleSessions: (sessions: readonly ProjectSessionDomain[]) => void | Promise<void>;
  readonly snoozeShortcutLabel?: string;
  readonly onVisibleChatsChange: (chats: readonly SidebarVisibleChat[]) => void;
  readonly organizeShortcutLabel?: string;
  /** The one Project the lanes and the Inbox entry show, or null for every Project. */
  readonly scopeProjectId: string | null;
  readonly onScopeChange: (projectId: string | null) => void;
  /** The lists the attention arrangement leaves out. */
  readonly hiddenShelves: readonly SidebarOptionalShelf[];
  readonly onHiddenShelvesChange: (shelves: readonly SidebarOptionalShelf[]) => void;
}

/** A team Space names itself, so the person always knows whose work they are looking at. */
function useHomeTitle(): string {
  const space = useCurrentSpace();
  return space.kind === "team" ? space.name : "Nodex";
}

/** A chat row shows only the reader's own Turns, so it words them for the reader. */
const READER: PageTurnHolder = { you: true, name: "" };

function reportSidebarThreadReorderError(): void {
  toast.danger(
    getIntl().formatMessage({
      id: "workbench.workbenchSessionSidebar.reorderTaskFailed",
      defaultMessage: "Couldn’t reorder task",
    }),
  );
}

function reportSidebarProjectReorderError(): void {
  toast.danger(
    getIntl().formatMessage({
      id: "workbench.workbenchSessionSidebar.reorderProjectFailed",
      defaultMessage: "Couldn’t reorder project",
    }),
  );
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
  const intl = useIntl();
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
        <div
          className="flex flex-col"
          role="list"
          aria-label={intl.formatMessage({
            id: "workbench.workbenchSessionSidebar.projects",
            defaultMessage: "Projects",
          })}
        >
          <SidebarPaginatedRows>
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
                {loading
                  ? intl.formatMessage({
                      id: "workbench.workbenchSessionSidebar.loadingProjects",
                      defaultMessage: "Loading projects...",
                    })
                  : emptyText}
              </div>
            )}
            {reorder.dropIndicatorIndex === orderedVisibleItems.length ? (
              <SidebarDropIndicator />
            ) : null}
          </SidebarPaginatedRows>
          {pager}
        </div>
      </SidebarProjectSortableContext>
    </div>
  );
}

function SidebarPinnedThreadRowsContent({
  containerId,
  getSessionId,
  getThreadId,
  visibleThreadKeys,
  itemsByKey,
  ariaLabel,
  onVisibleThreadOrderChange,
  renderThread,
}: {
  containerId: "pinned";
  getSessionId: (threadKey: string) => string | null;
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
          getSessionId={getSessionId}
          getItemId={(threadKey) => getSessionId(threadKey) ?? undefined}
          getThreadId={getThreadId}
          itemIds={optimisticThreadKeys.flatMap((threadKey) => {
            const sessionId = getSessionId(threadKey);
            return sessionId === null ? [] : [sessionId];
          })}
          visibleThreadKeys={optimisticThreadKeys}
          sortableThreadKeys={optimisticThreadKeys.filter((threadKey) => {
            const item = itemsByKey.get(threadKey);
            return item
              ? isCodexSidebarThreadItemReorderable(item) &&
                  (item.pendingWorktreeId != null || getThreadId(threadKey) !== null)
              : false;
          })}
          onVisibleThreadOrderChange={onVisibleThreadOrderChange}
          renderThread={renderThread}
          renderDragOverlay={(threadKey) => {
            const item = itemsByKey.get(threadKey);
            if (!item) return null;
            return (
              <div className="flex h-[var(--height-token-nav-row)] max-w-80 items-center gap-2 px-2 text-base text-token-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <ChatIcon className="icon-xs" />
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
  extraPages,
  onExtraPagesChange,
  forcedVisibleKey,
  suppressedKeys,
  collectionState,
  hasMoreAtSource,
  onLoadMore,
  onRetry,
  reorderable,
  onPlaceSession,
  renderThread,
}: {
  containerId: "chats";
  threadKeys: string[];
  getSessionId: (threadKey: string) => string | null;
  getThreadId: (threadKey: string) => string | null;
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  extraPages: number;
  onExtraPagesChange: (extraPages: number) => void;
  forcedVisibleKey: string | null;
  suppressedKeys: ReadonlySet<string>;
  collectionState: WorkbenchSessionCollectionState;
  hasMoreAtSource: boolean;
  onLoadMore: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  reorderable: boolean;
  onPlaceSession: (sessionId: string, placement: ProjectSessionPlacement) => Promise<void>;
  renderThread: (threadKey: string) => ReactNode;
}) {
  const intl = useIntl();
  const pendingThreadDrops = usePendingSidebarThreadDrops();
  const optimisticThreadKeys = resolveSidebarThreadKeysWithPendingDrops({
    containerId,
    pendingThreadDrops,
    threadKeys,
    threadKeysInDisplayOrder: threadKeys,
    getThreadId,
  });
  const sortableThreadKeys = optimisticThreadKeys.filter((threadKey) => {
    const item = itemsByKey.get(threadKey);
    return (
      getSessionId(threadKey) !== null &&
      !suppressedKeys.has(threadKey) &&
      item !== undefined &&
      isCodexSidebarThreadItemReorderable(item)
    );
  });
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys: sortableThreadKeys,
    reorderable,
    onVisibleThreadOrderChange: async ({ activeThreadKey, nextVisibleThreadKeys }) => {
      const resolved = resolveSidebarSessionPlacement({
        activeThreadKey,
        nextVisibleThreadKeys,
        getSessionId,
      });
      if (resolved) await onPlaceSession(resolved.sessionId, resolved.placement);
    },
  });
  const displayedThreadKeys = replaceVisibleCodexSidebarThreadKeyOrder({
    threadKeysInDisplayOrder: optimisticThreadKeys,
    visibleThreadKeys: sortableThreadKeys,
    nextVisibleThreadKeys: reorder.displayedVisibleThreadKeys,
  });

  return (
    <SidebarPaginatedItems
      items={displayedThreadKeys}
      getKey={(threadKey) => threadKey}
      maxItems={CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS}
      extraPages={extraPages}
      onExtraPagesChange={onExtraPagesChange}
      forcedVisibleKey={forcedVisibleKey}
      suppressedKeys={suppressedKeys}
      source={{
        hasMore: hasMoreAtSource,
        failed: collectionState.kind === "error",
        loadMore: onLoadMore,
      }}
    >
      {(pagination, pager) => (
        <div className="isolate flex flex-col [contain:layout]">
          <div
            className="flex flex-col"
            role="list"
            aria-label={intl.formatMessage({
              id: "workbench.workbenchSessionSidebar.chats",
              defaultMessage: "Chats",
            })}
          >
            <SidebarPaginatedRows>
              {pagination.visibleItems.length > 0 ? (
                <SidebarThreadSortableRows
                  containerId={containerId}
                  getSessionId={getSessionId}
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
                          <ChatIcon className="icon-xs" />
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
                  loadingText={intl.formatMessage({
                    id: "workbench.workbenchSessionSidebar.loadingChats",
                    defaultMessage: "Loading chats...",
                  })}
                  emptyText={intl.formatMessage({
                    id: "workbench.workbenchSessionSidebar.noProjectlessChats",
                    defaultMessage: "No projectless chats",
                  })}
                  placement="section"
                  onRetry={onRetry}
                />
              ) : null}
            </SidebarPaginatedRows>
            {pager}
          </div>
        </div>
      )}
    </SidebarPaginatedItems>
  );
}

function SidebarProjectThreadRowsContent({
  project,
  pinnedThreadKeys,
  sortablePinnedThreadKeys,
  threadKeys,
  extraPages,
  forcedVisibleKey,
  suppressedKeys,
  collectionState,
  hasMoreAtSource,
  onLoadMore,
  onRetry,
  onExtraPagesChange,
  onPinnedThreadOrderChange,
  regularReorderable,
  onPlaceSession,
  getSessionId,
  getThreadId,
  itemsByKey,
  renderThread,
}: {
  project: Project;
  pinnedThreadKeys: string[];
  sortablePinnedThreadKeys: string[];
  threadKeys: string[];
  extraPages: number;
  forcedVisibleKey: string | null;
  suppressedKeys: ReadonlySet<string>;
  collectionState: WorkbenchSessionCollectionState;
  hasMoreAtSource: boolean;
  onLoadMore: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onExtraPagesChange: (extraPages: number) => void;
  onPinnedThreadOrderChange: (change: {
    visibleThreadKeys: string[];
    nextVisibleThreadKeys: string[];
  }) => Promise<void>;
  regularReorderable: boolean;
  onPlaceSession: (sessionId: string, placement: ProjectSessionPlacement) => Promise<void>;
  getSessionId: (threadKey: string) => string | null;
  getThreadId: (threadKey: string) => string | null;
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  renderThread: (threadKey: string) => ReactNode;
}) {
  const intl = useIntl();
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
      optimisticPinnedThreadKeys.filter((threadKey) => {
        const item = itemsByKey.get(threadKey);
        return (
          sortablePinnedThreadKeySet.has(threadKey) &&
          !suppressedKeys.has(threadKey) &&
          item !== undefined &&
          isCodexSidebarThreadItemReorderable(item)
        );
      }),
    [itemsByKey, optimisticPinnedThreadKeys, sortablePinnedThreadKeySet, suppressedKeys],
  );
  const sortableRegularThreadKeys = useMemo(
    () =>
      listReorderableCodexSidebarChatKeys({
        visibleThreadKeys: optimisticRegularThreadKeys.filter((threadKey) => {
          const item = itemsByKey.get(threadKey);
          return (
            !suppressedKeys.has(threadKey) &&
            item !== undefined &&
            isCodexSidebarThreadItemReorderable(item)
          );
        }),
        getSessionId,
      }),
    [getSessionId, itemsByKey, optimisticRegularThreadKeys, suppressedKeys],
  );
  const pinnedReorder = useSidebarThreadReorderController({
    visibleThreadKeys: optimisticSortablePinnedThreadKeys,
    onVisibleThreadOrderChange: onPinnedThreadOrderChange,
  });
  const regularReorder = useSidebarThreadReorderController({
    visibleThreadKeys: sortableRegularThreadKeys,
    reorderable: regularReorderable,
    onVisibleThreadOrderChange: async ({ activeThreadKey, nextVisibleThreadKeys }) => {
      const resolved = resolveSidebarSessionPlacement({
        activeThreadKey,
        nextVisibleThreadKeys,
        getSessionId,
      });
      if (resolved) await onPlaceSession(resolved.sessionId, resolved.placement);
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
          <ChatIcon className="icon-xs" />
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
      extraPages={extraPages}
      onExtraPagesChange={onExtraPagesChange}
      forcedVisibleKey={forcedVisibleKey}
      suppressedKeys={suppressedKeys}
      pagerClassName={CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS}
      source={{
        hasMore: hasMoreAtSource,
        failed: collectionState.kind === "error",
        loadMore: onLoadMore,
      }}
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
          <CodexProjectSessionList project={project} showAll={extraPages > 0}>
            <SidebarPaginatedRows>
              <SidebarThreadDropContainer containerId={pinnedContainerId} targetProjectKind="local">
                <SidebarThreadSortableRows
                  containerId={pinnedContainerId}
                  getSessionId={getSessionId}
                  getItemId={(threadKey) => getSessionId(threadKey) ?? undefined}
                  getThreadId={getThreadId}
                  itemIds={pinnedReorder.displayedVisibleThreadKeys.flatMap((threadKey) => {
                    const sessionId = getSessionId(threadKey);
                    return sessionId === null ? [] : [sessionId];
                  })}
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
              <SidebarThreadDropContainer
                containerId={regularContainerId}
                targetProjectKind="local"
              >
                <SidebarThreadSortableRows
                  containerId={regularContainerId}
                  getSessionId={getSessionId}
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
                  emptyText={intl.formatMessage({
                    id: "workbench.workbenchSessionSidebar.noChatsInside",
                    defaultMessage: "No chats inside",
                  })}
                  placement="project-child"
                  onRetry={onRetry}
                />
              ) : null}
            </SidebarPaginatedRows>
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
  laneHolding,
  laneViewMenu,
  projectInboxCounts,
  activeProjectId,
  activeSessionId,
  activePendingClientThreadId,
  contextMenuSessionId,
  sessionCollectionsByProject,
  projectlessSessionCollection,
  expandedProjectIds,
  pinnedThreadsSectionCollapsed,
  projectsSectionCollapsed,
  chatsSectionCollapsed,
  sidebarCollapsibleSections,
  sidebarListExtraPages,
  onSidebarListExtraPagesChange,
  onLoadMoreTaskWindow,
  onRetryTaskWindow,
  model,
  onHoverSurfaceOpenChange,
  onTogglePinnedThreadsSectionCollapsed,
  onToggleProjectsSectionCollapsed,
  onToggleChatsSectionCollapsed,
  onSetSidebarSectionCollapsed,
  onToggleProjectExpanded,
  onSelectProject,
  onSelectSession,
  onSelectSidebarThread,
  onPreviewSidebarThread,
  onOpenSessionContextMenu,
  onOpenSessionLinkedPage,
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
  chatOrder,
  onChatOrderChange,
  lifecycle,
  onPlaceSession,
  onReorderPinnedThreads,
  sidebarArchivePendingKeys,
  hasMoreProjects,
  loadingMoreProjects,
  loadMoreProjectsFailed,
  onLoadMoreProjects,
}: {
  /** The reader points at or works in the sidebar, so its lanes hold still. */
  laneHolding: boolean;
  /** Adjusts what the attention arrangement shows; it sits beside its first heading. */
  laneViewMenu: ReactNode;
  /** Messages waiting in each Project's own Inbox. */
  projectInboxCounts: Readonly<Record<string, number>>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  activePendingClientThreadId?: string | null;
  contextMenuSessionId?: string | null;
  sessionCollectionsByProject: Readonly<Record<string, WorkbenchSessionCollection>>;
  projectlessSessionCollection: WorkbenchSessionCollection;
  expandedProjectIds: Set<string>;
  pinnedThreadsSectionCollapsed: boolean;
  projectsSectionCollapsed: boolean;
  chatsSectionCollapsed: boolean;
  sidebarCollapsibleSections: SidebarCollapsibleSectionsState;
  /** Show more steps each list keeps revealed, remembered by the Profile. */
  sidebarListExtraPages: SidebarListExtraPagesState;
  onSidebarListExtraPagesChange: (listId: SidebarListId, extraPages: number) => void;
  onLoadMoreTaskWindow: (projectId: string | null) => Promise<void>;
  onRetryTaskWindow: (projectId: string | null) => Promise<void>;
  model: CodexSidebarThreadSyncModel;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
  onTogglePinnedThreadsSectionCollapsed: () => void;
  onToggleProjectsSectionCollapsed: () => void;
  onToggleChatsSectionCollapsed: () => void;
  onSetSidebarSectionCollapsed: (sectionId: SidebarDisclosureSectionId, collapsed: boolean) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (session: ProjectSessionDomain) => void;
  onSelectSidebarThread: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onPreviewSidebarThread?: (item: CodexSidebarThreadItem) => void;
  onOpenSessionContextMenu?: (session: ProjectSession, event: ReactMouseEvent<HTMLElement>) => void;
  /** Takes the person to a chat with its earliest-linked live Page beside it. */
  onOpenSessionLinkedPage?: (session: ProjectSession, page: SessionLinkedPage) => void;
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
  chatOrder: SidebarChatOrder;
  onChatOrderChange: (chatOrder: SidebarChatOrder) => void;
  lifecycle: SidebarChatLifecycle;
  onPlaceSession: (sessionId: string, placement: ProjectSessionPlacement) => Promise<void>;
  onReorderPinnedThreads: (orderedThreadIds: readonly string[]) => Promise<unknown>;
  sidebarArchivePendingKeys: ReadonlySet<string>;
  hasMoreProjects: boolean;
  loadingMoreProjects: boolean;
  loadMoreProjectsFailed: boolean;
  onLoadMoreProjects?: () => Promise<void>;
}) {
  const intl = useIntl();
  const sectionCatalog = useSidebarSectionsCatalog();
  const runtimeGroupActivity = useSidebarRuntimeGroupActivity();
  const runtimeActivities = useAgentRuntimeActivities();
  const arrangedByAttention = lifecycle.organize === "attention";
  const hiddenShelves = lifecycle.hiddenShelves;
  const onToggleSessionSettled = lifecycle.onToggleSessionSettled;
  const onSnoozeSession = lifecycle.onSnoozeSession;
  const onAcceptSessionWork = lifecycle.onAcceptSessionWork;
  const snoozeShortcutLabel = lifecycle.snoozeShortcutLabel;
  const onVisibleChatsChange = lifecycle.onVisibleChatsChange;
  const openLaneSessions = useMemo(
    () =>
      lifecycle.openLane.collection.projections.filter((session) =>
        isCodexSidebarRootThread(session.thread),
      ),
    [lifecycle.openLane.collection.projections],
  );
  const settledLaneSessions = useMemo(
    () =>
      lifecycle.settledLane.collection.projections.filter((session) =>
        isCodexSidebarRootThread(session.thread),
      ),
    [lifecycle.settledLane.collection.projections],
  );
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
      ...settledLaneSessions,
      ...openLaneSessions,
      ...Object.values(sectionSessionsByProject).flat(),
      ...rootProjectlessSessions,
    ]) {
      sessions.set(session.id, session);
    }
    return [...sessions.values()];
  }, [
    directSectionSessions,
    settledLaneSessions,
    openLaneSessions,
    rootProjectlessSessions,
    sectionSessionsByProject,
  ]);
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
        const threadId = sessionExecutionThreadId(session) ?? session.id;
        const hostId = session.thread?.executionHostId ?? "local";
        const local = hostId === "local";
        const managedWorktreePath = session.thread?.managedWorktreePath ?? null;
        return {
          key: `${local ? "local" : "remote"}:session:${session.id}`,
          kind: local ? "local" : "remote",
          backendBinding: session.thread?.backendBinding ?? CODEX_AGENT_BACKEND_BINDING,
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
          recencyAt: session.activityAt,
          createdAt: session.thread?.createdAt ?? Date.parse(session.createdAt),
          pinned: session.pinned,
          pinnedOrder: session.pinnedOrder,
          unread: session.unread,
          snoozedUntil: session.snoozedUntil,
          snoozedAt: session.snoozedAt,
          wokeAt: session.wokeAt,
          settledAt: session.settledAt ?? null,
          ...(session.attentionAt === undefined ? {} : { attentionAt: session.attentionAt }),
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
      return sessionExecutionThreadId(session ?? null);
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
  const allPinnedThreadKeys = useMemo(
    () =>
      orderSidebarPinnedSessionKeys({
        threadKeys: [
          ...model.pinnedThreadKeys,
          ...fallbackThreadItems.filter((item) => item.pinned).map((item) => item.key),
        ],
        itemsByKey: sidebarThreadItemsByKey,
        sessionsById,
      }),
    [fallbackThreadItems, model.pinnedThreadKeys, sessionsById, sidebarThreadItemsByKey],
  );
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
  const visiblePinnedStandaloneThreadKeys = useMemo(
    () =>
      pinnedStandaloneThreadKeys.filter((threadKey) => !sidebarArchivePendingKeys.has(threadKey)),
    [pinnedStandaloneThreadKeys, sidebarArchivePendingKeys],
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
          setPendingWorktreePinnedBeforeThread(
            pendingItem.hostId,
            update.pendingWorktreeId,
            update.beforeThreadId,
          ).catch(() => {
            toast.danger(
              getIntl().formatMessage({
                id: "workbench.workbenchSessionSidebar.reorderPendingChatFailed",
                defaultMessage: "Failed to reorder pending chat",
              }),
            );
          }),
        ];
      });

      try {
        const pinnedOrderRequest = onReorderPinnedThreads(mutation.pinnedThreadIds).then(
          () => undefined,
        );
        await Promise.all([pinnedOrderRequest, ...pendingRequests]);
      } catch (error) {
        toast.danger(
          getIntl().formatMessage({
            id: "workbench.workbenchSessionSidebar.reorderPinnedChatsFailed",
            defaultMessage: "Failed to reorder pinned chats",
          }),
        );
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
    () => allProjectGroups.flatMap(({ project }) => localProjectSourceRoots(project.sources)),
    [allProjectGroups],
  );
  const stableWorktreeWorkspaceRootLabels = useMemo(
    () =>
      Object.fromEntries(
        allProjectGroups.flatMap(({ project }) =>
          localProjectSourceRoots(project.sources).map((root) => [root, project.name] as const),
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
  /** Every Project as a place to open, the person's pinned ones first. */
  const placeProjectGroups = useMemo(() => {
    const pinnedIds = new Set(pinnedProjectGroups.map((group) => group.project.id));
    return [
      ...pinnedProjectGroups,
      ...allProjectGroups.filter((group) => !pinnedIds.has(group.project.id)),
    ];
  }, [allProjectGroups, pinnedProjectGroups]);
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
        /** A list spanning Projects names each chat's own on its row. */
        showProject?: boolean;
        /** Rows arranged by attention say what each chat is about under their title. */
        preview?: boolean;
      } = {},
    ) => {
      const item = sidebarThreadItemsByKey.get(threadKey);
      if (!item) return null;
      const session = resolveSessionForItem(item);
      const sessionId = item.sessionId ?? session?.id ?? null;
      // Only the chat's owner or a Space Owner renames or archives a chat every Member shares.
      const manageable = session?.canManage ?? true;
      const hoverCardProjectLabel =
        options.hoverCardProjectLabel ??
        (item.projectId ? (projectLabelById.get(item.projectId) ?? null) : null);

      return (
        <CodexSidebarThreadRow
          key={item.key}
          item={item}
          runtime={runtimeSessionTarget(session)}
          grouped={options.grouped}
          active={
            (item.clientThreadId ?? item.threadId) === activePendingClientThreadId ||
            Boolean(sessionId && activeSessionId === sessionId)
          }
          contextMenuOpen={Boolean(sessionId && contextMenuSessionId === sessionId)}
          hoverCardProjectLabel={hoverCardProjectLabel}
          trailingLabel={options.showProject ? hoverCardProjectLabel : null}
          preview={options.preview === true}
          // A draft has no conversation to finish; it waits as the next New chat.
          onToggleSettled={
            session && !session.archived && hasSessionConversation(session)
              ? () => onToggleSessionSettled(session)
              : undefined
          }
          onSnooze={
            session && !session.archived && hasSessionConversation(session)
              ? (_item, snoozedUntil) => onSnoozeSession(session, snoozedUntil)
              : undefined
          }
          onWake={session ? () => onSnoozeSession(session, null) : undefined}
          snoozeShortcutLabel={snoozeShortcutLabel}
          // The Page this chat works on speaks first when it waits on the reader.
          turnLead={session?.pageTurn ? pageTurnPhrase(session.pageTurn, READER) : null}
          onAccept={
            session?.pageTurn?.reason === "review" ? () => onAcceptSessionWork(session) : undefined
          }
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
            !manageable
              ? undefined
              : session && onSessionTitleDoubleClick
                ? (_item, event) => onSessionTitleDoubleClick(session, event)
                : item.kind === "pending-worktree" && onPendingWorktreeTitleDoubleClick
                  ? (_item, event) => onPendingWorktreeTitleDoubleClick(item, event)
                  : undefined
          }
          archivePending={sidebarArchivePendingKeys.has(item.key)}
          onArchive={
            manageable && onArchiveSidebarThread
              ? (rowItem) => onArchiveSidebarThread(rowItem, session ?? undefined)
              : undefined
          }
          onTogglePinned={
            session && onToggleSessionPinned
              ? () => onToggleSessionPinned(session)
              : onToggleSidebarThreadPinned
          }
          onOpenLinkedPage={
            session && onOpenSessionLinkedPage
              ? (page) => onOpenSessionLinkedPage(session, page)
              : undefined
          }
        />
      );
    },
    [
      activeSessionId,
      activePendingClientThreadId,
      contextMenuSessionId,
      onToggleSessionSettled,
      onSnoozeSession,
      onAcceptSessionWork,
      snoozeShortcutLabel,
      onOpenSessionContextMenu,
      onOpenSessionLinkedPage,
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

  // A row's lane follows the same live status its glyph shows, so the two never disagree.
  const describeLifecycleChat = useCallback(
    (session: ProjectSession): (SidebarLifecycleChat & { readonly threadKey: string }) | null => {
      const threadKey = sidebarThreadKeyBySessionId.get(session.id);
      const item = threadKey ? sidebarThreadItemsByKey.get(threadKey) : undefined;
      if (!threadKey || !item || sidebarArchivePendingKeys.has(threadKey)) return null;
      const live = projectSidebarThreadRowLiveView(
        item,
        runtimeSessionTarget(session)
          ? {
              indicator: runtimeSessionLiveIndicator(runtimeActivities.get(session.id)),
              location: null,
            }
          : null,
      );
      return {
        id: session.id,
        threadKey,
        pinned: session.pinned,
        snoozedUntil: session.snoozedUntil,
        snoozedAt: session.snoozedAt,
        attentionAt: session.attentionAt ?? session.activityAt,
        status: live.status,
      };
    },
    [
      runtimeActivities,
      sidebarArchivePendingKeys,
      sidebarThreadItemsByKey,
      sidebarThreadKeyBySessionId,
    ],
  );
  const lifecycleChats = useMemo(
    () =>
      arrangedByAttention
        ? openLaneSessions.flatMap((session) => {
            const chat = describeLifecycleChat(session);
            return chat ? [chat] : [];
          })
        : [],
    [arrangedByAttention, describeLifecycleChat, openLaneSessions],
  );
  const chatLanes = useSidebarChatLanes({
    chats: lifecycleChats,
    activeSessionId,
    holding: laneHolding,
  });
  const settledThreadKeys = useMemo(
    () =>
      settledLaneSessions.flatMap((session) => {
        const threadKey = sidebarThreadKeyBySessionId.get(session.id);
        return threadKey && !sidebarArchivePendingKeys.has(threadKey) ? [threadKey] : [];
      }),
    [settledLaneSessions, sidebarArchivePendingKeys, sidebarThreadKeyBySessionId],
  );
  const visibleChats = useMemo<readonly SidebarVisibleChat[]>(() => {
    const visible = (chat: SidebarLifecycleChat): SidebarVisibleChat => ({
      sessionId: chat.id,
      needsReader: sidebarChatNeedsReader(chat.status),
      waitsOnReader: chat.status === "attention",
      open: true,
    });
    const chatForThreadKey = (threadKey: string) => {
      const item = sidebarThreadItemsByKey.get(threadKey);
      const session = item ? resolveSessionForItem(item) : null;
      return session ? describeLifecycleChat(session) : null;
    };
    const expandedProjectThreadKeys = (projectId: string) => {
      const group = projectGroupById.get(projectId);
      return group && expandedProjectIds.has(projectId)
        ? [...group.pinnedThreadKeys, ...group.threadKeys]
        : [];
    };
    if (arrangedByAttention)
      return [
        ...(pinnedThreadsSectionCollapsed || hiddenShelves.includes("pinned")
          ? []
          : chatLanes.pinned),
        ...(sidebarCollapsibleSections.active ? [] : chatLanes.active),
        ...(sidebarCollapsibleSections.working || hiddenShelves.includes("working")
          ? []
          : chatLanes.working),
        ...(sidebarCollapsibleSections.snoozed || hiddenShelves.includes("snoozed")
          ? []
          : chatLanes.snoozed),
      ].map(visible);
    // The tree's Sections sit between Pinned and the Projects; moving from chat to chat reaches
    // their chats where they sit.
    const sectionChats = sidebarSectionChatIds({
      sectionIds: sectionCatalog.sections.map((section) => section.sectionId),
      itemsBySectionId: sectionCatalog.itemsBySectionId,
      collapsed: (sectionId) => sidebarCollapsibleSections[`custom:${sectionId}`] ?? false,
      projectChatIds: (projectId) =>
        expandedProjectThreadKeys(projectId).flatMap((threadKey) => {
          const chat = chatForThreadKey(threadKey);
          return chat ? [chat.id] : [];
        }),
    }).flatMap((sessionId) => {
      const threadKey = sidebarThreadKeyBySessionId.get(sessionId);
      const chat = threadKey ? chatForThreadKey(threadKey) : null;
      return chat ? [chat] : [];
    });
    // The tree lists Pinned, then the reader's Sections, then the Projects and their chats.
    const chatsFor = (threadKeys: readonly string[]) =>
      threadKeys.flatMap((threadKey) => {
        const chat = chatForThreadKey(threadKey);
        return chat ? [chat] : [];
      });
    const ordered = [
      ...chatsFor(pinnedThreadsSectionCollapsed ? [] : visiblePinnedStandaloneThreadKeys),
      ...sectionChats,
      ...chatsFor(
        projectsSectionCollapsed
          ? []
          : [...pinnedProjectGroups, ...unpinnedProjectGroups].flatMap((group) =>
              expandedProjectThreadKeys(group.project.id),
            ),
      ),
      ...chatsFor(chatsSectionCollapsed ? [] : projectlessThreadKeys),
    ];
    const seen = new Set<string>();
    return ordered.flatMap((chat) => {
      if (seen.has(chat.id)) return [];
      seen.add(chat.id);
      return [visible(chat)];
    });
  }, [
    arrangedByAttention,
    chatLanes,
    chatsSectionCollapsed,
    hiddenShelves,
    describeLifecycleChat,
    expandedProjectIds,
    projectGroupById,
    sectionCatalog.itemsBySectionId,
    sectionCatalog.sections,
    sidebarCollapsibleSections,
    sidebarThreadKeyBySessionId,
    pinnedProjectGroups,
    pinnedThreadsSectionCollapsed,
    projectlessThreadKeys,
    projectsSectionCollapsed,
    resolveSessionForItem,
    sidebarThreadItemsByKey,
    unpinnedProjectGroups,
    visiblePinnedStandaloneThreadKeys,
  ]);
  useEffect(() => {
    onVisibleChatsChange(visibleChats);
  }, [onVisibleChatsChange, visibleChats]);

  const renderProjectGroup = (
    { project, pinnedThreadKeys, threadKeys }: CodexSidebarProjectGroup,
    dnd?: CodexProjectRowDndCapability,
    currentSectionId: string | null = null,
  ) => {
    // Arranged by attention, a Project is a place to open; its chats already sit in their lanes.
    const expanded = !arrangedByAttention && expandedProjectIds.has(project.id);
    const threadListId = `project:${project.id}` as const;
    const projectThreadItems = Array.from(new Set([...pinnedThreadKeys, ...threadKeys]))
      .map((threadKey) => sidebarThreadItemsByKey.get(threadKey))
      .filter((item): item is CodexSidebarThreadItem => item != null);

    return (
      <CodexProjectRow
        key={project.id}
        project={project}
        runtimeActivity={runtimeGroupActivity.projects.get(project.id)}
        activity={
          projectActivityQuery.isPending
            ? undefined
            : projectActivityQuery.isError
              ? null
              : (projectActivityById.get(project.id) ?? null)
        }
        active={activeSessionId === null && activeProjectId === project.id}
        expanded={expanded}
        disclosure={!arrangedByAttention}
        dnd={dnd}
        inboxCount={projectInboxCounts[project.id] ?? 0}
        threadItems={projectThreadItems}
        onActivate={() =>
          arrangedByAttention ? onSelectProject(project.id) : onToggleProjectExpanded(project.id)
        }
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
        {arrangedByAttention ? null : (
          <SidebarProjectThreadRowsContent
            project={project}
            pinnedThreadKeys={pinnedThreadKeys}
            sortablePinnedThreadKeys={pinnedThreadKeys.filter(
              (threadKey) =>
                model.threadItemsByKey.has(threadKey) && !sidebarArchivePendingKeys.has(threadKey),
            )}
            threadKeys={threadKeys}
            extraPages={sidebarListExtraPages[threadListId] ?? 0}
            onExtraPagesChange={(extraPages) => {
              onSidebarListExtraPagesChange(threadListId, extraPages);
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
            regularReorderable={chatOrder === "manual"}
            onPlaceSession={onPlaceSession}
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
        )}
      </CodexProjectRow>
    );
  };

  const renderProjectGroupRows = (
    groups: CodexSidebarProjectGroup[],
    options: {
      reorderScope: "projects" | "pinned";
      extraPages: number;
      onExtraPagesChange: (extraPages: number) => void;
      emptyText?: string;
      readsProjectWindow?: boolean;
    },
  ) => (
    <SidebarPaginatedItems
      items={groups}
      getKey={(group) => group.project.id}
      maxItems={CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS}
      extraPages={options.extraPages}
      onExtraPagesChange={options.onExtraPagesChange}
      forcedVisibleKey={activeProjectId}
      source={
        options.readsProjectWindow && onLoadMoreProjects
          ? {
              hasMore: hasMoreProjects,
              loading: loadingMoreProjects,
              failed: loadMoreProjectsFailed,
              loadMore: onLoadMoreProjects,
            }
          : undefined
      }
    >
      {(pagination, pager) => {
        const visibleGroupIds = pagination.visibleItems.map((group) => group.project.id);
        return (
          <SidebarProjectGroupRowsContent
            visibleItems={pagination.visibleItems}
            pager={pager}
            emptyText={
              options.emptyText ??
              intl.formatMessage({
                id: "workbench.workbenchSessionSidebar.noProjects",
                defaultMessage: "No projects",
              })
            }
            loading={loadingMoreProjects}
            reorderGroups={(nextVisibleGroupIds) => {
              if (options.reorderScope === "pinned") {
                return reorderVisiblePinnedProjectGroups(visibleGroupIds, nextVisibleGroupIds);
              }
              return reorderVisibleProjectGroups(visibleGroupIds, nextVisibleGroupIds);
            }}
            renderProjectGroup={(group, groupDndController) =>
              renderProjectGroup(
                group,
                arrangedByAttention ? undefined : { controller: groupDndController },
              )
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
          data-sidebar-drop-target={pinnedDropTarget.isOver ? "true" : undefined}
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
        data-sidebar-drop-target={pinnedDropTarget.isOver ? "true" : undefined}
        className={cn(
          "relative",
          pinnedDropTarget.isExternalThreadDropTarget &&
            pinnedDropTarget.isOver &&
            "rounded-lg bg-token-list-hover-background",
        )}
      >
        <CodexSidebarSection
          heading={intl.formatMessage({
            id: "workbench.workbenchSessionSidebar.pinned",
            defaultMessage: "Pinned",
          })}
          collapsed={pinnedThreadsSectionCollapsed}
          onToggle={onTogglePinnedThreadsSectionCollapsed}
        >
          {visiblePinnedStandaloneThreadKeys.length > 0 ? (
            <SidebarPinnedThreadRowsContent
              containerId="pinned"
              getSessionId={getSidebarSessionId}
              getThreadId={getSidebarRealThreadId}
              visibleThreadKeys={visiblePinnedStandaloneThreadKeys}
              itemsByKey={sidebarThreadItemsByKey}
              ariaLabel={intl.formatMessage({
                id: "workbench.workbenchSessionSidebar.pinnedChats",
                defaultMessage: "Pinned chats",
              })}
              onVisibleThreadOrderChange={reorderVisiblePinnedThreads}
              renderThread={renderThreadRow}
            />
          ) : null}
          {pinnedProjectGroups.length > 0
            ? renderProjectGroupRows(pinnedProjectGroups, {
                reorderScope: "pinned",
                extraPages: sidebarListExtraPages.pinned ?? 0,
                onExtraPagesChange: (extraPages) =>
                  onSidebarListExtraPagesChange("pinned", extraPages),
              })
            : null}
        </CodexSidebarSection>
      </div>
    );
  };

  // Arranged by attention, every row says what its chat is about under its title.
  const renderLaneThread = (threadKey: string) =>
    renderThreadRow(threadKey, {
      // Showing one Project, every row is that Project's; the name would only repeat.
      showProject: !(arrangedByAttention && lifecycle.scopeProjectId),
      preview: arrangedByAttention,
    });
  const toggleShelf = (shelf: "active" | "working" | "snoozed" | "settled") => () =>
    onSetSidebarSectionCollapsed(shelf, !sidebarCollapsibleSections[shelf]);
  const laneAttention = (chats: readonly SidebarLifecycleChat[]) =>
    resolveSidebarGroupStatus({
      needsAttention: chats.some((chat) => chat.status === "attention"),
      unread: chats.some((chat) => chat.status === "unread"),
      running: false,
    });

  // Settled chats share one shelf however the open ones are arranged.
  const renderSettledShelf = () => (
    <SidebarChatLaneSection
      shelf="settled"
      threadKeys={settledThreadKeys}
      collapsed={sidebarCollapsibleSections.settled}
      onToggle={toggleShelf("settled")}
      state={lifecycle.settledLane.collection.state}
      onRetry={lifecycle.settledLane.retry}
      source={{
        hasMore: lifecycle.settledLane.collection.hasMore,
        loadMore: lifecycle.settledLane.loadMore,
      }}
      extraPages={sidebarListExtraPages.settled ?? 0}
      onExtraPagesChange={(extraPages) => onSidebarListExtraPagesChange("settled", extraPages)}
      forcedVisibleKey={activeThreadKey}
      renderThread={renderLaneThread}
    />
  );

  const openLaneSessionById = new Map(openLaneSessions.map((session) => [session.id, session]));
  const settleableReadSessions = resolveSettleableReadChats(chatLanes.active, (chatId) => {
    const session = openLaneSessionById.get(chatId);
    return session ? hasSessionConversation(session) && session.pageTurn === null : false;
  }).flatMap((chatId) => {
    const session = openLaneSessionById.get(chatId);
    return session ? [session] : [];
  });

  const renderChatLanes = () => {
    const openLane = lifecycle.openLane;
    const laneProps = {
      state: openLane.collection.state,
      onRetry: openLane.retry,
      forcedVisibleKey: activeThreadKey,
    };
    const shows = (shelf: SidebarOptionalShelf) => !hiddenShelves.includes(shelf);
    // The view options sit beside the first heading: Pinned when it shows, otherwise Active,
    // which always does.
    const pinnedLeads = shows("pinned") && chatLanes.pinned.length > 0;
    return (
      <>
        {pinnedLeads ? (
          <SidebarChatLaneSection
            {...laneProps}
            shelf="pinned"
            actions={laneViewMenu}
            renderThread={renderLaneThread}
            threadKeys={chatLanes.pinned.map((chat) => chat.threadKey)}
            collapsed={pinnedThreadsSectionCollapsed}
            onToggle={onTogglePinnedThreadsSectionCollapsed}
            attention={laneAttention(chatLanes.pinned)}
            extraPages={sidebarListExtraPages.pinned ?? 0}
            onExtraPagesChange={(extraPages) => onSidebarListExtraPagesChange("pinned", extraPages)}
          />
        ) : null}
        <SidebarChatLaneSection
          {...laneProps}
          shelf="active"
          renderThread={renderLaneThread}
          actions={
            settleableReadSessions.length > 0 || !pinnedLeads ? (
              <>
                {settleableReadSessions.length > 0 ? (
                  <SidebarSettleReadChatsButton
                    count={settleableReadSessions.length}
                    onSettle={() => lifecycle.onSettleSessions(settleableReadSessions)}
                  />
                ) : null}
                {pinnedLeads ? null : laneViewMenu}
              </>
            ) : undefined
          }
          threadKeys={chatLanes.active.map((chat) => chat.threadKey)}
          collapsed={sidebarCollapsibleSections.active}
          onToggle={toggleShelf("active")}
          attention={laneAttention(chatLanes.active)}
          source={{ hasMore: openLane.collection.hasMore, loadMore: openLane.loadMore }}
          extraPages={sidebarListExtraPages.active ?? 0}
          onExtraPagesChange={(extraPages) => onSidebarListExtraPagesChange("active", extraPages)}
        />
        {shows("working") ? (
          <SidebarChatLaneSection
            {...laneProps}
            shelf="working"
            renderThread={renderLaneThread}
            threadKeys={chatLanes.working.map((chat) => chat.threadKey)}
            collapsed={sidebarCollapsibleSections.working}
            onToggle={toggleShelf("working")}
            extraPages={sidebarListExtraPages.working ?? 0}
            onExtraPagesChange={(extraPages) =>
              onSidebarListExtraPagesChange("working", extraPages)
            }
          />
        ) : null}
        {shows("snoozed") ? (
          <SidebarChatLaneSection
            {...laneProps}
            shelf="snoozed"
            renderThread={renderLaneThread}
            threadKeys={chatLanes.snoozed.map((chat) => chat.threadKey)}
            collapsed={sidebarCollapsibleSections.snoozed}
            onToggle={toggleShelf("snoozed")}
            extraPages={sidebarListExtraPages.snoozed ?? 0}
            onExtraPagesChange={(extraPages) =>
              onSidebarListExtraPagesChange("snoozed", extraPages)
            }
          />
        ) : null}
        {shows("projects") ? (
          <CodexSidebarSection
            heading={intl.formatMessage({
              id: "workbench.workbenchSessionSidebar.projects",
              defaultMessage: "Projects",
            })}
            collapsed={projectsSectionCollapsed}
            onToggle={onToggleProjectsSectionCollapsed}
            actions={
              <SidebarProjectsSectionActions
                chatOrder={chatOrder}
                onChatOrderChange={onChatOrderChange}
                organize={lifecycle.organize}
                autoSettleDays={lifecycle.autoSettleDays}
                onAutoSettleDaysChange={lifecycle.onAutoSettleDaysChange}
                onCreateProject={onCreateProject}
                openCreateDialogTick={projectPickerOpenTick}
              />
            }
          >
            <StableWorktreeSidebarRows
              entries={pendingStableWorktrees}
              onOpen={onOpenStableWorktree}
            />
            {renderProjectGroupRows(placeProjectGroups, {
              reorderScope: "projects",
              extraPages: sidebarListExtraPages.projects ?? 0,
              onExtraPagesChange: (extraPages) =>
                onSidebarListExtraPagesChange("projects", extraPages),
              readsProjectWindow: true,
            })}
          </CodexSidebarSection>
        ) : null}
        {shows("settled") ? renderSettledShelf() : null}
      </>
    );
  };

  const renderProjectGroups = () => (
    <>
      {renderPinnedSection()}
      <SidebarCustomSections
        runtimeActivities={runtimeGroupActivity.sections}
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
          // A chat its reader settled leaves the Section's list for the Settled shelf.
          if (session.settledAt != null) return null;
          const threadKey = sidebarThreadKeyBySessionId.get(session.id);
          return threadKey ? renderThreadRow(threadKey) : null;
        }}
        onSelectSession={onSelectSession}
        activeSessionId={activeSessionId}
        collapsedSections={sidebarCollapsibleSections}
        onSetCollapsed={onSetSidebarSectionCollapsed}
        listExtraPages={sidebarListExtraPages}
        onListExtraPagesChange={onSidebarListExtraPagesChange}
        onThreadsChanged={onThreadsChanged}
        getThreadKey={(sessionId) =>
          sidebarThreadKeyBySessionId.get(sessionId) ?? `section-session:${sessionId}`
        }
      />
      <CodexSidebarSection
        heading={intl.formatMessage({
          id: "workbench.workbenchSessionSidebar.projects",
          defaultMessage: "Projects",
        })}
        collapsed={projectsSectionCollapsed}
        onToggle={onToggleProjectsSectionCollapsed}
        actions={
          <SidebarProjectsSectionActions
            chatOrder={chatOrder}
            onChatOrderChange={onChatOrderChange}
            organize={lifecycle.organize}
            autoSettleDays={lifecycle.autoSettleDays}
            onAutoSettleDaysChange={lifecycle.onAutoSettleDaysChange}
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
          extraPages: sidebarListExtraPages.projects ?? 0,
          onExtraPagesChange: (extraPages) => onSidebarListExtraPagesChange("projects", extraPages),
          readsProjectWindow: true,
        })}
      </CodexSidebarSection>
      <SidebarThreadDropContainer
        containerId="chats"
        targetProjectKind="local"
        className="-mb-4 pb-4"
      >
        <CodexSidebarSection
          heading={intl.formatMessage({
            id: "workbench.workbenchSessionSidebar.chats",
            defaultMessage: "Chats",
          })}
          collapsed={chatsSectionCollapsed}
          onToggle={onToggleChatsSectionCollapsed}
          actions={
            <CodexSidebarActionButton
              label={intl.formatMessage({
                id: "workbench.workbenchSessionSidebar.newProjectlessChat",
                defaultMessage: "New projectless chat",
              })}
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
            extraPages={sidebarListExtraPages.chats ?? 0}
            onExtraPagesChange={(extraPages) => onSidebarListExtraPagesChange("chats", extraPages)}
            forcedVisibleKey={activeThreadKey}
            suppressedKeys={sidebarArchivePendingKeys}
            collectionState={projectlessSessionCollection.state}
            hasMoreAtSource={projectlessSessionCollection.hasMore}
            onLoadMore={() => onLoadMoreTaskWindow(null)}
            onRetry={() => onRetryTaskWindow(null)}
            reorderable={chatOrder === "manual"}
            onPlaceSession={onPlaceSession}
            renderThread={renderThreadRow}
          />
        </CodexSidebarSection>
      </SidebarThreadDropContainer>
      {renderSettledShelf()}
    </>
  );

  return arrangedByAttention ? renderChatLanes() : renderProjectGroups();
}

export interface ProjectSessionSidebarProps extends Omit<
  WorkbenchSidebarFrameProps,
  "children" | "testId"
> {
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
  projectsSectionCollapsed: boolean;
  chatsSectionCollapsed: boolean;
  sidebarCollapsibleSections: SidebarCollapsibleSectionsState;
  /** Show more steps each list keeps revealed, remembered by the Profile. */
  sidebarListExtraPages: SidebarListExtraPagesState;
  onSidebarListExtraPagesChange: (listId: SidebarListId, extraPages: number) => void;
  onLoadMoreTaskWindow: (projectId: string | null) => Promise<void>;
  onRetryTaskWindow: (projectId: string | null) => Promise<void>;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
  onTogglePinnedProjectsSectionCollapsed: () => void;
  onToggleProjectsSectionCollapsed: () => void;
  onToggleChatsSectionCollapsed: () => void;
  onSetSidebarSectionCollapsed: (sectionId: SidebarDisclosureSectionId, collapsed: boolean) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (session: ProjectSessionDomain) => void;
  onSelectSidebarThread: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onPreviewSidebarThread?: (item: CodexSidebarThreadItem) => void;
  onOpenSessionContextMenu?: (session: ProjectSession, event: ReactMouseEvent<HTMLElement>) => void;
  /** Takes the person to a chat with its earliest-linked live Page beside it. */
  onOpenSessionLinkedPage?: (session: ProjectSession, page: SessionLinkedPage) => void;
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
  onOpenInbox: () => void;
  inboxActive: boolean;
  /** Messages waiting in the Library Inbox and in each Project's Inbox. */
  inboxCounts: InboxCounts;
  projectPickerOpenTick?: number;
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onReorderProjects: (input: ProjectOrderInput) => Promise<void>;
  onSetProjectPinned: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onSetPinnedProjectOrder: (input: ProjectPinnedOrderInput) => Promise<void>;
  chatOrder: SidebarChatOrder;
  onChatOrderChange: (chatOrder: SidebarChatOrder) => void;
  lifecycle: SidebarChatLifecycle;
  onPlaceSession: (sessionId: string, placement: ProjectSessionPlacement) => Promise<void>;
  onMoveSidebarThread: (drop: SidebarThreadDropRequest) => Promise<SidebarThreadDropCommit | null>;
  onReorderPinnedThreads: (orderedThreadIds: readonly string[]) => Promise<unknown>;
  sidebarArchivePendingKeys: ReadonlySet<string>;
  hasMoreProjects: boolean;
  loadingMoreProjects: boolean;
  loadMoreProjectsFailed: boolean;
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
  projectsSectionCollapsed,
  chatsSectionCollapsed,
  sidebarCollapsibleSections,
  sidebarListExtraPages,
  onSidebarListExtraPagesChange,
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
  onToggleProjectsSectionCollapsed,
  onToggleChatsSectionCollapsed,
  onSetSidebarSectionCollapsed,
  onToggleProjectExpanded,
  onSelectProject,
  onSelectSession,
  onSelectSidebarThread,
  onPreviewSidebarThread,
  onOpenSessionContextMenu,
  onOpenSessionLinkedPage,
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
  onOpenInbox,
  inboxActive,
  inboxCounts,
  projectPickerOpenTick = 0,
  onCreateProject,
  onUpdateProject,
  onArchiveProject,
  onReorderProjects,
  onSetProjectPinned,
  onSetPinnedProjectOrder,
  chatOrder,
  onChatOrderChange,
  lifecycle,
  onPlaceSession,
  onMoveSidebarThread,
  onReorderPinnedThreads,
  sidebarArchivePendingKeys,
  hasMoreProjects,
  loadingMoreProjects,
  loadMoreProjectsFailed,
  onLoadMoreProjects,
}: ProjectSessionSidebarProps) {
  const intl = useIntl();
  const homeTitle = useHomeTitle();
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
  const { mutation: libraryMutation } = useApplyLibraryOperation();
  const { scrollAreaRef, ...sidebarScrollChrome } = useSidebarScrollChrome();
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
        void workspaceSidebarCommands
          .moveItem({
            item: { kind: "project", projectId: drop.projectId },
            sectionId,
            placement: resolveSidebarSectionItemPlacement(targetItems, drop.beforeItemId),
          })
          .then(async () => {
            await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
          })
          .catch(() =>
            toast.danger(
              getIntl().formatMessage({
                id: "workbench.workbenchSessionSidebar.moveProjectFailed",
                defaultMessage: "Failed to move project to section",
              }),
            ),
          );
        return;
      }
      if (drop.targetContainerId === "pinned") {
        void onSetProjectPinned(drop.projectId, { pinned: true }).catch(() => {
          toast.danger(
            getIntl().formatMessage({
              id: "workbench.workbenchSessionSidebar.pinProjectFailed",
              defaultMessage: "Failed to pin project",
            }),
          );
        });
      }
    },
    [onSetProjectPinned, queryClient, sectionCatalog.itemsBySectionId],
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
        toast.danger(
          error instanceof Error
            ? error.message
            : getIntl().formatMessage({
                id: "workbench.workbenchSessionSidebar.moveLibraryItemFailed",
                defaultMessage: "Could not move Library item",
              }),
        );
      }
    },
    [libraryMutation],
  );
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
  const laneHold = useSidebarLaneHold();
  const scopeProjects = sidebarThreadModel.projectGroups.map(({ project }) => ({
    id: project.id,
    name: project.name,
    inboxCount: inboxCounts.projects[project.id] ?? 0,
  }));
  // The scope belongs to the attention lanes; a Project that left the list shows every Project.
  const scopeProject =
    lifecycle.organize === "attention"
      ? (scopeProjects.find((project) => project.id === lifecycle.scopeProjectId) ?? null)
      : null;
  const scopeProjectId = scopeProject?.id ?? null;

  return (
    <WorkbenchSidebarFrame
      floating={floating}
      header={header}
      width={width}
      animatedWidth={animatedWidth}
      contentOpacity={contentOpacity}
      resizeDisabled={resizeDisabled}
      getWindowZoom={getWindowZoom}
      onResizeWidth={onResizeWidth}
      onResizeActiveChange={onResizeActiveChange}
      testId="project-session-sidebar"
    >
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden [--height-token-nav-row:30px] [--padding-row-cell-x:8px] [--padding-row-x:8px] [--radius-token-row:10px]"
        style={sidebarScrollChrome.scrollChromeStyle}
      >
        <nav
          className="sidebar-foreground-muted flex min-h-0 flex-1 flex-col"
          {...laneHold.holdHandlers}
          role="navigation"
          aria-label={intl.formatMessage({
            id: "workbench.workbenchSessionSidebar.home",
            defaultMessage: "Home",
          })}
        >
          <WorkbenchSidebarHeader
            title={homeTitle}
            searchShortcutLabel={resolveCodexPageSearchShortcutLabel()}
            scrolledContentUnderHeader={sidebarScrollChrome.scrolledContentUnderHeader}
            onSearch={onOpenCommandPalette}
            tools={
              <>
                {scopeProject ? (
                  <SidebarScopeChip
                    projectName={scopeProject.name}
                    onClear={() => lifecycle.onScopeChange(null)}
                  />
                ) : null}
                <SidebarArrangeToggle
                  organize={lifecycle.organize}
                  shortcutLabel={lifecycle.organizeShortcutLabel}
                  onOrganizeChange={lifecycle.onOrganizeChange}
                />
              </>
            }
          >
            <SidebarInboxButton
              entry={
                // Showing one Project, the entry is that Project's Inbox.
                scopeProject
                  ? {
                      active: activeSessionId === null && activeProjectId === scopeProject.id,
                      count: scopeProject.inboxCount,
                      waiting: inboxCounts.waiting.projects[scopeProject.id] === true,
                      shortcutLabel: resolveCodexInboxShortcutLabel(),
                      onOpen: () => onSelectProject(scopeProject.id),
                    }
                  : {
                      active: inboxActive,
                      count: inboxCounts.library,
                      waiting: inboxCounts.waiting.library,
                      shortcutLabel: resolveCodexInboxShortcutLabel(),
                      onOpen: onOpenInbox,
                    }
              }
            />
            <SidebarNewChatButton
              shortcutLabel={resolveCodexNewChatShortcutLabel()}
              onClick={() => void onStartNewChatInProject(scopeProject?.id ?? activeProjectId)}
            />
          </WorkbenchSidebarHeader>

          <div
            ref={scrollAreaRef}
            data-app-action-sidebar-scroll=""
            data-content-below={sidebarScrollChrome.hasContentBelow ? "true" : "false"}
            className={SIDEBAR_SCROLL_AREA_CLASS}
            onScroll={sidebarScrollChrome.syncScrollChrome}
          >
            <SidebarReorderDndProvider
              getThreadIdByThreadKey={getSidebarThreadIdByKey}
              homeContainerIdByThreadId={homeContainerIdByThreadId}
              onProjectError={reportSidebarProjectReorderError}
              onProjectDrop={handleProjectDrop}
              onThreadError={reportSidebarThreadReorderError}
              onThreadDrop={onMoveSidebarThread}
              onLibraryMove={handleLibraryMove}
            >
              <SidebarThreadOrganizerSections
                laneHolding={laneHold.holding}
                laneViewMenu={
                  <SidebarLaneViewMenu
                    hiddenShelves={lifecycle.hiddenShelves}
                    onHiddenShelvesChange={lifecycle.onHiddenShelvesChange}
                    scopeProjectId={scopeProjectId}
                    projects={scopeProjects}
                    libraryInboxCount={inboxCounts.library}
                    onScopeChange={lifecycle.onScopeChange}
                  />
                }
                projectInboxCounts={inboxCounts.projects}
                activeProjectId={activeProjectId}
                activeSessionId={activeSessionId}
                activePendingClientThreadId={activePendingClientThreadId}
                contextMenuSessionId={contextMenuSessionId}
                sessionCollectionsByProject={sessionCollectionsByProject}
                projectlessSessionCollection={projectlessSessionCollection}
                expandedProjectIds={expandedProjectIds}
                pinnedThreadsSectionCollapsed={pinnedProjectsSectionCollapsed}
                projectsSectionCollapsed={projectsSectionCollapsed}
                chatsSectionCollapsed={chatsSectionCollapsed}
                sidebarCollapsibleSections={sidebarCollapsibleSections}
                sidebarListExtraPages={sidebarListExtraPages}
                onSidebarListExtraPagesChange={onSidebarListExtraPagesChange}
                onLoadMoreTaskWindow={onLoadMoreTaskWindow}
                onRetryTaskWindow={onRetryTaskWindow}
                model={sidebarThreadModel}
                onHoverSurfaceOpenChange={onHoverSurfaceOpenChange}
                onTogglePinnedThreadsSectionCollapsed={onTogglePinnedProjectsSectionCollapsed}
                onToggleProjectsSectionCollapsed={onToggleProjectsSectionCollapsed}
                onToggleChatsSectionCollapsed={onToggleChatsSectionCollapsed}
                onSetSidebarSectionCollapsed={onSetSidebarSectionCollapsed}
                onToggleProjectExpanded={onToggleProjectExpanded}
                onSelectProject={onSelectProject}
                onSelectSession={onSelectSession}
                onSelectSidebarThread={onSelectSidebarThread}
                onPreviewSidebarThread={onPreviewSidebarThread}
                onOpenSessionContextMenu={onOpenSessionContextMenu}
                onOpenSessionLinkedPage={onOpenSessionLinkedPage}
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
                chatOrder={chatOrder}
                onChatOrderChange={onChatOrderChange}
                lifecycle={lifecycle}
                onPlaceSession={onPlaceSession}
                onReorderPinnedThreads={onReorderPinnedThreads}
                sidebarArchivePendingKeys={sidebarArchivePendingKeys}
                hasMoreProjects={hasMoreProjects}
                loadingMoreProjects={loadingMoreProjects}
                loadMoreProjectsFailed={loadMoreProjectsFailed}
                onLoadMoreProjects={onLoadMoreProjects}
              />
            </SidebarReorderDndProvider>
          </div>
        </nav>
      </div>
    </WorkbenchSidebarFrame>
  );
}
