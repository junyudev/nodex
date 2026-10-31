import { openWorkbenchSceneFile } from "@/lib/workbench-scene-file-opener";
import { prepareWorkbenchSceneSurfaceClose } from "@/lib/workbench-scene-command-lifecycle";
import type { FileReferenceRouterPort } from "@/lib/file-reference-router";
import { useRegisterFileLocationNavigator } from "@/lib/file-location-navigation";
import { useApplicationReady } from "@/bootstrap/application-surface";
import { subscribeDictationRecordingNavigation } from "@/lib/global-dictation-commands";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, type MotionStyle } from "motion/react";
import { BackIcon } from "@/components/shared/icons";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { PanelTabPresentationRegistry } from "./panel-tab-presentation-registry";
import { WorkbenchSidebar, type WorkbenchSidebarBodyProps } from "./workbench-sidebar";
import { WorkbenchAppRail } from "./workbench-app-rail";
import { WorkbenchRailFoot } from "./workbench-rail-account-controls";
import { WorkbenchTitlebarProvider } from "./workbench-titlebar-context";
import { WorkspaceFullViewToggle, WorkspaceTabsControl } from "./workspace-tabs-control";
import type { AppShellLeadingTab } from "./app-shell-tabs";
import { SESSION_CHAT_TAB_STATUS_LABELS, SessionChatTabIcon } from "./session-chat-tab-icon";
import { useSessionRowStatus } from "@/lib/use-session-execution";
import {
  ThreadStageHeaderSlotContext,
  type ThreadStageHeaderSlot,
} from "@/features/local-conversation/view/thread-stage-header-slot";
import { ThreadSummaryToggleDensityContext } from "@/features/local-conversation/view/summary-panel/thread-summary-panel-toggle";
import {
  WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
} from "@/lib/workbench-shell-geometry";
import { getWorkbenchPrimaryDestination } from "../../../shared/workbench-layout";
import { WorkbenchEmptyRoute, WorkbenchRouteHost } from "./workbench-route-host";
import { InboxRoute } from "@/features/inbox/inbox-route";
import { inboxScopeProjectId } from "../../../shared/inbox";
import { parseDatabaseId } from "../../../shared/database-identities";
import { useInboxCounts, useInboxInvalidation } from "@/features/inbox/use-inbox";
import { WorkbenchThreadSummaryHeader } from "./workbench-thread-summary-header";
import { ToolbarIconButton, WindowNavigationToolbarButton } from "./workbench-panel-controls";
import { ContentIssuesControl } from "@/components/shared/content-issues-control";
import { contentEditIssues, type ContentEditLocation } from "@/lib/content-edit-issues";
import type {
  ContentRoutingContext,
  ContentRoutingIdentity,
} from "../../../shared/content-routing-context";
import { ContentRecoveryObserver } from "@/features/document-recovery/recovery-entry";
import {
  PageStageSessionTab,
  type OpenPageTabHandler,
  type PageStageHistoryModalContext,
} from "./workbench-page-stage-panel";
import {
  HeaderAction,
  HeaderActionProvider,
  HeaderInlineActionRail,
  HeaderShellSlot,
} from "./workbench-header-actions";
import { HistoryPanel } from "./workbench-history-panel";
import { useTerminalSessionStoreVersion } from "@/lib/terminal-session-store";
import { BrowserSidebarHiddenWebviewHosts } from "@/features/browser-sidebar/browser-sidebar-hidden-webview-hosts";
import { useBrowserSidebarRendererState } from "@/features/browser-sidebar/browser-sidebar-renderer-state-store";
import { WorkspaceFilesPanel, type WorkspaceFilesTab } from "@/features/workspace-files";
import {
  ContentSearchProvider,
  type ContentSearchOpenRequest,
} from "@/features/content-search/content-search-context";
import { ContentSearchSurface } from "@/features/content-search/content-search-surface";
import {
  buildSettingsAnchorPath,
  buildSettingsPath,
  resolveBrowserSettingsDestination,
} from "./workbench-settings-routes";
import {
  AgentSettingsNavigationProvider,
  agentSettingsAnchor,
  type AgentSettingsKind,
} from "@/lib/agent-settings-navigation";
import type { BrowserSettingsDestination } from "./workbench-settings-routes";
import type { SettingsOpenThread } from "./workbench-settings-page-registry";
import {
  buildCodexHooksSettingsPath,
  type CodexHooksSettingsTarget,
} from "@/lib/codex-hooks-route";
import {
  buildAutomationsPath,
  resolveAutomationsRouteState,
} from "@/lib/workbench-automations-routes";
import type {
  LibraryPlacedResourceTarget,
  LibraryRouteTarget,
} from "../../../shared/library-module";
import type { LibraryResourceTarget as ActionableLibraryResourceTarget } from "../library/library-resource-actions";
import { WorkbenchProcessManagerDialog } from "./workbench-process-manager-dialog";
import { LibraryFilesDialog } from "../library/library-files-dialog";
import {
  ProjectAgentDockLeadingRow,
  ProjectAgentDockUnavailableOverlay,
} from "./project-agent-dock";
import type { OpenPageStageOptions } from "@/components/board/open-page-stage";
import { NodexTooltip, NodexTooltipProvider } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { libraryContentRoute, projectContentRoute } from "../../../shared/content-routing-context";
import { requestPageCreateFromContext } from "@/lib/page-create-workflow";
import { useProjectPageCreateTarget } from "@/lib/use-project-page-create-target";
import { useMutationAuditSessionId } from "@/lib/mutation-audit-session";
import {
  useCodexAppServerControl,
  useCodexAppServerRegistry,
  useConversationSubset,
  useLocalConversationAccount,
  useLocalConversationConnection,
} from "@/features/local-conversation";
import { APP_SHELL_GLOBAL_HEADER_LAYER_CLASS } from "@/lib/app-shell-layers";
import { registerUserAttachmentImagePreviewOpener } from "@/features/user-attachment-image-editor";
import { readDatabaseViewWindow, subscribeCodexPendingWorktreeWarnings } from "@/lib/api";
import {
  consumeForkSidePanelTransfer,
  createPendingWorktree,
  listPendingWorktrees,
  pendingWorktreeRouteTransport,
} from "@/lib/pending-worktree-runtime";
import { useScheduledTasks } from "@/features/scheduled/use-scheduled-tasks";
import type { ScheduledSidebarNavigation } from "@/features/scheduled/scheduled-sidebar";
import {
  ScheduledNavigationProvider,
  type ScheduledNavigation,
} from "@/features/scheduled/scheduled-navigation";
import type { CustomizeNavigation } from "@/features/plugins/customize-navigation";
import {
  buildPluginDirectoryPath,
  buildPluginSettingsPath,
  PLUGINS_SETTINGS_PATH,
} from "@/features/plugins/plugins-routes";
import type { ScheduledTaskChatOption } from "@/features/scheduled/scheduled-task-fields";
import { buildScheduledTaskReplyPrompt } from "@/features/scheduled/scheduled-task-model";
import { useBoard } from "@/lib/use-board";
import { createPageTitleProjectionStore } from "@/lib/page-title-projection-store";
import { PageTitleProjectionProvider } from "@/lib/page-title-projection-context";
import { useLibraryNavigationInvalidation } from "@/lib/use-library-navigation";
import { cn } from "@/lib/utils";
import {
  type SidebarCollapsibleSectionsState,
  type SidebarDisclosureSectionId,
  type SidebarListExtraPagesState,
  type SidebarListId,
} from "@/lib/sidebar-section-prefs";
import { useWorkbenchSidebarState } from "@/lib/use-workbench-sidebar-state";
import type { WorkbenchCommandPort } from "@/lib/use-workbench-command-ingress";
import {
  executeDesktopNotificationAction,
  executeRuntimeDesktopNotificationAction,
  resolveDesktopNotificationParentThreadId,
  resolveDesktopNotificationRuntimeSessionId,
  resolveDesktopNotificationSideChatThreadId,
} from "@/lib/desktop-notification-action";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { DesktopNotificationActionInvocation } from "../../../shared/types";
import { makeBrowserSidebarTabKey } from "../../../shared/browser-sidebar";
import {
  APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR,
  SelectedAppShellHeaderContent,
  WorkbenchSessionScopePath,
  createThreadScopeIdentityRegistry,
  promoteThreadScopeToPending,
  resolvePendingThreadScopeDescriptor,
  resolveProjectDraftThreadScopeDescriptor,
  resolveProjectSessionThreadScopeDescriptor,
} from "@/lib/workbench-ui-scopes";
import {
  applyForkBrowserTransferToWorkbenchScene,
  collectWorkbenchScenePresentedPageIds,
  INBOX_SCENE_OWNER,
  LIBRARY_SCENE_OWNER,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  updateWorkbenchSceneSurface,
  type WorkbenchComposerOverlayState,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import type { FloatingComposerPlacement } from "@/features/floating-composer/floating-composer";
import {
  findWorkbenchPanelLeafForTab,
  getWorkbenchPanelActiveLeaf,
  listWorkbenchPanelLeaves,
} from "../../../shared/workbench-panel-layout";
import {
  applyWorkbenchSurfacePatch,
  presentWorkbenchSessionDomainWithScene,
  workbenchSurfaceFromCreateInput,
  type WorkbenchSurfaceUpdatePatch,
} from "@/lib/workbench-scene-presentation";
import {
  projectSessionProjectionsByProject,
  useWorkbenchSessionCatalog,
  useWorkbenchSessionCollections,
} from "@/lib/use-workbench-session-catalog";
import {
  createWorkbenchSceneNavigator,
  type PresentWorkbenchPanelSurfaceInput,
  type WorkbenchSurfaceOpenRequest,
} from "@/lib/workbench-scene-navigator";
import {
  listWorkbenchScenePreviewEntries,
  makeWorkbenchScenePreviewSlotKey,
  projectWorkbenchScenePreviews,
} from "@/lib/workbench-scene-preview";
import { projectDetailQueryOptions, projectSessionDetailQueryOptions } from "@/lib/query-options";
import { projectCatalogStoreFor } from "@/lib/project-catalog";
import { useWorkbenchPanelController } from "@/lib/use-workbench-panel-controller";
import { useWorkbenchPanelLifecycle } from "@/lib/use-workbench-panel-lifecycle";
import { useSaveSideChat } from "@/lib/use-save-side-chat";
import {
  useWorkbenchPanelOpeners,
  type OpenCanvasStageHandler,
} from "@/lib/use-workbench-panel-openers";
import { FileReferenceRouterProvider } from "@/lib/file-reference-router";
import { openWorkbenchWindow } from "@/lib/workbench-shell-operations";
import { useWorkbenchPanelCommandRouter } from "@/lib/use-workbench-panel-command-router";
import { useWorkbenchSessionCommands } from "@/lib/use-workbench-session-commands";
import {
  useWorkbenchPanelProjection,
  type PanelGroupTabsByPanel,
} from "./use-workbench-panel-projection";
import { useWorkbenchSidebarController } from "./use-workbench-sidebar-controller";
import { useWorkbenchSidebarChrome } from "./use-workbench-sidebar-chrome";
import { WorkbenchSessionScene } from "./workbench-session-scene";
import { ProjectSessionThreadComposerDock } from "./workbench-session-thread-route";
import { WorkbenchSceneFrame } from "./workbench-scene-frame";
import { DbViewSessionTab } from "./workbench-db-view-panel";
import { WorkbenchLibraryResourceSurface } from "./workbench-library-resource-surface";
import { WorkbenchCanvasStagePanel } from "./workbench-canvas-stage-panel";
import { WorkbenchDatabaseViewSurface } from "./workbench-database-view-surface";
import { WorkbenchLibraryPageSurface } from "./workbench-library-page-surface";
import { LibrarySceneBreadcrumb, useLibrarySceneNavigation } from "./library-scene-breadcrumb";
import { PagesTabPicker } from "./pages-tab-picker";
import { SpaceHome } from "./space-home";
import { TerminalPanel } from "./workbench-terminal-panel";
import { buildWorkbenchScenePanels } from "./workbench-scene-panels";
import { useWorkbenchRouteSurfaces } from "./use-workbench-route-surfaces";
import { WorkbenchCommandPaletteHost } from "./workbench-command-palette-host";
import { openCommandPaletteFolder } from "@/lib/command-palette-projects";
import { useWorkbenchChromeLayout } from "./use-workbench-chrome-layout";
import { useWorkbenchChromeCommands } from "@/lib/use-workbench-chrome-commands";
import {
  useWorkbenchThreadSummary,
  type WorkbenchThreadSummaryCommands,
} from "@/lib/use-workbench-thread-summary";
import {
  presentWorkbenchSession,
  type WorkbenchSessionRenderProjection,
} from "@/lib/workbench-session-presentation";
import {
  getCachedProjectSessionDetail,
  projectSessionToSummary,
} from "@/lib/project-session-query-cache";
import {
  hasSessionConversation,
  runtimeSessionLiveIndicator,
  sessionExecutionThreadId,
} from "@/lib/session-execution";
import { useWorkbenchCodexNavigation } from "@/features/local-conversation/use-workbench-codex-navigation";
import { presentPageStageRelatedChatCandidates } from "@/lib/page-stage-related-chat-candidates";
import {
  attentionForIndicator,
  buildProjectAgentDockPendingWorktreeModel,
  buildProjectAgentDockModel,
  resolveProjectAgentDockLiveIndicator,
  resolveProjectAgentDockPendingWorktree,
  type ProjectAgentDockTargetRow,
} from "@/lib/project-agent-dock-model";
import { useAgentRuntimeSessionActivity } from "@/lib/agent-runtime-session-activity";
import {
  createProjectAgentDockDraftSession,
  createProjectAgentDockMaterializer,
} from "@/lib/project-agent-dock-controller";
import type { CodexPendingWorktreeEntry } from "../../../shared/codex-pending-worktree";
import { useBrowserUsePresentationCoordinator } from "@/lib/use-browser-use-presentation-coordinator";
import { useWorkbenchPreferences } from "./use-workbench-preferences";
import { useWorkbenchWindowState } from "@/lib/use-workbench-window-state";
import { useWorkbenchAgentBridge } from "@/lib/use-workbench-agent-bridge";
import { useWorkbenchSceneCommands } from "@/lib/use-workbench-scene-commands";
import {
  getWorkbenchSceneReturnLocation,
  type WorkbenchLayoutSnapshot,
} from "../../../shared/workbench-layout";
import type {
  CodexComposerIntent,
  CodexScheduledAutomation,
  PanelId,
  Project,
  ProjectCreateInput,
  ProjectLifecycleMutationResult,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectUpdateInput,
  ProjectSession as ProjectSessionDomain,
  WorkbenchTabProjection,
  WorkbenchTabCreateInput,
} from "@/lib/types";

type ProjectSession = WorkbenchSessionRenderProjection;

import { type RecentPageSession } from "@/lib/use-workbench-profile-preferences";
import type { PageStageSessionSnapshot } from "@/components/board/page-stage/types";
import { getCodexSidebarFloatingOuterClassName } from "@/lib/codex-sidebar-auto-reveal";
import {
  CloseIcon,
  EnterFullViewIcon,
  MoveToLeftPaneIcon,
  MoveToRightPaneIcon,
  PanelBottomHiddenIcon,
  PanelBottomVisibleIcon,
  SidebarHiddenIcon,
  SidebarVisibleIcon,
} from "@/components/shared/icons";
import {
  SIDEBAR_COLLAPSED_CHROME_BUTTON_CLASS,
  SidebarCompactNewChatButton,
} from "./sidebar-new-chat-controls";
import { useCodexAccountActions } from "@/lib/use-codex-account-actions";
import {
  filterAvailablePanelActions,
  PANEL_NEW_TAB_ACTIONS,
  type PanelNewTabActionKind,
} from "@/lib/workbench-panel-actions";
import { requestPageTitleFocus } from "@/lib/page-title-focus-intent";
import { createPageFor, type CreatePageForResult } from "@/lib/workspace-page-create";
import type { PanelDestination } from "./panel-destination-picker-model";
import { WorkbenchBrowserSidebarPanel } from "./workbench-new-tab-page";
import {
  useWorkbenchNewTabPortValue,
  WorkbenchNewTabPortProvider,
  type WorkbenchNewTabOwnerContext,
  type WorkbenchNewTabPlacement,
} from "@/lib/workbench-new-tab-port";
import { inboxPagePeek, readPageStagePanelTabPageRef } from "@/lib/workbench-panel-placement";
import { formatToggleFullViewShortcutLabel } from "@/lib/workbench-command-shortcuts";
import {
  oppositeWorkbenchPanelSide,
  resolveSessionWorkspacePresentation,
  useSessionContentSidePreference,
  type WorkbenchPanelSide,
} from "@/lib/workbench-session-workspace";
import { isRootThreadRightPanelComposerOverlayEligibleTab } from "@/lib/workbench-panel-tab-model";
import {
  buildSessionPanelRenderModel,
  collectMountedBrowserTabIds,
} from "@/lib/workbench-panel-projection";
import { makeWorkbenchPanelSlotKey } from "@/lib/workbench-panel-slot-key";
import { panelTabCycleRequestDirectionToOffset } from "@/lib/workbench-panel-tab-cycle";
import {
  buildWorkbenchScenePanelTabShortcutProjection,
  projectWorkbenchPanelTabShortcutProjection,
  type WorkbenchPanelTabShortcutState,
} from "@/lib/workbench-panel-tab-shortcut";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import {
  buildStableWorktreeCreateInput,
  listStableWorktrees,
  type StableWorktreeEntry,
} from "./stable-worktree-production";
import {
  StableWorktreeStatusDialog,
  type StableWorktreeStatusDialogTransport,
} from "./stable-worktree-status-dialog";
import {
  buildCancelledPendingWorktreeComposerIntent,
  resolveCancelledPendingWorktreeProjectId,
} from "./pending-worktree-cancel-recovery";
import { useSidebarThreadSyncModel } from "@/lib/use-sidebar-thread-sync-model";
import {
  resolveWorkbenchNavigationShortcutLabel,
  WORKBENCH_NAVIGATION_COMMANDS,
  type WorkbenchNavigationCommandState,
} from "../../../shared/window-navigation";
import {
  CREATE_PAGE_COMMAND_ID,
  CREATE_PAGE_EXPANDED_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  TOGGLE_FULL_VIEW_COMMAND_ID,
  type WorkbenchCommandInvocation,
} from "../../../shared/workbench-commands";
import {
  createCommandKeymapState,
  formatCommandShortcutLabel,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import { KeyboardShortcutHelpDialog } from "./keyboard-shortcut-help-dialog";
import type { CommandMenuMode } from "@/lib/command-palette";
import type { CodexBackgroundTerminalProcessThreadRef } from "@/lib/codex-background-terminal-processes";
import { primaryCanvasBlockId } from "../../../shared/block-documents";

/** A full-view Chat tab carries the Chat actions without the move between panes. */
const CHAT_TAB_THREAD_HEADER_SLOT: ThreadStageHeaderSlot = { variant: "chat-tab", paneMove: null };

const RIGHT_PANEL_HEADER_FALLBACK_SPACER_WIDTH_PX = 70;
const RIGHT_PANEL_HEADER_FALLBACK_RAIL_WIDTH_PX = 62;

function createProjectAgentDockDraftId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function resolvePendingProjectSessionId(
  entries: readonly CodexPendingWorktreeEntry[],
  clientThreadId: string | null,
): string | null {
  if (!clientThreadId) return null;
  const entry = entries.find(
    (candidate) =>
      candidate.launchMode === "start-conversation" && candidate.clientThreadId === clientThreadId,
  );
  return entry?.launchMode === "start-conversation" ? (entry.projectSessionId ?? null) : null;
}

const ELECTRON_STABLE_WORKTREE_STATUS_TRANSPORT: StableWorktreeStatusDialogTransport = {
  list: pendingWorktreeRouteTransport.list,
  subscribe: pendingWorktreeRouteTransport.subscribe,
  clearAttention: pendingWorktreeRouteTransport.clearAttention,
  cancel: pendingWorktreeRouteTransport.cancel,
  autoFix: pendingWorktreeRouteTransport.autoFix,
  retry: pendingWorktreeRouteTransport.retry,
};
export interface WorkbenchRuntimeProps {
  windowSessionId: string;
  initialWindowLayoutSnapshot: WorkbenchLayoutSnapshot;
  projects: Project[];
  hasMoreProjects?: boolean;
  loadingMoreProjects?: boolean;
  loadMoreProjectsFailed?: boolean;
  onLoadMoreProjects?: () => Promise<void>;
  projectCatalogError?: string | null;
  onRetryProjects?: () => Promise<void> | void;
  sidebar?: {
    collapsed: boolean;
    width: number;
    collapsibleSections?: SidebarCollapsibleSectionsState;
    listExtraPages?: SidebarListExtraPagesState;
  };
  pageStageCloseRef: React.RefObject<(() => Promise<void>) | null>;
  pageStagePersistRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  pageStageSessionSnapshotRef?: React.MutableRefObject<PageStageSessionSnapshot | null>;
  pendingPageDeepLinkOpen?: {
    projectId: string;
    pageId: string;
  } | null;
  pendingViewDeepLinkOpen?: {
    projectId: string;
    viewId: string;
  } | null;
  onPageDeepLinkHandled?: (payload: { projectId: string; pageId: string }) => void;
  onViewDeepLinkHandled?: (payload: { projectId: string; viewId: string }) => void;
  pendingSessionOpen?: {
    projectId: string | null;
    sessionId: string;
  } | null;
  setSearchQuery?: (projectId: string, value: string) => void;
  openPageStage: (
    projectId: string,
    pageId: string,
    titleSnapshot?: string,
    options?: OpenPageStageOptions,
  ) => void;
  onOpenProjectSessionInNewWindow?: (session: ProjectSession) => Promise<void>;
  onLeavePageStage: (snapshot: PageStageSessionSnapshot) => void;
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onReorderProjects: (input: ProjectOrderInput) => Promise<void>;
  onSetProjectPinned: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onSetPinnedProjectOrder: (input: ProjectPinnedOrderInput) => Promise<void>;
  onRequestProjectPickerOpen: () => void;
  threadSearchOpenTick: number;
  contentSearchOpenRequest?: ContentSearchOpenRequest | null;
  setSidebarCollapsed?: (collapsed: boolean) => void;
  setSidebarWidth?: (width: number) => void;
  setSidebarCollapsibleSectionCollapsed?: (
    sectionId: SidebarDisclosureSectionId,
    collapsed: boolean,
  ) => void;
  setSidebarListExtraPages?: (listId: SidebarListId, extraPages: number) => void;
  recentPageSessions?: readonly RecentPageSession[];
  projectPickerOpenTick?: number;
  taskSearchOpenTick?: number;
  onNavigationStateChange?: (state: WorkbenchNavigationCommandState) => void;
  onRegisterCommandPort?: (port: WorkbenchCommandPort) => () => void;
  commandKeymapState?: CommandKeymapState | null;
}

const EMPTY_RECENT_PAGE_SESSIONS: readonly RecentPageSession[] = [];

export function WorkbenchRuntime({
  windowSessionId,
  initialWindowLayoutSnapshot,
  projects,
  hasMoreProjects = false,
  loadingMoreProjects = false,
  loadMoreProjectsFailed = false,
  onLoadMoreProjects,
  projectCatalogError = null,
  onRetryProjects,
  recentPageSessions = EMPTY_RECENT_PAGE_SESSIONS,
  sidebar,
  pageStageCloseRef,
  pageStagePersistRef,
  pageStageSessionSnapshotRef,
  pendingPageDeepLinkOpen,
  pendingViewDeepLinkOpen,
  onPageDeepLinkHandled,
  onViewDeepLinkHandled,
  pendingSessionOpen,
  setSearchQuery: observeSearchQueryMutation,
  openPageStage,
  onOpenProjectSessionInNewWindow,
  onLeavePageStage,
  onCreateProject,
  onUpdateProject,
  onArchiveProject,
  onReorderProjects,
  onSetProjectPinned,
  onSetPinnedProjectOrder,
  onRequestProjectPickerOpen,
  projectPickerOpenTick = 0,
  taskSearchOpenTick = 0,
  threadSearchOpenTick,
  contentSearchOpenRequest = null,
  setSidebarCollapsed,
  setSidebarWidth,
  setSidebarCollapsibleSectionCollapsed,
  setSidebarListExtraPages,
  onNavigationStateChange,
  onRegisterCommandPort,
  commandKeymapState,
}: WorkbenchRuntimeProps) {
  const queryClient = useQueryClient();
  const currentLibraryId = useLibraryNavigationInvalidation() ?? projects[0]?.libraryId ?? null;
  const contentIssueCount = useSyncExternalStore(
    contentEditIssues.subscribe,
    () =>
      contentEditIssues.getSnapshot().filter((issue) => issue.scope.libraryId === currentLibraryId)
        .length,
  );
  const appHandle = useScopeHandle(appScope);
  const mutationAuditSessionId = useMutationAuditSessionId();
  const workbenchWindow = useWorkbenchWindowState(initialWindowLayoutSnapshot);
  const sceneLocation = getWorkbenchSceneReturnLocation(workbenchWindow.location);
  const activeProjectId =
    sceneLocation.kind === "project"
      ? sceneLocation.projectId
      : sceneLocation.kind === "session"
        ? sceneLocation.projectContextId
        : null;
  const activeSessionId = sceneLocation.kind === "session" ? sceneLocation.sessionId : null;
  const searchByProject = workbenchWindow.databaseSearchByProject;
  const activeSearchQuery = activeProjectId ? (searchByProject[activeProjectId] ?? "") : "";
  const setSearchQuery = useCallback(
    (projectId: string, value: string) => {
      workbenchWindow.setDatabaseSearch(projectId, value);
      observeSearchQueryMutation?.(projectId, value);
    },
    [observeSearchQueryMutation, workbenchWindow],
  );
  const settingsPath =
    workbenchWindow.location.kind === "settings" ? workbenchWindow.location.path : null;
  const automationsPath =
    workbenchWindow.location.kind === "automations" ? workbenchWindow.location.path : null;
  const pluginsPath =
    workbenchWindow.location.kind === "plugins" ? workbenchWindow.location.path : null;
  const pendingWorktreeClientThreadId =
    workbenchWindow.location.kind === "pending-worktree"
      ? workbenchWindow.location.clientThreadId
      : null;
  const setSettingsPath = useCallback(
    (update: string | null | ((current: string | null) => string | null)) => {
      const next = typeof update === "function" ? update(settingsPath) : update;
      if (next === null) {
        if (workbenchWindow.location.kind === "settings") {
          workbenchWindow.closeRoute();
        }
        return;
      }
      if (workbenchWindow.location.kind === "settings") {
        workbenchWindow.navigate(
          {
            ...workbenchWindow.location,
            path: next,
          },
          { record: false },
        );
        return;
      }
      workbenchWindow.openRoute({ kind: "settings", path: next });
    },
    [settingsPath, workbenchWindow],
  );
  /**
   * Scheduled and Customize are path routes over the current Scene. Closing either one
   * returns to that Scene before another destination opens.
   */
  const setDestinationRoute = useCallback(
    (kind: "automations" | "plugins", path: string | null) => {
      const location = workbenchWindow.location;
      if (path === null) {
        if (location.kind === "automations" || location.kind === "plugins") {
          workbenchWindow.closeRoute();
        }
        return;
      }
      if (location.kind === kind) {
        workbenchWindow.navigate({ ...location, path }, { record: false });
        return;
      }
      workbenchWindow.openRoute({ kind, path });
    },
    [workbenchWindow],
  );
  const setAutomationsPath = useCallback(
    (path: string | null) => setDestinationRoute("automations", path),
    [setDestinationRoute],
  );
  const setPluginsPath = useCallback(
    (path: string | null) => setDestinationRoute("plugins", path),
    [setDestinationRoute],
  );
  const setPendingWorktreeClientThreadId = useCallback(
    (clientThreadId: string | null, expectedHostId?: string) => {
      if (clientThreadId === null) {
        if (workbenchWindow.location.kind === "pending-worktree") {
          workbenchWindow.closeRoute();
        }
        return;
      }
      if (workbenchWindow.location.kind === "pending-worktree") {
        workbenchWindow.navigate(
          {
            ...workbenchWindow.location,
            clientThreadId,
            expectedHostId,
          },
          { record: false },
        );
        return;
      }
      workbenchWindow.openRoute({
        kind: "pending-worktree",
        clientThreadId,
        expectedHostId,
      });
    },
    [workbenchWindow],
  );
  const sidebarState = useWorkbenchSidebarState({
    projects,
    activeProjectId,
    collapsibleSections: sidebar?.collapsibleSections,
    setCollapsibleSectionCollapsed: setSidebarCollapsibleSectionCollapsed,
    listExtraPages: sidebar?.listExtraPages,
    setListExtraPages: setSidebarListExtraPages,
  });
  const {
    expandedProjectIds,
    toggleProjectExpanded,
    contextMenuSessionId,
    togglePinnedSection: togglePinnedProjectsSectionCollapsed,
    togglePagesSection,
    toggleProjectsSection: toggleProjectsSectionCollapsed,
    toggleChatsSection: toggleChatsSectionCollapsed,
  } = sidebarState;
  const sessionCatalog = useWorkbenchSessionCatalog({
    projects,
    expandedProjectIds,
    window: workbenchWindow,
  });
  useWorkbenchCodexNavigation(
    workbenchWindow.owner,
    (sessionId) =>
      sessionCatalog.findById(sessionId)?.domain ??
      getCachedProjectSessionDetail(queryClient, sessionId),
  );
  const selectedProjectSceneId = sceneLocation.kind === "project" ? sceneLocation.projectId : null;
  const selectedProjectQuery = useQuery({
    ...projectDetailQueryOptions(selectedProjectSceneId ?? ""),
    enabled: selectedProjectSceneId !== null,
  });
  const projectCatalog = useMemo(() => projectCatalogStoreFor(queryClient), [queryClient]);
  useEffect(() => {
    if (
      !selectedProjectSceneId ||
      !selectedProjectQuery.isSuccess ||
      selectedProjectQuery.data !== null
    ) {
      return;
    }
    workbenchWindow.removeScene({
      kind: "project",
      projectId: selectedProjectSceneId,
    });
    workbenchWindow.selectProject(null);
  }, [
    selectedProjectQuery.data,
    selectedProjectQuery.isSuccess,
    selectedProjectSceneId,
    workbenchWindow,
  ]);
  const projectSceneOwner = useMemo(
    () =>
      selectedProjectSceneId
        ? { kind: "project" as const, projectId: selectedProjectSceneId }
        : null,
    [selectedProjectSceneId],
  );
  const projectSceneKey = projectSceneOwner ? makeWorkbenchSceneKey(projectSceneOwner) : null;
  const activeProjectScene =
    projectSceneOwner && projectSceneKey
      ? (workbenchWindow.scenesByOwnerKey[projectSceneKey] ??
        materializeInitialWorkbenchScene(projectSceneOwner))
      : null;
  useEffect(() => {
    if (!projectSceneOwner || !projectSceneKey || !activeProjectScene) return;
    if (workbenchWindow.scenesByOwnerKey[projectSceneKey]) return;
    workbenchWindow.setScene(projectSceneOwner, activeProjectScene, {
      recordHistory: false,
    });
  }, [activeProjectScene, projectSceneKey, projectSceneOwner, workbenchWindow]);
  // Space and the Library Inbox are the window's two Scenes of Library content.
  const librarySceneOwner =
    sceneLocation.kind === "library"
      ? LIBRARY_SCENE_OWNER
      : sceneLocation.kind === "inbox"
        ? INBOX_SCENE_OWNER
        : null;
  const librarySceneKey = librarySceneOwner ? makeWorkbenchSceneKey(librarySceneOwner) : null;
  const activeLibraryScene =
    librarySceneOwner && librarySceneKey
      ? (workbenchWindow.scenesByOwnerKey[librarySceneKey] ??
        materializeInitialWorkbenchScene(librarySceneOwner))
      : null;
  useEffect(() => {
    if (!librarySceneOwner || !librarySceneKey || !activeLibraryScene) {
      return;
    }
    if (workbenchWindow.scenesByOwnerKey[librarySceneKey]) return;
    workbenchWindow.setScene(librarySceneOwner, activeLibraryScene, {
      recordHistory: false,
    });
  }, [activeLibraryScene, librarySceneKey, librarySceneOwner, workbenchWindow]);
  const activeOwnedScene = activeProjectScene ?? activeLibraryScene;
  const activeOwnedSceneOwner = projectSceneOwner ?? librarySceneOwner;
  const activeOwnedSceneKey = projectSceneKey ?? librarySceneKey;
  const projectAgentDockBoundSessionId =
    activeProjectScene?.agentDock?.binding.kind === "session"
      ? activeProjectScene.agentDock.binding.sessionId
      : null;
  const projectAgentDockSessionQuery = useQuery({
    ...projectSessionDetailQueryOptions(projectAgentDockBoundSessionId ?? ""),
    enabled: projectAgentDockBoundSessionId !== null,
  });
  const projectAgentDockExactSession =
    projectAgentDockSessionQuery.data?.projectId === selectedProjectSceneId &&
    !projectAgentDockSessionQuery.data.archived
      ? projectAgentDockSessionQuery.data
      : null;
  const sidebarSessionCollections = useWorkbenchSessionCollections({
    projects,
    expandedProjectIds,
    activeProjectId: sessionCatalog.activeProjectId,
    resolveScene: sessionCatalog.resolveScene,
    placementScope: "builtin",
  });
  const sessionCollectionsByProject = sessionCatalog.collectionsByProject;
  const projectlessSessionCollection = sessionCatalog.projectlessCollection;
  const sessionsByProject = useMemo<Record<string, ProjectSession[]>>(
    () => projectSessionProjectionsByProject(sessionCollectionsByProject),
    [sessionCollectionsByProject],
  );
  const projectlessSessions = useMemo(
    () => [...projectlessSessionCollection.projections],
    [projectlessSessionCollection.projections],
  );
  const selectedSessionDetailReady = sessionCatalog.selectedDetailReady;
  const selectedSessionDetailError = sessionCatalog.selectedDetailError;
  // A catalog summary can render the sidebar before the selected scene's detail
  // materializes its lazy surfaces. Missing selections must reconcile first.
  const selectedRouteReady =
    workbenchWindow.location.kind === "session"
      ? selectedSessionDetailReady &&
        (sessionCatalog.active !== null || selectedSessionDetailError !== null)
      : workbenchWindow.location.kind === "project"
        ? !selectedProjectQuery.isPending &&
          (selectedProjectQuery.data != null || selectedProjectQuery.isError) &&
          (!activeProjectScene?.composerOverlay.visible ||
            projectAgentDockBoundSessionId === null ||
            projectAgentDockSessionQuery.isError ||
            projectAgentDockExactSession !== null)
        : true;
  useApplicationReady(selectedRouteReady);
  const loadMoreProjectSessionSummaries = sessionCatalog.loadMore;
  const resolveSessionScene = sessionCatalog.resolveScene;
  const resolveProjectDefaultDatabaseViewId = sessionCatalog.resolveDefaultDatabaseViewId;
  const mutateScene = useCallback(
    (
      owner: WorkbenchSceneOwner,
      mutation: (scene: WorkbenchSceneSnapshot) => WorkbenchSceneSnapshot,
    ): WorkbenchSceneSnapshot => {
      let next = materializeInitialWorkbenchScene(owner);
      workbenchWindow.setScene(owner, (stored) => {
        const previous = stored ?? materializeInitialWorkbenchScene(owner);
        next = mutation(previous);
        return next;
      });
      return next;
    },
    [workbenchWindow],
  );
  const updateSceneSurfacePresentation = useCallback(
    (
      owner: WorkbenchSceneOwner,
      surfaceId: string,
      patch: Parameters<typeof updateWorkbenchSceneSurface>[2],
    ): WorkbenchSceneSnapshot => {
      let next = materializeInitialWorkbenchScene(owner);
      workbenchWindow.setScene(
        owner,
        (stored) => {
          const previous = stored ?? materializeInitialWorkbenchScene(owner);
          next = updateWorkbenchSceneSurface(previous, surfaceId, patch);
          return next;
        },
        { recordHistory: false },
      );
      return next;
    },
    [workbenchWindow],
  );
  const panelController = useWorkbenchPanelController({
    mutateScene,
  });
  const prunePanelOwner = panelController.pruneOwner;
  const panelControllerRef = useRef(panelController);
  panelControllerRef.current = panelController;
  useEffect(() => {
    if (
      !selectedProjectSceneId ||
      !selectedProjectQuery.isSuccess ||
      selectedProjectQuery.data !== null
    ) {
      return;
    }
    prunePanelOwner(
      makeWorkbenchSceneKey({
        kind: "project",
        projectId: selectedProjectSceneId,
      }),
    );
  }, [
    prunePanelOwner,
    selectedProjectQuery.data,
    selectedProjectQuery.isSuccess,
    selectedProjectSceneId,
  ]);
  const previewSurfacesByPanelRef = useRef(panelController.previewSurfacesByPanel);
  previewSurfacesByPanelRef.current = panelController.previewSurfacesByPanel;
  const workbenchWindowRef = useRef(workbenchWindow);
  workbenchWindowRef.current = workbenchWindow;
  const sessionCatalogRef = useRef(sessionCatalog);
  sessionCatalogRef.current = sessionCatalog;
  const sceneCommandsRef = useRef<ReturnType<typeof useWorkbenchSceneCommands> | null>(null);
  const sceneNavigator = useMemo(
    () =>
      createWorkbenchSceneNavigator({
        getScene: (owner) =>
          workbenchWindowRef.current.scenesByOwnerKey[makeWorkbenchSceneKey(owner)],
        presentDurable: (input, surface) => {
          const capability = sceneCommandsRef.current;
          if (!capability)
            return Promise.resolve({ status: "unavailable", reason: "Workbench is starting" });
          return capability.present(input, surface);
        },
        hasConversation(sessionId) {
          return hasSessionConversation(
            sessionCatalogRef.current.findById(sessionId)?.domain ?? null,
          );
        },
        setScene(owner, update) {
          workbenchWindowRef.current.setScene(owner, update);
        },
        setSceneAndSelect(owner, update, location) {
          workbenchWindowRef.current.setSceneAndNavigate(owner, update, location);
        },
        selectLocation(location) {
          workbenchWindowRef.current.navigate(location);
        },
        preview: {
          prepareReplace: (owner, entry) => prepareWorkbenchSceneSurfaceClose(owner, entry.surface),
          list(owner) {
            const scene =
              workbenchWindowRef.current.scenesByOwnerKey[makeWorkbenchSceneKey(owner)] ??
              materializeInitialWorkbenchScene(owner);
            return listWorkbenchScenePreviewEntries(scene, previewSurfacesByPanelRef.current);
          },
          set(owner, panelId, leafId, surface) {
            const slotKey = makeWorkbenchScenePreviewSlotKey(owner, panelId, leafId);
            const next = { ...previewSurfacesByPanelRef.current };
            if (surface) {
              next[slotKey] = surface;
            } else {
              delete next[slotKey];
            }
            previewSurfacesByPanelRef.current = next;
            panelControllerRef.current.updatePreviewSurfacesByPanel(next);
          },
        },
      }),
    [],
  );
  const {
    previewTabsByPanel,
    previewSurfacesByPanel,
    sideChatTabsBySession,
    sideChatActiveTabByPanel,
    mcpAppTabsBySession,
    mcpAppActiveTabByPanel,
    planTabsBySession,
    planActiveTabByPanel,
    automationTabsBySession,
    automationActiveTabByPanel,
    backgroundAgentTabsBySession,
    backgroundAgentActiveTabByPanel,
    processOutputTabsBySession,
    processOutputActiveTabByPanel,
    imageEditorTabsBySession,
    imageEditorActiveTabByPanel,
    activePlanKeyBySession,
    panelCollapsedOverrides,
    tabOrderByPanelGroup,
  } = panelController;
  const projectScenePresentation = useMemo(
    () =>
      activeProjectScene
        ? projectWorkbenchScenePreviews(
            activeProjectScene,
            previewSurfacesByPanel,
            tabOrderByPanelGroup,
          )
        : null,
    [activeProjectScene, previewSurfacesByPanel, tabOrderByPanelGroup],
  );
  const libraryScenePresentation = useMemo(
    () =>
      activeLibraryScene
        ? projectWorkbenchScenePreviews(
            activeLibraryScene,
            previewSurfacesByPanel,
            tabOrderByPanelGroup,
          )
        : null,
    [activeLibraryScene, previewSurfacesByPanel, tabOrderByPanelGroup],
  );
  const activeOwnedScenePresentation = projectScenePresentation ?? libraryScenePresentation;
  const projectScenePresentedPageIds = useMemo<ReadonlySet<string>>(
    () =>
      projectScenePresentation
        ? collectWorkbenchScenePresentedPageIds(projectScenePresentation.scene)
        : new Set(),
    [projectScenePresentation],
  );
  const libraryScenePresentedPageIds = useMemo<ReadonlySet<string>>(
    () =>
      libraryScenePresentation
        ? collectWorkbenchScenePresentedPageIds(libraryScenePresentation.scene)
        : new Set(),
    [libraryScenePresentation],
  );
  const librarySceneNavigation = useLibrarySceneNavigation(libraryScenePresentation?.scene ?? null);
  const [pageTitleStore] = useState(createPageTitleProjectionStore);
  const [panelTabPresentationRegistry] = useState(() => new PanelTabPresentationRegistry());
  const panelTabPresentationControllerKeysRef = useRef(new Set<string>());
  const [headerLeftWidth, setHeaderLeftWidth] = useState(0);
  const [titlebarHost, setTitlebarHost] = useState<HTMLElement | null>(null);
  const [, setHeaderLeftRailWidth] = useState(0);
  const [headerRightWidth, setHeaderRightWidth] = useState(
    RIGHT_PANEL_HEADER_FALLBACK_SPACER_WIDTH_PX,
  );
  const [, setHeaderRightRailWidth] = useState(RIGHT_PANEL_HEADER_FALLBACK_RAIL_WIDTH_PX);
  const [threadScopeIdentityRegistry] = useState(createThreadScopeIdentityRegistry);
  const [projectAgentDockMaterializer] = useState(createProjectAgentDockMaterializer);
  const [projectAgentDockQuery, setProjectAgentDockQuery] = useState("");
  const [rightPanelComposerOverlayTarget, setRightPanelComposerOverlayTarget] =
    useState<HTMLElement | null>(null);
  const terminalSessionVersion = useTerminalSessionStoreVersion();
  const {
    threadSummaryPanelPinnedOpen,
    toggleThreadSummaryPanelPinnedOpen,
    threadQueueFollowUpsEnabled,
    handleThreadQueueFollowUpsEnabledChange,
    composerEnterBehavior,
    handleComposerEnterBehaviorChange,
    worktreeStartMode,
    handleWorktreeStartModeChange,
    worktreeAutoBranchPrefix,
    handleWorktreeAutoBranchPrefixChange,
    taskShorthandPagePromotionEnabled,
    handleTaskShorthandPagePromotionEnabledChange,
  } = useWorkbenchPreferences();
  useEffect(
    () => () => {
      panelTabPresentationRegistry.dispose();
    },
    [panelTabPresentationRegistry],
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [keyboardShortcutHelpOpen, setKeyboardShortcutHelpOpen] = useState(false);
  const [commandPaletteOpenRequest, setCommandPaletteOpenRequest] = useState({
    tick: 0,
    mode: "root" as CommandMenuMode,
    initialQuery: undefined as string | undefined,
  });
  const [commandContentSearchOpenRequest, setCommandContentSearchOpenRequest] =
    useState<ContentSearchOpenRequest | null>(null);
  const workbenchRootRef = useRef<HTMLDivElement | null>(null);
  const pinningPreviewTabIdsRef = useRef<Set<string>>(new Set());
  const focusedPanelGroupRef = workbenchWindow.owner.focusedPanelGroupRef;
  const panelTabShortcutStateRef = useRef<WorkbenchPanelTabShortcutState | null>(null);
  const panelGroupTabsRef = useRef<PanelGroupTabsByPanel>({
    right: { itemsByLeafId: {}, activeTabIdsByLeafId: {} },
    bottom: { itemsByLeafId: {}, activeTabIdsByLeafId: {} },
  });
  const pendingWorkbenchCommandInvocationsRef = useRef<WorkbenchCommandInvocation[]>([]);
  const activeThreadIdRef = useRef<string | null>(null);
  const activeThreadWaitersRef = useRef(
    new Set<{
      threadId: string;
      resolve: (presented: boolean) => void;
    }>(),
  );
  const desktopNotificationActionChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const shellAtMediumWidthRef = useRef(false);
  const shellAtNarrowWidthRef = useRef(false);
  const pinnedProjectsSectionCollapsed = sidebarState.sections.pinned;
  const pagesSectionCollapsed = sidebarState.sections.pages;
  const projectsSectionCollapsed = sidebarState.sections.projects;
  const chatsSectionCollapsed = sidebarState.sections.chats;
  const [pendingWorktrees, setPendingWorktrees] = useState<CodexPendingWorktreeEntry[]>([]);
  const [pendingStableWorktrees, setPendingStableWorktrees] = useState<StableWorktreeEntry[]>([]);
  const [reopenStableWorktreeAfterSettingsId, setReopenStableWorktreeAfterSettingsId] = useState<
    string | null
  >(null);
  const [
    reopenPendingWorktreeAfterSettingsClientThreadId,
    setReopenPendingWorktreeAfterSettingsClientThreadId,
  ] = useState<string | null>(null);
  const closePendingWorktreeRoute = useCallback(() => {
    setPendingWorktreeClientThreadId(null);
  }, [setPendingWorktreeClientThreadId]);
  useEffect(() => {
    let disposed = false;
    let receivedSubscription = false;
    const applyEntries = (entries: readonly CodexPendingWorktreeEntry[]) => {
      if (disposed) return;
      setPendingWorktrees([...entries]);
      setPendingStableWorktrees(listStableWorktrees(entries));
    };
    const unsubscribe = pendingWorktreeRouteTransport.subscribe((entries) => {
      receivedSubscription = true;
      applyEntries(entries);
    });
    void listPendingWorktrees()
      .then((entries) => {
        if (receivedSubscription) return;
        applyEntries(entries);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  useEffect(
    () =>
      subscribeCodexPendingWorktreeWarnings((event) => {
        toast.danger(event.message);
      }),
    [],
  );
  const [localEnvironmentSettingsInitial, setLocalEnvironmentSettingsInitial] = useState<{
    projectId: string | null;
    configPath: string | null;
  } | null>(null);
  const [newThreadComposerIntentsBySessionId, setNewThreadComposerIntentsBySessionId] = useState<
    Record<string, CodexComposerIntent>
  >({});
  const [processManagerOpen, setProcessManagerOpen] = useState(false);
  const codexAccount = useLocalConversationAccount();
  const codexConnection = useLocalConversationConnection();
  const codexAccountActions = useCodexAccountActions();
  const reducedMotion = useResolvedReducedMotion();
  const sidebarChrome = useWorkbenchSidebarChrome({
    persistedCollapsed: sidebar?.collapsed,
    persistedWidth: sidebar?.width,
    reducedMotion,
    workbenchRootRef,
    onCollapsedChange: setSidebarCollapsed,
    onWidthChange: setSidebarWidth,
  });
  const {
    applySidebarWidth,
    floatingSidebarResizing,
    getWindowZoom,
    motion: realSidebarMotion,
    peekArea,
    peekDestination,
    setFloatingSidebarResizing,
    setPeekMenuOpen,
    setSidebarCollapsed: setSidebarCollapsedWithCodexState,
    setSidebarClickInFlight,
    sidebarAnimating,
    sidebarClickInFlight,
    sidebarLogicalCollapsed,
    sidebarOpen,
    sidebarWidth,
    toggleSidebarCollapsed,
  } = sidebarChrome;

  const activeProject = selectedProjectSceneId
    ? selectedProjectQuery.isSuccess
      ? projectCatalog.project(selectedProjectQuery.data)
      : (projects.find((project) => project.id === selectedProjectSceneId) ?? null)
    : sessionCatalog.activeProject;
  const projectAgentDockCollection = selectedProjectSceneId
    ? (sessionCollectionsByProject[selectedProjectSceneId] ?? null)
    : null;
  const projectAgentDockPendingWorktree = useMemo(
    () =>
      resolveProjectAgentDockPendingWorktree(
        pendingWorktrees,
        projectAgentDockBoundSessionId,
        Boolean(projectAgentDockExactSession?.thread),
      ),
    [pendingWorktrees, projectAgentDockBoundSessionId, projectAgentDockExactSession?.thread],
  );
  const projectAgentDockPendingWorktreeModel = useMemo(
    () =>
      projectAgentDockPendingWorktree
        ? buildProjectAgentDockPendingWorktreeModel(projectAgentDockPendingWorktree)
        : null,
    [projectAgentDockPendingWorktree],
  );
  const projectAgentDockModel = useMemo(() => {
    if (!selectedProjectSceneId || !activeProjectScene?.agentDock || !projectAgentDockCollection) {
      return null;
    }
    return buildProjectAgentDockModel({
      projectId: selectedProjectSceneId,
      dock: activeProjectScene.agentDock,
      summaries: projectAgentDockCollection.presentations.map((presentation) =>
        projectSessionToSummary(presentation.domain),
      ),
      exactSelectedSession: projectAgentDockExactSession
        ? projectSessionToSummary(projectAgentDockExactSession)
        : null,
      collectionState: projectAgentDockCollection.state,
      hasMore: projectAgentDockCollection.hasMore,
      query: projectAgentDockQuery,
    });
  }, [
    activeProjectScene?.agentDock,
    projectAgentDockCollection,
    projectAgentDockExactSession,
    projectAgentDockQuery,
    selectedProjectSceneId,
  ]);
  const projectAgentDockSession = useMemo(() => {
    if (!activeProjectScene?.agentDock || !selectedProjectSceneId) return null;
    if (activeProjectScene.agentDock.binding.kind === "new") {
      const domain = createProjectAgentDockDraftSession(
        selectedProjectSceneId,
        activeProjectScene.agentDock.newDraftId,
      );
      return presentWorkbenchSession({
        domain,
        scene: materializeInitialWorkbenchScene({
          kind: "session",
          sessionId: domain.id,
        }),
      });
    }
    if (!projectAgentDockExactSession) return null;
    return presentWorkbenchSession({
      domain: projectAgentDockExactSession,
      scene: resolveSessionScene(projectAgentDockExactSession),
    });
  }, [
    activeProjectScene?.agentDock,
    projectAgentDockExactSession,
    resolveSessionScene,
    selectedProjectSceneId,
  ]);
  const projectAgentDockThreadScope = useMemo(() => {
    if (!activeProjectScene?.agentDock) return null;
    if (activeProjectScene.agentDock.binding.kind === "new") {
      return resolveProjectDraftThreadScopeDescriptor(
        threadScopeIdentityRegistry,
        activeProjectScene.agentDock.newDraftId,
      );
    }
    if (!projectAgentDockExactSession) return null;
    return resolveProjectSessionThreadScopeDescriptor(
      threadScopeIdentityRegistry,
      projectAgentDockExactSession,
      projectAgentDockPendingWorktree?.clientThreadId ?? null,
    );
  }, [
    activeProjectScene?.agentDock,
    projectAgentDockExactSession,
    projectAgentDockPendingWorktree?.clientThreadId,
    threadScopeIdentityRegistry,
  ]);
  const updateProjectAgentDock = useCallback(
    (
      projectId: string,
      update: (
        dock: NonNullable<WorkbenchSceneSnapshot["agentDock"]>,
      ) => NonNullable<WorkbenchSceneSnapshot["agentDock"]>,
    ) => {
      const owner = { kind: "project", projectId } as const;
      workbenchWindow.setScene(
        owner,
        (stored) => {
          const scene = stored ?? materializeInitialWorkbenchScene(owner);
          if (!scene.agentDock) return scene;
          return {
            ...scene,
            agentDock: update(scene.agentDock),
          };
        },
        { recordHistory: false },
      );
    },
    [workbenchWindow],
  );
  const updateComposerOverlay = useCallback(
    (owner: WorkbenchSceneOwner, patch: Partial<WorkbenchComposerOverlayState>) => {
      workbenchWindow.setScene(
        owner,
        (stored) => {
          const scene = stored ?? materializeInitialWorkbenchScene(owner);
          const current = scene.composerOverlay;
          const next = { ...current, ...patch };
          if (
            next.visible === current.visible &&
            next.dock === current.dock &&
            next.minimizedDock === current.minimizedDock
          ) {
            return scene;
          }
          return { ...scene, composerOverlay: next };
        },
        { recordHistory: false },
      );
    },
    [workbenchWindow],
  );
  const updateProjectAgentDockOverlay = useCallback(
    (patch: Partial<WorkbenchComposerOverlayState>) => {
      if (!selectedProjectSceneId) return;
      updateComposerOverlay({ kind: "project", projectId: selectedProjectSceneId }, patch);
    },
    [selectedProjectSceneId, updateComposerOverlay],
  );
  const selectProjectAgentDockTarget = useCallback(
    (row: ProjectAgentDockTargetRow) => {
      if (!selectedProjectSceneId) return;
      updateProjectAgentDock(selectedProjectSceneId, (dock) => ({
        ...dock,
        binding:
          row.kind === "new" ? { kind: "new" } : { kind: "session", sessionId: row.sessionId! },
      }));
    },
    [selectedProjectSceneId, updateProjectAgentDock],
  );
  const materializeProjectAgentDockDraft = useCallback(
    async (input: {
      readonly projectId: string;
      readonly draftId: string;
    }): Promise<ProjectSessionDomain> =>
      projectAgentDockMaterializer.materialize(input, {
        ensureDefaultDraft: async (projectId) =>
          (await sessionCatalogRef.current.ensureDefaultDraft(projectId)).domain,
      }),
    [projectAgentDockMaterializer],
  );
  const commitMaterializedProjectAgentDockDraft = useCallback(
    (input: {
      readonly projectId: string;
      readonly draftId: string;
      readonly sessionId: string;
    }) => {
      const owner = { kind: "project", projectId: input.projectId } as const;
      workbenchWindowRef.current.setScene(
        owner,
        (stored) => {
          const scene = stored ?? materializeInitialWorkbenchScene(owner);
          const dock = scene.agentDock;
          if (!dock || dock.newDraftId !== input.draftId) return scene;
          return {
            ...scene,
            agentDock: {
              ...dock,
              newDraftId: createProjectAgentDockDraftId(),
              binding:
                dock.binding.kind === "new"
                  ? { kind: "session", sessionId: input.sessionId }
                  : dock.binding,
            },
          };
        },
        { recordHistory: false },
      );
    },
    [],
  );
  useEffect(() => {
    if (!selectedProjectSceneId || !projectAgentDockBoundSessionId) return;
    if (!projectAgentDockSessionQuery.isSuccess) return;
    if (projectAgentDockExactSession) return;
    updateProjectAgentDock(selectedProjectSceneId, (dock) => ({
      ...dock,
      binding: { kind: "new" },
    }));
  }, [
    projectAgentDockBoundSessionId,
    projectAgentDockExactSession,
    projectAgentDockSessionQuery.isSuccess,
    selectedProjectSceneId,
    updateProjectAgentDock,
  ]);
  useEffect(() => {
    setProjectAgentDockQuery("");
  }, [selectedProjectSceneId]);
  const activeSessions = useMemo(
    () => (activeProject ? (sessionsByProject[activeProject.id] ?? []) : []),
    [activeProject, sessionsByProject],
  );
  const activeSession = sessionCatalog.activeProjection;
  const activeThreadId = activeSession?.thread?.threadId ?? null;
  activeThreadIdRef.current = activeThreadId;
  useEffect(() => {
    if (!activeThreadId) return;
    for (const waiter of [...activeThreadWaitersRef.current]) {
      if (waiter.threadId !== activeThreadId) continue;
      activeThreadWaitersRef.current.delete(waiter);
      waiter.resolve(true);
    }
  }, [activeThreadId]);
  useEffect(
    () => () => {
      for (const waiter of activeThreadWaitersRef.current) waiter.resolve(false);
      activeThreadWaitersRef.current.clear();
    },
    [],
  );
  const waitForActiveThread = useCallback((threadId: string): Promise<boolean> => {
    if (activeThreadIdRef.current === threadId) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = {
        threadId,
        resolve: (presented: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          resolve(presented);
        },
      };
      const timeoutId = window.setTimeout(() => {
        activeThreadWaitersRef.current.delete(waiter);
        waiter.resolve(false);
      }, 10_000);
      activeThreadWaitersRef.current.add(waiter);
    });
  }, []);
  const createSessionViewTab = useCallback(
    async (input: WorkbenchTabCreateInput): Promise<WorkbenchTabProjection | null> => {
      if (!activeSession || input.sessionId !== activeSession.id) return null;
      const commands = sceneCommandsRef.current;
      if (!commands) return null;
      const surface = workbenchSurfaceFromCreateInput(input);
      const sceneOwner = { kind: "session" as const, sessionId: input.sessionId };
      const scene =
        workbenchWindow.owner.read().windowState.scenesByOwnerKey[
          makeWorkbenchSceneKey(sceneOwner)
        ];
      if (!scene) return null;
      const { id, state: _state, stateKey: _stateKey, ...opening } = surface;
      const receipt = await commands.execute(
        sceneOwner,
        {
          kind: "open_tab",
          panelId: input.panelId,
          groupId: input.targetLeafId ?? scene.panels[input.panelId].layout.activeLeafId,
          surface: opening,
        },
        {
          surfaceId: id,
          open: {
            presentation: input.presentation,
            targetIndex: input.targetIndex,
            openerTabId: input.openerTabId,
          },
        },
      );
      if (receipt.error || !receipt.tabId) return null;
      const next =
        workbenchWindow.owner.read().windowState.scenesByOwnerKey[
          makeWorkbenchSceneKey(sceneOwner)
        ];
      return next
        ? (presentWorkbenchSessionDomainWithScene(activeSession, next).tabs.find(
            (candidate) => candidate.id === receipt.tabId,
          ) ?? null)
        : null;
    },
    [activeSession, workbenchWindow.owner],
  );
  const updateSessionViewTab = useCallback(
    (tabId: string, patch: WorkbenchSurfaceUpdatePatch): WorkbenchTabProjection | null => {
      if (!activeSession) return null;
      const current = resolveSessionScene(activeSession);
      const surface = current.panelSurfacesById[tabId];
      if (!surface) return null;
      const nextSurface = applyWorkbenchSurfacePatch(surface, patch);
      const next = panelControllerRef.current.durable.updateTab(activeSession, tabId, nextSurface);
      return (
        presentWorkbenchSessionDomainWithScene(activeSession, next).tabs.find(
          (candidate) => candidate.id === tabId,
        ) ?? null
      );
    },
    [activeSession, resolveSessionScene],
  );
  const activeRenderSession = activeSession;
  const activeSessionScene = activeSession ? resolveSessionScene(activeSession) : null;
  const updateActiveSessionComposerOverlay = useCallback(
    (patch: Partial<WorkbenchComposerOverlayState>) => {
      if (!activeSession) return;
      updateComposerOverlay({ kind: "session", sessionId: activeSession.id }, patch);
    },
    [activeSession, updateComposerOverlay],
  );
  const forkTransferTargetConversationId = activeRenderSession?.thread?.threadId ?? null;
  const forkTransferTargetSessionId = activeRenderSession?.id ?? null;
  const consumedForkTransferTargetsRef = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!forkTransferTargetConversationId || !forkTransferTargetSessionId) return;
    const targetKey = `${forkTransferTargetConversationId}\0${forkTransferTargetSessionId}`;
    if (consumedForkTransferTargetsRef.current.has(targetKey)) return;
    consumedForkTransferTargetsRef.current.add(targetKey);
    void consumeForkSidePanelTransfer({
      routeKind: "local-thread",
      targetConversationId: forkTransferTargetConversationId,
      targetProjectSessionId: forkTransferTargetSessionId,
      targetBrowserViewScopeId: windowSessionId,
    })
      .then((snapshot) => {
        if (!snapshot || !activeRenderSession) return;
        panelControllerRef.current.durable.apply(activeRenderSession, (scene) =>
          applyForkBrowserTransferToWorkbenchScene(scene, snapshot),
        );
      })
      .catch(() => {
        consumedForkTransferTargetsRef.current.delete(targetKey);
      });
  }, [
    activeRenderSession,
    forkTransferTargetConversationId,
    forkTransferTargetSessionId,
    windowSessionId,
  ]);
  const scheduledTasks = useScheduledTasks();
  const {
    applySnapshot: applySidebarThreadSnapshot,
    model: sidebarThreadModel,
    refresh: refreshSidebarThreadSnapshot,
    reorderPinned: reorderPinnedSidebarThreads,
    setPinned: setSidebarThreadPinned,
  } = useSidebarThreadSyncModel({
    projects,
  });
  const sidebarArchivePendingKeys = sidebarState.archivePendingKeys;
  const knownSessions = useMemo(
    () => [...Object.values(sessionsByProject).flat(), ...projectlessSessions],
    [projectlessSessions, sessionsByProject],
  );
  const pageStageRelatedChatCandidates = useMemo(
    () => presentPageStageRelatedChatCandidates(knownSessions, projects),
    [knownSessions, projects],
  );
  const processManagerThreads = useMemo<CodexBackgroundTerminalProcessThreadRef[]>(() => {
    const seen = new Set<string>();
    const refs: CodexBackgroundTerminalProcessThreadRef[] = [];
    for (const session of knownSessions) {
      const threadId = session.thread?.threadId;
      if (!threadId || seen.has(threadId)) {
        continue;
      }
      seen.add(threadId);
      refs.push({
        threadId,
        title: session.displayTitle || threadId,
      });
    }
    return refs;
  }, [knownSessions]);
  const processManagerThreadIds = useMemo(
    () => processManagerThreads.map((thread) => thread.threadId),
    [processManagerThreads],
  );
  const processManagerConversationsById = useConversationSubset(processManagerThreadIds);
  const workbenchCodexControl = useCodexAppServerControl(
    activeSession?.thread?.threadId ?? null,
    activeSession?.thread?.executionHostId ?? null,
  );
  const sceneCommands = useWorkbenchSceneCommands(
    workbenchWindow.owner,
    windowSessionId,
    workbenchCodexControl.discardSideChat,
    panelController.tabOpenerStore,
  );
  sceneCommandsRef.current = sceneCommands;
  const executeSceneCommand = sceneCommands.execute;
  useWorkbenchAgentBridge(
    workbenchWindow.owner,
    {
      resolveSessionProjectId: (sessionId) =>
        sessionCatalogRef.current.findById(sessionId)?.domain.projectId,
    },
    sceneCommands.executor,
  );
  const codexAppServerRegistry = useCodexAppServerRegistry();
  const activeProjectBoard = useBoard({
    projectId: activeProject?.id ?? activeProjectId ?? "",
    databaseViewId: activeProject?.defaultDatabaseViewId ?? undefined,
    enabled: Boolean(activeProject?.id && activeProject.defaultDatabaseViewId),
    sessionId: activeSession ? `${activeSession.id}:right-panel-actions` : "right-panel-actions",
  });
  useProjectPageCreateTarget({
    appHandle,
    project: activeProject,
    board: activeProjectBoard.board,
    databaseView: activeProjectBoard.databaseView,
    error: activeProjectBoard.error,
    clientSessionId: mutationAuditSessionId,
  });
  const [pageStageHistoryModal, setPageStageHistoryModal] =
    useState<PageStageHistoryModalContext | null>(null);
  const activeSessionPanelModel = useMemo(
    () =>
      activeRenderSession
        ? buildSessionPanelRenderModel({
            session: activeRenderSession,
            previewTabsByPanel,
            sideChatTabsBySession,
            sideChatActiveTabByPanel,
            mcpAppTabsBySession,
            mcpAppActiveTabByPanel,
            planTabsBySession,
            planActiveTabByPanel,
            automationTabsBySession,
            automationActiveTabByPanel,
            backgroundAgentTabsBySession,
            backgroundAgentActiveTabByPanel,
            processOutputTabsBySession,
            processOutputActiveTabByPanel,
            imageEditorTabsBySession,
            imageEditorActiveTabByPanel,
            panelCollapsedOverrides,
            activePlanKeyBySession,
            tabOrderByPanelGroup,
          })
        : null,
    [
      activePlanKeyBySession,
      tabOrderByPanelGroup,
      activeRenderSession,
      automationActiveTabByPanel,
      automationTabsBySession,
      backgroundAgentActiveTabByPanel,
      backgroundAgentTabsBySession,
      mcpAppActiveTabByPanel,
      mcpAppTabsBySession,
      panelCollapsedOverrides,
      planActiveTabByPanel,
      planTabsBySession,
      previewTabsByPanel,
      processOutputActiveTabByPanel,
      processOutputTabsBySession,
      imageEditorActiveTabByPanel,
      imageEditorTabsBySession,
      sideChatActiveTabByPanel,
      sideChatTabsBySession,
    ],
  );
  const activePanelOwnerKey =
    activeOwnedSceneKey ??
    (activeSession
      ? makeWorkbenchSceneKey({
          kind: "session",
          sessionId: activeSession.id,
        })
      : null);
  const rightPanel = activeOwnedScene?.panels.right ?? activeSessionPanelModel?.rightPanel ?? null;
  const bottomPanel =
    activeOwnedScene?.panels.bottom ?? activeSessionPanelModel?.bottomPanel ?? null;
  const rightPanelCollapsed =
    rightPanel && activePanelOwnerKey
      ? (panelCollapsedOverrides[makeWorkbenchPanelSlotKey(activePanelOwnerKey, "right")] ??
        rightPanel.collapsed)
      : true;
  const bottomPanelCollapsed =
    bottomPanel && activePanelOwnerKey
      ? (panelCollapsedOverrides[makeWorkbenchPanelSlotKey(activePanelOwnerKey, "bottom")] ??
        bottomPanel.collapsed)
      : true;
  const sidePanelOpen = !rightPanelCollapsed;
  const bottomPanelOpen = !bottomPanelCollapsed;
  useEffect(() => {
    setPageStageHistoryModal((current) => {
      if (!current) return current;
      if (!activeSession || activeSession.id !== current.sessionId) return null;

      const ownerTab = activeSession.tabs.find((tab) => tab.id === current.tabId);
      const pageRef = readPageStagePanelTabPageRef(ownerTab);
      if (!pageRef) return null;
      if (pageRef.projectId !== current.projectId || pageRef.pageId !== current.pageId) return null;

      return current;
    });
  }, [activeSession]);
  const closePageStageHistoryModal = useCallback(() => {
    setPageStageHistoryModal(null);
  }, []);
  const togglePageStageHistoryModal = useCallback((context: PageStageHistoryModalContext) => {
    setPageStageHistoryModal((current) => {
      if (
        current &&
        current.sessionId === context.sessionId &&
        current.tabId === context.tabId &&
        current.projectId === context.projectId &&
        current.pageId === context.pageId
      ) {
        return null;
      }
      return context;
    });
  }, []);
  const pageStageHistoryModalProject = useMemo(
    () =>
      pageStageHistoryModal
        ? (projects.find((project) => project.id === pageStageHistoryModal.projectId) ?? null)
        : null,
    [pageStageHistoryModal, projects],
  );
  const pageStageHistoryPanelProjectId =
    pageStageHistoryModal?.projectId ?? activeProject?.id ?? null;
  const rightActiveRenderableTab = activeSessionPanelModel?.rightActiveRenderableTab ?? null;
  const rightPanelFullWidth = sidePanelOpen && (rightPanel?.size.fullWidth ?? false);
  const { preferredSide: preferredSessionContentSide, update: updatePreferredSessionContentSide } =
    useSessionContentSidePreference();
  // Only a Session places its content beside its Conversation; other Scenes are full-width stacks.
  const sessionWorkspace =
    !activeOwnedSceneOwner && activeSessionPanelModel
      ? resolveSessionWorkspacePresentation({
          collapsed: rightPanelCollapsed,
          fullWidth: activeSessionPanelModel.rightPanel.size.fullWidth ?? false,
          side: activeSessionPanelModel.rightPanel.side,
          preferredSide: preferredSessionContentSide,
        })
      : null;
  /** Full view, whichever surface fills it; the content panel's tab strip stays in the titlebar. */
  const rightPanelFullView = sessionWorkspace
    ? sessionWorkspace.layout === "full"
    : rightPanelFullWidth;
  const sessionConversationFillsFullView = sessionWorkspace?.fullViewSurface === "conversation";
  const sessionContentSide = sessionWorkspace?.contentSide ?? "right";
  const activeImageEditorOwnsRootComposer = Boolean(
    rightActiveRenderableTab &&
    isRootThreadRightPanelComposerOverlayEligibleTab(rightActiveRenderableTab) &&
    ("kind" in rightActiveRenderableTab
      ? rightActiveRenderableTab.kind === "image_editor"
      : "imageEditor" in rightActiveRenderableTab),
  );
  const rightPanelComposerOverlayEnabled = Boolean(
    activeSession &&
    sidePanelOpen &&
    rightPanelFullWidth &&
    rightPanelComposerOverlayTarget &&
    (activeImageEditorOwnsRootComposer || hasSessionConversation(activeSession)) &&
    isRootThreadRightPanelComposerOverlayEligibleTab(rightActiveRenderableTab),
  );
  const shellCanNavigateBack = workbenchWindow.canNavigateBack;
  const shellCanNavigateForward = workbenchWindow.canNavigateForward;
  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const {
    appShellHeaderEdgeScroll,
    appShellMainContentLayout,
    bottomPanelAnimatedHeightCss,
    bottomPanelHeight,
    bottomPanelMotion,
    bottomPanelRequestedHeight,
    effectiveHeaderLeftWidth,
    headerLeftFallbackRailWidth,
    headerLeftFallbackWidth,
    headerLeftShellSlotMinWidth,
    headerLeftShellSlotWidth,
    mainContentTargetWidth,
    realSidebarMounted,
    regularRightPanelWidth,
    rightHeaderShellSlotWidth,
    rightPanelMotion,
    rightPanelRequestedWidth,
    rightPanelTargetWidth,
    safeHeaderLeftWidth,
    safeHeaderRightWidth,
    shellBodySize,
    shellMainContentWidth,
    shellWidthClass,
    threadSummaryPanelLayoutMode,
  } = useWorkbenchChromeLayout({
    activeSessionId: activeSession?.id ?? null,
    destinationRouteOpen: Boolean(automationsPath ?? pluginsPath),
    bottomPanelOpen,
    bottomPanelRequestedHeight: bottomPanel?.size.heightPx ?? null,
    headerLeftWidth,
    isMacPlatform,
    reducedMotion,
    rightPanelFullWidth,
    rightPanelFullView,
    rightPanelSide: sessionContentSide,
    rightPanelOpen: sidePanelOpen,
    rightPanelRequestedWidth: rightPanel?.size.widthPx ?? null,
    rootRef: workbenchRootRef,
    sidebarLogicalCollapsed,
    sidebarMotion: realSidebarMotion,
    sidebarOpen,
  });
  useEffect(() => {
    onNavigationStateChange?.({
      canNavigateBack: shellCanNavigateBack,
      canNavigateForward: shellCanNavigateForward,
    });
  }, [onNavigationStateChange, shellCanNavigateBack, shellCanNavigateForward]);

  useEffect(() => {
    if (!pendingWorktreeClientThreadId) return;
    setSettingsPath(null);
    setLocalEnvironmentSettingsInitial(null);
    setAutomationsPath(null);
  }, [pendingWorktreeClientThreadId, setAutomationsPath, setSettingsPath]);

  const handleCodexAccountLogout = useCallback(async () => {
    await codexAccountActions.logout();
  }, [codexAccountActions]);
  const handleCodexAccountErrorMessage = useCallback((message: string | null) => {
    if (!message) return;
    toast.danger(message);
  }, []);
  useEffect(() => {
    if (!activePanelOwnerKey || !rightPanel || !bottomPanel) {
      panelControllerRef.current.updatePanelCollapsedOverrides((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      return;
    }

    const rightKey = makeWorkbenchPanelSlotKey(activePanelOwnerKey, "right");
    const bottomKey = makeWorkbenchPanelSlotKey(activePanelOwnerKey, "bottom");
    panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
      const rightMatches = current[rightKey] === rightPanel.collapsed;
      const bottomMatches = current[bottomKey] === bottomPanel.collapsed;
      if (!rightMatches && !bottomMatches) {
        return current;
      }

      const next = { ...current };
      if (rightMatches) delete next[rightKey];
      if (bottomMatches) delete next[bottomKey];
      return next;
    });
  }, [activePanelOwnerKey, bottomPanel, rightPanel]);

  const openSettings = useCallback(() => {
    closePendingWorktreeRoute();
    setAutomationsPath(null);
    setReopenStableWorktreeAfterSettingsId(null);
    setReopenPendingWorktreeAfterSettingsClientThreadId(null);
    setLocalEnvironmentSettingsInitial(null);
    setSettingsPath(buildSettingsPath("general-settings"));
  }, [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath]);

  const openBrowserSettings = useCallback(
    (destination: BrowserSettingsDestination) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      setReopenStableWorktreeAfterSettingsId(null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(null);
      setLocalEnvironmentSettingsInitial(null);
      setSettingsPath(resolveBrowserSettingsDestination(destination));
    },
    [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath],
  );

  const openSettingsPath = useCallback(
    (path: string) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      setReopenStableWorktreeAfterSettingsId(null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(null);
      setLocalEnvironmentSettingsInitial(null);
      setSettingsPath(path);
    },
    [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath],
  );

  const openSettingsAt = useCallback(
    (sectionId: Parameters<typeof buildSettingsPath>[0], anchor?: string) =>
      openSettingsPath(
        anchor ? buildSettingsAnchorPath(sectionId, anchor) : buildSettingsPath(sectionId),
      ),
    [openSettingsPath],
  );

  const openAgentSettings = useCallback(
    (kind?: AgentSettingsKind, instanceId?: string) =>
      openSettingsAt("agent", kind && agentSettingsAnchor(kind, instanceId)),
    [openSettingsAt],
  );

  const openKeyboardShortcutsSettings = useCallback(() => {
    closePendingWorktreeRoute();
    setAutomationsPath(null);
    setReopenStableWorktreeAfterSettingsId(null);
    setReopenPendingWorktreeAfterSettingsClientThreadId(null);
    setLocalEnvironmentSettingsInitial(null);
    setSettingsPath(buildSettingsPath("keyboard-shortcuts"));
  }, [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath]);

  const openVoiceSettings = useCallback(
    (recordingId?: string) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      setReopenStableWorktreeAfterSettingsId(null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(null);
      setLocalEnvironmentSettingsInitial(null);
      const path = buildSettingsPath("voice");
      setSettingsPath(recordingId ? `${path}?recording=${encodeURIComponent(recordingId)}` : path);
    },
    [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath],
  );

  useEffect(() => subscribeDictationRecordingNavigation(openVoiceSettings), [openVoiceSettings]);

  const openKeyboardShortcutHelp = useCallback(() => {
    setCommandPaletteOpen(false);
    setKeyboardShortcutHelpOpen(true);
  }, []);

  const toggleSettings = useCallback(() => {
    setAutomationsPath(null);
    setReopenStableWorktreeAfterSettingsId(null);
    setReopenPendingWorktreeAfterSettingsClientThreadId(null);
    setLocalEnvironmentSettingsInitial(null);
    setSettingsPath((current) => (current ? null : buildSettingsPath("general-settings")));
  }, [setAutomationsPath, setSettingsPath]);

  const openLocalEnvironmentsSettings = useCallback(
    (input?: {
      projectId?: string | null;
      configPath?: string | null;
      reopenStableWorktreeId?: string | null;
      reopenPendingWorktreeClientThreadId?: string | null;
    }) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      setReopenStableWorktreeAfterSettingsId(input?.reopenStableWorktreeId ?? null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(
        input?.reopenPendingWorktreeClientThreadId ?? null,
      );
      setLocalEnvironmentSettingsInitial({
        projectId: input?.projectId ?? null,
        configPath: input?.configPath ?? null,
      });
      setSettingsPath(buildSettingsPath("local-environments"));
    },
    [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath],
  );

  const openStableWorktreeStatus = useCallback(
    (pendingWorktreeId: string) => {
      openModal(appHandle, StableWorktreeStatusDialog, {
        pendingWorktreeId,

        transport: ELECTRON_STABLE_WORKTREE_STATUS_TRANSPORT,
        onEditEnvironment: (entry) => {
          const sourceProject =
            projects.find(
              (project) =>
                project.primaryWorkspaceRoot === entry.sourceWorkspaceRoot ||
                project.sources.some((source) => source.root === entry.sourceWorkspaceRoot),
            ) ?? null;
          openLocalEnvironmentsSettings({
            projectId: sourceProject?.id ?? null,
            configPath: entry.localEnvironmentConfigPath ?? null,
            reopenStableWorktreeId: entry.id,
          });
        },
        onOpenPendingWorktree: (clientThreadId) => {
          setSettingsPath(null);
          setLocalEnvironmentSettingsInitial(null);
          setAutomationsPath(null);
          setPendingWorktreeClientThreadId(clientThreadId);
        },
        onActionError: (error) => {
          toast.danger(error instanceof Error ? error.message : "Worktree action failed");
        },
      });
    },
    [
      appHandle,
      openLocalEnvironmentsSettings,
      projects,
      setAutomationsPath,
      setPendingWorktreeClientThreadId,
      setSettingsPath,
    ],
  );

  const createStableWorktree = useCallback(
    async (project: Project, projectName: string) => {
      const sourceWorkspaceRoot = project.primaryWorkspaceRoot?.trim();
      if (!sourceWorkspaceRoot) {
        throw new Error("This project has no source workspace root.");
      }
      const result = await createPendingWorktree(
        buildStableWorktreeCreateInput({
          sourceWorkspaceRoot,
          sourceWorkspaceRoots: project.sources.map((source) => source.root),
          label: projectName,
        }),
      );
      openStableWorktreeStatus(result.pendingWorktreeId);
    },
    [openStableWorktreeStatus],
  );

  const openHooksSettings = useCallback(
    (target: CodexHooksSettingsTarget) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      setReopenStableWorktreeAfterSettingsId(null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(null);
      setLocalEnvironmentSettingsInitial(null);
      setSettingsPath(buildCodexHooksSettingsPath(target));
    },
    [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath],
  );

  const closeSettings = useCallback(() => {
    setSettingsPath(null);
    setLocalEnvironmentSettingsInitial(null);
    setReopenStableWorktreeAfterSettingsId(null);
    setReopenPendingWorktreeAfterSettingsClientThreadId(null);
    if (
      reopenStableWorktreeAfterSettingsId &&
      pendingStableWorktrees.some((entry) => entry.id === reopenStableWorktreeAfterSettingsId)
    ) {
      openStableWorktreeStatus(reopenStableWorktreeAfterSettingsId);
      return;
    }
    if (
      reopenPendingWorktreeAfterSettingsClientThreadId &&
      pendingWorktrees.some(
        (entry) =>
          "clientThreadId" in entry &&
          entry.clientThreadId === reopenPendingWorktreeAfterSettingsClientThreadId,
      )
    ) {
      setPendingWorktreeClientThreadId(reopenPendingWorktreeAfterSettingsClientThreadId);
    }
  }, [
    openStableWorktreeStatus,
    pendingStableWorktrees,
    pendingWorktrees,
    reopenPendingWorktreeAfterSettingsClientThreadId,
    reopenStableWorktreeAfterSettingsId,
    setPendingWorktreeClientThreadId,
    setSettingsPath,
  ]);

  const [inboxFocusToken, setInboxFocusToken] = useState(0);
  // Every way into the Library Inbox lands on the Inbox itself; tabs opened beside it stay open.
  const openInbox = useCallback(() => {
    closePendingWorktreeRoute();
    setInboxFocusToken((current) => current + 1);
    const home =
      workbenchWindow.scenesByOwnerKey[makeWorkbenchSceneKey(INBOX_SCENE_OWNER)]?.primary;
    if (!home) {
      workbenchWindow.selectInbox();
      return;
    }
    void executeSceneCommand(
      INBOX_SCENE_OWNER,
      { kind: "activate_tab", tabId: home.id },
      { location: { kind: "inbox" } },
    );
  }, [closePendingWorktreeRoute, executeSceneCommand, workbenchWindow]);
  // Capture where you are: inside a Project the shortcut opens that Project's own Inbox.
  const captureInbox = useCallback(() => {
    const home = activeProjectScene?.primary;
    if (
      workbenchWindow.location.kind === "project" &&
      activeProjectScene &&
      home?.kind === "inbox"
    ) {
      setInboxFocusToken((current) => current + 1);
      void executeSceneCommand(activeProjectScene.owner, { kind: "activate_tab", tabId: home.id });
      return;
    }
    openInbox();
  }, [activeProjectScene, executeSceneCommand, openInbox, workbenchWindow.location.kind]);
  const inboxCounts = useInboxCounts();
  useInboxInvalidation();
  useEffect(() => {
    const keymap =
      commandKeymapState ?? createCommandKeymapState({}, isMacPlatform ? "macOS" : "windows");
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardEventToCommand(event, keymap, "openInbox")) return;
      event.preventDefault();
      captureInbox();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [captureInbox, commandKeymapState, isMacPlatform]);

  const openAutomations = useCallback(
    (path = buildAutomationsPath()) => {
      closePendingWorktreeRoute();
      setSettingsPath(null);
      setReopenStableWorktreeAfterSettingsId(null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(null);
      setAutomationsPath(path);
    },
    [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath],
  );

  const openPlugins = useCallback(
    (path = buildPluginDirectoryPath()) => {
      closePendingWorktreeRoute();
      setSettingsPath(null);
      setReopenStableWorktreeAfterSettingsId(null);
      setReopenPendingWorktreeAfterSettingsClientThreadId(null);
      setPluginsPath(path);
    },
    [closePendingWorktreeRoute, setPluginsPath, setSettingsPath],
  );

  const presentExistingDatabaseView = useCallback(
    async (projectId: string, databaseViewId: string): Promise<boolean> => {
      const result = await sceneNavigator.presentPanelSurface({
        owner: { kind: "project", projectId },
        request: {
          kind: "db_view",
          config: {
            routingContext: { kind: "project", projectId },
            target: { kind: "database-view", databaseViewId },
          },
        },
        target: { panelId: "right" },
        mode: "durable",
        navigation: "select-owner",
      });
      return result.status === "presented";
    },
    [sceneNavigator],
  );

  const presentLibraryTarget = useCallback(
    async (
      target: LibraryRouteTarget,
      options: {
        readonly owner?: WorkbenchSceneOwner;
        /** The Project presentation a Page opens in; Library content opens as Space content. */
        readonly pageRoutingContext?: ContentRoutingContext;
        readonly titleSnapshot?: string;
        readonly placement?: PresentWorkbenchPanelSurfaceInput["target"]["placement"];
        readonly targetLeafId?: string;
        readonly targetPanelId?: PanelId;
        readonly mode?: PresentWorkbenchPanelSurfaceInput["mode"];
        readonly isCurrent?: () => boolean;
      } = {},
    ): Promise<boolean> => {
      try {
        const request: WorkbenchSurfaceOpenRequest =
          target.kind === "page"
            ? {
                kind: "page_stage",
                config: {
                  routingContext: options.pageRoutingContext ?? libraryContentRoute,
                  pageId: target.pageId,
                  ...(options.titleSnapshot ? { titleSnapshot: options.titleSnapshot } : {}),
                },
                titleSnapshot: options.titleSnapshot,
              }
            : target.kind === "canvas"
              ? {
                  kind: "canvas_stage",
                  config: {
                    routingContext: { kind: "library" },
                    canvasBlockId: target.canvasId,
                    ...(options.titleSnapshot ? { titleSnapshot: options.titleSnapshot } : {}),
                  },
                  titleSnapshot: options.titleSnapshot,
                }
              : target.kind === "database"
                ? {
                    kind: "db_view",
                    config: {
                      routingContext: { kind: "library" },
                      target: {
                        kind: "database-default",
                        databaseId: target.databaseId,
                      },
                    },
                    titleSnapshot: options.titleSnapshot,
                  }
                : {
                    kind: "db_view",
                    config: {
                      routingContext: { kind: "library" },
                      target: {
                        kind: "database-view",
                        databaseViewId: target.viewId,
                      },
                    },
                    titleSnapshot: options.titleSnapshot,
                  };
        const presented = await sceneNavigator.presentPanelSurface({
          owner: options.owner ?? LIBRARY_SCENE_OWNER,
          request,
          target: {
            panelId: options.targetPanelId ?? "right",
            ...(options.targetLeafId ? { leafId: options.targetLeafId } : {}),
            ...(options.placement ? { placement: options.placement } : {}),
          },
          mode: options.mode ?? "durable",
          navigation: "select-owner",
          ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
        });
        return presented.status === "presented";
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : "Resource could not be opened");
        return false;
      }
    },
    [sceneNavigator],
  );
  const openResourceTarget = useCallback(
    async (target: LibraryPlacedResourceTarget) => {
      await presentLibraryTarget(target);
    },
    [presentLibraryTarget],
  );
  /**
   * Creates an Untitled Page where the owner's work lives and opens it in the owner's panel
   * group, title first: a Project's Pages join its primary Database, a projectless chat's join
   * Space, and a chat's Page is linked to it.
   */
  const openNewPage = useCallback(
    async (
      owner: WorkbenchSceneOwner,
      placement: {
        readonly panelId: PanelId;
        readonly leafId?: string;
        readonly isCurrent?: () => boolean;
      },
    ): Promise<boolean> => {
      if (owner.kind !== "project" && owner.kind !== "session") return false;
      let created: CreatePageForResult;
      try {
        created = await createPageFor({
          for:
            owner.kind === "project"
              ? { kind: "project", projectId: owner.projectId }
              : { kind: "session", sessionId: owner.sessionId },
        });
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : "Could not create Page");
        return false;
      }
      // The Page stays where it was created when the user moved on in the meantime.
      if (placement.isCurrent?.() === false) return false;
      requestPageTitleFocus(created.pageId);
      return await presentLibraryTarget(
        { kind: "page", pageId: created.pageId },
        {
          owner,
          pageRoutingContext: created.projectId
            ? projectContentRoute(created.projectId)
            : libraryContentRoute,
          titleSnapshot: "Untitled",
          targetPanelId: placement.panelId,
          ...(placement.leafId ? { targetLeafId: placement.leafId } : {}),
          ...(placement.isCurrent ? { isCurrent: placement.isCurrent } : {}),
        },
      );
    },
    [presentLibraryTarget],
  );

  useRegisterFileLocationNavigator(presentLibraryTarget);

  const sidebarController = useWorkbenchSidebarController({
    browserViewScopeId: windowSessionId,
    projects,
    projectlessSessions,
    knownSessions,
    activeProject,
    activeSessionId,
    activeSessions,
    pendingSessionOpen,
    pendingWorktreeClientThreadId,
    catalog: sessionCatalog,
    sidebarCollections: sidebarSessionCollections,
    window: workbenchWindow,
    panelController,
    codexControl: workbenchCodexControl,
    sidebarState,
    sidebarSync: {
      applySnapshot: applySidebarThreadSnapshot,
      refresh: refreshSidebarThreadSnapshot,
      setPinned: setSidebarThreadPinned,
    },
    sidebarThreadModel,
    queryClient,
    appHandle,
    setSettingsPath,
    setAutomationsPath,
    setPendingWorktreeClientThreadId,
    setLocalEnvironmentSettingsInitial,
    closePendingWorktreeRoute,
    onOpenProjectSessionInNewWindow,
  });
  const {
    archiveSession,
    archiveSidebarThreadItem,
    archiveSidebarThreadItemQuiet,
    handlePendingWorktreeTitleDoubleClick,
    handleSessionTitleDoubleClick,
    markSidebarThreadItemRead,
    moveSidebarThreadForSidebar,
    openRenameSessionDialog,
    openSessionContextMenu,
    forkSession,
    prefetchSidebarSession,
    refreshProjectSessions,
    resolveForkLocalEnvironmentConfigPath,
    selectProject,
    selectSession,
    selectSidebarThread,
    toggleSessionPin,
    toggleSidebarThreadPinned,
  } = sidebarController;

  useEffect(() => {
    if (activeProjectId !== null && !projects.some((project) => project.id === activeProjectId)) {
      workbenchWindow.selectProject(null);
    }
  }, [activeProjectId, projects, workbenchWindow]);

  const panelLifecycle = useWorkbenchPanelLifecycle({
    executeSceneCommand,
    windowOwner: workbenchWindow.owner,
    activeSession,
    controller: panelController,
    createSessionViewTab,
    pinningPreviewTabIdsRef,
  });
  const {
    updateActivePanel,
    setActivePanelCollapsed,
    setActivePanelTab,
    pinPreviewTab,
    selectPanelTab,
    closePanelTab,
    closePlanSidePanel,
  } = panelLifecycle;
  const updateActiveWorkbenchPanel = useCallback(
    async (panelId: PanelId, input: Partial<WorkbenchSceneSnapshot["panels"][PanelId]>) => {
      if (!activeOwnedSceneOwner) {
        return await updateActivePanel(panelId, input);
      }
      const receipt = await executeSceneCommand(activeOwnedSceneOwner, {
        kind: "set_panel_state",
        panelId,
        ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
        ...(input.size === undefined ? {} : { size: input.size }),
      });
      return receipt.error
        ? null
        : (workbenchWindow.owner.read().windowState.scenesByOwnerKey[
            makeWorkbenchSceneKey(activeOwnedSceneOwner)
          ] ?? null);
    },
    [activeOwnedSceneOwner, executeSceneCommand, updateActivePanel, workbenchWindow.owner],
  );
  const setActiveWorkbenchPanelCollapsed = useCallback(
    async (panelId: PanelId, collapsed: boolean) => {
      if (activeOwnedSceneOwner && panelId === "right" && collapsed) {
        return activeOwnedScene?.panels.right ?? null;
      }
      if (!activeOwnedSceneOwner) {
        return await setActivePanelCollapsed(panelId, collapsed);
      }
      return await updateActiveWorkbenchPanel(panelId, { collapsed });
    },
    [
      activeOwnedSceneOwner,
      activeOwnedScene?.panels.right,
      setActivePanelCollapsed,
      updateActiveWorkbenchPanel,
    ],
  );
  const presentProjectSceneSurface = useCallback(
    async (
      projectId: string,
      request: WorkbenchSurfaceOpenRequest,
      options: {
        readonly panelId?: PanelId;
        readonly targetLeafId?: string;
        readonly placement?: PresentWorkbenchPanelSurfaceInput["target"]["placement"];
        readonly mode?: PresentWorkbenchPanelSurfaceInput["mode"];
      } = {},
    ): Promise<boolean> => {
      const result = await sceneNavigator.presentPanelSurface({
        owner: { kind: "project", projectId },
        request,
        target: {
          panelId: options.panelId ?? "right",
          ...(options.targetLeafId ? { leafId: options.targetLeafId } : {}),
          ...(options.placement ? { placement: options.placement } : {}),
        },
        mode: options.mode ?? "durable",
        navigation: "background",
      });
      return result.status === "presented";
    },
    [sceneNavigator],
  );
  const openProjectScenePage = useCallback<OpenPageTabHandler>(
    async (projectId, pageId, titleSnapshot = "Page", options) => {
      await presentProjectSceneSurface(
        projectId,
        {
          kind: "page_stage",
          config: {
            routingContext: { kind: "project", projectId },
            pageId,
            ...(titleSnapshot ? { titleSnapshot } : {}),
          },
          titleSnapshot,
        },
        {
          mode: options?.openMode ?? "durable",
          ...(options?.placement ? { placement: options.placement } : {}),
        },
      );
    },
    [presentProjectSceneSurface],
  );
  const openProjectSceneCanvas: OpenCanvasStageHandler = useCallback(
    async (projectId, canvasBlockId, titleSnapshot = "Canvas", options) =>
      await presentProjectSceneSurface(
        projectId,
        {
          kind: "canvas_stage",
          config: {
            routingContext: { kind: "project", projectId },
            canvasBlockId,
            ...(titleSnapshot ? { titleSnapshot } : {}),
          },
          titleSnapshot,
        },
        {
          panelId: options?.targetPanelId,
          targetLeafId: options?.targetLeafId,
          placement: options?.placement,
        },
      ),
    [presentProjectSceneSurface],
  );
  const openProjectSceneManualSurface = useCallback(
    async (
      projectId: string,
      kind: "browser" | "files" | "terminal",
      options: {
        readonly panelId: PanelId;
        readonly targetLeafId?: string;
        readonly path?: string;
        readonly url?: string;
        readonly hostId?: string;
        readonly cwd?: string | null;
        readonly workspaceRoot?: string | null;
      },
    ): Promise<boolean> => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return false;
      const panelOptions = {
        panelId: options.panelId,
        targetLeafId: options.targetLeafId,
      };
      if (kind === "browser") {
        return await presentProjectSceneSurface(
          projectId,
          {
            kind,
            config: {
              ...(options.url ? { url: options.url } : {}),
            },
          },
          panelOptions,
        );
      }
      if (kind === "terminal") {
        return await presentProjectSceneSurface(
          projectId,
          {
            kind,
            config: {
              context: { kind: "project", projectId },
            },
          },
          panelOptions,
        );
      }
      const hostId = options.hostId ?? "local";
      const workspaceRoot =
        options.workspaceRoot ?? (hostId === "local" ? projectWorkspaceRootOrNull(project) : null);
      return await presentProjectSceneSurface(
        projectId,
        {
          kind,
          titleSnapshot: options.path?.split(/[\\/]/).pop() || "Files",
          config: {
            projectId,
            hostId,
            workspaceRoot,
            cwd: options.cwd ?? workspaceRoot,
            ...(options.path ? { path: options.path } : {}),
          },
        },
        panelOptions,
      );
    },
    [presentProjectSceneSurface, projects],
  );
  /** Opens a panel action in a Project Scene group; resolves false when nothing opened. */
  const openProjectScenePanelAction = useCallback(
    async (
      projectId: string,
      action: PanelNewTabActionKind,
      placement: { readonly panelId: PanelId; readonly leafId?: string },
    ): Promise<boolean> => {
      const panelOptions = { panelId: placement.panelId, targetLeafId: placement.leafId };
      if (action === "new_page") {
        return await openNewPage({ kind: "project", projectId }, placement);
      }
      if (action === "canvas_stage") {
        return await openProjectSceneCanvas(projectId, primaryCanvasBlockId(projectId), "Canvas", {
          targetPanelId: placement.panelId,
          targetLeafId: placement.leafId,
        });
      }
      if (action === "browser" || action === "files" || action === "terminal") {
        return await openProjectSceneManualSurface(projectId, action, panelOptions);
      }
      if (action !== "db_view") return false;
      if (!projects.find((project) => project.id === projectId)?.defaultDatabaseViewId) {
        return false;
      }
      return await presentProjectSceneSurface(
        projectId,
        {
          kind: "db_view",
          config: {
            routingContext: { kind: "project", projectId },
            target: { kind: "project-default" },
          },
        },
        panelOptions,
      );
    },
    [
      openNewPage,
      openProjectSceneCanvas,
      openProjectSceneManualSurface,
      presentProjectSceneSurface,
      projects,
    ],
  );
  const openProjectSceneDestination = useCallback(
    async (
      projectId: string,
      destination: PanelDestination,
      placement: { readonly panelId: PanelId; readonly leafId?: string },
    ): Promise<boolean> =>
      await presentProjectSceneSurface(
        projectId,
        destination.kind === "page"
          ? {
              kind: "page_stage",
              config: {
                routingContext: { kind: "project", projectId: destination.projectId },
                pageId: destination.pageId,
                ...(destination.titleSnapshot ? { titleSnapshot: destination.titleSnapshot } : {}),
              },
              titleSnapshot: destination.titleSnapshot,
            }
          : {
              kind: "db_view",
              config: {
                routingContext: { kind: "project", projectId: destination.projectId },
                target: { kind: "database-view", databaseViewId: destination.databaseViewId },
              },
            },
        { panelId: placement.panelId, targetLeafId: placement.leafId },
      ),
    [presentProjectSceneSurface],
  );
  const browserUsePresentation = useBrowserUsePresentationCoordinator({
    activeSession,
    catalog: sessionCatalog,
    controller: panelController,
    createSessionViewTab,
    pinPreviewTab,
    setActivePanelCollapsed,
    setActivePanelTab,
    windowSessionId,
  });

  const presentOwnedSceneFile = useCallback<FileReferenceRouterPort["openWorkspaceFileTab"]>(
    async (input) => {
      if (!activeOwnedSceneOwner) return false;
      const location = getWorkbenchSceneReturnLocation(workbenchWindowRef.current.location);
      return openWorkbenchSceneFile({
        owner: activeOwnedSceneOwner,
        navigator: sceneNavigator,
        projects,
        input: {
          ...input,
          isCurrent: () =>
            input.isCurrent?.() !== false &&
            JSON.stringify(getWorkbenchSceneReturnLocation(workbenchWindowRef.current.location)) ===
              JSON.stringify(location),
        },
      });
    },
    [activeOwnedSceneOwner, projects, sceneNavigator],
  );
  const browserLinkSessionId = activeSession?.id;
  const browserLinkOwner = useMemo(
    () =>
      activeOwnedSceneOwner ??
      (browserLinkSessionId ? { kind: "session" as const, sessionId: browserLinkSessionId } : null),
    [activeOwnedSceneOwner, browserLinkSessionId],
  );
  const supportsBrowserLinkNavigation =
    browserLinkOwner?.kind === "project" || browserLinkOwner?.kind === "session";
  const openLinkInBrowserTab = useCallback(
    async (url: string): Promise<boolean> => {
      if (browserLinkOwner?.kind !== "project" && browserLinkOwner?.kind !== "session")
        return false;
      const result = await sceneNavigator.presentPanelSurface({
        owner: browserLinkOwner,
        request: { kind: "browser", config: { url } },
        target: { panelId: "right" },
        mode: "durable",
        navigation: "background",
      });
      return result.status === "presented";
    },
    [browserLinkOwner, sceneNavigator],
  );
  const openLinkInBrowserWindow = useCallback(
    (url: string) => openWorkbenchWindow({ browserUrl: url }),
    [],
  );
  const panelOpeners = useWorkbenchPanelOpeners({
    presentOwnedSceneFile,
    activeProjectId,
    activeSession,
    controller: panelController,
    lifecycle: panelLifecycle,
    codexControl: workbenchCodexControl,
    projects,
    rightPanelFullWidth,
    createSessionViewTab,
    updateTab: updateSessionViewTab,
    refreshProjectSessions,
    requestPageStageNavigation: openPageStage,
    presentProjectScenePage: openProjectScenePage,
    pendingPageDeepLinkOpen,
    onPageDeepLinkHandled,
  });
  useEffect(
    () => registerUserAttachmentImagePreviewOpener(panelOpeners.openImagePreview),
    [panelOpeners.openImagePreview],
  );
  const {
    openSideChat,
    openExistingSideChat,
    openMcpAppSidePanel,
    openPlanSidePanel,
    openAutomationSidePanel,
    openWorkspaceFileTab,
  } = panelOpeners;
  const openExistingSideChatRef = useRef(openExistingSideChat);
  openExistingSideChatRef.current = openExistingSideChat;

  const sessionCommands = useWorkbenchSessionCommands({
    activeProject,
    activeProjectId,
    activeSession,
    projects,
    sessionsByProject,
    projectlessSessions,
    knownSessions,
    catalog: sessionCatalog,
    controller: panelController,
    lifecycle: panelLifecycle,
    panelOpeners,
    sceneNavigator,
    createSessionViewTab,
    codexControl: workbenchCodexControl,
    processManagerConversationsById,
    threadScopeIdentityRegistry,
    selectSession,
    archiveSession,
    toggleSessionPin,
    refreshProjectSessions,
    resolveForkLocalEnvironmentConfigPath,
    closePendingWorktreeRoute,
    setPendingWorktreeClientThreadId,
    setSettingsPath,
    setAutomationsPath,
    onOpenProjectSessionInNewWindow,
    windowSessionId,
    commandKeymapState,
    setCommandPaletteOpen,
    setCommandPaletteOpenRequest,
    setCommandContentSearchOpenRequest,
    setLocalEnvironmentSettingsInitial,
    setNewThreadComposerIntentsBySessionId,
    setProcessManagerOpen,
  });
  const {
    ensureDefaultDraftSessionForProject,
    startNewChatInProject,
    startNewChatWithPrompt,
    openSidebarCommandPalette,
    openCommandPalette,
    requestContentSearchOpen,
    showUnavailableProduct,
    activateReviewTab,
    openSubagentsPanelTab,
    openAttachedThreadSession,
    openAttachedThreadSessionById,
    openResolvedPendingThreadSession,
    presentScheduledChat,
    replyAboutScheduledTask,
    openProcessOutputInCurrentSession,
    openProcessManagerOutput,
    openTurnDiffFileInSidePanel,
    openSummaryOutputInSidePanel,
    consumeNewThreadComposerIntent,
    forkSessionFromTurn,
    forkSessionFromTurnIntoWorktree,
  } = sessionCommands;
  const scheduledRouteState = automationsPath
    ? resolveAutomationsRouteState(automationsPath)
    : null;
  // A run or Heartbeat chat opened from Scheduled is the route's active Session.
  const scheduledRunPresented =
    scheduledRouteState?.runSessionId != null &&
    scheduledRouteState.runSessionId === activeSessionId;
  const navigateScheduled = useCallback(
    (path: string, options?: { readonly replace?: boolean }) => {
      if (workbenchWindow.location.kind !== "automations") {
        openAutomations(path);
        return;
      }
      workbenchWindow.navigate(
        { ...workbenchWindow.location, path },
        { record: options?.replace !== true },
      );
    },
    [openAutomations, workbenchWindow],
  );
  const openScheduledTaskChat = useCallback(
    (task: CodexScheduledAutomation) => {
      if (!task.targetSessionId) return;
      void presentScheduledChat(task.targetSessionId, (sessionId) =>
        buildAutomationsPath({ automationId: task.id, runSessionId: sessionId }),
      );
    },
    [presentScheduledChat],
  );
  const replyAboutScheduledTaskInPlace = useCallback(
    (task: CodexScheduledAutomation, message: string) =>
      replyAboutScheduledTask({
        projectId: task.projectId,
        prompt: buildScheduledTaskReplyPrompt(task, message),
        scheduledPath: (sessionId) =>
          buildAutomationsPath({ automationId: task.id, runSessionId: sessionId }),
      }),
    [replyAboutScheduledTask],
  );
  const scheduledChatOptions = useMemo<ScheduledTaskChatOption[]>(() => {
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    return knownSessions
      .filter((session) => !session.archived && hasSessionConversation(session))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({
        id: session.id,
        title: session.displayTitle,
        projectName: session.projectId ? (projectNames.get(session.projectId) ?? null) : null,
      }));
  }, [knownSessions, projects]);
  const navigatePlugins = useCallback(
    (path: string, options?: { readonly replace?: boolean }) => {
      if (workbenchWindow.location.kind !== "plugins") {
        openPlugins(path);
        return;
      }
      workbenchWindow.navigate(
        { ...workbenchWindow.location, path },
        { record: options?.replace !== true },
      );
    },
    [openPlugins, workbenchWindow],
  );
  const customizeNavigation: CustomizeNavigation = {
    path: pluginsPath,
    projectId: activeProjectId,
    onNavigate: navigatePlugins,
    onStartChat: (prompt) => void startNewChatWithPrompt({ projectId: activeProjectId, prompt }),
    onOpenSettings: (target) =>
      openSettingsPath(target == null ? PLUGINS_SETTINGS_PATH : buildPluginSettingsPath(target)),
    onOpenHooksSettings: () => openSettingsAt("hooks-settings"),
  };
  // Pages and Inboxes reach Scheduled through this, wherever they are shown.
  const scheduledNavigation: ScheduledNavigation = {
    openTask: (automationId) => navigateScheduled(buildAutomationsPath({ automationId })),
    scheduleRunbook: ({ pageId, title, projectId }) =>
      navigateScheduled(
        buildAutomationsPath({
          automationMode: "create",
          runbookPageId: pageId,
          runbookTitle: title,
          projectId,
        }),
      ),
  };
  const scheduledSidebarNavigation: ScheduledSidebarNavigation = {
    tasks: scheduledTasks,
    selectedTaskId: scheduledRouteState?.automationId ?? null,
    activeRunSessionId: scheduledRunPresented ? (scheduledRouteState?.runSessionId ?? null) : null,
    onSelectTask: (task) => {
      if (task.kind === "heartbeat") {
        openScheduledTaskChat(task);
        return;
      }
      navigateScheduled(buildAutomationsPath({ automationId: task.id }));
    },
    onOpenRun: (task, run) => {
      if (!run.sessionId) return;
      void presentScheduledChat(run.sessionId, (sessionId) =>
        buildAutomationsPath({ automationId: task.id, runSessionId: sessionId }),
      );
    },
    onOpenInbox: (projectId) => {
      setAutomationsPath(null);
      if (projectId === null) openInbox();
      else selectProject(projectId);
    },
    onCreateTask: () => navigateScheduled(buildAutomationsPath({ automationMode: "create" })),
    onEditTask: (task) =>
      navigateScheduled(buildAutomationsPath({ automationId: task.id, automationMode: "edit" })),
    onTaskDeleted: (task) => {
      if (scheduledRouteState?.automationId === task.id)
        navigateScheduled(buildAutomationsPath(), { replace: true });
    },
  };
  const openSettingsThreadSessionById = useCallback<SettingsOpenThread>(
    async (threadId, context) => {
      const opened = await openAttachedThreadSessionById(threadId, context);
      if (!opened) return;

      setSettingsPath(null);
    },
    [openAttachedThreadSessionById, setSettingsPath],
  );
  const panelCommands = useWorkbenchPanelCommandRouter({
    activeSession,
    activePanelOwnerKey,
    projects,
    windowSessionId,
    isMacPlatform,
    sidePanelOpen,
    bottomPanelOpen,
    controller: panelController,
    lifecycle: panelLifecycle,
    panelOpeners,
    sessionCommands,
    createSessionViewTab,
    resolveProjectDefaultDatabaseViewId,
    openPageStage,
    commandKeymapState,
    openNewPage: async (placement) =>
      activeSession
        ? await openNewPage({ kind: "session", sessionId: activeSession.id }, placement)
        : false,
    focusedPanelGroupRef,
    panelTabShortcutStateRef,
  });
  const {
    cycleFocusedPanelTab,
    closeFocusedPanelTab,
    dispatchPanelAction,
    focusOrCreateDatabaseViewTab,
    resolveActivePanelCapabilities,
  } = panelCommands;

  const openPendingViewDeepLink = useEffectEvent(
    async (request: { projectId: string; viewId: string }) => {
      const opened = await focusOrCreateDatabaseViewTab(request.viewId, "right");
      if (!opened) return;
      onViewDeepLinkHandled?.(request);
    },
  );

  useEffect(() => {
    if (!pendingViewDeepLinkOpen) return;
    if (pendingViewDeepLinkOpen.projectId !== activeProjectId) return;

    void openPendingViewDeepLink(pendingViewDeepLinkOpen);
  }, [activeProjectId, activeSession?.id, pendingViewDeepLinkOpen]);

  const chromeCommands = useWorkbenchChromeCommands({
    activePanelOwner:
      activePanelOwnerKey && rightPanel && bottomPanel
        ? {
            key: activePanelOwnerKey,
            panels: { right: rightPanel, bottom: bottomPanel },
          }
        : null,
    controller: panelController,
    lifecycle: {
      setActivePanelCollapsed: setActiveWorkbenchPanelCollapsed,
      updateActivePanel: updateActiveWorkbenchPanel,
    },
    navigateBack: workbenchWindow.navigateBack,
    navigateForward: workbenchWindow.navigateForward,
    workbenchRootRef,
    shellMainContentWidth,
    shellBodyHeight: shellBodySize.height,
    regularRightPanelWidth,
    rightPanelRequestedWidth,
    bottomPanelHeight,
    bottomPanelRequestedHeight,
    rightPanelSide: sessionContentSide,
  });
  const {
    showActiveRightPanel,
    hideActiveRightPanel,
    showActiveBottomPanel,
    hideActiveBottomPanel,
    setActiveRightPanelFullWidth,
    executeShellNavigation,
    resizeRightPanel,
    resizeBottomPanel,
  } = chromeCommands;
  const activeSessionRightPanel = activeSessionPanelModel?.rightPanel ?? null;
  /** Shows the Chat in place of the content panel, keeping full view and every content tab. */
  const presentSessionConversationInFullView = useCallback(() => {
    if (!activeSessionRightPanel) return;
    void updateActiveWorkbenchPanel("right", {
      collapsed: true,
      size: { ...activeSessionRightPanel.size, fullWidth: true },
    });
  }, [activeSessionRightPanel, updateActiveWorkbenchPanel]);
  /** Places the Chat in the pane on `side`, its content beside it, and remembers the choice. */
  const moveSessionConversationToSide = useCallback(
    (side: WorkbenchPanelSide) => {
      if (!activeSessionRightPanel) return;
      const contentSide = oppositeWorkbenchPanelSide(side);
      updatePreferredSessionContentSide(contentSide);
      void updateActiveWorkbenchPanel("right", {
        collapsed: false,
        side: contentSide,
        size: { ...activeSessionRightPanel.size, fullWidth: false },
      });
    },
    [activeSessionRightPanel, updateActiveWorkbenchPanel, updatePreferredSessionContentSide],
  );
  const rightPanelComposerOverlayPlacement: FloatingComposerPlacement | undefined =
    activeSessionScene && activeSession
      ? {
          control: {
            state: activeSessionScene.composerOverlay,
            attention: "none",
            onStateChange: updateActiveSessionComposerOverlay,
          },
          // Browser pages own their full height; other surfaces scroll clear of the composer.
          reserveContent:
            !rightActiveRenderableTab ||
            !("kind" in rightActiveRenderableTab) ||
            rightActiveRenderableTab.kind !== "browser",
          title: activeSession.displayTitle,
          menuItems: [
            {
              id: "full-view",
              label: "Open in full view",
              icon: <EnterFullViewIcon />,
              onSelect: presentSessionConversationInFullView,
            },
            {
              id: "left",
              label: "Move to left pane",
              icon: <MoveToLeftPaneIcon />,
              onSelect: () => moveSessionConversationToSide("left"),
            },
            {
              id: "right",
              label: "Move to right pane",
              icon: <MoveToRightPaneIcon />,
              onSelect: () => moveSessionConversationToSide("right"),
            },
          ],
          onDropBesideContent: (side) => moveSessionConversationToSide(side),
        }
      : undefined;
  const browserSidebarState = useBrowserSidebarRendererState();
  const browserTabSnapshotByKey = useMemo(
    () =>
      new Map(
        browserSidebarState.state.tabs.map((snapshot) => [
          makeBrowserSidebarTabKey(snapshot),
          snapshot,
        ]),
      ),
    [browserSidebarState.state.tabs],
  );

  const saveSideChat = useSaveSideChat({
    owner: workbenchWindow.owner,
    refresh: refreshProjectSessions,
    open: sessionCommands.openAttachedThreadSessionById,
    execute: executeSceneCommand,
  });
  const { panelGroupTabs, browserRetentionTabs, visibleBrowserTabIds } =
    useWorkbenchPanelProjection({
      saveSideChat,
      activeRenderSession,
      activeSessionPanelModel,
      projects,
      pageStageRelatedChatCandidates,
      pageTitleStore,
      currentLibraryId,
      panelTabPresentationRegistry,
      panelTabPresentationControllerKeysRef,
      panelGroupTabsRef,
      terminalSessionVersion,
      browserTabSnapshotByKey,
      browserBoundsSyncTriggerByPanel: {
        right: rightPanelMotion.animatedSize,
        bottom: bottomPanelMotion.animatedSize,
      },
      lifecycle: panelLifecycle,
      openers: panelOpeners,
      sessionCommands,
      panelCommands,
      controller: panelController,
      surface: {
        activeSearchQuery,
        browserViewScopeId: windowSessionId,
        onOpenBrowserSettings: openBrowserSettings,
        onOpenLibraryTarget: (target, { sourceSurfaceId, ...options }) =>
          presentLibraryTarget(target, {
            ...options,
            placement: { kind: "same-group", sourceSurfaceId },
          }),
        windowSessionId,
        onLeavePageStage,
        pageStageCloseRef,
        pageStageHistoryModal,
        pageStagePersistRef,
        pageStageSessionSnapshotRef,
        searchByProject,
        setSearchQuery,
        taskSearchOpenTick,
        onSearchInFiles: () => openCommandPalette({ mode: "text" }),
      },
      conversation: {
        composerEnterBehavior,
        threadQueueFollowUpsEnabled,
        onOpenHooksSettings: openHooksSettings,
        onQueueingEnabledChange: handleThreadQueueFollowUpsEnabledChange,
        onRefreshSessions: refreshProjectSessions,
      },
      automation: {
        chats: scheduledChatOptions,
        onOpenAutomations: openAutomations,
        onOpenLocalEnvironmentsSettings: openLocalEnvironmentsSettings,
      },
      onTogglePageStageHistoryModal: togglePageStageHistoryModal,
      onUpdateSessionViewTab: updateSessionViewTab,
    });
  const mountedBrowserTabIds = useMemo(
    () =>
      activeRenderSession && activeSessionPanelModel
        ? collectMountedBrowserTabIds(activeRenderSession, activeSessionPanelModel, {
            right: rightPanelMotion.mounted,
            bottom: bottomPanelMotion.mounted,
          })
        : new Set<string>(),
    [
      activeRenderSession,
      activeSessionPanelModel,
      bottomPanelMotion.mounted,
      rightPanelMotion.mounted,
    ],
  );
  const projectBrowserRetentionTabs = useMemo<WorkbenchTabProjection[]>(() => {
    if (!activeProjectScene || !activeProject || !projectSceneKey) return [];
    return Object.values(activeProjectScene.panelSurfacesById).flatMap((surface, index) =>
      surface.kind === "browser"
        ? [
            {
              id: surface.id,
              sessionId: projectSceneKey,
              projectId: activeProject.id,
              panelId: findWorkbenchPanelLeafForTab(
                activeProjectScene.panels.right.layout,
                surface.id,
              )
                ? ("right" as const)
                : ("bottom" as const),
              title: surface.titleSnapshot,
              order: index,
              stateKey: surface.stateKey,
              state: surface.state,
              createdAt: activeProjectScene.touchedAt,
              updatedAt: activeProjectScene.touchedAt,
              kind: "browser" as const,
              browserTabId: surface.config.browserTabId,
              config: {
                projectId: activeProject.id,
                ...surface.config,
              },
            },
          ]
        : [],
    );
  }, [activeProject, activeProjectScene, projectSceneKey]);
  const visibleProjectBrowserTabIds = useMemo(() => {
    const visible = new Set<string>();
    if (!activeProjectScene) return visible;
    for (const panelId of ["right", "bottom"] as const) {
      const panel = activeProjectScene.panels[panelId];
      if (panel.collapsed) continue;
      for (const leaf of listWorkbenchPanelLeaves(panel.layout)) {
        const surface = leaf.activeTabId
          ? activeProjectScene.panelSurfacesById[leaf.activeTabId]
          : null;
        if (surface?.kind === "browser") visible.add(surface.id);
      }
    }
    return visible;
  }, [activeProjectScene]);

  useEffect(() => {
    if (settingsPath !== null) return;
    const atMediumWidth = shellWidthClass !== "wide";
    const atNarrowWidth = shellWidthClass === "narrow";
    const crossedMediumWidth = atMediumWidth !== shellAtMediumWidthRef.current;
    const crossedNarrowWidth = atNarrowWidth !== shellAtNarrowWidthRef.current;
    if (!crossedMediumWidth && !crossedNarrowWidth) return;

    shellAtMediumWidthRef.current = atMediumWidth;
    shellAtNarrowWidthRef.current = atNarrowWidth;

    if (!activePanelOwnerKey || !rightPanel) return;

    const shouldClearRightPanel =
      !activeOwnedSceneOwner &&
      ((crossedMediumWidth && atMediumWidth && sidebarOpen && sidePanelOpen) ||
        (crossedNarrowWidth && atNarrowWidth && sidePanelOpen));
    if (shouldClearRightPanel) {
      const overrideKey = makeWorkbenchPanelSlotKey(activePanelOwnerKey, "right");
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [overrideKey]: true,
      }));
      void updateActiveWorkbenchPanel("right", {
        collapsed: true,
        size: {
          ...rightPanel.size,
          fullWidth: false,
        },
      })
        .catch((error) => {
          toast.danger(error instanceof Error ? error.message : "Unable to update panel");
        })
        .finally(() => {
          panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
            if (!(overrideKey in current)) return current;
            const next = { ...current };
            delete next[overrideKey];
            return next;
          });
        });
    }

    if (crossedNarrowWidth && atNarrowWidth && sidebarOpen) {
      setSidebarCollapsedWithCodexState(true, { animate: false });
    }
  }, [
    activePanelOwnerKey,
    activeOwnedSceneOwner,
    rightPanel,
    setSidebarCollapsedWithCodexState,
    settingsPath,
    sidePanelOpen,
    sidebarOpen,
    shellWidthClass,
    updateActiveWorkbenchPanel,
  ]);

  const toggleThreadSummaryPanel = useCallback(() => {
    toggleThreadSummaryPanelPinnedOpen();
  }, [toggleThreadSummaryPanelPinnedOpen]);
  const threadSummaryCommands = useMemo<WorkbenchThreadSummaryCommands>(
    () => ({
      selectPanelTab,
      setPanelCollapsed: setActivePanelCollapsed,
      openAutomationSidePanel,
      openAutomations,
      openSummaryOutputInSidePanel,
      openProcessOutput: openProcessOutputInCurrentSession,
      openProcessManager: () => {
        setProcessManagerOpen(true);
      },
      presentBrowserTab: browserUsePresentation.presentBrowserTab,
    }),
    [
      openAutomationSidePanel,
      openAutomations,
      openProcessOutputInCurrentSession,
      openSummaryOutputInSidePanel,
      browserUsePresentation.presentBrowserTab,
      selectPanelTab,
      setActivePanelCollapsed,
    ],
  );
  const threadSummary = useWorkbenchThreadSummary({
    activeSession,
    windowSessionId,
    layoutMode: threadSummaryPanelLayoutMode,
    mainContentWidth: mainContentTargetWidth,
    rightPanelFullWidth,
    pinnedOpen: threadSummaryPanelPinnedOpen,
    sideChatTabs: activeSession ? (sideChatTabsBySession[activeSession.id] ?? []) : [],
    previewTabsByPanel,
    scheduledAutomations: scheduledTasks.tasks,
    commands: threadSummaryCommands,
  });
  const {
    mounted: threadSummaryPanelMounted,
    open: threadSummaryPanelOpen,
    hideImmediately: threadSummaryPanelHideImmediately,
    contentShift: threadSummaryPanelContentShift,
    sideChatRows: threadSummarySideChatRows,
    browserRows: threadSummaryBrowserRows,
    scheduledAutomation: threadSummaryScheduledAutomation,
    onOpenSideChatRow: openSummarySideChatRow,
    onOpenBrowserRow: openSummaryBrowserRow,
    onOpenScheduledAutomation: openSummaryScheduledAutomation,
    onOpenProcessManager: openSummaryProcessManager,
    onOpenBackgroundTerminalOutput: openSummaryBackgroundTerminalOutput,
  } = threadSummary;
  const threadSummaryHeaderAction = (
    <WorkbenchThreadSummaryHeader
      activeSession={activeSession}
      pinnedOpen={threadSummaryPanelPinnedOpen}
      onTogglePinnedOpen={toggleThreadSummaryPanel}
      summary={threadSummary}
      onOpenSubagentsPanel={() => {
        const rootThreadId =
          activeSession?.executionRef?.threadId ?? activeSession?.thread?.threadId;
        if (rootThreadId) void openSubagentsPanelTab(rootThreadId);
      }}
    />
  );

  const toggleActiveSidePanel = useCallback(() => {
    if (!activePanelOwnerKey || activeOwnedSceneOwner) return;
    if (!sidePanelOpen) {
      void showActiveRightPanel();
      return;
    }
    void hideActiveRightPanel();
  }, [
    activePanelOwnerKey,
    hideActiveRightPanel,
    activeOwnedSceneOwner,
    showActiveRightPanel,
    sidePanelOpen,
  ]);

  const sessionContentTabCount = activeSessionPanelModel
    ? Object.values(activeSessionPanelModel.renderableTabsByPanelLeaf.right).reduce(
        (count, tabs) => count + tabs.length,
        0,
      )
    : 0;
  /**
   * Enters full view showing the selected content, or returns a full view to split view. Without
   * content, it opens a New tab to show.
   */
  const setSessionWorkspaceFullView = useCallback(
    (fullView: boolean) => {
      if (!sessionWorkspace) return;
      if (sessionContentTabCount > 0) {
        setActiveRightPanelFullWidth(fullView);
        return;
      }
      if (!resolveActivePanelCapabilities("right").actions.browser.available) return;
      // Settle the layout first, so the New tab appears in place without a passing layout.
      setActiveRightPanelFullWidth(fullView);
      void dispatchPanelAction("browser", { panelId: "right" });
    },
    [
      dispatchPanelAction,
      resolveActivePanelCapabilities,
      sessionContentTabCount,
      sessionWorkspace,
      setActiveRightPanelFullWidth,
    ],
  );
  const toggleActiveWorkspaceFullView = useCallback(() => {
    if (!sessionWorkspace) return;
    setSessionWorkspaceFullView(sessionWorkspace.layout !== "full");
  }, [sessionWorkspace, setSessionWorkspaceFullView]);

  const toggleActiveBottomPanel = useCallback(() => {
    if (!activePanelOwnerKey) return;
    if (bottomPanelOpen) {
      void hideActiveBottomPanel();
      return;
    }

    const hasBottomPanelContent = activeOwnedScene
      ? listWorkbenchPanelLeaves(activeOwnedScene.panels.bottom.layout).some(
          (leaf) => leaf.tabIds.length > 0,
        )
      : (activeSessionPanelModel?.bottomRenderableTabs.length ?? 0) > 0;
    if (hasBottomPanelContent) {
      void showActiveBottomPanel();
      return;
    }

    if (projectSceneOwner && activeProject) {
      const workspaceRoot = projectWorkspaceRootOrNull(activeProject);
      if (!workspaceRoot) {
        void showActiveBottomPanel();
        return;
      }
      void openProjectSceneManualSurface(activeProject.id, "terminal", {
        panelId: "bottom",
        targetLeafId: activeProjectScene?.panels.bottom.layout.activeLeafId,
      }).then((opened) => {
        if (!opened) void showActiveBottomPanel();
      });
      return;
    }

    if (activeOwnedSceneOwner) {
      void showActiveBottomPanel();
      return;
    }

    const terminalAvailable = resolveActivePanelCapabilities("bottom").actions.terminal.available;
    if (activeSession && terminalAvailable) {
      void dispatchPanelAction("terminal", {
        panelId: "bottom",
      });
      return;
    }

    void showActiveBottomPanel();
  }, [
    activePanelOwnerKey,
    activeOwnedScene,
    activeOwnedSceneOwner,
    activeProject,
    activeProjectScene?.panels.bottom.layout.activeLeafId,
    activeSession,
    activeSessionPanelModel?.bottomRenderableTabs.length,
    bottomPanelOpen,
    dispatchPanelAction,
    hideActiveBottomPanel,
    openProjectSceneManualSurface,
    projectSceneOwner,
    resolveActivePanelCapabilities,
    showActiveBottomPanel,
  ]);

  const resolveNewTabOwnerContext = useCallback(
    (owner: WorkbenchSceneOwner, panelId: PanelId): WorkbenchNewTabOwnerContext | null => {
      const canOpenBottomTerminal = (terminalAvailable: boolean) =>
        panelId === "right" && !bottomPanelOpen && terminalAvailable;
      if (owner.kind === "session") {
        if (activeSession?.id !== owner.sessionId) return null;
        const project = projects.find((candidate) => candidate.id === activeSession.projectId);
        // Singletons stay listed: choosing one that is already open switches to it.
        return {
          actions: filterAvailablePanelActions(PANEL_NEW_TAB_ACTIONS, [], panelId, {
            kind: "session",
            backendKind: activeSession.thread?.backendBinding.kind ?? "codex",
            projectId: activeSession.projectId,
            hasAttachedThread: Boolean(activeSession.executionRef || activeSession.thread),
            cwd: activeSession.thread?.cwd,
            projectWorkspaceRoot: projectWorkspaceRootOrNull(project ?? null),
          }),
          currentProjectId: activeSession.projectId,
          canOpenBottomTerminal: canOpenBottomTerminal(
            resolveActivePanelCapabilities("bottom").actions.terminal.available,
          ),
        };
      }
      if (owner.kind !== "project" || activeProject?.id !== owner.projectId) return null;
      const projectWorkspaceRoot = projectWorkspaceRootOrNull(activeProject);
      return {
        actions: filterAvailablePanelActions(PANEL_NEW_TAB_ACTIONS, [], panelId, {
          kind: "project",
          projectId: activeProject.id,
          projectWorkspaceRoot,
        }),
        currentProjectId: activeProject.id,
        canOpenBottomTerminal: canOpenBottomTerminal(projectWorkspaceRoot !== null),
      };
    },
    [activeProject, activeSession, bottomPanelOpen, projects, resolveActivePanelCapabilities],
  );
  const { createManualTab: createSessionManualTab } = sessionCommands;
  const { openPanelDestinationFromPicker } = panelCommands;
  const runNewTabAction = useCallback(
    async (
      action: PanelNewTabActionKind,
      { owner, panelId, leafId, isCurrent }: WorkbenchNewTabPlacement,
    ) => {
      if (action === "new_page") {
        return await openNewPage(owner, { panelId, leafId, isCurrent });
      }
      if (owner.kind === "project") {
        return await openProjectScenePanelAction(owner.projectId, action, { panelId, leafId });
      }
      if (owner.kind !== "session" || activeSession?.id !== owner.sessionId) return false;
      // Review is a singleton: an open Review is revealed instead of duplicated.
      if (action === "review") return await createSessionManualTab("review", panelId, leafId);
      return await dispatchPanelAction(action, { panelId, leafId });
    },
    [
      activeSession?.id,
      createSessionManualTab,
      dispatchPanelAction,
      openNewPage,
      openProjectScenePanelAction,
    ],
  );
  const openNewTabDestination = useCallback(
    async (destination: PanelDestination, { owner, panelId, leafId }: WorkbenchNewTabPlacement) => {
      if (owner.kind === "project") {
        return await openProjectSceneDestination(owner.projectId, destination, {
          panelId,
          leafId,
        });
      }
      if (owner.kind !== "session" || activeSession?.id !== owner.sessionId) return false;
      await openPanelDestinationFromPicker(destination, panelId, leafId);
      return true;
    },
    [activeSession?.id, openPanelDestinationFromPicker, openProjectSceneDestination],
  );
  const openNewTabLibraryTarget = useCallback(
    async (
      target: LibraryRouteTarget,
      placement: WorkbenchNewTabPlacement & { readonly title?: string },
    ) =>
      await presentLibraryTarget(target, {
        owner: placement.owner,
        ...(placement.title ? { titleSnapshot: placement.title } : {}),
        targetPanelId: placement.panelId,
        targetLeafId: placement.leafId,
        isCurrent: placement.isCurrent,
      }),
    [presentLibraryTarget],
  );
  const newTabPort = useWorkbenchNewTabPortValue({
    windowOwner: workbenchWindow.owner,
    executeSceneCommand,
    isMac: isMacPlatform,
    commandKeymapState: commandKeymapState ?? null,
    projects,
    commands: {
      resolveOwnerContext: resolveNewTabOwnerContext,
      runAction: runNewTabAction,
      openDestination: openNewTabDestination,
      openLibraryTarget: openNewTabLibraryTarget,
    },
  });

  const handleDesktopNotificationAction = useCallback(
    async (invocation: DesktopNotificationActionInvocation): Promise<void> => {
      const parentThreadId = resolveDesktopNotificationParentThreadId(invocation);
      if (!parentThreadId) return;
      const runtimeSessionId = resolveDesktopNotificationRuntimeSessionId(invocation);

      const opened = await openAttachedThreadSessionById(
        parentThreadId,
        runtimeSessionId ? { runtimeSessionId } : undefined,
      );
      if (!opened) return;
      const presented = await waitForActiveThread(parentThreadId);
      if (!presented) return;
      if (runtimeSessionId) {
        await executeRuntimeDesktopNotificationAction(invocation, runtimeSessionId, (input) =>
          agentRuntimeRuntime.message({
            sessionId: input.sessionId,
            message: { messageId: createUuidV7(), text: input.text },
          }),
        );
        return;
      }

      const sideChatThreadId = resolveDesktopNotificationSideChatThreadId(invocation);
      if (sideChatThreadId) {
        const sideChatOpened = await openExistingSideChatRef.current({
          threadId: sideChatThreadId,
          parentThreadId,
          parentNavigationPath: invocation.navigationPath ?? `thread:${parentThreadId}`,
        });
        if (!sideChatOpened) return;
      }

      const manager = codexAppServerRegistry.getForHostId(invocation.hostId);
      await executeDesktopNotificationAction(invocation, manager);
    },
    [codexAppServerRegistry, openAttachedThreadSessionById, waitForActiveThread],
  );

  const openDesktopNotification = useCallback(
    (invocation: DesktopNotificationActionInvocation): Promise<void> => {
      const action = desktopNotificationActionChainRef.current
        .catch(() => undefined)
        .then(() => handleDesktopNotificationAction(invocation));
      desktopNotificationActionChainRef.current = action;
      return action;
    },
    [handleDesktopNotificationAction],
  );

  const executeWorkbenchCommand = useCallback(
    ({ commandId, source }: WorkbenchCommandInvocation): boolean => {
      if (commandId === CREATE_PAGE_COMMAND_ID || commandId === CREATE_PAGE_EXPANDED_COMMAND_ID) {
        return requestPageCreateFromContext(appHandle, {
          activeProjectId: activeProject?.id ?? activeProjectId,
          unavailableFeedback: source === "keyboard_shortcut" ? "silent" : "toast",
          captureSelection: source === "keyboard_shortcut",
          expanded: commandId === CREATE_PAGE_EXPANDED_COMMAND_ID,
        });
      }
      if (commandId === TOGGLE_BOTTOM_PANEL_COMMAND_ID) {
        toggleActiveBottomPanel();
        return true;
      }
      if (commandId === TOGGLE_FULL_VIEW_COMMAND_ID) {
        toggleActiveWorkspaceFullView();
        return true;
      }
      return false;
    },
    [
      activeProject?.id,
      activeProjectId,
      appHandle,
      toggleActiveBottomPanel,
      toggleActiveWorkspaceFullView,
    ],
  );

  const commandPort = useMemo<WorkbenchCommandPort>(
    () => ({
      navigate: (direction) => {
        executeShellNavigation(direction);
      },
      toggleSidebar: () => {
        toggleSidebarCollapsed();
      },
      renameThread: () => {
        if (!activeSession) return;
        openRenameSessionDialog(activeSession);
      },
      openContentSearch: (source, preferredDomain) => {
        requestContentSearchOpen(source, preferredDomain);
      },
      cyclePanelTab: (direction) => {
        cycleFocusedPanelTab(panelTabCycleRequestDirectionToOffset(direction), null, {
          respectActiveElementGuard: true,
        });
      },
      closePanelTab: () => {
        closeFocusedPanelTab(null, { respectActiveElementGuard: true });
      },
      execute: (commandId, source) => {
        if (commandId === CREATE_PAGE_COMMAND_ID || commandId === CREATE_PAGE_EXPANDED_COMMAND_ID) {
          return executeWorkbenchCommand({ commandId, source });
        }
        if (!selectedSessionDetailReady) {
          pendingWorkbenchCommandInvocationsRef.current.push({
            commandId,
            source,
          });
          return true;
        }
        return executeWorkbenchCommand({ commandId, source });
      },
      openCommandPalette,
      goToPages: workbenchWindow.selectLibrary,
      goToSettings: openSettings,
      toggleSettings,
      openKeyboardShortcuts: openKeyboardShortcutHelp,
      openDesktopNotification,
    }),
    [
      activeSession,
      closeFocusedPanelTab,
      cycleFocusedPanelTab,
      executeShellNavigation,
      executeWorkbenchCommand,
      openCommandPalette,
      workbenchWindow.selectLibrary,
      openSettings,
      openKeyboardShortcutHelp,
      openDesktopNotification,
      openRenameSessionDialog,
      requestContentSearchOpen,
      selectedSessionDetailReady,
      toggleSettings,
      toggleSidebarCollapsed,
    ],
  );

  useEffect(() => {
    if (!onRegisterCommandPort) return undefined;
    return onRegisterCommandPort(commandPort);
  }, [commandPort, onRegisterCommandPort]);

  useEffect(() => {
    if (!selectedSessionDetailReady) return;
    const pending = pendingWorkbenchCommandInvocationsRef.current.splice(0);
    for (const invocation of pending) {
      executeWorkbenchCommand(invocation);
    }
  }, [executeWorkbenchCommand, selectedSessionDetailReady]);

  const sidebarCollapseControlLabel = sidebarLogicalCollapsed ? "Show sidebar" : "Hide sidebar";
  const sidebarCollapseControlButton = (
    <NodexTooltip
      delayOpen
      tooltipContent="Toggle sidebar"
      side="bottom"
      disabled={sidebarAnimating || sidebarClickInFlight}
    >
      <button
        type="button"
        onClick={() => {
          setSidebarClickInFlight(true);
          toggleSidebarCollapsed();
        }}
        onPointerLeave={() => setSidebarClickInFlight(false)}
        aria-label={sidebarCollapseControlLabel}
        className={SIDEBAR_COLLAPSED_CHROME_BUTTON_CLASS}
        style={{ viewTransitionName: "sidebar-trigger" }}
      >
        {sidebarLogicalCollapsed ? (
          <SidebarHiddenIcon className="icon-xs" />
        ) : (
          <SidebarVisibleIcon className="icon-xs" />
        )}
      </button>
    </NodexTooltip>
  );
  const backCommand = WORKBENCH_NAVIGATION_COMMANDS.back;
  const forwardCommand = WORKBENCH_NAVIGATION_COMMANDS.forward;
  const backShortcutLabel = resolveWorkbenchNavigationShortcutLabel("back", isMacPlatform);
  const forwardShortcutLabel = resolveWorkbenchNavigationShortcutLabel("forward", isMacPlatform);
  const windowNavigationChrome = (
    <div className="flex items-center gap-1.5" data-testid="workbench-window-navigation-chrome">
      <WindowNavigationToolbarButton
        label={backCommand.label}
        shortcutLabel={backShortcutLabel}
        disabled={!shellCanNavigateBack}
        onClick={() => void executeShellNavigation("back")}
      >
        <BackIcon className="icon-xs" />
      </WindowNavigationToolbarButton>
      <WindowNavigationToolbarButton
        label={forwardCommand.label}
        shortcutLabel={forwardShortcutLabel}
        disabled={!shellCanNavigateForward}
        onClick={() => void executeShellNavigation("forward")}
      >
        <BackIcon className="icon-xs -scale-x-100" />
      </WindowNavigationToolbarButton>
      {sidebarCollapseControlButton}
    </div>
  );

  const sidebarHeaderActions = (
    <>
      <HeaderAction
        actionId="workbench-window-navigation-chrome"
        slotPosition="left"
        align="start"
        order={100}
      >
        {windowNavigationChrome}
      </HeaderAction>
      {sidebarLogicalCollapsed ? (
        <HeaderAction
          actionId="workbench-sidebar-new-chat"
          slotPosition="left"
          align="start"
          order={110}
        >
          <SidebarCompactNewChatButton
            label="New chat"
            onClick={() => void startNewChatInProject(activeProjectId)}
          />
        </HeaderAction>
      ) : null}
    </>
  );

  const fullViewShortcutLabel = formatToggleFullViewShortcutLabel(commandKeymapState);
  // Split view offers moving the Chat to the content's side; the content then takes the Chat's.
  const titlebarThreadHeaderSlot = useMemo<ThreadStageHeaderSlot>(
    () => ({
      variant: "titlebar",
      paneMove:
        sessionWorkspace?.layout === "split"
          ? {
              side: sessionWorkspace.contentSide,
              onSelect: () => moveSessionConversationToSide(sessionWorkspace.contentSide),
            }
          : null,
    }),
    [moveSessionConversationToSide, sessionWorkspace],
  );
  // The Chat tab carries the chat's live status while content hides the conversation.
  const sessionChatStatus = useSessionRowStatus(
    sessionWorkspace?.fullViewSurface === "content" ? activeSession : null,
  );
  const sessionChatTab: AppShellLeadingTab | null =
    sessionWorkspace?.layout === "full" && activeSession
      ? {
          id: "session-chat",
          title: activeSession.displayTitle.trim() || "Chat",
          icon: <SessionChatTabIcon status={sessionChatStatus} />,
          statusLabel: sessionChatStatus
            ? SESSION_CHAT_TAB_STATUS_LABELS[sessionChatStatus]
            : undefined,
          selected: sessionConversationFillsFullView,
          actions: (
            <ThreadStageHeaderSlotContext.Provider value={CHAT_TAB_THREAD_HEADER_SLOT}>
              <SelectedAppShellHeaderContent />
            </ThreadStageHeaderSlotContext.Provider>
          ),
          contextMenuItems:
            sessionContentTabCount > 0
              ? [
                  {
                    id: "move-chat-left",
                    label: "Move to left pane",
                    iconKey: "moveLeft",
                    onSelect: () => moveSessionConversationToSide("left"),
                  },
                  {
                    id: "move-chat-right",
                    label: "Move to right pane",
                    iconKey: "moveRight",
                    onSelect: () => moveSessionConversationToSide("right"),
                  },
                ]
              : undefined,
          onSelect: presentSessionConversationInFullView,
          onDoubleClick: () => setSessionWorkspaceFullView(false),
        }
      : null;
  const panelHeaderActions = activePanelOwnerKey ? (
    <>
      <HeaderAction
        actionId="workbench-bottom-panel-toggle"
        slotPosition="right"
        align="end"
        order={200}
      >
        <ToolbarIconButton
          label="Toggle bottom panel"
          pressed={bottomPanelOpen}
          onClick={() =>
            executeWorkbenchCommand({
              commandId: TOGGLE_BOTTOM_PANEL_COMMAND_ID,
              source: "toolbar",
            })
          }
        >
          {bottomPanelOpen ? (
            <PanelBottomVisibleIcon className="icon-sm" />
          ) : (
            <PanelBottomHiddenIcon className="icon-sm" />
          )}
        </ToolbarIconButton>
      </HeaderAction>
      {!activeOwnedSceneOwner ? (
        <HeaderAction
          actionId="workbench-workspace-tabs"
          slotPosition="right"
          align="end"
          order={300}
        >
          <WorkspaceTabsControl
            mode={sessionWorkspace?.layout ?? "chat"}
            tabs={Object.values(panelGroupTabs.right.itemsByLeafId).flat()}
            activeTabId={
              rightPanel
                ? panelGroupTabs.right.activeTabIdsByLeafId[rightPanel.layout.activeLeafId]
                : null
            }
            onFullViewChange={setSessionWorkspaceFullView}
            fullViewToggleInGroup={
              sessionWorkspace?.contentSide !== "left" || sessionWorkspace.layout !== "split"
            }
            fullViewShortcutLabel={fullViewShortcutLabel}
            onToggle={() => {
              if (sessionWorkspace?.layout === "split") {
                void hideActiveRightPanel();
                return;
              }
              if (sessionWorkspace?.layout === "full") {
                setSessionWorkspaceFullView(false);
                return;
              }
              // With no tabs to show, `New tab` opens one beside the Chat.
              if (
                !sidePanelOpen &&
                Object.values(panelGroupTabs.right.itemsByLeafId).flat().length === 0 &&
                resolveActivePanelCapabilities("right").actions.browser.available
              ) {
                void dispatchPanelAction("browser", { panelId: "right" });
                return;
              }
              if (!rightPanel) return;
              void updateActiveWorkbenchPanel("right", {
                collapsed: false,
                size: { ...rightPanel.size, fullWidth: false },
              });
            }}
            onSelect={(tabId, mode) => {
              if (!activeSession) return;
              const owner = { kind: "session", sessionId: activeSession.id } as const;
              const scene =
                workbenchWindow.owner.read().windowState.scenesByOwnerKey[
                  makeWorkbenchSceneKey(owner)
                ];
              if (!scene) return;
              void executeSceneCommand(
                owner,
                { kind: "activate_tab", tabId },
                {
                  preparedScene: {
                    ...scene,
                    panels: {
                      ...scene.panels,
                      right: {
                        ...scene.panels.right,
                        collapsed: false,
                        size: { ...scene.panels.right.size, fullWidth: mode === "full" },
                      },
                    },
                  },
                },
              );
            }}
          />
        </HeaderAction>
      ) : null}
    </>
  ) : null;

  const headerActions = (
    <>
      {sidebarHeaderActions}
      {threadSummaryHeaderAction ? (
        // Full view hides the Chat's title row; its compact summary control joins the workspace
        // controls, whichever surface fills the view.
        <HeaderAction
          actionId="local-thread-summary-panel-toggle"
          slotPosition={rightPanelFullView ? "right" : "center"}
          align="end"
          order={rightPanelFullView ? 150 : 250}
        >
          <ThreadSummaryToggleDensityContext.Provider
            value={rightPanelFullView ? "compact" : "toolbar"}
          >
            {threadSummaryHeaderAction}
          </ThreadSummaryToggleDensityContext.Provider>
        </HeaderAction>
      ) : null}
      {panelHeaderActions}
    </>
  );

  // A content strip starting at the window's leading edge clears the collapsed sidebar's controls.
  const rightPanelHeaderStartInsetWidth =
    activePanelOwnerKey &&
    sidebarLogicalCollapsed &&
    (rightPanelFullView || sessionWorkspace?.contentSide === "left")
      ? Math.max(0, effectiveHeaderLeftWidth - WORKBENCH_NAVIGATION_RAIL_WIDTH_PX)
      : 0;
  const bottomPanelGlobalHeaderInsetWidth = activePanelOwnerKey ? 40 : 0;

  // A content pane on the right ends under the global controls; one on the left ends at the
  // Chat, carrying its own full-view toggle.
  const rightPanelHeaderAfterList = !activePanelOwnerKey ? null : sessionWorkspace?.contentSide ===
      "left" && sessionWorkspace.layout === "split" ? (
    <div className="flex h-full shrink-0 items-center ps-1.5">
      <WorkspaceFullViewToggle
        full={false}
        shortcutLabel={fullViewShortcutLabel}
        onFullViewChange={setSessionWorkspaceFullView}
      />
    </div>
  ) : (
    <div
      aria-hidden="true"
      data-testid="right-panel-tab-bar-header-spacer"
      className="pointer-events-none h-full shrink-0"
      style={{ width: `calc(${headerRightWidth}px)` }}
    />
  );

  const bottomPanelGlobalHeaderControls = activePanelOwnerKey ? (
    <div className="pointer-events-auto flex h-full shrink-0 items-center">
      <ToolbarIconButton label="Close" onClick={hideActiveBottomPanel}>
        <CloseIcon className="icon-xs" />
      </ToolbarIconButton>
    </div>
  ) : null;

  const showFloatingSidebar =
    sidebarLogicalCollapsed &&
    !realSidebarMounted &&
    (peekArea !== null || floatingSidebarResizing);
  const showInlineSidebar = realSidebarMounted;
  const applicationMenuBarEnabled =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-codex-window-chrome") === "application-menu";
  const floatingSidebarOuterClassName =
    getCodexSidebarFloatingOuterClassName(applicationMenuBarEnabled);
  const openResourceTargetInProject = useCallback(
    async (projectId: string, target: ActionableLibraryResourceTarget, title: string) => {
      selectProject(projectId);
      if (target.kind === "page") {
        await openProjectScenePage(projectId, target.pageId, title);
        return;
      }
      const window = await readDatabaseViewWindow(projectId, {
        databaseId: target.databaseId,
        first: 1,
      });
      const opened = await presentExistingDatabaseView(projectId, window.query.view.viewId);
      if (!opened) toast.danger("Database View is unavailable in this Project");
    },
    [openProjectScenePage, presentExistingDatabaseView, selectProject],
  );
  const openContentIssueLocation = async (
    scope: ContentRoutingIdentity,
    location: ContentEditLocation,
  ) => {
    if (scope.libraryId !== currentLibraryId) return;
    const { target, label } = location;
    try {
      if (scope.routingContext.kind === "library") {
        await presentLibraryTarget(target, { titleSnapshot: label });
        return;
      }
      const projectId = scope.routingContext.projectId;
      if (!projects.some((project) => project.id === projectId)) {
        toast.danger("This Project is no longer available.");
        return;
      }
      selectProject(projectId);
      if (target.kind === "page") await openProjectScenePage(projectId, target.pageId, label);
      else if (target.kind === "canvas")
        await openProjectSceneCanvas(projectId, target.canvasId, label);
      else if (target.kind === "view") {
        if (!(await presentExistingDatabaseView(projectId, target.viewId)))
          toast.danger("This View is no longer available.");
      } else await openResourceTargetInProject(projectId, target, label);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "The content could not be opened.");
    }
  };
  const handOffCancelledPendingWorktree = useCallback(
    async (entry: CodexPendingWorktreeEntry) => {
      const targetProjectId = resolveCancelledPendingWorktreeProjectId(
        entry,
        new Set(projects.map((project) => project.id)),
      );
      const session = await ensureDefaultDraftSessionForProject(targetProjectId);
      setSettingsPath(null);
      setAutomationsPath(null);
      setNewThreadComposerIntentsBySessionId((current) => ({
        ...current,
        [session.id]: buildCancelledPendingWorktreeComposerIntent(entry, Date.now()),
      }));
    },
    [ensureDefaultDraftSessionForProject, projects, setAutomationsPath, setSettingsPath],
  );
  const {
    automationsRouteShell,
    pluginsRouteShell,
    pendingWorktreeRouteShell,
    settingsRouteShell,
  } = useWorkbenchRouteSurfaces({
    settings: {
      path: settingsPath,
      props: {
        onPathChange: setSettingsPath,
        onBackToApp: closeSettings,
        onRequestProjectPickerOpen,
        onOpenThread: openSettingsThreadSessionById,
        onOpenCustomize: openPlugins,
        onStartChat: (prompt: string) =>
          void startNewChatWithPrompt({ projectId: activeProjectId, prompt }),
        projects,
        activeProjectId: activeProject?.id ?? activeProjectId,
        initialLocalEnvironmentProjectId: localEnvironmentSettingsInitial?.projectId ?? null,
        initialLocalEnvironmentConfigPath: localEnvironmentSettingsInitial?.configPath ?? null,
        threadQueueFollowUpsEnabled,
        onThreadQueueFollowUpsEnabledChange: handleThreadQueueFollowUpsEnabledChange,
        composerEnterBehavior,
        onComposerEnterBehaviorChange: handleComposerEnterBehaviorChange,
        worktreeStartMode,
        onWorktreeStartModeChange: handleWorktreeStartModeChange,
        worktreeAutoBranchPrefix,
        onWorktreeAutoBranchPrefixChange: handleWorktreeAutoBranchPrefixChange,
        taskShorthandPagePromotionEnabled,
        onTaskShorthandPagePromotionEnabledChange: handleTaskShorthandPagePromotionEnabledChange,
      },
    },
    automations: {
      path: scheduledRunPresented ? null : automationsPath,
      props: {
        tasks: scheduledTasks,
        projects,
        chats: scheduledChatOptions,
        onNavigate: navigateScheduled,
        onOpenHeartbeatChat: openScheduledTaskChat,
        onReplyAboutTask: replyAboutScheduledTaskInPlace,
        onOpenLocalEnvironmentsSettings: openLocalEnvironmentsSettings,
      },
    },
    plugins: {
      path: pluginsPath,
      props: { navigation: customizeNavigation },
    },
    pendingWorktree: {
      clientThreadId: pendingWorktreeClientThreadId,
      props: {
        expectedHostId:
          workbenchWindow.location.kind === "pending-worktree"
            ? workbenchWindow.location.expectedHostId
            : undefined,
        externalHeader: true,
        onClose: closePendingWorktreeRoute,
        onOpenThread: async (threadId) => {
          if (!pendingWorktreeClientThreadId) return;
          return await openResolvedPendingThreadSession(
            pendingWorktreeClientThreadId,
            threadId,
            workbenchWindow.location.kind === "pending-worktree"
              ? workbenchWindow.location.expectedHostId
              : undefined,
          );
        },
        onOpenPendingWorktree: setPendingWorktreeClientThreadId,
        onCancelToSource: handOffCancelledPendingWorktree,
        onEditEnvironment: (entry) => {
          void openLocalEnvironmentsSettings({
            projectId:
              entry.launchMode === "start-conversation"
                ? (entry.startConversationParamsInput.projectAssignment?.projectId ?? null)
                : entry.launchMode === "fork-conversation"
                  ? (entry.projectAssignment?.projectId ?? null)
                  : null,
            configPath: entry.localEnvironmentConfigPath ?? null,
            reopenPendingWorktreeClientThreadId: pendingWorktreeClientThreadId,
          });
        },
      },
    },
  });
  // Scheduled and Customize are page routes over the Scene; they own the title row.
  const destinationRouteShell = automationsRouteShell ?? pluginsRouteShell;
  // A full-width Scene panel covers the title row only while its Scene is showing,
  // never under a route such as Automations opened over it.
  const appShellHeaderCoveredByScene = rightPanelFullView && destinationRouteShell == null;
  const appShellHeaderCenterVisible =
    settingsRouteShell == null &&
    (activePanelOwnerKey != null ||
      destinationRouteShell != null ||
      pendingWorktreeRouteShell != null);
  const appShellHeaderActions = settingsPath
    ? null
    : pendingWorktreeRouteShell
      ? null
      : destinationRouteShell || librarySceneOwner
        ? sidebarHeaderActions
        : headerActions;

  const commandPalette = (
    <WorkbenchCommandPaletteHost
      open={commandPaletteOpen}
      openRequest={commandPaletteOpenRequest}
      projects={projects}
      activeProjectId={activeProject?.id ?? activeProjectId}
      openProjectFolder={() =>
        openCommandPaletteFolder({
          createProject: onCreateProject,
          startChat: async (projectId) => {
            closePendingWorktreeRoute();
            setAutomationsPath(null);
            setSettingsPath(null);
            await sessionCommands.startNewChatInProject(projectId, { focusComposer: true });
          },
        })
      }
      activeSession={activeSession}
      recentPageSessions={recentPageSessions}
      canNavigateBack={shellCanNavigateBack}
      canNavigateForward={shellCanNavigateForward}
      canOpenSessionInNewWindow={Boolean(onOpenProjectSessionInNewWindow)}
      commandKeymapState={commandKeymapState}
      sessionCommands={sessionCommands}
      panelCommands={panelCommands}
      panelOpeners={panelOpeners}
      sidebarCommands={sidebarController}
      setOpen={setCommandPaletteOpen}
      executeNavigation={executeShellNavigation}
      executeWorkbenchCommand={executeWorkbenchCommand}
      toggleSidebar={toggleSidebarCollapsed}
      toggleSidePanel={toggleActiveSidePanel}
      openInbox={captureInbox}
      openAutomations={openAutomations}
      openLibraryFiles={() => {
        const projectId = activeProject?.id ?? activeProjectId;
        openModal(appHandle, LibraryFilesDialog, {
          routingContext: projectId ? projectContentRoute(projectId) : libraryContentRoute,
        });
      }}
      openProcessManager={() => setProcessManagerOpen(true)}
      openSettings={openSettings}
      openSettingsSection={openSettingsAt}
      openKeyboardShortcuts={openKeyboardShortcutHelp}
      onOpenSessionInNewWindow={onOpenProjectSessionInNewWindow}
    />
  );

  const activeSessionProject = activeRenderSession?.projectId
    ? (projects.find((project) => project.id === activeRenderSession.projectId) ?? activeProject)
    : null;
  const renderOwnedSceneFileSurface = useCallback(
    (
      surface: Extract<WorkbenchSurfaceDescriptor, { kind: "files" }>,
      context: { readonly active: boolean; readonly panelId: PanelId },
    ) => {
      if (!activeOwnedScene || !activeOwnedSceneOwner || !activeOwnedSceneKey) return null;
      const owner = activeOwnedSceneOwner;
      const sceneKey = activeOwnedSceneKey;
      const preview = listWorkbenchScenePreviewEntries(
        activeOwnedScene,
        previewSurfacesByPanel,
      ).some((entry) => entry.surface.id === surface.id);
      const tab = {
        id: surface.id,
        sessionId: sceneKey,
        projectId: surface.config.projectId,
        panelId: context.panelId,
        kind: "files" as const,
        title: surface.titleSnapshot,
        order: 0,
        config: surface.config,
        browserTabId: null,
        stateKey: surface.stateKey,
        state: surface.state,
        createdAt: activeOwnedScene.touchedAt,
        updatedAt: activeOwnedScene.touchedAt,
        ...(preview ? { preview: true as const } : {}),
      } as WorkspaceFilesTab;
      return (
        <WorkspaceFilesPanel
          key={`${sceneKey}:${surface.id}:${surface.stateKey}`}
          tab={tab}
          presentationOwnerId={sceneKey}
          project={projects.find((project) => project.id === surface.config.projectId) ?? null}
          onOpenFileTab={openWorkspaceFileTab}
          onSearchInFiles={() => openCommandPalette({ mode: "text" })}
          onUpdateTabState={(state) => {
            const scene = workbenchWindowRef.current.scenesByOwnerKey[sceneKey];
            const entry = scene
              ? listWorkbenchScenePreviewEntries(scene, previewSurfacesByPanelRef.current).find(
                  (entry) => entry.surface.id === surface.id,
                )
              : undefined;
            if (!entry) {
              updateSceneSurfacePresentation(owner, surface.id, { state });
              return;
            }
            const slotKey = makeWorkbenchScenePreviewSlotKey(owner, entry.panelId, entry.leafId);
            const next = {
              ...previewSurfacesByPanelRef.current,
              [slotKey]: { ...entry.surface, state },
            };
            previewSurfacesByPanelRef.current = next;
            panelControllerRef.current.updatePreviewSurfacesByPanel(next);
          }}
        />
      );
    },
    [
      activeOwnedScene,
      activeOwnedSceneOwner,
      activeOwnedSceneKey,
      projects,
      previewSurfacesByPanel,
      openCommandPalette,
      openWorkspaceFileTab,
      updateSceneSurfacePresentation,
    ],
  );
  const renderProjectSceneSurface = useCallback(
    (
      surface: WorkbenchSurfaceDescriptor,
      context: { readonly active: boolean; readonly panelId: PanelId },
    ) => {
      if (!activeProjectScene || !activeProject || !projectSceneKey) return null;
      const previewEntry =
        listWorkbenchScenePreviewEntries(activeProjectScene, previewSurfacesByPanel).find(
          (entry) => entry.surface.id === surface.id,
        ) ?? null;
      const leafId =
        findWorkbenchPanelLeafForTab(activeProjectScene.panels[context.panelId].layout, surface.id)
          ?.id ?? activeProjectScene.panels[context.panelId].layout.activeLeafId;
      const common = {
        id: surface.id,
        sessionId: projectSceneKey,
        projectId: activeProject.id,
        panelId: context.panelId,
        title: surface.titleSnapshot,
        order: 0,
        stateKey: surface.stateKey,
        state: surface.state,
        createdAt: activeProjectScene.touchedAt,
        updatedAt: activeProjectScene.touchedAt,
        browserTabId: null,
        ...(previewEntry ? { preview: true as const } : {}),
      };
      const closeSurface = () => {
        void executeSceneCommand(activeProjectScene.owner, {
          kind: "close_tab",
          tabId: surface.id,
        });
      };

      if (surface.kind === "inbox") {
        const projectId = inboxScopeProjectId(surface.config.scope);
        if (!projectId) return null;
        const homeProject = projects.find((project) => project.id === projectId);
        return (
          <InboxRoute
            windowSessionId={windowSessionId}
            scope={surface.config.scope}
            visible={context.active}
            projects={projects}
            focusComposerToken={inboxFocusToken}
            onOpenSession={sessionCommands.openProjectSessionById}
            onShowPagesInChat={sessionCommands.showPagesInChat}
            onOpenScheduledTask={(automationId) =>
              navigateScheduled(buildAutomationsPath({ automationId }))
            }
            onOpenPage={(pageId) => {
              const peek = inboxPagePeek(surface.id);
              void openProjectScenePage(projectId, pageId, "Page", {
                placement: peek.placement,
                openMode: peek.mode,
              });
            }}
            onOpenDatabase={(databaseId) => {
              // The Board button opens this Project's default View beside its Home.
              if (databaseId === homeProject?.databaseId) {
                void presentProjectSceneSurface(
                  projectId,
                  {
                    kind: "db_view",
                    config: {
                      routingContext: { kind: "project", projectId },
                      target: { kind: "project-default" },
                    },
                  },
                  { panelId: context.panelId },
                );
                return;
              }
              void openResourceTarget({
                kind: "database",
                databaseId: parseDatabaseId(databaseId),
              });
            }}
            onOpenSettings={() => openSettingsAt("inbox-settings")}
          />
        );
      }

      if (
        (surface.kind === "db_view" ||
          surface.kind === "page_stage" ||
          surface.kind === "canvas_stage") &&
        surface.config.routingContext.kind === "library"
      ) {
        return (
          <WorkbenchLibraryResourceSurface
            surface={surface}
            owner={workbenchWindow.owner}
            sceneOwner={activeProjectScene.owner}
            windowSessionId={windowSessionId}
            active={context.active}
            presentedPageIds={projectScenePresentedPageIds}
            onClose={closeSurface}
            onTitleChange={(titleSnapshot) => {
              updateSceneSurfacePresentation(activeProjectScene.owner, surface.id, {
                titleSnapshot,
              });
            }}
            onOpenTarget={(target, options) => {
              void presentLibraryTarget(target, {
                ...options,
                owner: activeProjectScene.owner,
                targetPanelId: context.panelId,
                placement: { kind: "same-group", sourceSurfaceId: surface.id },
              });
            }}
          />
        );
      }

      if (surface.kind === "db_view") {
        if (surface.config.routingContext.kind !== "project") return null;
        const routingContext = surface.config.routingContext;
        if (surface.config.target.kind === "database-default")
          return (
            <WorkbenchDatabaseViewSurface
              isActivePanelTab={context.active}
              workbenchPresentation={{
                owner: workbenchWindow.owner,
                sceneOwner: activeProjectScene.owner,
                surface,
              }}
              routingContext={routingContext}
              target={surface.config.target}
              presentedPageIds={projectScenePresentedPageIds}
              onOpenPage={(pageId, titleSnapshot, openMode) => {
                void openProjectScenePage(routingContext.projectId, pageId, titleSnapshot, {
                  openMode,
                  placement: { kind: "same-group", sourceSurfaceId: surface.id },
                });
              }}
            />
          );
        const databaseViewId =
          surface.config.target.kind === "project-default"
            ? projects.find((project) => project.id === routingContext.projectId)
                ?.defaultDatabaseViewId
            : surface.config.target.kind === "database-view"
              ? surface.config.target.databaseViewId
              : null;
        if (!databaseViewId) {
          return (
            <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
              Database View is unavailable
            </div>
          );
        }
        const tab: WorkbenchTabProjection = {
          ...common,
          kind: "db_view",
          config: {
            routingContext,
            target: { kind: "database-view", databaseViewId },
          },
        };
        return (
          <DbViewSessionTab
            isActivePanelTab={context.active}
            workbenchPresentation={{
              owner: workbenchWindow.owner,
              sceneOwner: activeProjectScene.owner,
              surface,
            }}
            sessionId={`${windowSessionId}:${projectSceneKey}:${surface.id}`}
            tab={tab}
            projects={projects}
            activeSearchQuery={activeSearchQuery}
            searchByProject={searchByProject}
            presentedPageIds={projectScenePresentedPageIds}
            taskSearchOpenTick={taskSearchOpenTick}
            setSearchQuery={setSearchQuery}
            onOpenPageTab={openProjectScenePage}
            onOpenPageInNewChat={sessionCommands.openPageInNewChat}
            onOpenRelatedChat={sessionCommands.openProjectSessionById}
            onSendPageToChat={sessionCommands.sendPageToChat}
            onOpenCanvasStage={openProjectSceneCanvas}
            onSelectDatabaseView={(nextViewId, title) => {
              if (!projectSceneOwner) return;
              updateSceneSurfacePresentation(projectSceneOwner, surface.id, {
                titleSnapshot: title,
                config: {
                  ...surface.config,
                  target: { kind: "database-view", databaseViewId: nextViewId },
                },
              });
            }}
            targetLeafId={leafId}
            pageStageCloseRef={pageStageCloseRef}
          />
        );
      }

      if (surface.kind === "canvas_stage") {
        if (surface.config.routingContext.kind !== "project") return null;
        const projectId = surface.config.routingContext.projectId;
        return (
          <WorkbenchCanvasStagePanel
            surface={surface}
            windowSessionId={windowSessionId}
            presentationOwnerId={projectSceneKey}
            isActivePanelTab={context.active}
            onClose={closeSurface}
            onTitleChange={(title) => {
              if (!projectSceneOwner) return;
              updateSceneSurfacePresentation(projectSceneOwner, surface.id, {
                titleSnapshot: title,
              });
            }}
            onOpenPage={({ pageId, titleSnapshot }) => {
              void openProjectScenePage(projectId, pageId, titleSnapshot, {
                openMode: "durable",
                placement: { kind: "same-group", sourceSurfaceId: surface.id },
              });
            }}
          />
        );
      }

      if (surface.kind === "page_stage") {
        if (surface.config.routingContext.kind !== "project") return null;
        const pageAccessProjectId = surface.config.routingContext.projectId;
        const tab: WorkbenchTabProjection = {
          ...common,
          kind: "page_stage",
          config: surface.config,
        };
        return (
          <PageStageSessionTab
            tab={tab}
            project={projects.find((item) => item.id === pageAccessProjectId) ?? null}
            closeRef={pageStageCloseRef}
            persistRef={pageStagePersistRef}
            sessionSnapshotRef={pageStageSessionSnapshotRef}
            sessionId={projectSceneKey}
            sessionThread={null}
            canStartThreadInSession={false}
            onLeavePage={onLeavePageStage}
            onClose={closeSurface}
            onOpenTerminal={async () => {
              await openProjectSceneManualSurface(activeProject.id, "terminal", {
                panelId: "bottom",
                targetLeafId: activeProjectScene.panels.bottom.layout.activeLeafId,
              });
            }}
            onEnsureDefaultDraftSessionForProject={ensureDefaultDraftSessionForProject}
            onRefreshSessions={refreshProjectSessions}
            onOpenPageTab={openProjectScenePage}
            onOpenCanvasStage={openProjectSceneCanvas}
            onOpenThread={async (threadId) => {
              await openAttachedThreadSessionById(threadId);
            }}
            onOpenRelatedChat={sessionCommands.openProjectSessionById}
            onOpenPageInNewChat={sessionCommands.openPageInNewChat}
            onLinkPageToChat={sessionCommands.linkPageToChat}
            relatedChatCandidates={pageStageRelatedChatCandidates}
            onResolveChatSessionForThread={sessionCommands.resolveChatSessionForThread}
            historyPanelActive={Boolean(
              pageStageHistoryModal &&
              pageStageHistoryModal.sessionId === projectSceneKey &&
              pageStageHistoryModal.tabId === surface.id,
            )}
            onToggleHistoryPanel={togglePageStageHistoryModal}
            isActivePanelTab={context.active}
          />
        );
      }

      if (surface.kind === "files") return renderOwnedSceneFileSurface(surface, context);

      if (surface.kind === "browser") {
        const tab: WorkbenchTabProjection = {
          ...common,
          kind: "browser",
          browserTabId: surface.config.browserTabId,
          config: {
            projectId: activeProject.id,
            ...surface.config,
          },
        };
        return (
          <WorkbenchBrowserSidebarPanel
            owner={{ kind: "project", projectId: activeProject.id }}
            surfaceId={surface.id}
            panelId={context.panelId}
            tab={tab}
            surfaceContext={{
              browserConversationId: projectSceneKey,
              codexSessionId: null,
            }}
            browserViewScopeId={windowSessionId}
            onRefreshSessions={refreshProjectSessions}
            onUpdateTab={(_surfaceId, patch) => {
              const patchConfig = patch.config;
              const nextConfig = {
                ...surface.config,
                ...(patchConfig && "url" in patchConfig ? { url: patchConfig.url } : {}),
                ...(patchConfig && "title" in patchConfig ? { title: patchConfig.title } : {}),
                ...(patchConfig && "faviconUrl" in patchConfig
                  ? { faviconUrl: patchConfig.faviconUrl }
                  : {}),
                ...(patchConfig && "deviceToolbarVisible" in patchConfig
                  ? { deviceToolbarVisible: patchConfig.deviceToolbarVisible }
                  : {}),
                ...(patchConfig && "deviceToolbarState" in patchConfig
                  ? { deviceToolbarState: patchConfig.deviceToolbarState }
                  : {}),
              };
              if (projectSceneOwner) {
                panelControllerRef.current.sceneDurable?.updateSurface(
                  projectSceneOwner,
                  surface.id,
                  {
                    ...(patch.title === undefined ? {} : { titleSnapshot: patch.title }),
                    ...(!("state" in patch) ? {} : { state: patch.state }),
                    config: nextConfig,
                  },
                );
              }
              return {
                ...tab,
                ...(patch.title === undefined ? {} : { title: patch.title }),
                config: {
                  projectId: activeProject.id,
                  ...nextConfig,
                },
              };
            }}
            onOpenNewTab={(request) => {
              void openProjectSceneManualSurface(activeProject.id, "browser", {
                panelId: context.panelId,
                targetLeafId: leafId,
                url: request.url,
              });
            }}
            boundsSyncTrigger={
              context.panelId === "right"
                ? rightPanelMotion.animatedSize
                : bottomPanelMotion.animatedSize
            }
            onOpenBrowserSettings={openBrowserSettings}
            activeForContentSearch={context.active}
            isVisible={context.active}
          />
        );
      }

      if (surface.kind === "terminal") {
        const contextProjectId =
          surface.config.context?.kind === "project"
            ? surface.config.context.projectId
            : activeProject.id;
        const terminalProject =
          projects.find((item) => item.id === contextProjectId) ?? activeProject;
        const cwd = projectWorkspaceRootOrNull(terminalProject);
        if (!cwd) {
          return (
            <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
              Terminal workspace is unavailable
            </div>
          );
        }
        return (
          <TerminalPanel
            terminalId={surface.config.terminalSessionId}
            cwd={cwd}
            conversationId={null}
            projectSessionId={null}
            onNewTerminalTab={() => {
              void openProjectSceneManualSurface(activeProject.id, "terminal", {
                panelId: context.panelId,
                targetLeafId: leafId,
              });
            }}
          />
        );
      }

      return null;
    },
    [
      renderOwnedSceneFileSurface,
      executeSceneCommand,
      activeProject,
      activeProjectScene,
      activeSearchQuery,
      bottomPanelMotion.animatedSize,
      ensureDefaultDraftSessionForProject,
      inboxFocusToken,
      navigateScheduled,
      onLeavePageStage,
      openAttachedThreadSessionById,
      openResourceTarget,
      openSettingsAt,
      presentProjectSceneSurface,
      openBrowserSettings,
      openProjectSceneCanvas,
      openProjectSceneManualSurface,
      openProjectScenePage,
      presentLibraryTarget,
      sessionCommands.openPageInNewChat,
      sessionCommands.openProjectSessionById,
      sessionCommands.showPagesInChat,
      sessionCommands.linkPageToChat,
      sessionCommands.resolveChatSessionForThread,
      sessionCommands.sendPageToChat,
      pageStageCloseRef,
      pageStageHistoryModal,
      pageStageRelatedChatCandidates,
      pageStagePersistRef,
      pageStageSessionSnapshotRef,
      projectSceneKey,
      projectScenePresentedPageIds,
      projectSceneOwner,
      projects,
      previewSurfacesByPanel,
      refreshProjectSessions,
      searchByProject,
      setSearchQuery,
      taskSearchOpenTick,
      togglePageStageHistoryModal,
      rightPanelMotion.animatedSize,
      updateSceneSurfacePresentation,
      workbenchWindow.owner,
      windowSessionId,
    ],
  );
  const renderLibrarySceneSurface = useCallback(
    (
      surface: WorkbenchSurfaceDescriptor,
      context: { readonly active: boolean; readonly panelId: PanelId },
    ) => {
      if (!activeLibraryScene || !librarySceneOwner || !librarySceneKey) {
        return null;
      }
      const removeSurface = () => {
        void executeSceneCommand(librarySceneOwner, { kind: "close_tab", tabId: surface.id });
      };
      const publishTitle = (title: string) => {
        if (surface.titleSnapshot === title) return;
        updateSceneSurfacePresentation(librarySceneOwner, surface.id, { titleSnapshot: title });
      };
      // Content opened from this Scene stays in it, in the source surface's tab group; an Inbox
      // opens a message's Page beside itself instead.
      const openInSourceGroup = (target: LibraryRouteTarget, titleSnapshot?: string) => {
        void presentLibraryTarget(target, {
          owner: librarySceneOwner,
          titleSnapshot,
          targetPanelId: context.panelId,
          placement: { kind: "same-group", sourceSurfaceId: surface.id },
        });
      };

      if (surface.kind === "files") return renderOwnedSceneFileSurface(surface, context);

      if (surface.kind === "inbox") {
        return (
          <InboxRoute
            windowSessionId={windowSessionId}
            scope={surface.config.scope}
            visible={context.active}
            projects={projects}
            focusComposerToken={inboxFocusToken}
            onOpenSession={sessionCommands.openProjectSessionById}
            onShowPagesInChat={sessionCommands.showPagesInChat}
            onOpenScheduledTask={(automationId) =>
              navigateScheduled(buildAutomationsPath({ automationId }))
            }
            onOpenPage={(pageId) =>
              void presentLibraryTarget(
                { kind: "page", pageId },
                {
                  owner: librarySceneOwner,
                  targetPanelId: context.panelId,
                  ...inboxPagePeek(surface.id),
                },
              )
            }
            onOpenDatabase={(databaseId) =>
              openInSourceGroup({ kind: "database", databaseId: parseDatabaseId(databaseId) })
            }
            onOpenSettings={() => openSettingsAt("inbox-settings")}
          />
        );
      }

      if (surface.kind === "db_view") {
        if (surface.config.target.kind === "project-default") {
          return (
            <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
              Database View is unavailable
            </div>
          );
        }
        return (
          <WorkbenchDatabaseViewSurface
            isActivePanelTab={context.active}
            workbenchPresentation={{
              owner: workbenchWindow.owner,
              sceneOwner: librarySceneOwner,
              surface,
            }}
            routingContext={surface.config.routingContext}
            target={surface.config.target}
            keyboardSurface={{
              surfaceId: surface.id,
              presentationId: surface.id,
            }}
            presentedPageIds={libraryScenePresentedPageIds}
            projects={projects}
            pageStageCloseRef={pageStageCloseRef}
            onOpenPageInNewChat={sessionCommands.openPageInNewChat}
            onOpenRelatedChat={sessionCommands.openProjectSessionById}
            onSendPageToChat={sessionCommands.sendPageToChat}
            onPresentationChange={({ databaseName, viewName }) => {
              publishTitle(
                surface.config.target.kind === "database-default" ? databaseName : viewName,
              );
            }}
            onOpenPage={(pageId, titleSnapshot, openMode) => {
              void presentLibraryTarget(
                { kind: "page", pageId },
                {
                  owner: librarySceneOwner,
                  titleSnapshot,
                  placement: { kind: "adjacent-right", sourceSurfaceId: surface.id },
                  mode: openMode,
                },
              );
            }}
          />
        );
      }

      if (surface.kind === "page_stage") {
        return (
          <WorkbenchLibraryPageSurface
            pageId={surface.config.pageId}
            surfaceId={surface.id}
            isActivePanelTab={context.active}
            onClose={removeSurface}
            onOpenDatabase={(databaseId) => openInSourceGroup({ kind: "database", databaseId })}
            onOpenPage={(pageId, titleSnapshot) =>
              openInSourceGroup({ kind: "page", pageId }, titleSnapshot)
            }
            onOpenCanvas={(canvasId, titleSnapshot) =>
              openInSourceGroup({ kind: "canvas", canvasId }, titleSnapshot)
            }
          />
        );
      }

      if (surface.kind === "canvas_stage") {
        return (
          <WorkbenchCanvasStagePanel
            surface={surface}
            windowSessionId={windowSessionId}
            presentationOwnerId={librarySceneKey}
            isActivePanelTab={context.active}
            onClose={removeSurface}
            onTitleChange={publishTitle}
            onOpenPage={({ pageId, titleSnapshot }) =>
              openInSourceGroup({ kind: "page", pageId }, titleSnapshot)
            }
          />
        );
      }

      return (
        <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
          This surface requires a Project or chat.
        </div>
      );
    },
    [
      renderOwnedSceneFileSurface,
      executeSceneCommand,
      activeLibraryScene,
      inboxFocusToken,
      navigateScheduled,
      openSettingsAt,
      presentLibraryTarget,
      librarySceneKey,
      libraryScenePresentedPageIds,
      librarySceneOwner,
      pageStageCloseRef,
      projects,
      sessionCommands.openPageInNewChat,
      sessionCommands.openProjectSessionById,
      sessionCommands.showPagesInChat,
      sessionCommands.sendPageToChat,
      updateSceneSurfacePresentation,
      workbenchWindow.owner,
      windowSessionId,
    ],
  );
  const closeActiveOwnedScenePanelTab = useCallback(
    async (tabId: string): Promise<void> => {
      if (!activeOwnedSceneOwner) return;
      await executeSceneCommand(activeOwnedSceneOwner, { kind: "close_tab", tabId });
    },
    [activeOwnedSceneOwner, executeSceneCommand],
  );
  const projectScenePanels =
    projectScenePresentation && activeProject && panelController.sceneDurable
      ? buildWorkbenchScenePanels({
          scene: projectScenePresentation.scene,
          project: activeProject,
          projects,
          currentLibraryId,
          browserViewScopeId: windowSessionId,
          browserTabSnapshotByKey,
          pageTitleStore,
          commands: panelController.sceneDurable,
          executeCommand: executeSceneCommand,
          previewSurfaceIds: projectScenePresentation.previewSurfaceIds,
          isMac: isMacPlatform,
          commandKeymapState,
          availableActions: filterAvailablePanelActions(
            PANEL_NEW_TAB_ACTIONS,
            [
              ...(projectScenePresentation.scene.primary
                ? [projectScenePresentation.scene.primary]
                : []),
              ...Object.values(projectScenePresentation.scene.panelSurfacesById),
            ],
            "right",
            {
              kind: "project",
              projectId: activeProject.id,
              projectWorkspaceRoot: projectWorkspaceRootOrNull(activeProject),
            },
          ),
          currentProjectDbViewExists: Object.values(
            projectScenePresentation.scene.panelSurfacesById,
          ).some((surface) => surface.kind === "db_view"),
          rightPanelHeaderAfterList,
          rightPanelHeaderStartInsetWidth,
          bottomPanelGlobalHeaderInsetWidth,
          renderSurface: renderProjectSceneSurface,
          onFocusGroup: (panelId, leafId) => {
            panelCommands.rememberFocusedPanelGroup(panelId, leafId);
          },
          onPinPreview: (panelId, leafId, surfaceId) => {
            sceneNavigator.pinPreview({
              owner: projectScenePresentation.scene.owner,
              panelId,
              leafId,
              surfaceId,
            });
          },
          onOpenAction: (panelId, leafId, action) => {
            void openProjectScenePanelAction(activeProject.id, action, { panelId, leafId });
          },
          onOpenDestination: async (panelId, leafId, destination) => {
            await openProjectSceneDestination(activeProject.id, destination, { panelId, leafId });
          },
        })
      : null;
  const libraryScenePanels =
    libraryScenePresentation && panelController.sceneDurable
      ? buildWorkbenchScenePanels({
          scene: libraryScenePresentation.scene,
          project: null,
          projects,
          currentLibraryId,
          browserViewScopeId: windowSessionId,
          browserTabSnapshotByKey,
          pageTitleStore,
          commands: panelController.sceneDurable,
          executeCommand: executeSceneCommand,
          previewSurfaceIds: libraryScenePresentation.previewSurfaceIds,
          isMac: isMacPlatform,
          commandKeymapState,
          availableActions: [],
          currentProjectDbViewExists: false,
          rightPanelHeaderAfterList,
          rightPanelHeaderStartInsetWidth,
          bottomPanelGlobalHeaderInsetWidth,
          renderSurface: renderLibrarySceneSurface,
          renderNewTab: (panelId, leafId) => (
            <PagesTabPicker
              onOpenTarget={(target, titleSnapshot) => {
                void presentLibraryTarget(target, {
                  owner: libraryScenePresentation.scene.owner,
                  titleSnapshot,
                  targetPanelId: panelId,
                  targetLeafId: leafId,
                });
              }}
            />
          ),
          renderEmptyLeaf: (panelId, leafId) => (
            <SpaceHome
              onOpenTarget={(target, titleSnapshot) => {
                void presentLibraryTarget(target, {
                  owner: libraryScenePresentation.scene.owner,
                  titleSnapshot,
                  targetPanelId: panelId,
                  targetLeafId: leafId,
                });
              }}
            />
          ),
          onFocusGroup: (panelId, leafId) => {
            panelCommands.rememberFocusedPanelGroup(panelId, leafId);
          },
          onPinPreview: (panelId, leafId, surfaceId) => {
            sceneNavigator.pinPreview({
              owner: libraryScenePresentation.scene.owner,
              panelId,
              leafId,
              surfaceId,
            });
          },
          onOpenAction: () => undefined,
          onOpenDestination: async () => undefined,
        })
      : null;
  const activePanelTabShortcutState: WorkbenchPanelTabShortcutState | null = activePanelOwnerKey
    ? activeOwnedScenePresentation && activeOwnedSceneOwner
      ? {
          ownerKey: activePanelOwnerKey,
          projection: buildWorkbenchScenePanelTabShortcutProjection(
            activeOwnedScenePresentation.scene,
          ),
          selectTab: ({ panelId, tabId, leafId }) => {
            if (activeOwnedScenePresentation.previewSurfaceIds.has(tabId)) {
              return;
            }
            sceneNavigator.clearPreview({
              owner: activeOwnedSceneOwner,
              panelId,
              leafId,
            });
            panelControllerRef.current.sceneDurable?.activateSurface(
              activeOwnedSceneOwner,
              panelId,
              leafId,
              tabId,
            );
          },
          closeTab: ({ tabId }) => {
            void closeActiveOwnedScenePanelTab(tabId);
          },
        }
      : activeSession
        ? {
            ownerKey: activePanelOwnerKey,
            projection: projectWorkbenchPanelTabShortcutProjection(panelGroupTabs, {
              rightContentConcealed: sessionConversationFillsFullView,
            }),
            selectTab: ({ panelId, tabId, leafId }) => selectPanelTab(panelId, tabId, leafId),
            closeTab: ({ panelId, tabId, leafId }) => closePanelTab(panelId, tabId, leafId),
          }
        : null
    : null;
  panelTabShortcutStateRef.current = activePanelTabShortcutState;
  const projectAgentDockLeadingContent =
    projectAgentDockModel && selectedProjectSceneId ? (
      <ProjectAgentDockLeadingRow
        model={projectAgentDockModel}
        query={projectAgentDockQuery}
        onQueryChange={setProjectAgentDockQuery}
        onSelect={selectProjectAgentDockTarget}
        onLoadMore={() => {
          void loadMoreProjectSessionSummaries(selectedProjectSceneId);
        }}
        onRetry={() => {
          void sessionCatalog.retryCollection(selectedProjectSceneId);
          if (projectAgentDockBoundSessionId) {
            void projectAgentDockSessionQuery.refetch();
          }
        }}
        onOpenChat={() => {
          const sessionId = projectAgentDockModel.trigger.sessionId;
          if (!sessionId) return;
          workbenchWindow.selectSession({
            id: sessionId,
            projectId: selectedProjectSceneId,
          });
        }}
        pendingWorktree={projectAgentDockPendingWorktreeModel}
        onOpenPendingWorktreeDetails={() => {
          if (!projectAgentDockPendingWorktreeModel) return;
          setPendingWorktreeClientThreadId(projectAgentDockPendingWorktreeModel.clientThreadId);
        }}
      />
    ) : null;
  const projectAgentDockTriggerActivity = useAgentRuntimeSessionActivity(
    projectAgentDockModel?.trigger.runtimeSessionId ?? null,
  );
  const projectAgentDockAttention = projectAgentDockPendingWorktreeModel
    ? projectAgentDockPendingWorktreeModel.attention
    : projectAgentDockModel
      ? attentionForIndicator(
          resolveProjectAgentDockLiveIndicator(
            projectAgentDockModel.trigger,
            runtimeSessionLiveIndicator(projectAgentDockTriggerActivity),
          ),
        )
      : "none";
  const projectAgentDockPlacement: FloatingComposerPlacement | undefined = activeProjectScene
    ? {
        control: {
          state: activeProjectScene.composerOverlay,
          attention: projectAgentDockAttention,
          onStateChange: updateProjectAgentDockOverlay,
        },
        reserveContent: true,
      }
    : undefined;
  const projectHomeActive =
    activeProjectScene?.primary?.kind === "inbox" &&
    getWorkbenchPanelActiveLeaf(activeProjectScene.panels.right.layout).activeTabId ===
      activeProjectScene.primary.id;
  const projectAgentDock =
    !projectHomeActive &&
    selectedProjectSceneId &&
    projectSceneKey &&
    activeProjectScene?.agentDock &&
    activeProject &&
    projectAgentDockModel &&
    projectAgentDockLeadingContent ? (
      projectAgentDockSession && projectAgentDockThreadScope ? (
        <WorkbenchSessionScopePath
          thread={projectAgentDockThreadScope}
          route={{
            routeKey: `/project/${encodeURIComponent(selectedProjectSceneId)}/agent-dock`,
            kind: "thread",
          }}
          selected={false}
        >
          <ProjectSessionThreadComposerDock
            session={projectAgentDockSession}
            project={activeProject}
            projects={projects}
            composerDock={{
              visible: activeProjectScene.composerOverlay.visible,
              target: rightPanelComposerOverlayTarget,
              placement: projectAgentDockPlacement,
              leadingContent: projectAgentDockLeadingContent,
            }}
            composerScopeIdentity={projectAgentDockThreadScope.stableKey}
            browserUseViewScopeId={windowSessionId}
            newThreadStartBlockedReason={
              projectAgentDockPendingWorktreeModel?.composerBlockedReason ?? null
            }
            projectDraftId={
              activeProjectScene.agentDock.binding.kind === "new"
                ? activeProjectScene.agentDock.newDraftId
                : null
            }
            onMaterializeProjectDraft={materializeProjectAgentDockDraft}
            onCommitMaterializedProjectDraft={commitMaterializedProjectAgentDockDraft}
            onRefreshProjectSessions={refreshProjectSessions}
            onEnsureDefaultDraftSessionForProject={ensureDefaultDraftSessionForProject}
            onOpenPendingWorktree={(clientThreadId, projectSessionId) => {
              promoteThreadScopeToPending(
                threadScopeIdentityRegistry,
                projectAgentDockThreadScope,
                clientThreadId,
                projectSessionId,
              );
            }}
            onOpenLocalEnvironmentsSettings={openLocalEnvironmentsSettings}
            onRequestProjectPickerOpen={onRequestProjectPickerOpen}
            onOpenHooksSettings={openHooksSettings}
            onOpenVoiceSettings={openVoiceSettings}
            threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
            composerEnterBehavior={composerEnterBehavior}
            onQueueingEnabledChange={handleThreadQueueFollowUpsEnabledChange}
            onOpenThread={openAttachedThreadSession}
            onForkSession={forkSession}
            commandKeymapState={commandKeymapState}
            isMac={isMacPlatform}
          />
        </WorkbenchSessionScopePath>
      ) : (
        <ProjectAgentDockUnavailableOverlay
          target={rightPanelComposerOverlayTarget}
          placement={projectAgentDockPlacement}
          leadingContent={projectAgentDockLeadingContent}
          message={
            projectAgentDockSessionQuery.isError
              ? "This chat couldn’t be loaded. Retry or choose another chat."
              : "Loading chat…"
          }
        />
      )
    ) : null;
  const projectSceneRoute =
    selectedProjectSceneId && projectSceneKey && activeProjectScene && activeProject ? (
      <>
        <WorkbenchSceneFrame
          ownerKey={projectSceneKey}
          primary={null}
          primaryTestId="project-scene-surface"
          primaryHidden
          rightPanelTestId="project-right-panel"
          bottomPanelTestId="project-bottom-panel"
          layout={{
            appShellMainContentLayout: "default",
            rightPanelTargetWidth,
            bottomPanelHeight,
            rightPanel: {
              ...rightPanelMotion,
              open: sidePanelOpen,
              fullWidth: rightPanelFullWidth,
              content: projectScenePanels?.right ?? null,
            },
            bottomPanel: {
              ...bottomPanelMotion,
              open: bottomPanelOpen,
              content: projectScenePanels?.bottom ?? null,
            },
          }}
          chrome={{
            bottomPanelGlobalHeaderControls,
            setRightPanelComposerOverlayTarget,
            resizeRightPanel,
            resizeBottomPanel,
          }}
        />
        {projectAgentDock}
      </>
    ) : null;
  const librarySceneRoute =
    librarySceneKey && activeLibraryScene && libraryScenePresentation ? (
      <WorkbenchSessionScopePath
        thread={APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR}
        route={{
          routeKey: `/${librarySceneKey}`,
          kind: libraryScenePresentation.scene.owner.kind === "inbox" ? "inbox" : "library",
        }}
        selected
      >
        {libraryScenePresentation.scene.owner.kind === "library" ? (
          <LibrarySceneBreadcrumb scene={libraryScenePresentation.scene} />
        ) : null}
        <WorkbenchSceneFrame
          ownerKey={librarySceneKey}
          primary={null}
          primaryTestId={`${librarySceneKey}-primary-surface`}
          primaryHidden
          rightPanelTestId={`${librarySceneKey}-right-panel`}
          bottomPanelTestId={`${librarySceneKey}-bottom-panel`}
          layout={{
            appShellMainContentLayout: "default",
            rightPanelTargetWidth,
            bottomPanelHeight,
            rightPanel: {
              ...rightPanelMotion,
              open: sidePanelOpen,
              fullWidth: rightPanelFullWidth,
              content: libraryScenePanels?.right ?? null,
            },
            bottomPanel: {
              ...bottomPanelMotion,
              open: bottomPanelOpen,
              content: libraryScenePanels?.bottom ?? null,
            },
          }}
          chrome={{
            bottomPanelGlobalHeaderControls,
            setRightPanelComposerOverlayTarget,
            resizeRightPanel,
            resizeBottomPanel,
          }}
        />
      </WorkbenchSessionScopePath>
    ) : null;
  const activeSessionRoute =
    activeRenderSession && activeSessionPanelModel && sessionWorkspace ? (
      <WorkbenchSessionScene
        session={activeRenderSession}
        model={activeSessionPanelModel}
        projects={projects}
        project={activeSessionProject}
        sessionError={selectedSessionDetailError}
        threadScopeIdentityRegistry={threadScopeIdentityRegistry}
        activateReviewTab={activateReviewTab}
        panelGroupTabs={panelGroupTabs}
        panelLifecycle={panelLifecycle}
        panelCommands={panelCommands}
        workspace={{
          presentation: sessionWorkspace,
          chatTab: sessionChatTab,
          moveConversationToSide: moveSessionConversationToSide,
        }}
        layout={{
          appShellMainContentLayout,
          rightPanelTargetWidth,
          bottomPanelHeight,
          rightPanel: rightPanelMotion,
          bottomPanel: bottomPanelMotion,
          rightPanelHeaderStartInsetWidth,
          bottomPanelGlobalHeaderInsetWidth,
        }}
        chrome={{
          isMac: isMacPlatform,
          commandKeymapState,
          rightPanelHeaderAfterList,
          bottomPanelGlobalHeaderControls,
          setRightPanelComposerOverlayTarget,
          resizeRightPanel,
          resizeBottomPanel,
        }}
        threadPageProps={{
          session: activeRenderSession,
          browserUseViewScopeId: windowSessionId,
          project: activeSessionProject,
          projects,
          routeActive: true,
          threadBodyVisible: !activeSessionPanelModel.rightPanelFullWidth,
          onRefreshProjectSessions: refreshProjectSessions,
          onEnsureDefaultDraftSessionForProject: ensureDefaultDraftSessionForProject,
          onStartNewChatWithPrompt: startNewChatWithPrompt,
          onOpenPendingWorktree: setPendingWorktreeClientThreadId,
          newThreadComposerIntent:
            newThreadComposerIntentsBySessionId[activeRenderSession.id] ?? null,
          onConsumeNewThreadComposerIntent: consumeNewThreadComposerIntent,
          onRequestProjectPickerOpen,
          onOpenLocalEnvironmentsSettings: openLocalEnvironmentsSettings,
          onOpenHooksSettings: openHooksSettings,
          onOpenVoiceSettings: openVoiceSettings,
          threadQueueFollowUpsEnabled,
          composerEnterBehavior,
          onQueueingEnabledChange: handleThreadQueueFollowUpsEnabledChange,
          onOpenThread: openAttachedThreadSession,
          onOpenSubagentsPanel: () => {
            const rootThreadId =
              activeRenderSession.executionRef?.threadId ?? activeRenderSession.thread?.threadId;
            if (!rootThreadId) return;
            void openSubagentsPanelTab(rootThreadId);
          },
          onOpenTurnDiffFileInSidePanel: openTurnDiffFileInSidePanel,
          turnDiffHoverPreviewDisabled: activeSessionPanelModel.sidePanelOpen,
          onForkSessionFromTurn: forkSessionFromTurn,
          onForkSession: forkSession,
          onForkFromTurnIntoWorktree: forkSessionFromTurnIntoWorktree,
          searchOpenTick: threadSearchOpenTick,
          summaryPanelMounted: threadSummaryPanelMounted,
          summaryPanelOpen: threadSummaryPanelOpen,
          summaryPanelHideImmediately: threadSummaryPanelHideImmediately,
          summaryPanelContentShift: threadSummaryPanelContentShift,
          summarySideChatRows: threadSummarySideChatRows,
          summaryBrowserRows: threadSummaryBrowserRows,
          summaryScheduledAutomation: threadSummaryScheduledAutomation,
          summaryComputerUsePip: threadSummary.summaryComputerUsePip,
          onOpenSummarySideChatRow: openSummarySideChatRow,
          onOpenSummaryBrowserRow: openSummaryBrowserRow,
          onOpenSummaryScheduledAutomation: openSummaryScheduledAutomation,
          onOpenSummaryOutputInSidePanel: openSummaryOutputInSidePanel,
          onOpenProcessManager: openSummaryProcessManager,
          onOpenBackgroundTerminalOutput: openSummaryBackgroundTerminalOutput,
          onToggleSummaryComputerUsePip: threadSummary.onToggleSummaryComputerUsePip,
          rightPanelComposerOverlayEnabled,
          rightPanelComposerOverlayTarget,
          rightPanelComposerOverlayPlacement,
          onOpenSideChat: filterAvailablePanelActions(
            PANEL_NEW_TAB_ACTIONS,
            activeRenderSession.tabs,
            "right",
            {
              kind: "session",
              backendKind: activeRenderSession.thread?.backendBinding.kind ?? "codex",
              projectId: activeRenderSession.projectId,
              hasAttachedThread: hasSessionConversation(activeRenderSession),
              cwd: activeRenderSession.thread?.cwd,
              projectWorkspaceRoot: projectWorkspaceRootOrNull(activeSessionProject),
            },
          ).some((action) => action.kind === "side_chat")
            ? (input) =>
                openSideChat({
                  ...input,
                  targetPanelId: "right",
                })
            : undefined,
          onOpenMcpAppSidePanel: openMcpAppSidePanel,
          onOpenPlanInSidePanel: openPlanSidePanel,
          onClosePlanSidePanel: closePlanSidePanel,
          planSidePanelState: activeSessionPanelModel.threadPlanSidePanelState,
          onRequestRenameThread: () => {
            openRenameSessionDialog(activeRenderSession);
          },
          onArchiveThread: async () => {
            await archiveSession(activeRenderSession);
          },
          onToggleThreadPin: async () => {
            await toggleSessionPin(activeRenderSession);
          },
          commandKeymapState,
          isMac: isMacPlatform,
        }}
      />
    ) : null;

  const sidebarBody: WorkbenchSidebarBodyProps = {
    hasMoreProjects,
    loadingMoreProjects,
    loadMoreProjectsFailed,
    onLoadMoreProjects,
    activeProjectId,
    activeSessionId: activeSession?.id ?? null,
    activePendingClientThreadId: pendingWorktreeClientThreadId,
    contextMenuSessionId,
    sessionCollectionsByProject: sidebarSessionCollections.collectionsByProject,
    projectlessSessionCollection: sidebarSessionCollections.projectlessCollection,
    sidebarThreadModel,
    pendingStableWorktrees,
    expandedProjectIds,
    pinnedProjectsSectionCollapsed,
    pagesSectionCollapsed,
    sidebarListExtraPages: sidebarState.listExtraPages,
    projectsSectionCollapsed,
    chatsSectionCollapsed,
    sidebarCollapsibleSections: sidebarState.sections,
    onLoadMoreTaskWindow: sidebarSessionCollections.loadMore,
    onRetryTaskWindow: sidebarSessionCollections.retryCollection,
    width: sidebarWidth,
    getWindowZoom,
    onResizeWidth: applySidebarWidth,
    onTogglePinnedProjectsSectionCollapsed: togglePinnedProjectsSectionCollapsed,
    onTogglePagesSectionCollapsed: togglePagesSection,
    onSidebarListExtraPagesChange: sidebarState.setListExtraPages,
    onToggleProjectsSectionCollapsed: toggleProjectsSectionCollapsed,
    onToggleChatsSectionCollapsed: toggleChatsSectionCollapsed,
    onSetSidebarSectionCollapsed: sidebarState.setSectionCollapsed,
    onToggleProjectExpanded: toggleProjectExpanded,
    onSelectProject: (projectId) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      selectProject(projectId);
    },
    onSelectSession: (session) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      selectSession(session);
    },
    onSelectSidebarThread: (item) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      void selectSidebarThread(item);
    },
    onPreviewSidebarThread: prefetchSidebarSession,
    onOpenSessionContextMenu: openSessionContextMenu,
    onOpenSessionLinkedPage: (session, page) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      void sessionCommands.openPageInChat({
        sessionId: session.id,
        routingContext: session.projectId
          ? { kind: "project", projectId: session.projectId }
          : { kind: "library" },
        page: { pageId: page.pageId, titleSnapshot: page.title },
      });
    },
    onSessionTitleDoubleClick: handleSessionTitleDoubleClick,
    onPendingWorktreeTitleDoubleClick: handlePendingWorktreeTitleDoubleClick,
    onArchiveSidebarThread: archiveSidebarThreadItem,
    onArchiveThreadItem: archiveSidebarThreadItemQuiet,
    onMarkThreadItemRead: markSidebarThreadItemRead,
    onThreadsChanged: refreshSidebarThreadSnapshot,
    onToggleSessionPinned: toggleSessionPin,
    onToggleSidebarThreadPinned: toggleSidebarThreadPinned,
    onStartNewChatInProject: (projectId) => {
      closePendingWorktreeRoute();
      setAutomationsPath(null);
      void startNewChatInProject(projectId);
    },
    onOpenStableWorktree: openStableWorktreeStatus,
    onCreateStableWorktree: createStableWorktree,
    onOpenCommandPalette: openSidebarCommandPalette,
    onOpenInbox: openInbox,
    onOpenResourceTarget: openResourceTarget,
    onOpenResourceTargetInProject: openResourceTargetInProject,
    activeResourceTarget: librarySceneNavigation.activeRoot,
    inboxActive: workbenchWindow.location.kind === "inbox",
    inboxCounts,
    projectPickerOpenTick,
    onCreateProject: async (input) => await onCreateProject(input),
    onUpdateProject: onUpdateProject ?? (async () => null),
    onArchiveProject: onArchiveProject ?? (async () => ({ kind: "not-found" })),
    onReorderProjects,
    onSetProjectPinned,
    onSetPinnedProjectOrder,
    onReorderSessions: sessionCatalog.reorder,
    onMoveSidebarThread: moveSidebarThreadForSidebar,
    onReorderPinnedThreads: reorderPinnedSidebarThreads,
    sidebarArchivePendingKeys,
  };

  const workbench = (
    <PageTitleProjectionProvider currentLibraryId={currentLibraryId} store={pageTitleStore}>
      {currentLibraryId ? <ContentRecoveryObserver libraryId={currentLibraryId} /> : null}
      <span role="status" aria-live="polite" className="sr-only">
        {contentIssueCount > 0
          ? `${contentIssueCount} content ${contentIssueCount === 1 ? "issue needs" : "issues need"} attention`
          : ""}
      </span>
      <HeaderActionProvider
        actions={
          <>
            {appShellHeaderActions}
            {contentIssueCount > 0 ? (
              <HeaderAction actionId="content-issues" slotPosition="right" align="end" order={150}>
                <ContentIssuesControl
                  libraryId={currentLibraryId}
                  projects={projects}
                  onOpenLocation={openContentIssueLocation}
                />
              </HeaderAction>
            ) : null}
          </>
        }
      >
        <NodexTooltipProvider>
          <FileReferenceRouterProvider
            openWorkspaceFileTab={openWorkspaceFileTab}
            openBrowserTab={supportsBrowserLinkNavigation ? openLinkInBrowserTab : undefined}
            openBrowserWindow={supportsBrowserLinkNavigation ? openLinkInBrowserWindow : undefined}
            workspaceRoot={
              projectWorkspaceRootOrNull(activeSessionProject) ?? activeSession?.thread?.cwd ?? null
            }
          >
            <ContentSearchProvider
              openRequest={contentSearchOpenRequest ?? commandContentSearchOpenRequest}
            >
              <ContentSearchSurface />
              {commandPalette}
              <KeyboardShortcutHelpDialog
                open={keyboardShortcutHelpOpen}
                onOpenChange={setKeyboardShortcutHelpOpen}
                commandKeymapState={commandKeymapState}
                onCustomize={openKeyboardShortcutsSettings}
              />
              <WorkbenchProcessManagerDialog
                open={processManagerOpen}
                activeThreadId={sessionExecutionThreadId(activeSession)}
                threads={processManagerThreads}
                control={workbenchCodexControl}
                onOpenChange={setProcessManagerOpen}
                onOpenThread={openAttachedThreadSession}
                onOpenOutput={openProcessManagerOutput}
              />
              <motion.div
                ref={workbenchRootRef}
                data-page-create-project-focus-root={
                  activeProject?.id ?? activeProjectId ?? undefined
                }
                tabIndex={-1}
                data-workbench-shell
                data-app-shell-frame
                data-app-shell-page-surface="true"
                className="relative flex flex-col text-token-text-primary browser:bg-token-side-bar-background"
                style={
                  {
                    "--height-toolbar": `${WORKBENCH_TITLEBAR_HEIGHT_PX}px`,
                    "--height-titlebar": `${WORKBENCH_TITLEBAR_HEIGHT_PX}px`,
                    "--app-shell-navigation-rail-width": `${WORKBENCH_NAVIGATION_RAIL_WIDTH_PX}px`,
                    "--spacing-token-safe-header-left": `${safeHeaderLeftWidth}px`,
                    "--spacing-token-safe-header-right": `${safeHeaderRightWidth}px`,
                    "--app-shell-bottom-panel-height": bottomPanelAnimatedHeightCss,
                    width: "calc(100vw / var(--codex-window-zoom, 1))",
                    height: "calc(100vh / var(--codex-window-zoom, 1))",
                    zoom: "var(--codex-window-zoom, 1)",
                  } as MotionStyle
                }
              >
                {activeRenderSession ? (
                  <BrowserSidebarHiddenWebviewHosts
                    durableBrowserConversationId={activeRenderSession.id}
                    browserViewScopeId={windowSessionId}
                    tabs={browserRetentionTabs}
                    mountedTabIds={mountedBrowserTabIds}
                    visibleTabIds={visibleBrowserTabIds}
                  />
                ) : activeProjectScene && projectSceneKey ? (
                  <BrowserSidebarHiddenWebviewHosts
                    durableBrowserConversationId={projectSceneKey}
                    browserViewScopeId={windowSessionId}
                    tabs={projectBrowserRetentionTabs}
                    mountedTabIds={visibleProjectBrowserTabIds}
                    visibleTabIds={visibleProjectBrowserTabIds}
                  />
                ) : null}
                <WorkbenchTitlebarProvider host={titlebarHost} active={!settingsPath}>
                  <header
                    ref={setTitlebarHost}
                    data-testid="workbench-global-header"
                    data-workbench-titlebar
                    data-app-shell-header-edge-scroll={appShellHeaderEdgeScroll ? "true" : "false"}
                    className={cn(
                      "app-header-tint draggable pointer-events-none fixed inset-x-0 top-0 flex h-toolbar min-w-0 items-center",
                      APP_SHELL_GLOBAL_HEADER_LAYER_CLASS,
                    )}
                  >
                    <HeaderShellSlot
                      side="left"
                      slotWidth={headerLeftShellSlotWidth}
                      minWidth={headerLeftShellSlotMinWidth}
                      fallbackWidth={headerLeftFallbackWidth}
                      fallbackRailWidth={headerLeftFallbackRailWidth}
                      onMeasuredWidthChange={setHeaderLeftWidth}
                      onMeasuredRailWidthChange={setHeaderLeftRailWidth}
                    />
                    {appShellHeaderCenterVisible ? (
                      <motion.div
                        aria-hidden={appShellHeaderCoveredByScene ? "true" : undefined}
                        data-testid="app-shell-header-context-menu-surface"
                        className={cn(
                          "group/titlebar-main pointer-events-none flex h-full min-w-0 flex-1 isolate items-center gap-1.5 overflow-hidden [contain:layout_paint] pe-2",
                          appShellHeaderCoveredByScene && "invisible",
                        )}
                      >
                        <span
                          aria-hidden="true"
                          data-workbench-titlebar-divider=""
                          className="me-1.5 hidden h-5 w-px shrink-0 bg-token-border group-has-[[data-testid=thread-stage-header-content]>*]/titlebar-main:block"
                        />
                        <div
                          data-testid="thread-stage-header-content"
                          className="pointer-events-none w-full min-w-0 flex-1 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto"
                        >
                          {/* A showing Project Scene owns this row; a route opened over it keeps its header. */}
                          {workbenchWindow.location.kind === "project" ? null : (
                            <ThreadStageHeaderSlotContext.Provider value={titlebarThreadHeaderSlot}>
                              <SelectedAppShellHeaderContent />
                            </ThreadStageHeaderSlotContext.Provider>
                          )}
                        </div>
                        {!destinationRouteShell ? (
                          <HeaderInlineActionRail
                            slotPosition="center"
                            data-testid="thread-stage-header-summary-actions"
                            className="ms-auto"
                          />
                        ) : null}
                      </motion.div>
                    ) : null}
                    <HeaderShellSlot
                      side="right"
                      slotWidth={rightHeaderShellSlotWidth}
                      minWidth={destinationRouteShell ? 0 : headerRightWidth}
                      fallbackWidth={
                        destinationRouteShell ? 0 : RIGHT_PANEL_HEADER_FALLBACK_SPACER_WIDTH_PX
                      }
                      fallbackRailWidth={
                        destinationRouteShell ? 0 : RIGHT_PANEL_HEADER_FALLBACK_RAIL_WIDTH_PX
                      }
                      onMeasuredWidthChange={setHeaderRightWidth}
                      onMeasuredRailWidthChange={setHeaderRightRailWidth}
                    />
                  </header>

                  <div
                    data-workbench-workspace-row
                    className="relative flex min-h-0 min-w-0 flex-1 pt-(--height-toolbar)"
                  >
                    <div
                      aria-hidden="true"
                      data-app-shell-page-surface-shadow
                      className="pointer-events-none absolute top-(--height-toolbar) right-1 bottom-1 left-(--app-shell-navigation-rail-width) rounded-(--app-shell-surface-radius) shadow-[var(--app-shell-page-surface-shadow)]"
                    />
                    <div className="shrink-0 pb-1">
                      <WorkbenchAppRail
                        destination={getWorkbenchPrimaryDestination(workbenchWindow.location)}
                        onHome={workbenchWindow.selectHome}
                        onSpace={workbenchWindow.selectLibrary}
                        onScheduled={() => openAutomations()}
                        onPlugins={() => openPlugins()}
                        footer={
                          <WorkbenchRailFoot
                            onOpenSettings={openSettings}
                            onOpenAccountSettings={() => openSettingsAt("account")}
                            settingsShortcutLabel={formatCommandShortcutLabel(
                              commandKeymapState ??
                                createCommandKeymapState({}, isMacPlatform ? "macOS" : "windows"),
                              "settings",
                              "CmdOrCtrl+,",
                            )}
                            account={codexAccount}
                            connection={codexConnection}
                            onRefreshAccount={codexAccountActions.refreshAccount}
                            onConsumeRateLimitReset={codexAccountActions.consumeRateLimitReset}
                            onStartChatGptLogin={codexAccountActions.startChatGptLogin}
                            onStartApiKeyLogin={codexAccountActions.startApiKeyLogin}
                            onCancelLogin={codexAccountActions.cancelLogin}
                            onLogout={handleCodexAccountLogout}
                            onErrorMessage={handleCodexAccountErrorMessage}
                          />
                        }
                      />
                    </div>
                    <div className="relative flex min-h-0 min-w-0 flex-1 pr-1 pb-1">
                      <div
                        ref={shellBodySize.ref}
                        data-app-shell-summary-layout={threadSummaryPanelLayoutMode}
                        data-app-shell-width-class={shellWidthClass}
                        className="relative flex max-h-full min-h-0 min-w-0 flex-1"
                      >
                        <WorkbenchRouteHost
                          location={workbenchWindow.location}
                          sidebarMounted={realSidebarMounted}
                          settings={settingsRouteShell}
                          sidebar={
                            <WorkbenchSidebar
                              destination={getWorkbenchPrimaryDestination(workbenchWindow.location)}
                              body={sidebarBody}
                              scheduled={scheduledSidebarNavigation}
                              customize={customizeNavigation}
                              inline={{
                                visible: showInlineSidebar,
                                animatedWidth: realSidebarMotion.animatedWidth,
                                contentOpacity: realSidebarMotion.opacity,
                                resizeDisabled: sidebarAnimating,
                              }}
                              floating={{
                                visible: showFloatingSidebar,
                                destination:
                                  peekDestination ??
                                  getWorkbenchPrimaryDestination(workbenchWindow.location),
                                outerClassName: floatingSidebarOuterClassName,
                                resizing: floatingSidebarResizing,
                                reducedMotion: Boolean(reducedMotion),
                                onResizeActiveChange: setFloatingSidebarResizing,
                                onHoverSurfaceOpenChange: setPeekMenuOpen,
                              }}
                            />
                          }
                          pendingWorktree={{
                            content: () => (
                              <WorkbenchSessionScopePath
                                thread={resolvePendingThreadScopeDescriptor(
                                  threadScopeIdentityRegistry,
                                  pendingWorktreeClientThreadId!,
                                  resolvePendingProjectSessionId(
                                    pendingWorktrees,
                                    pendingWorktreeClientThreadId,
                                  ),
                                )}
                                route={{
                                  routeKey: `/pending-worktree?clientThreadId=${encodeURIComponent(pendingWorktreeClientThreadId!)}`,
                                  kind: "pending-worktree",
                                }}
                                selected
                              >
                                {pendingWorktreeRouteShell}
                              </WorkbenchSessionScopePath>
                            ),
                          }}
                          automations={{
                            content: () =>
                              scheduledRunPresented ? (
                                activeSessionRoute
                              ) : (
                                <WorkbenchSessionScopePath
                                  thread={APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR}
                                  route={{ routeKey: automationsPath!, kind: "automations" }}
                                  selected
                                >
                                  {automationsRouteShell}
                                </WorkbenchSessionScopePath>
                              ),
                          }}
                          plugins={{
                            content: () => (
                              <WorkbenchSessionScopePath
                                thread={APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR}
                                route={{ routeKey: pluginsPath!, kind: "plugins" }}
                                selected
                              >
                                {pluginsRouteShell}
                              </WorkbenchSessionScopePath>
                            ),
                          }}
                          session={{
                            content: () =>
                              projectSceneRoute ??
                              librarySceneRoute ??
                              activeSessionRoute ?? (
                                <WorkbenchEmptyRoute
                                  activeProjectId={activeProjectId}
                                  projectCatalogError={projectCatalogError}
                                  onRetryProjects={onRetryProjects}
                                  onStartProjectlessChat={() => {
                                    void startNewChatInProject(null);
                                  }}
                                />
                              ),
                            afterMain: pageStageHistoryPanelProjectId ? (
                              <HistoryPanel
                                projectId={pageStageHistoryPanelProjectId}
                                pageId={pageStageHistoryModal?.pageId ?? null}
                                pageTitle={pageStageHistoryModal?.pageTitle}
                                pageMarkdown={pageStageHistoryModal?.pageMarkdown}
                                projectWorkspacePath={projectWorkspaceRootOrNull(
                                  pageStageHistoryModalProject,
                                )}
                                open={pageStageHistoryModal !== null}
                                onClose={closePageStageHistoryModal}
                                onPageMutated={() => {
                                  void activeProjectBoard.refresh();
                                }}
                              />
                            ) : null,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </WorkbenchTitlebarProvider>
              </motion.div>
            </ContentSearchProvider>
          </FileReferenceRouterProvider>
        </NodexTooltipProvider>
      </HeaderActionProvider>
    </PageTitleProjectionProvider>
  );

  return (
    <AgentSettingsNavigationProvider openAgentSettings={openAgentSettings}>
      <ScheduledNavigationProvider value={scheduledNavigation}>
        <WorkbenchNewTabPortProvider port={newTabPort}>{workbench}</WorkbenchNewTabPortProvider>
      </ScheduledNavigationProvider>
    </AgentSettingsNavigationProvider>
  );
}
