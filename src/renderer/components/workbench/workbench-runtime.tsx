import { useRegisterFileLocationNavigator } from "@/lib/file-location-navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useMotionValue, useTransform, type MotionStyle } from "motion/react";
import { BackIcon } from "@/components/shared/icons";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { PanelTabPresentationRegistry } from "./panel-tab-presentation-registry";
import { WorkbenchSidebar, type WorkbenchSidebarBodyProps } from "./workbench-sidebar";
import { WorkbenchEmptyRoute, WorkbenchRouteHost } from "./workbench-route-host";
import { WorkbenchAutomationDetailRail } from "./workbench-automation-detail-rail";
import { WorkbenchThreadSummaryHeader } from "./workbench-thread-summary-header";
import { ToolbarIconButton, WindowNavigationToolbarButton } from "./workbench-panel-controls";
import { ContentHistoryControl } from "@/components/shared/surface-history-status";
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
import { terminalSessionStore, useTerminalSessionStoreVersion } from "@/lib/terminal-session-store";
import { BrowserSidebarHiddenWebviewHosts } from "@/features/browser-sidebar/browser-sidebar-hidden-webview-hosts";
import { BrowserSidebarPanel } from "@/features/browser-sidebar/browser-sidebar-panel";
import { invokeBrowserSidebarCommand } from "@/features/browser-sidebar/browser-sidebar-commands";
import { useBrowserSidebarRendererState } from "@/features/browser-sidebar/browser-sidebar-renderer-state-store";
import { WorkspaceFilesPanel, type WorkspaceFilesTab } from "@/features/workspace-files";
import { workspaceTextDocumentRegistry } from "@/features/workspace-files/workspace-text-document-controller";
import {
  getBrowserDocumentBottomKey,
  useBrowserDocumentBottom,
} from "@/features/browser-sidebar/browser-document-bottom-store";
import {
  ContentSearchProvider,
  type ContentSearchOpenRequest,
} from "@/features/content-search/content-search-context";
import { ContentSearchSurface } from "@/features/content-search/content-search-surface";
import { buildSettingsPath, resolveBrowserSettingsDestination } from "./workbench-settings-routes";
import type { BrowserSettingsDestination } from "./workbench-settings-routes";
import {
  buildCodexHooksSettingsPath,
  type CodexHooksSettingsTarget,
} from "@/lib/codex-hooks-route";
import { buildAutomationsPath } from "./workbench-automations-routes";
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
import { libraryContentAccess, projectContentAccess } from "../../../shared/content-access-context";
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
import { useCodexScheduledAutomations } from "@/lib/use-codex-scheduled-automations";
import { useBoard } from "@/lib/use-board";
import { createPageTitleProjectionStore } from "@/lib/page-title-projection-store";
import { PageTitleProjectionProvider } from "@/lib/page-title-projection-context";
import { useLibraryNavigationInvalidation } from "@/lib/use-library-navigation";
import { cn } from "@/lib/utils";
import {
  type SidebarCollapsibleSectionsState,
  type SidebarDisclosureSectionId,
} from "@/lib/sidebar-section-prefs";
import { useWorkbenchSidebarState } from "@/lib/use-workbench-sidebar-state";
import { makeEditorSurfaceKey, documentSessionRegistry } from "@/lib/document-session-registry";
import {
  canvasSceneSurfaceRegistry,
  makeCanvasSceneSurfaceKey,
} from "@/lib/canvas-scene-surface-runtime";
import type { WorkbenchCommandPort } from "@/lib/use-workbench-command-ingress";
import {
  executeDesktopNotificationAction,
  resolveDesktopNotificationParentThreadId,
  resolveDesktopNotificationSideChatThreadId,
} from "@/lib/desktop-notification-action";
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
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  resolveWorkbenchSceneSurface,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import {
  findWorkbenchPanelLeafForTab,
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
import {
  useWorkbenchPanelOpeners,
  type OpenCanvasStageHandler,
} from "@/lib/use-workbench-panel-openers";
import { FileReferenceRouterProvider } from "@/lib/file-reference-router";
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
import { WorkbenchCanvasStagePanel } from "./workbench-canvas-stage-panel";
import { WorkbenchDatabaseViewSurface } from "./workbench-database-view-surface";
import { WorkbenchLibraryPageSurface } from "./workbench-library-page-surface";
import { PagesSceneBreadcrumb, usePagesSceneNavigation } from "./pages-scene-breadcrumb";
import { EmptyPagesScene, PagesTabPicker } from "./pages-tab-picker";
import { TerminalPanel } from "./workbench-terminal-panel";
import { buildWorkbenchScenePanels } from "./workbench-scene-panels";
import { useWorkbenchRouteSurfaces } from "./use-workbench-route-surfaces";
import { WorkbenchCommandPaletteHost } from "./workbench-command-palette-host";
import { useWorkbenchChromeLayout } from "./use-workbench-chrome-layout";
import {
  AUTOMATION_DETAIL_RAIL_DEFAULT_WIDTH,
  clampAutomationDetailRailWidth,
  useWorkbenchChromeCommands,
} from "@/lib/use-workbench-chrome-commands";
import {
  useWorkbenchThreadSummary,
  type WorkbenchThreadSummaryCommands,
} from "@/lib/use-workbench-thread-summary";
import {
  presentWorkbenchSession,
  type WorkbenchSessionRenderProjection,
} from "@/lib/workbench-session-presentation";
import { projectSessionToSummary } from "@/lib/project-session-query-cache";
import { presentPageStageRelatedChatCandidates } from "@/lib/page-stage-related-chat-candidates";
import {
  buildProjectAgentDockPendingWorktreeModel,
  buildProjectAgentDockModel,
  resolveProjectAgentDockPendingWorktree,
  type ProjectAgentDockTargetRow,
} from "@/lib/project-agent-dock-model";
import {
  createProjectAgentDockDraftSession,
  createProjectAgentDockMaterializer,
} from "@/lib/project-agent-dock-controller";
import type { CodexPendingWorktreeEntry } from "../../../shared/codex-pending-worktree";
import { useBrowserUsePresentationCoordinator } from "@/lib/use-browser-use-presentation-coordinator";
import { useWorkbenchPreferences } from "./use-workbench-preferences";
import { useWorkbenchWindowState } from "@/lib/use-workbench-window-state";
import {
  getWorkbenchSceneReturnLocation,
  type WorkbenchLayoutSnapshot,
} from "../../../shared/workbench-layout";
import type {
  CodexComposerIntent,
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
import {
  CODEX_SIDEBAR_FLOATING_HEADER_CLASS,
  getCodexSidebarFloatingOuterClassName,
  getCodexSidebarFloatingTransition,
} from "@/lib/codex-sidebar-auto-reveal";
import { useSyncedMotionValue } from "@/lib/resize-observer-motion-values";
import {
  CloseIcon,
  ExpandPanelIcon,
  PanelBottomHiddenIcon,
  PanelBottomVisibleIcon,
  PanelRightHiddenIcon,
  PanelRightVisibleIcon,
  RestorePanelIcon,
  SidebarHiddenIcon,
  SidebarVisibleIcon,
} from "@/components/shared/icons";
import {
  SIDEBAR_COLLAPSED_CHROME_BUTTON_CLASS,
  SidebarCompactNewChatButton,
} from "./sidebar-new-chat-controls";
import { useCodexAccountActions } from "@/lib/use-codex-account-actions";
import { filterAvailablePanelActions, PANEL_NEW_TAB_ACTIONS } from "@/lib/workbench-panel-actions";
import { readPageStagePanelTabPageRef } from "@/lib/workbench-panel-placement";
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
  type WorkbenchPanelTabShortcutFocus,
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
  type WorkbenchCommandInvocation,
} from "../../../shared/workbench-commands";
import { type CommandKeymapState } from "../../../shared/command-keybindings";
import { KeyboardShortcutHelpDialog } from "./keyboard-shortcut-help-dialog";
import type { CommandMenuMode } from "@/lib/command-palette";
import type { CodexBackgroundTerminalProcessThreadRef } from "@/lib/codex-background-terminal-processes";
import { primaryCanvasBlockId } from "../../../shared/block-documents";

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
  onLoadMoreProjects?: () => Promise<void>;
  projectCatalogError?: string | null;
  onRetryProjects?: () => Promise<void> | void;
  onSceneMutation?: (
    owner: WorkbenchSceneOwner,
    previous: WorkbenchSceneSnapshot,
    next: WorkbenchSceneSnapshot,
  ) => void;
  sidebar?: {
    collapsed: boolean;
    width: number;
    collapsibleSections?: SidebarCollapsibleSectionsState;
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
  onLoadMoreProjects,
  projectCatalogError = null,
  onRetryProjects,
  onSceneMutation,
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
  onNavigationStateChange,
  onRegisterCommandPort,
  commandKeymapState,
}: WorkbenchRuntimeProps) {
  const queryClient = useQueryClient();
  const currentLibraryId = useLibraryNavigationInvalidation() ?? projects[0]?.libraryId ?? null;
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
  const setAutomationsPath = useCallback(
    (path: string | null) => {
      if (path === null) {
        if (workbenchWindow.location.kind === "automations") {
          workbenchWindow.closeRoute();
        }
        return;
      }
      if (workbenchWindow.location.kind === "automations") {
        workbenchWindow.navigate(
          {
            ...workbenchWindow.location,
            path,
          },
          { record: false },
        );
        return;
      }
      workbenchWindow.openRoute({ kind: "automations", path });
    },
    [workbenchWindow],
  );
  const setPendingWorktreeClientThreadId = useCallback(
    (clientThreadId: string | null) => {
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
          },
          { record: false },
        );
        return;
      }
      workbenchWindow.openRoute({
        kind: "pending-worktree",
        clientThreadId,
      });
    },
    [workbenchWindow],
  );
  const sidebarState = useWorkbenchSidebarState({
    projects,
    activeProjectId,
    collapsibleSections: sidebar?.collapsibleSections,
    setCollapsibleSectionCollapsed: setSidebarCollapsibleSectionCollapsed,
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
  const pagesSceneOwner = useMemo(
    () => (sceneLocation.kind === "pages" ? { kind: "pages" as const } : null),
    [sceneLocation],
  );
  const pagesSceneKey = pagesSceneOwner ? makeWorkbenchSceneKey(pagesSceneOwner) : null;
  const activePagesScene =
    pagesSceneOwner && pagesSceneKey
      ? (workbenchWindow.scenesByOwnerKey[pagesSceneKey] ??
        materializeInitialWorkbenchScene(pagesSceneOwner))
      : null;
  useEffect(() => {
    if (!pagesSceneOwner || !pagesSceneKey || !activePagesScene) {
      return;
    }
    if (workbenchWindow.scenesByOwnerKey[pagesSceneKey]) return;
    workbenchWindow.setScene(pagesSceneOwner, activePagesScene, {
      recordHistory: false,
    });
  }, [activePagesScene, pagesSceneKey, pagesSceneOwner, workbenchWindow]);
  const activeOwnedScene = activeProjectScene ?? activePagesScene;
  const activeOwnedSceneOwner = projectSceneOwner ?? pagesSceneOwner;
  const activeOwnedSceneKey = projectSceneKey ?? pagesSceneKey;
  const projectAgentDockBoundSessionId =
    activeProjectScene?.agentDock?.binding.kind === "session"
      ? activeProjectScene.agentDock.binding.sessionId
      : null;
  const projectAgentDockSessionQuery = useQuery({
    ...projectSessionDetailQueryOptions(projectAgentDockBoundSessionId ?? ""),
    enabled: projectAgentDockBoundSessionId !== null,
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
        onSceneMutation?.(owner, previous, next);
        return next;
      });
      return next;
    },
    [onSceneMutation, workbenchWindow],
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
          onSceneMutation?.(owner, previous, next);
          return next;
        },
        { recordHistory: false },
      );
      return next;
    },
    [onSceneMutation, workbenchWindow],
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
  const sceneNavigator = useMemo(
    () =>
      createWorkbenchSceneNavigator({
        hasAttachedThread(sessionId) {
          return (sessionCatalogRef.current.findById(sessionId)?.domain.thread ?? null) !== null;
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
  } = panelController;
  const projectScenePresentation = useMemo(
    () =>
      activeProjectScene
        ? projectWorkbenchScenePreviews(activeProjectScene, previewSurfacesByPanel)
        : null,
    [activeProjectScene, previewSurfacesByPanel],
  );
  const pagesScenePresentation = useMemo(
    () =>
      activePagesScene
        ? projectWorkbenchScenePreviews(activePagesScene, previewSurfacesByPanel)
        : null,
    [activePagesScene, previewSurfacesByPanel],
  );
  const activeOwnedScenePresentation = projectScenePresentation ?? pagesScenePresentation;
  const projectScenePresentedPageIds = useMemo<ReadonlySet<string>>(
    () =>
      projectScenePresentation
        ? collectWorkbenchScenePresentedPageIds(projectScenePresentation.scene)
        : new Set(),
    [projectScenePresentation],
  );
  const pagesScenePresentedPageIds = useMemo<ReadonlySet<string>>(
    () =>
      pagesScenePresentation
        ? collectWorkbenchScenePresentedPageIds(pagesScenePresentation.scene)
        : new Set(),
    [pagesScenePresentation],
  );
  const pagesSceneNavigation = usePagesSceneNavigation(pagesScenePresentation?.scene ?? null);
  const [pageTitleStore] = useState(createPageTitleProjectionStore);
  const [panelTabPresentationRegistry] = useState(() => new PanelTabPresentationRegistry());
  const panelTabPresentationControllerKeysRef = useRef(new Set<string>());
  const [headerLeftWidth, setHeaderLeftWidth] = useState(0);
  const [, setHeaderLeftRailWidth] = useState(0);
  const [headerRightWidth, setHeaderRightWidth] = useState(
    RIGHT_PANEL_HEADER_FALLBACK_SPACER_WIDTH_PX,
  );
  const [, setHeaderRightRailWidth] = useState(RIGHT_PANEL_HEADER_FALLBACK_RAIL_WIDTH_PX);
  const [automationsDetailRailOpen, setAutomationsDetailRailOpen] = useState(false);
  const automationsDetailRailRequestedWidth = useMotionValue(AUTOMATION_DETAIL_RAIL_DEFAULT_WIDTH);
  const [threadScopeIdentityRegistry] = useState(createThreadScopeIdentityRegistry);
  const [projectAgentDockMaterializer] = useState(createProjectAgentDockMaterializer);
  const [projectAgentDockQuery, setProjectAgentDockQuery] = useState("");
  const [automationsDetailRailPortalElement, setAutomationsDetailRailPortalElement] =
    useState<HTMLDivElement | null>(null);
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
    initialQuery: "",
  });
  const [commandContentSearchOpenRequest, setCommandContentSearchOpenRequest] =
    useState<ContentSearchOpenRequest | null>(null);
  const workbenchRootRef = useRef<HTMLDivElement | null>(null);
  const pinningPreviewTabIdsRef = useRef<Set<string>>(new Set());
  const focusedPanelGroupRef = useRef<WorkbenchPanelTabShortcutFocus | null>(null);
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
    floatingSidebarVisible,
    getWindowZoom,
    motion: realSidebarMotion,
    setFloatingSidebarFocusActive,
    setFloatingSidebarHoverSurfaceActive,
    setFloatingSidebarResizing,
    setSidebarCollapsed: setSidebarCollapsedWithCodexState,
    setSidebarClickInFlight,
    setSidebarHoverSuppressed,
    setSidebarTriggerHovered,
    showRealSidebarFromFloatingPanel,
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
  const projectAgentDockExactSession =
    projectAgentDockSessionQuery.data?.projectId === selectedProjectSceneId &&
    !projectAgentDockSessionQuery.data.archived
      ? projectAgentDockSessionQuery.data
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
  const setComposerOverlayVisible = useCallback(
    (owner: WorkbenchSceneOwner, visible: boolean) => {
      workbenchWindow.setScene(
        owner,
        (stored) => {
          const scene = stored ?? materializeInitialWorkbenchScene(owner);
          if (scene.composerOverlay.visible === visible) return scene;
          return {
            ...scene,
            composerOverlay: { visible },
          };
        },
        { recordHistory: false },
      );
    },
    [workbenchWindow],
  );
  const setProjectAgentDockVisible = useCallback(
    (visible: boolean) => {
      if (!selectedProjectSceneId) return;
      setComposerOverlayVisible(
        {
          kind: "project",
          projectId: selectedProjectSceneId,
        },
        visible,
      );
    },
    [selectedProjectSceneId, setComposerOverlayVisible],
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
    (input: WorkbenchTabCreateInput): WorkbenchTabProjection | null => {
      if (!activeSession || input.sessionId !== activeSession.id) return null;
      const tab = workbenchSurfaceFromCreateInput(input);
      const next = panelControllerRef.current.durable.createTab(activeSession, {
        panelId: input.panelId,
        presentation: input.presentation,
        targetLeafId: input.targetLeafId,
        targetIndex: input.targetIndex,
        openerTabId: input.openerTabId,
        tab,
      });
      return (
        presentWorkbenchSessionDomainWithScene(activeSession, next).tabs.find(
          (candidate) => candidate.id === tab.id,
        ) ?? null
      );
    },
    [activeSession],
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
  const setActiveSessionComposerOverlayVisible = useCallback(
    (visible: boolean) => {
      if (!activeSession) return;
      setComposerOverlayVisible(
        {
          kind: "session",
          sessionId: activeSession.id,
        },
        visible,
      );
    },
    [activeSession, setComposerOverlayVisible],
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
  const scheduledAutomationsQuery = useCodexScheduledAutomations();
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
  const workbenchCodexControl = useCodexAppServerControl(activeProject?.id ?? activeProjectId);
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
          })
        : null,
    [
      activePlanKeyBySession,
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
    (activeImageEditorOwnsRootComposer || Boolean(activeSession.thread)) &&
    isRootThreadRightPanelComposerOverlayEligibleTab(rightActiveRenderableTab),
  );
  const rightPanelComposerOverlayCompact =
    rightPanelComposerOverlayEnabled &&
    rightActiveRenderableTab !== null &&
    "kind" in rightActiveRenderableTab &&
    rightActiveRenderableTab.kind === "browser";
  const rightPanelComposerOverlayBrowserTabId =
    rightPanelComposerOverlayCompact && rightActiveRenderableTab
      ? rightActiveRenderableTab.id
      : null;
  const rightPanelComposerOverlayBrowserIdentity =
    rightPanelComposerOverlayBrowserTabId && activeSession
      ? {
          browserConversationId: activeSession.id,
          browserViewScopeId: windowSessionId,
          browserTabId: rightPanelComposerOverlayBrowserTabId,
        }
      : null;
  const rightPanelComposerOverlayAtDocumentBottom = useBrowserDocumentBottom(
    rightPanelComposerOverlayBrowserIdentity,
  );
  const rightPanelComposerOverlayDocumentBottomKey = getBrowserDocumentBottomKey(
    rightPanelComposerOverlayBrowserIdentity,
  );
  const rightPanelComposerOverlayVisibility = activeSessionScene
    ? rightPanelComposerOverlayCompact
      ? {
          kind: "controlled-browser-auto" as const,
          visible: activeSessionScene.composerOverlay.visible,
          attention: "none" as const,
          onVisibleChange: setActiveSessionComposerOverlayVisible,
          documentBottomKey: rightPanelComposerOverlayDocumentBottomKey,
          isAtDocumentBottom: rightPanelComposerOverlayAtDocumentBottom,
        }
      : {
          kind: "controlled" as const,
          visible: activeSessionScene.composerOverlay.visible,
          attention: "none" as const,
          onVisibleChange: setActiveSessionComposerOverlayVisible,
        }
    : undefined;
  const shellCanNavigateBack = workbenchWindow.canNavigateBack;
  const shellCanNavigateForward = workbenchWindow.canNavigateForward;
  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const {
    appShellHeaderEdgeScroll,
    appShellMainContentFrameBorderVisible,
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
    realSidebarMounted,
    regularRightPanelWidth,
    rightHeaderShellSlotWidth,
    rightPanelMotion,
    rightPanelRequestedWidth,
    rightPanelTargetWidth,
    safeHeaderLeftWidth,
    shellBodySize,
    shellMainContentWidth,
    shellWidthClass,
    threadSummaryPanelLayoutMode,
  } = useWorkbenchChromeLayout({
    activeSessionId: activeSession?.id ?? null,
    automationsRouteOpen: Boolean(automationsPath),
    bottomPanelOpen,
    bottomPanelRequestedHeight: bottomPanel?.size.heightPx ?? null,
    headerLeftWidth,
    isMacPlatform,
    reducedMotion,
    rightPanelFullWidth,
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

  const openKeyboardShortcutsSettings = useCallback(() => {
    closePendingWorktreeRoute();
    setAutomationsPath(null);
    setReopenStableWorktreeAfterSettingsId(null);
    setReopenPendingWorktreeAfterSettingsClientThreadId(null);
    setLocalEnvironmentSettingsInitial(null);
    setSettingsPath(buildSettingsPath("keyboard-shortcuts"));
  }, [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath]);

  const openVoiceSettings = useCallback(() => {
    closePendingWorktreeRoute();
    setAutomationsPath(null);
    setReopenStableWorktreeAfterSettingsId(null);
    setReopenPendingWorktreeAfterSettingsClientThreadId(null);
    setLocalEnvironmentSettingsInitial(null);
    setSettingsPath(buildSettingsPath("voice"));
  }, [closePendingWorktreeRoute, setAutomationsPath, setSettingsPath]);

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
        agentMode: workbenchCodexControl.permissionMode,
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
      workbenchCodexControl.permissionMode,
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

  const presentExistingDatabaseView = useCallback(
    async (projectId: string, databaseViewId: string): Promise<boolean> => {
      const result = await sceneNavigator.presentPanelSurface({
        owner: { kind: "project", projectId },
        request: {
          kind: "db_view",
          config: {
            accessContext: { kind: "project", projectId },
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
        readonly titleSnapshot?: string;
        readonly placement?: PresentWorkbenchPanelSurfaceInput["target"]["placement"];
        readonly targetLeafId?: string;
        readonly targetPanelId?: PanelId;
        readonly mode?: PresentWorkbenchPanelSurfaceInput["mode"];
      } = {},
    ): Promise<boolean> => {
      try {
        const request: WorkbenchSurfaceOpenRequest =
          target.kind === "page"
            ? {
                kind: "page_stage",
                config: {
                  accessContext: { kind: "library" },
                  pageId: target.pageId,
                  ...(options.titleSnapshot ? { titleSnapshot: options.titleSnapshot } : {}),
                },
                titleSnapshot: options.titleSnapshot,
              }
            : target.kind === "canvas"
              ? {
                  kind: "canvas_stage",
                  config: {
                    accessContext: { kind: "library" },
                    canvasBlockId: target.canvasId,
                    ...(options.titleSnapshot ? { titleSnapshot: options.titleSnapshot } : {}),
                  },
                  titleSnapshot: options.titleSnapshot,
                }
              : target.kind === "database"
                ? {
                    kind: "db_view",
                    config: {
                      accessContext: { kind: "library" },
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
                      accessContext: { kind: "library" },
                      target: {
                        kind: "database-view",
                        databaseViewId: target.viewId,
                      },
                    },
                    titleSnapshot: options.titleSnapshot,
                  };
        const presented = await sceneNavigator.presentPanelSurface({
          owner: { kind: "pages" },
          request,
          target: {
            panelId: options.targetPanelId ?? "right",
            ...(options.targetLeafId ? { leafId: options.targetLeafId } : {}),
            ...(options.placement ? { placement: options.placement } : {}),
          },
          mode: options.mode ?? "durable",
          navigation: "select-owner",
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

  useRegisterFileLocationNavigator(presentLibraryTarget);

  const sidebarController = useWorkbenchSidebarController({
    projects,
    projectlessSessions,
    knownSessions,
    activeProject,
    activeSessionId,
    activeSessions,
    pendingSessionOpen,
    pendingWorktreeClientThreadId,
    catalog: sessionCatalog,
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
    activeSession,
    controller: panelController,
    createSessionViewTab,
    codexControl: workbenchCodexControl,
    panelGroupTabsRef,
    pinningPreviewTabIdsRef,
    windowSessionId,
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
      return (
        panelControllerRef.current.sceneDurable?.patchPanel(activeOwnedSceneOwner, panelId, {
          ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
          ...(input.size === undefined ? {} : { size: input.size }),
        }) ?? null
      );
    },
    [activeOwnedSceneOwner, updateActivePanel],
  );
  const setActiveWorkbenchPanelCollapsed = useCallback(
    async (panelId: PanelId, collapsed: boolean) => {
      if (activeOwnedSceneOwner && panelId === "right" && collapsed) {
        return activeOwnedScene?.panels.right ?? null;
      }
      if (!activeOwnedSceneOwner || !activeOwnedSceneKey) {
        return await setActivePanelCollapsed(panelId, collapsed);
      }
      const overrideKey = makeWorkbenchPanelSlotKey(activeOwnedSceneKey, panelId);
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [overrideKey]: collapsed,
      }));
      try {
        return await updateActiveWorkbenchPanel(panelId, { collapsed });
      } finally {
        panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
          if (!(overrideKey in current)) return current;
          const next = { ...current };
          delete next[overrideKey];
          return next;
        });
      }
    },
    [
      activeOwnedSceneKey,
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
            accessContext: { kind: "project", projectId },
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
            accessContext: { kind: "project", projectId },
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
      const workspaceRoot = projectWorkspaceRootOrNull(project);
      return await presentProjectSceneSurface(
        projectId,
        {
          kind,
          titleSnapshot: options.path?.split(/[\\/]/).pop() || "Files",
          config: {
            projectId,
            hostId: "local",
            workspaceRoot,
            cwd: workspaceRoot,
            ...(options.path ? { path: options.path } : {}),
          },
        },
        panelOptions,
      );
    },
    [presentProjectSceneSurface, projects],
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

  const panelOpeners = useWorkbenchPanelOpeners({
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
    openScheduledAutomationChatCreate,
    startScheduledAutomationTemplateChat,
    openSidebarCommandPalette,
    openCommandPalette,
    requestContentSearchOpen,
    showSidebarUnavailableProduct,
    activateReviewTab,
    openSubagentsPanelTab,
    openAttachedThreadSession,
    openAttachedThreadSessionById,
    openResolvedPendingThreadSession,
    openAutomationHistoryThreadSessionById,
    openProcessOutputInCurrentSession,
    openProcessManagerOutput,
    openTurnDiffFileInSidePanel,
    openSummaryOutputInSidePanel,
    consumeNewThreadComposerIntent,
    forkSessionFromTurn,
    forkSessionFromTurnIntoWorktree,
  } = sessionCommands;
  const openSettingsThreadSessionById = useCallback(
    async (threadId: string) => {
      const opened = await openAttachedThreadSessionById(threadId);
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
    rightPanelFullWidth,
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
    automationsDetailRailRequestedWidth,
  });
  const {
    showActiveRightPanel,
    hideActiveRightPanel,
    showActiveBottomPanel,
    hideActiveBottomPanel,
    toggleActiveRightPanelFullWidth,
    executeShellNavigation,
    resizeRightPanel,
    resizeAutomationDetailRail,
    resizeBottomPanel,
  } = chromeCommands;
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

  const { panelGroupTabs, browserRetentionTabs, visibleBrowserTabIds } =
    useWorkbenchPanelProjection({
      activeRenderSession,
      activeSessionPanelModel,
      projects,
      pageStageRelatedChatCandidates,
      pageTitleStore,
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
        windowSessionId,
        onLeavePageStage,
        pageStageCloseRef,
        pageStageHistoryModal,
        pageStagePersistRef,
        pageStageSessionSnapshotRef,
        searchByProject,
        setSearchQuery,
        taskSearchOpenTick,
      },
      conversation: {
        composerEnterBehavior,
        threadQueueFollowUpsEnabled,
        onOpenHooksSettings: openHooksSettings,
        onQueueingEnabledChange: handleThreadQueueFollowUpsEnabledChange,
        onRefreshSessions: refreshProjectSessions,
      },
      automation: {
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
    const atMediumWidth = shellWidthClass !== "wide";
    const atNarrowWidth = shellWidthClass === "narrow";
    const crossedMediumWidth = atMediumWidth !== shellAtMediumWidthRef.current;
    const crossedNarrowWidth = atNarrowWidth !== shellAtNarrowWidthRef.current;
    if (!crossedMediumWidth && !crossedNarrowWidth) return;

    shellAtMediumWidthRef.current = atMediumWidth;
    shellAtNarrowWidthRef.current = atNarrowWidth;

    if (!activePanelOwnerKey || !rightPanel) return;

    const shouldClearRightPanel =
      (crossedMediumWidth && atMediumWidth && sidebarOpen && sidePanelOpen) ||
      (crossedNarrowWidth && atNarrowWidth && sidePanelOpen);
    if (shouldClearRightPanel) {
      setFloatingSidebarFocusActive(false);
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
      setSidebarCollapsedWithCodexState(true, {
        animate: false,
        suppressHoverOpen: true,
      });
    }
  }, [
    activePanelOwnerKey,
    rightPanel,
    setFloatingSidebarFocusActive,
    setSidebarCollapsedWithCodexState,
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
    rightPanelFullWidth,
    pinnedOpen: threadSummaryPanelPinnedOpen,
    sideChatTabs: activeSession ? (sideChatTabsBySession[activeSession.id] ?? []) : [],
    previewTabsByPanel,
    scheduledAutomations: scheduledAutomationsQuery.data ?? [],
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
      activeProject={activeProject}
      activeSession={activeSession}
      pinnedOpen={threadSummaryPanelPinnedOpen}
      onTogglePinnedOpen={toggleThreadSummaryPanel}
      summary={threadSummary}
    />
  );

  const toggleActiveSidePanel = useCallback(() => {
    if (!activePanelOwnerKey || projectSceneOwner) return;
    if (!sidePanelOpen) {
      void showActiveRightPanel();
      return;
    }
    void hideActiveRightPanel();
  }, [
    activePanelOwnerKey,
    hideActiveRightPanel,
    projectSceneOwner,
    showActiveRightPanel,
    sidePanelOpen,
  ]);

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

  const handleDesktopNotificationAction = useCallback(
    async (invocation: DesktopNotificationActionInvocation): Promise<void> => {
      const parentThreadId = resolveDesktopNotificationParentThreadId(invocation);
      if (!parentThreadId) return;

      const opened = await openAttachedThreadSessionById(parentThreadId);
      if (!opened) return;
      const presented = await waitForActiveThread(parentThreadId);
      if (!presented) return;

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
      return false;
    },
    [activeProject?.id, activeProjectId, appHandle, toggleActiveBottomPanel],
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
      goToPages: workbenchWindow.selectPages,
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
      workbenchWindow.selectPages,
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
        onPointerEnter={() => setSidebarTriggerHovered(true)}
        onPointerLeave={() => {
          setSidebarTriggerHovered(false);
          setSidebarHoverSuppressed(false);
          setSidebarClickInFlight(false);
        }}
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
    <div className="flex items-center gap-1" data-testid="workbench-window-navigation-chrome">
      {sidebarCollapseControlButton}
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
      {!projectSceneOwner ? (
        <HeaderAction
          actionId="workbench-side-panel-toggle"
          slotPosition="right"
          align="end"
          order={300}
        >
          <ToolbarIconButton
            label="Toggle side panel"
            pressed={sidePanelOpen}
            onClick={toggleActiveSidePanel}
          >
            {sidePanelOpen ? (
              <PanelRightVisibleIcon className="icon-sm" />
            ) : (
              <PanelRightHiddenIcon className="icon-sm" />
            )}
          </ToolbarIconButton>
        </HeaderAction>
      ) : null}
    </>
  ) : null;

  const headerActions = (
    <>
      {sidebarHeaderActions}
      {threadSummaryHeaderAction ? (
        <HeaderAction
          actionId="local-thread-summary-panel-toggle"
          slotPosition="center"
          align="end"
          order={250}
        >
          {threadSummaryHeaderAction}
        </HeaderAction>
      ) : null}
      {panelHeaderActions}
    </>
  );

  const rightPanelHeaderStartInsetWidth =
    activePanelOwnerKey && rightPanelFullWidth && sidebarLogicalCollapsed
      ? effectiveHeaderLeftWidth
      : 0;
  const panelTabScrollEndPaddingPx = activePanelOwnerKey ? 28 : 0;
  const bottomPanelGlobalHeaderInsetWidth = activePanelOwnerKey ? 40 : 0;

  const rightPanelHeaderAfterList = activePanelOwnerKey ? (
    <>
      {!projectSceneOwner ? (
        <div className="no-drag pointer-events-auto flex h-full shrink-0 items-center">
          <ToolbarIconButton
            label={rightPanelFullWidth ? "Restore panel width" : "Expand panel"}
            pressed={rightPanelFullWidth}
            onClick={toggleActiveRightPanelFullWidth}
          >
            {rightPanelFullWidth ? (
              <RestorePanelIcon className="icon-xs" />
            ) : (
              <ExpandPanelIcon className="icon-xs" />
            )}
          </ToolbarIconButton>
        </div>
      ) : null}
      <div
        aria-hidden="true"
        data-testid="right-panel-tab-bar-header-spacer"
        className="no-drag pointer-events-none h-full shrink-0"
        style={{ width: `calc(${headerRightWidth}px)` }}
      />
    </>
  ) : null;

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
    (floatingSidebarVisible || floatingSidebarResizing);
  const showInlineSidebar = realSidebarMounted;
  const floatingSidebarTransition = getCodexSidebarFloatingTransition(Boolean(reducedMotion));
  const floatingSidebarExitX = reducedMotion ? 0 : -8;
  const floatingSidebarHeaderExitX = reducedMotion ? 0 : 8;
  const applicationMenuBarEnabled =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-codex-window-chrome") === "application-menu";
  const floatingSidebarOuterClassName =
    getCodexSidebarFloatingOuterClassName(applicationMenuBarEnabled);
  const floatingSidebarHeader = (
    <motion.div
      className={CODEX_SIDEBAR_FLOATING_HEADER_CLASS}
      initial={reducedMotion ? false : { x: 8 }}
      animate={{ x: 0 }}
      exit={{ x: floatingSidebarHeaderExitX }}
      transition={floatingSidebarTransition}
    >
      <NodexTooltip delayOpen tooltipContent="Toggle sidebar" side="bottom">
        <button
          type="button"
          onClick={showRealSidebarFromFloatingPanel}
          aria-label="Show sidebar"
          className={SIDEBAR_COLLAPSED_CHROME_BUTTON_CLASS}
          style={{ viewTransitionName: "sidebar-trigger" }}
        >
          <SidebarHiddenIcon className="icon-xs" />
        </button>
      </NodexTooltip>
    </motion.div>
  );
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
  const { automationsRouteShell, pendingWorktreeRouteShell, settingsRouteShell } =
    useWorkbenchRouteSurfaces({
      settings: {
        path: settingsPath,
        props: {
          onPathChange: setSettingsPath,
          onBackToApp: closeSettings,
          onRequestProjectPickerOpen,
          onOpenThread: openSettingsThreadSessionById,
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
        path: automationsPath,
        props: {
          projects,
          externalHeader: true,
          detailRailPortalTarget: automationsDetailRailPortalElement,
          onDetailRailOpenChange: setAutomationsDetailRailOpen,
          onPathChange: setAutomationsPath,
          onOpenThread: openAutomationHistoryThreadSessionById,
          onCreateWithChat: openScheduledAutomationChatCreate,
          onPersonalizeTemplate: startScheduledAutomationTemplateChat,
          onOpenLocalEnvironmentsSettings: openLocalEnvironmentsSettings,
        },
      },
      pendingWorktree: {
        clientThreadId: pendingWorktreeClientThreadId,
        props: {
          agentMode: workbenchCodexControl.permissionMode,
          externalHeader: true,
          onClose: closePendingWorktreeRoute,
          onOpenThread: async (threadId) => {
            if (!pendingWorktreeClientThreadId) return;
            return await openResolvedPendingThreadSession(pendingWorktreeClientThreadId, threadId);
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
  const appShellHeaderCenterVisible =
    settingsRouteShell == null &&
    (activePanelOwnerKey != null ||
      automationsRouteShell != null ||
      pendingWorktreeRouteShell != null);
  const appShellHeaderActions = settingsPath
    ? null
    : pendingWorktreeRouteShell
      ? null
      : automationsPath || sceneLocation.kind === "pages"
        ? sidebarHeaderActions
        : headerActions;
  const automationsDetailRailMounted = Boolean(automationsRouteShell && automationsDetailRailOpen);
  const automationsDetailRailOpenValue = useSyncedMotionValue(automationsDetailRailMounted ? 1 : 0);
  const automationsDetailRailResolvedWidth = useTransform(
    [automationsDetailRailOpenValue, automationsDetailRailRequestedWidth, shellMainContentWidth],
    ([latestOpen, latestRequestedWidth, latestShellWidth]) =>
      Number(latestOpen) > 0
        ? clampAutomationDetailRailWidth(Number(latestRequestedWidth), Number(latestShellWidth))
        : 0,
  );

  const commandPalette = (
    <WorkbenchCommandPaletteHost
      open={commandPaletteOpen}
      openRequest={commandPaletteOpenRequest}
      projects={projects}
      activeProjectId={activeProject?.id ?? activeProjectId}
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
      openAutomations={openAutomations}
      openLibraryFiles={() => {
        const projectId = activeProject?.id ?? activeProjectId;
        openModal(appHandle, LibraryFilesDialog, {
          accessContext: projectId ? projectContentAccess(projectId) : libraryContentAccess,
        });
      }}
      openProcessManager={() => setProcessManagerOpen(true)}
      openSettings={openSettings}
      openKeyboardShortcuts={openKeyboardShortcutHelp}
      onOpenSessionInNewWindow={onOpenProjectSessionInNewWindow}
    />
  );

  const activeSessionProject = activeRenderSession?.projectId
    ? (projects.find((project) => project.id === activeRenderSession.projectId) ?? activeProject)
    : null;
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
        if (previewEntry) {
          sceneNavigator.clearPreview({
            owner: activeProjectScene.owner,
            panelId: previewEntry.panelId,
            leafId: previewEntry.leafId,
            surfaceId: surface.id,
          });
          return;
        }
        if (!projectSceneOwner) return;
        panelControllerRef.current.sceneDurable?.removeSurface(projectSceneOwner, surface.id);
      };

      if (surface.kind === "db_view") {
        const databaseViewId =
          surface.config.target.kind === "project-default"
            ? activeProject.defaultDatabaseViewId
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
            projectId:
              surface.config.accessContext.kind === "project"
                ? surface.config.accessContext.projectId
                : activeProject.id,
            databaseViewId,
          },
        };
        return (
          <DbViewSessionTab
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
        const projectId =
          surface.config.accessContext.kind === "project"
            ? surface.config.accessContext.projectId
            : activeProject.id;
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
        const tab: WorkbenchTabProjection = {
          ...common,
          kind: "page_stage",
          config: {
            projectId:
              surface.config.accessContext.kind === "project"
                ? surface.config.accessContext.projectId
                : activeProject.id,
            pageId: surface.config.pageId,
            ...(surface.config.titleSnapshot
              ? { titleSnapshot: surface.config.titleSnapshot }
              : {}),
          },
        };
        return (
          <PageStageSessionTab
            tab={tab}
            project={
              projects.find(
                (item) =>
                  item.id ===
                  (surface.config.accessContext.kind === "project"
                    ? surface.config.accessContext.projectId
                    : activeProject.id),
              ) ?? null
            }
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

      if (surface.kind === "files") {
        const tab: WorkbenchTabProjection = {
          ...common,
          kind: "files",
          config: surface.config,
        };
        return (
          <WorkspaceFilesPanel
            tab={tab as WorkspaceFilesTab}
            presentationOwnerId={projectSceneKey}
            project={projects.find((item) => item.id === surface.config.projectId) ?? activeProject}
            onOpenFileTab={async (input) =>
              openProjectSceneManualSurface(activeProject.id, "files", {
                panelId: input.panelId,
                path: input.path,
              })
            }
            onUpdateTabState={(state) => {
              if (!projectSceneOwner) return;
              panelControllerRef.current.sceneDurable?.updateSurface(
                projectSceneOwner,
                surface.id,
                { state },
              );
            }}
          />
        );
      }

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
          <BrowserSidebarPanel
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
      activeProject,
      activeProjectScene,
      activeSearchQuery,
      bottomPanelMotion.animatedSize,
      ensureDefaultDraftSessionForProject,
      onLeavePageStage,
      openAttachedThreadSessionById,
      openBrowserSettings,
      openProjectSceneCanvas,
      openProjectSceneManualSurface,
      openProjectScenePage,
      sessionCommands.openPageInNewChat,
      sessionCommands.openProjectSessionById,
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
      sceneNavigator,
      setSearchQuery,
      taskSearchOpenTick,
      togglePageStageHistoryModal,
      rightPanelMotion.animatedSize,
      updateSceneSurfacePresentation,
      windowSessionId,
    ],
  );
  const closePagesSceneSurfaceRuntime = useCallback(
    async (surface: WorkbenchSurfaceDescriptor, removeDescriptor: () => void): Promise<void> => {
      if (surface.kind === "canvas_stage" && pagesSceneKey) {
        try {
          await canvasSceneSurfaceRegistry.dispose(
            makeCanvasSceneSurfaceKey(windowSessionId, pagesSceneKey, surface.id),
          );
        } catch {
          toast.danger("Canvas changes could not be saved locally");
          return;
        }
      }
      removeDescriptor();
      if (surface.kind !== "page_stage") return;
      await documentSessionRegistry.dispose(`library-page:${surface.id}`).catch(() => {
        toast.danger("Page changes could not be saved locally");
      });
    },
    [pagesSceneKey, windowSessionId],
  );
  const renderPagesSceneSurface = useCallback(
    (
      surface: WorkbenchSurfaceDescriptor,
      context: { readonly active: boolean; readonly panelId: PanelId },
    ) => {
      if (!activePagesScene || !pagesSceneOwner || !pagesSceneKey) {
        return null;
      }
      const previewEntry =
        listWorkbenchScenePreviewEntries(activePagesScene, previewSurfacesByPanel).find(
          (entry) => entry.surface.id === surface.id,
        ) ?? null;
      const removeSurface = () => {
        if (previewEntry) {
          sceneNavigator.clearPreview({
            owner: activePagesScene.owner,
            panelId: previewEntry.panelId,
            leafId: previewEntry.leafId,
            surfaceId: surface.id,
          });
          return;
        }
        void (async () => {
          await closePagesSceneSurfaceRuntime(surface, () => {
            panelControllerRef.current.sceneDurable?.removeSurface(pagesSceneOwner, surface.id);
          });
        })();
      };
      const publishTitle = (title: string) => {
        if (surface.titleSnapshot === title) return;
        updateSceneSurfacePresentation(pagesSceneOwner, surface.id, { titleSnapshot: title });
      };

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
            accessContext={surface.config.accessContext}
            target={surface.config.target}
            keyboardSurface={{
              surfaceId: surface.id,
              presentationId: surface.id,
            }}
            presentedPageIds={pagesScenePresentedPageIds}
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
            onOpenDatabase={(databaseId) => {
              void presentLibraryTarget(
                { kind: "database", databaseId },
                { placement: { kind: "same-group", sourceSurfaceId: surface.id } },
              );
            }}
            onOpenPage={(pageId, titleSnapshot) => {
              void presentLibraryTarget(
                { kind: "page", pageId },
                {
                  titleSnapshot,
                  placement: { kind: "same-group", sourceSurfaceId: surface.id },
                },
              );
            }}
            onOpenCanvas={(canvasId, titleSnapshot) => {
              void presentLibraryTarget(
                { kind: "canvas", canvasId },
                {
                  titleSnapshot,
                  placement: { kind: "same-group", sourceSurfaceId: surface.id },
                },
              );
            }}
          />
        );
      }

      if (surface.kind === "canvas_stage") {
        return (
          <WorkbenchCanvasStagePanel
            surface={surface}
            windowSessionId={windowSessionId}
            presentationOwnerId={pagesSceneKey}
            isActivePanelTab={context.active}
            onClose={removeSurface}
            onTitleChange={publishTitle}
            onOpenPage={({ pageId, titleSnapshot }) => {
              void presentLibraryTarget(
                { kind: "page", pageId },
                {
                  titleSnapshot,
                  placement: { kind: "same-group", sourceSurfaceId: surface.id },
                },
              );
            }}
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
      activePagesScene,
      closePagesSceneSurfaceRuntime,
      presentLibraryTarget,
      pagesSceneKey,
      pagesScenePresentedPageIds,
      pagesSceneOwner,
      pageStageCloseRef,
      previewSurfacesByPanel,
      projects,
      sceneNavigator,
      sessionCommands.openPageInNewChat,
      sessionCommands.openProjectSessionById,
      sessionCommands.sendPageToChat,
      updateSceneSurfacePresentation,
      windowSessionId,
    ],
  );
  const closeProjectSceneSurfaceRuntime = useCallback(
    async (surface: WorkbenchSurfaceDescriptor, removeDescriptor: () => void): Promise<void> => {
      if (!projectSceneKey) return;
      if (surface.kind === "files") {
        const saved = await workspaceTextDocumentRegistry.flush(surface.id);
        if (!saved) {
          toast.danger("Resolve the file conflict before closing this tab");
          return;
        }
      }
      if (surface.kind === "canvas_stage") {
        try {
          await canvasSceneSurfaceRegistry.dispose(
            makeCanvasSceneSurfaceKey(windowSessionId, projectSceneKey, surface.id),
          );
        } catch {
          toast.danger("Canvas changes could not be saved locally");
          return;
        }
      }
      if (surface.kind === "terminal") {
        terminalSessionStore.release(surface.config.terminalSessionId);
      }
      removeDescriptor();
      if (surface.kind === "page_stage") {
        await documentSessionRegistry
          .dispose(makeEditorSurfaceKey(projectSceneKey, surface.id))
          .catch(() => {
            toast.danger("Page changes could not be saved locally");
          });
      }
      if (surface.kind === "browser") {
        try {
          await invokeBrowserSidebarCommand({
            type: "close-tab",
            browserConversationId: projectSceneKey,
            browserViewScopeId: windowSessionId,
            browserTabId: surface.config.browserTabId,
          });
        } catch {
          // Browser runtime cleanup is best effort; the durable descriptor still closes.
        }
      }
    },
    [projectSceneKey, windowSessionId],
  );
  const closeActiveOwnedScenePanelTab = useCallback(
    async (tabId: string): Promise<void> => {
      if (!activeOwnedScene || !activeOwnedSceneOwner) return;
      const previewEntry = listWorkbenchScenePreviewEntries(
        activeOwnedScene,
        previewSurfacesByPanel,
      ).find((entry) => entry.surface.id === tabId);
      if (previewEntry) {
        sceneNavigator.clearPreview({
          owner: activeOwnedSceneOwner,
          panelId: previewEntry.panelId,
          leafId: previewEntry.leafId,
          surfaceId: tabId,
        });
        return;
      }
      const surface = resolveWorkbenchSceneSurface(activeOwnedScene, tabId);
      if (!surface) return;
      const removeDescriptor = () => {
        panelControllerRef.current.sceneDurable?.removeSurface(activeOwnedSceneOwner, surface.id);
      };
      if (activeOwnedSceneOwner.kind === "project") {
        await closeProjectSceneSurfaceRuntime(surface, removeDescriptor);
        return;
      }
      if (activeOwnedSceneOwner.kind === "pages") {
        await closePagesSceneSurfaceRuntime(surface, removeDescriptor);
      }
    },
    [
      activeOwnedScene,
      activeOwnedSceneOwner,
      closePagesSceneSurfaceRuntime,
      closeProjectSceneSurfaceRuntime,
      previewSurfacesByPanel,
      sceneNavigator,
    ],
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
          tabOpenerStore: panelController.tabOpenerStore,
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
          currentProjectDbViewExists:
            projectScenePresentation.scene.primary?.kind === "db_view" ||
            Object.values(projectScenePresentation.scene.panelSurfacesById).some(
              (surface) => surface.kind === "db_view",
            ),
          rightPanelHeaderAfterList,
          rightPanelHeaderStartInsetWidth,
          bottomPanelGlobalHeaderInsetWidth,
          panelTabScrollEndPaddingPx,
          renderSurface: renderProjectSceneSurface,
          onCloseSurface: closeProjectSceneSurfaceRuntime,
          onFocusGroup: (panelId, leafId) => {
            panelCommands.rememberFocusedPanelGroup(panelId, leafId);
          },
          onClearPreview: (panelId, leafId, surfaceId) => {
            sceneNavigator.clearPreview({
              owner: projectScenePresentation.scene.owner,
              panelId,
              leafId,
              surfaceId,
            });
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
            if (action === "canvas_stage") {
              void openProjectSceneCanvas(
                activeProject.id,
                primaryCanvasBlockId(activeProject.id),
                "Canvas",
                { targetPanelId: panelId, targetLeafId: leafId },
              );
              return;
            }
            if (action === "browser" || action === "files" || action === "terminal") {
              void openProjectSceneManualSurface(activeProject.id, action, {
                panelId,
                targetLeafId: leafId,
              });
              return;
            }
            if (action !== "db_view" || !activeProject.defaultDatabaseViewId) return;
            void presentProjectSceneSurface(
              activeProject.id,
              {
                kind: "db_view",
                config: {
                  accessContext: {
                    kind: "project",
                    projectId: activeProject.id,
                  },
                  target: { kind: "project-default" },
                },
              },
              { panelId, targetLeafId: leafId },
            );
          },
          onOpenDestination: async (panelId, leafId, destination) => {
            if (destination.kind === "page") {
              await presentProjectSceneSurface(
                activeProject.id,
                {
                  kind: "page_stage",
                  config: {
                    accessContext: {
                      kind: "project",
                      projectId: destination.projectId,
                    },
                    pageId: destination.pageId,
                    ...(destination.titleSnapshot
                      ? { titleSnapshot: destination.titleSnapshot }
                      : {}),
                  },
                  titleSnapshot: destination.titleSnapshot,
                },
                { panelId, targetLeafId: leafId },
              );
              return;
            }
            await presentProjectSceneSurface(
              activeProject.id,
              {
                kind: "db_view",
                config: {
                  accessContext: {
                    kind: "project",
                    projectId: destination.projectId,
                  },
                  target: {
                    kind: "database-view",
                    databaseViewId: destination.databaseViewId,
                  },
                },
              },
              { panelId, targetLeafId: leafId },
            );
          },
        })
      : null;
  const pagesScenePanels =
    pagesScenePresentation && panelController.sceneDurable
      ? buildWorkbenchScenePanels({
          scene: pagesScenePresentation.scene,
          project: null,
          projects,
          currentLibraryId,
          browserViewScopeId: windowSessionId,
          browserTabSnapshotByKey,
          pageTitleStore,
          commands: panelController.sceneDurable,
          tabOpenerStore: panelController.tabOpenerStore,
          previewSurfaceIds: pagesScenePresentation.previewSurfaceIds,
          isMac: isMacPlatform,
          commandKeymapState,
          availableActions: [],
          currentProjectDbViewExists: false,
          rightPanelHeaderAfterList,
          rightPanelHeaderStartInsetWidth,
          bottomPanelGlobalHeaderInsetWidth,
          panelTabScrollEndPaddingPx,
          renderSurface: renderPagesSceneSurface,
          renderNewTab: (panelId, leafId) => (
            <PagesTabPicker
              onOpenTarget={(target, titleSnapshot) => {
                void presentLibraryTarget(target, {
                  titleSnapshot,
                  targetPanelId: panelId,
                  targetLeafId: leafId,
                });
              }}
            />
          ),
          renderEmptyLeaf: (panelId, leafId) => (
            <EmptyPagesScene
              onOpenTarget={(target, titleSnapshot) => {
                void presentLibraryTarget(target, {
                  titleSnapshot,
                  targetPanelId: panelId,
                  targetLeafId: leafId,
                });
              }}
            />
          ),
          onCloseSurface: closePagesSceneSurfaceRuntime,
          onFocusGroup: (panelId, leafId) => {
            panelCommands.rememberFocusedPanelGroup(panelId, leafId);
          },
          onClearPreview: (panelId, leafId, surfaceId) => {
            sceneNavigator.clearPreview({
              owner: pagesScenePresentation.scene.owner,
              panelId,
              leafId,
              surfaceId,
            });
          },
          onPinPreview: (panelId, leafId, surfaceId) => {
            sceneNavigator.pinPreview({
              owner: pagesScenePresentation.scene.owner,
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
            projection: projectWorkbenchPanelTabShortcutProjection(panelGroupTabs),
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
  const projectAgentDockAttention = projectAgentDockPendingWorktreeModel
    ? projectAgentDockPendingWorktreeModel.attention
    : (projectAgentDockModel?.trigger.attention ?? "none");
  const projectAgentDock =
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
              visibility: {
                kind: "controlled",
                visible: activeProjectScene.composerOverlay.visible,
                attention: projectAgentDockAttention,
                onVisibleChange: setProjectAgentDockVisible,
              },
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
            onOpenHooksSettings={openHooksSettings}
            onOpenVoiceSettings={openVoiceSettings}
            threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
            composerEnterBehavior={composerEnterBehavior}
            onQueueingEnabledChange={handleThreadQueueFollowUpsEnabledChange}
            onOpenThread={openAttachedThreadSession}
            commandKeymapState={commandKeymapState}
            isMac={isMacPlatform}
          />
        </WorkbenchSessionScopePath>
      ) : (
        <ProjectAgentDockUnavailableOverlay
          target={rightPanelComposerOverlayTarget}
          visible={activeProjectScene.composerOverlay.visible}
          attention={projectAgentDockAttention}
          onVisibleChange={setProjectAgentDockVisible}
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
          primaryTestId="project-database-surface"
          primaryHidden
          rightPanelTestId="project-right-panel"
          bottomPanelTestId="project-bottom-panel"
          layout={{
            appShellMainContentLayout: "default",
            frameBorderVisible: appShellMainContentFrameBorderVisible,
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
  const pagesSceneRoute =
    pagesSceneKey && activePagesScene && pagesScenePresentation ? (
      <WorkbenchSessionScopePath
        thread={APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR}
        route={{
          routeKey: "/pages",
          kind: "pages",
        }}
        selected
      >
        <PagesSceneBreadcrumb scene={pagesScenePresentation.scene} />
        <WorkbenchSceneFrame
          ownerKey={pagesSceneKey}
          primary={null}
          primaryTestId="pages-primary-surface"
          primaryHidden
          rightPanelTestId="pages-right-panel"
          bottomPanelTestId="pages-bottom-panel"
          layout={{
            appShellMainContentLayout: "default",
            frameBorderVisible: appShellMainContentFrameBorderVisible,
            rightPanelTargetWidth,
            bottomPanelHeight,
            rightPanel: {
              ...rightPanelMotion,
              open: sidePanelOpen,
              fullWidth: rightPanelFullWidth,
              content: pagesScenePanels?.right ?? null,
            },
            bottomPanel: {
              ...bottomPanelMotion,
              open: bottomPanelOpen,
              content: pagesScenePanels?.bottom ?? null,
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
    activeRenderSession && activeSessionPanelModel ? (
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
        layout={{
          appShellMainContentLayout,
          frameBorderVisible: appShellMainContentFrameBorderVisible,
          rightPanelTargetWidth,
          bottomPanelHeight,
          rightPanel: rightPanelMotion,
          bottomPanel: bottomPanelMotion,
          rightPanelHeaderStartInsetWidth,
          panelTabScrollEndPaddingPx,
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
            const rootThreadId = activeRenderSession.thread?.threadId;
            if (!rootThreadId) return;
            void openSubagentsPanelTab(rootThreadId);
          },
          onOpenTurnDiffFileInSidePanel: openTurnDiffFileInSidePanel,
          turnDiffHoverPreviewDisabled: activeSessionPanelModel.sidePanelOpen,
          onForkSessionFromTurn: forkSessionFromTurn,
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
          rightPanelComposerOverlayCompact,
          rightPanelComposerOverlayTarget,
          rightPanelComposerOverlayVisibility,
          onOpenSideChat: filterAvailablePanelActions(
            PANEL_NEW_TAB_ACTIONS,
            activeRenderSession.tabs,
            "right",
            {
              kind: "session",
              backendKind: activeRenderSession.thread?.backendBinding.kind ?? "codex",
              projectId: activeRenderSession.projectId,
              hasAttachedThread: Boolean(activeRenderSession.thread),
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
    onLoadMoreProjects,
    activeProjectId,
    activeSessionId: activeSession?.id ?? null,
    activePendingClientThreadId: pendingWorktreeClientThreadId,
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
    sidebarCollapsibleSections: sidebarState.sections,
    onLoadMoreTaskWindow: loadMoreProjectSessionSummaries,
    onRetryTaskWindow: sessionCatalog.retryCollection,
    width: sidebarWidth,
    getWindowZoom,
    onResizeWidth: applySidebarWidth,
    onTogglePinnedProjectsSectionCollapsed: togglePinnedProjectsSectionCollapsed,
    onTogglePagesSectionCollapsed: togglePagesSection,
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
    onShowUnavailableProduct: showSidebarUnavailableProduct,
    onOpenAutomations: openAutomations,
    onOpenResourceTarget: openResourceTarget,
    onOpenResourceTargetInProject: openResourceTargetInProject,
    activeResourceTarget: pagesSceneNavigation.activeRoot,
    automationsActive: Boolean(automationsPath),
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
    onOpenSettings: openSettings,
    account: codexAccount,
    connection: codexConnection,
    onRefreshAccount: codexAccountActions.refreshAccount,
    onConsumeRateLimitReset: codexAccountActions.consumeRateLimitReset,
    onStartChatGptLogin: codexAccountActions.startChatGptLogin,
    onStartApiKeyLogin: codexAccountActions.startApiKeyLogin,
    onCancelLogin: codexAccountActions.cancelLogin,
    onLogout: handleCodexAccountLogout,
    onAccountErrorMessage: handleCodexAccountErrorMessage,
    sidebarArchivePendingKeys,
  };

  return (
    <PageTitleProjectionProvider currentLibraryId={currentLibraryId} store={pageTitleStore}>
      <HeaderActionProvider
        actions={
          <>
            {appShellHeaderActions}
            <HeaderAction actionId="content-history" slotPosition="right" align="end" order={150}>
              <ContentHistoryControl projects={projects} />
            </HeaderAction>
          </>
        }
      >
        <NodexTooltipProvider>
          <FileReferenceRouterProvider
            openWorkspaceFileTab={openWorkspaceFileTab}
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
                activeThreadId={activeSession?.thread?.threadId ?? null}
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
                className="relative flex flex-col text-token-text-primary"
                style={
                  {
                    "--spacing-token-safe-header-left": `${safeHeaderLeftWidth}px`,
                    "--spacing-token-safe-header-right": "12px",
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
                <header
                  data-testid="workbench-global-header"
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
                      aria-hidden={
                        automationsRouteShell == null && rightPanelFullWidth ? "true" : undefined
                      }
                      data-testid="app-shell-header-context-menu-surface"
                      className={cn(
                        "pointer-events-none ms-4 flex h-full min-w-0 flex-1 isolate items-center gap-1.5 overflow-hidden [contain:layout_paint] pe-2",
                        automationsRouteShell == null && rightPanelFullWidth && "invisible",
                      )}
                      style={{ marginRight: automationsDetailRailResolvedWidth }}
                    >
                      <div
                        data-testid="thread-stage-header-content"
                        className="pointer-events-none w-full min-w-0 flex-1 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto"
                      >
                        {selectedProjectSceneId ? null : <SelectedAppShellHeaderContent />}
                      </div>
                      {!automationsRouteShell ? (
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
                    minWidth={automationsRouteShell ? 0 : headerRightWidth}
                    fallbackWidth={
                      automationsRouteShell ? 0 : RIGHT_PANEL_HEADER_FALLBACK_SPACER_WIDTH_PX
                    }
                    fallbackRailWidth={
                      automationsRouteShell ? 0 : RIGHT_PANEL_HEADER_FALLBACK_RAIL_WIDTH_PX
                    }
                    onMeasuredWidthChange={setHeaderRightWidth}
                    onMeasuredRailWidthChange={setHeaderRightRailWidth}
                  />
                </header>

                <div
                  ref={shellBodySize.ref}
                  data-app-shell-summary-layout={threadSummaryPanelLayoutMode}
                  data-app-shell-width-class={shellWidthClass}
                  className="relative flex max-h-full min-h-0 w-full flex-1"
                >
                  <WorkbenchRouteHost
                    location={workbenchWindow.location}
                    sidebarMounted={realSidebarMounted}
                    settings={settingsRouteShell}
                    sidebar={
                      <WorkbenchSidebar
                        body={sidebarBody}
                        inline={{
                          visible: showInlineSidebar,
                          animatedWidth: realSidebarMotion.animatedWidth,
                          contentOpacity: realSidebarMotion.opacity,
                          resizeDisabled: sidebarAnimating,
                        }}
                        floating={{
                          visible: showFloatingSidebar,
                          header: floatingSidebarHeader,
                          outerClassName: floatingSidebarOuterClassName,
                          resizing: floatingSidebarResizing,
                          reducedMotion: Boolean(reducedMotion),
                          exitX: floatingSidebarExitX,
                          transition: floatingSidebarTransition,
                          onResizeActiveChange: setFloatingSidebarResizing,
                          onHoverSurfaceOpenChange: setFloatingSidebarHoverSurfaceActive,
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
                      content: () => (
                        <WorkbenchSessionScopePath
                          thread={APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR}
                          route={{ routeKey: automationsPath!, kind: "automations" }}
                          selected
                        >
                          {automationsRouteShell}
                        </WorkbenchSessionScopePath>
                      ),
                      afterMain: (
                        <WorkbenchAutomationDetailRail
                          mounted={automationsDetailRailMounted}
                          width={automationsDetailRailResolvedWidth}
                          onResizePointerDown={resizeAutomationDetailRail}
                          onPortalElementChange={setAutomationsDetailRailPortalElement}
                        />
                      ),
                    }}
                    session={{
                      content: () =>
                        projectSceneRoute ??
                        pagesSceneRoute ??
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
                          pageNfm={pageStageHistoryModal?.pageNfm}
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
              </motion.div>
            </ContentSearchProvider>
          </FileReferenceRouterProvider>
        </NodexTooltipProvider>
      </HeaderActionProvider>
    </PageTitleProjectionProvider>
  );
}
