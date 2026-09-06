import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WorkbenchRuntime } from "./workbench-runtime";
import { useProjects } from "@/lib/use-projects";
import { useWorkbenchWindowState } from "@/lib/use-workbench-window-state";
import { useWorkbenchProfilePreferences } from "@/lib/use-workbench-profile-preferences";
import {
  shouldUseRendererWorkbenchCommandFallback,
  useWorkbenchShortcuts,
} from "@/lib/use-workbench-shortcuts";
import { useCommandKeymapState } from "@/lib/use-command-keymap-state";
import { openWorkbenchWindow } from "@/lib/workbench-shell-operations";
import {
  reminderOpenToPageDeepLink,
  useWorkbenchCommandIngress,
  type WorkbenchPageDeepLinkRequest,
  type WorkbenchReminderOpenRequest,
  type WorkbenchSessionDeepLinkRequest,
  type WorkbenchViewDeepLinkRequest,
} from "@/lib/use-workbench-command-ingress";
import { registerAppCloseFlushHandler } from "@/lib/app-close-flush";
import { workspaceTextDocumentRegistry } from "@/features/workspace-files/workspace-text-document-controller";
import { documentSessionRegistry } from "@/lib/document-session-registry";
import { flushContentInteractionHistories } from "@/lib/content-interaction-history";
import { canvasSceneSurfaceRegistry } from "@/lib/canvas-scene-surface-runtime";
import { useWindowSessionLayoutPersistence } from "@/lib/use-window-session-layout-persistence";
import type { OpenPageStageOptions } from "@/components/board/open-page-stage";
import type { PageStageSessionSnapshot } from "@/components/board/page-stage/types";
import type {
  Project,
  ProjectCreateInput,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectUpdateInput,
  WindowSessionBootstrap,
} from "@/lib/types";
import { WorkbenchLayoutSnapshotSchema } from "../../../shared/schemas/workbench-layout";
import { getWorkbenchSceneReturnLocation } from "../../../shared/workbench-layout";
import {
  CREATE_PAGE_COMMAND_ID,
  CREATE_PAGE_EXPANDED_COMMAND_ID,
} from "../../../shared/workbench-commands";
import { toast } from "@/components/ui/toast";

const WORKBENCH_V2_FLAG_KEY = "workbenchV2";

function readWorkbenchV2Flag(): boolean {
  try {
    return localStorage.getItem(WORKBENCH_V2_FLAG_KEY) !== "false";
  } catch {
    return true;
  }
}

function findProjectById(projects: readonly Project[], projectId: string | null): Project | null {
  if (!projectId) return null;
  return projects.find((project) => project.id === projectId) ?? null;
}

function readProjectQueryParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = new URL(window.location.href).searchParams.get("project")?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function replaceProjectQueryParam(projectId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("project") === projectId) return;
    if (projectId) url.searchParams.set("project", projectId);
    else url.searchParams.delete("project");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // Ignore URL replacement failures; state reconciliation still selects the canonical project.
  }
}

export function WorkbenchShell({
  windowSessionBootstrap,
}: {
  windowSessionBootstrap: WindowSessionBootstrap;
}) {
  const workbenchV2Enabled = readWorkbenchV2Flag();
  const initialWindowLayoutSnapshot = useMemo(
    () => WorkbenchLayoutSnapshotSchema.parse(windowSessionBootstrap.session.layout),
    [windowSessionBootstrap.session.layout],
  );
  const workbenchWindow = useWorkbenchWindowState(initialWindowLayoutSnapshot);
  const workbenchSceneLocation = getWorkbenchSceneReturnLocation(workbenchWindow.location);
  const {
    projects,
    hasMoreProjects,
    loadingMoreProjects,
    loadMoreProjects,
    loading,
    error: projectsError,
    refresh: refreshProjects,
    createProjectOrThrow,
    archiveProject,
    updateProjectOrThrow,
    reorderProjects,
    setProjectPinned,
    setPinnedProjectOrder,
    projectCatalogRenderToken,
    markProjectCatalogRendered,
  } = useProjects();
  useLayoutEffect(() => {
    if (projectCatalogRenderToken === null) return;
    markProjectCatalogRendered(projectCatalogRenderToken);
  }, [markProjectCatalogRendered, projectCatalogRenderToken]);
  const {
    sidebar,
    recentPageSessions,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarCollapsibleSectionCollapsed,
    recordRecentPageLeave,
  } = useWorkbenchProfilePreferences();
  const projectOrder = useMemo(() => projects.map((project) => project.id), [projects]);
  const setDbProjectState = workbenchWindow.selectProject;
  const [projectPickerOpenTick, setProjectPickerOpenTick] = useState(0);
  const pageStageCloseRef = useRef<(() => Promise<void>) | null>(null);
  const pageStagePersistRef = useRef<(() => Promise<void>) | null>(null);
  const pageStageSessionSnapshotRef = useRef<PageStageSessionSnapshot | null>(null);

  const [pendingDeepLinkOpen, setPendingDeepLinkOpen] = useState<{
    projectId: string;
    pageId: string;
  } | null>(null);
  const [pendingSessionDeepLinkOpen, setPendingSessionDeepLinkOpen] = useState<{
    projectId: string | null;
    sessionId: string;
  } | null>(null);
  const [pendingViewDeepLinkOpen, setPendingViewDeepLinkOpen] = useState<{
    projectId: string;
    viewId: string;
  } | null>(null);
  const reconciledProjectQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (projects.length === 0) return;
    const queryProjectId = readProjectQueryParam();
    if (!queryProjectId || reconciledProjectQueryRef.current === queryProjectId) return;
    const project = findProjectById(projects, queryProjectId);
    if (!project) return;
    reconciledProjectQueryRef.current = queryProjectId;
    setDbProjectState(project.id);
    replaceProjectQueryParam(project.id);
  }, [projects, setDbProjectState]);

  const snapshotForPersistence = workbenchWindow.snapshotForPersistence;
  const currentLayout = useMemo(() => snapshotForPersistence(), [snapshotForPersistence]);

  const { flush: flushWindowSessionLayout } = useWindowSessionLayoutPersistence({
    sessionId: windowSessionBootstrap.session.id,
    initialRevision: windowSessionBootstrap.session.layoutRevision,
    initialLayout: initialWindowLayoutSnapshot,
    layout: currentLayout,
  });

  useEffect(() => {
    return registerAppCloseFlushHandler(async () => {
      await flushContentInteractionHistories();
      await pageStagePersistRef.current?.();
      await documentSessionRegistry.persistAll();
      await canvasSceneSurfaceRegistry.persistAllDurable();
      await workspaceTextDocumentRegistry.flushAll();
      await flushWindowSessionLayout();
    });
  }, [flushWindowSessionLayout]);

  const handleCreateProject = useCallback(
    async (input: ProjectCreateInput) => {
      const result = await createProjectOrThrow(input);
      if (result) {
        setDbProjectState(result.id);
      }
      return result;
    },
    [createProjectOrThrow, setDbProjectState],
  );

  const handleArchiveProject = useCallback(
    async (projectId: string) => await archiveProject(projectId),
    [archiveProject],
  );

  const handleUpdateProject = useCallback(
    async (projectId: string, updates: ProjectUpdateInput) =>
      await updateProjectOrThrow(projectId, updates),
    [updateProjectOrThrow],
  );

  const handleReorderProjects = useCallback(
    async (input: ProjectOrderInput) => await reorderProjects(input),
    [reorderProjects],
  );

  const handleSetProjectPinned = useCallback(
    async (projectId: string, input: ProjectPinnedInput) =>
      await setProjectPinned(projectId, input),
    [setProjectPinned],
  );

  const handleSetPinnedProjectOrder = useCallback(
    async (input: ProjectPinnedOrderInput) => await setPinnedProjectOrder(input),
    [setPinnedProjectOrder],
  );

  const recordPageLeave = useCallback(
    (snapshot: PageStageSessionSnapshot) => {
      recordRecentPageLeave(snapshot.projectId, snapshot.pageId, snapshot.titleSnapshot);
    },
    [recordRecentPageLeave],
  );

  const handlePageDeepLinkHandled = useCallback(
    (payload: { projectId: string; pageId: string }) => {
      setPendingDeepLinkOpen((current) => {
        if (!current) return null;
        if (current.projectId !== payload.projectId || current.pageId !== payload.pageId) {
          return current;
        }
        return null;
      });
    },
    [],
  );

  const handleViewDeepLinkHandled = useCallback(
    (payload: { projectId: string; viewId: string }) => {
      setPendingViewDeepLinkOpen((current) => {
        if (!current) return null;
        if (current.projectId !== payload.projectId || current.viewId !== payload.viewId) {
          return current;
        }
        return null;
      });
    },
    [],
  );

  const handleOpenProjectPicker = useCallback(() => {
    setProjectPickerOpenTick((tick) => tick + 1);
  }, []);

  const navigateToProject = useCallback(
    (projectId: string) => {
      setDbProjectState(projectId);
    },
    [setDbProjectState],
  );

  const navigateToProjectIndex = useCallback(
    (index: number) => {
      const projectId = projectOrder[index];
      if (!projectId) return;
      navigateToProject(projectId);
    },
    [navigateToProject, projectOrder],
  );

  const navigateToPage = useCallback(
    async (
      projectId: string,
      pageId: string,
      _titleSnapshot?: string,
      options?: OpenPageStageOptions & {
        setDbProjectId?: string;
        activePagesTabId?: string;
        activeRecentSessionId?: string | null;
      },
    ) => {
      setPendingDeepLinkOpen({ projectId, pageId });
      setDbProjectState(options?.setDbProjectId ?? projectId);
    },
    [setDbProjectState],
  );

  const handlePageDeepLinkOpen = useCallback(
    (request: WorkbenchPageDeepLinkRequest) => {
      setPendingDeepLinkOpen(request);
      navigateToProject(request.projectId);
    },
    [navigateToProject],
  );

  const handleReminderOpen = useCallback(
    (request: WorkbenchReminderOpenRequest) => {
      handlePageDeepLinkOpen(reminderOpenToPageDeepLink(request));
    },
    [handlePageDeepLinkOpen],
  );

  const handleSessionDeepLinkOpen = useCallback(
    (request: WorkbenchSessionDeepLinkRequest) => {
      setPendingSessionDeepLinkOpen(request);
      if (request.projectId === null) return;
      navigateToProject(request.projectId);
    },
    [navigateToProject],
  );

  const handleViewDeepLinkOpen = useCallback(
    (request: WorkbenchViewDeepLinkRequest) => {
      setPendingViewDeepLinkOpen(request);
      navigateToProject(request.projectId);
    },
    [navigateToProject],
  );

  useEffect(() => {
    if (!pendingSessionDeepLinkOpen) return;
    if (
      workbenchSceneLocation.kind !== "session" ||
      workbenchSceneLocation.sessionId !== pendingSessionDeepLinkOpen.sessionId
    ) {
      return;
    }
    setPendingSessionDeepLinkOpen(null);
  }, [pendingSessionDeepLinkOpen, workbenchSceneLocation]);

  const flushBeforeWindowClone = useCallback(async () => {
    await pageStagePersistRef.current?.();
    await flushWindowSessionLayout();
  }, [flushWindowSessionLayout]);

  const handleRequestNewWindow = useCallback(async () => {
    await flushBeforeWindowClone();
    await openWorkbenchWindow({});
  }, [flushBeforeWindowClone]);

  const workbenchCommands = useWorkbenchCommandIngress({
    onReminderOpen: handleReminderOpen,
    onPageDeepLinkOpen: handlePageDeepLinkOpen,
    onSessionDeepLinkOpen: handleSessionDeepLinkOpen,
    onViewDeepLinkOpen: handleViewDeepLinkOpen,
    onRequestNewWindow: () => {
      void handleRequestNewWindow();
    },
  });

  const handleOpenContentSearch = useCallback(() => {
    workbenchCommands.openContentSearch("keyboard_shortcut");
  }, [workbenchCommands]);

  const handleOpenProjectSessionInNewWindow = useCallback(
    async (session: { id: string; projectId: string | null }) => {
      await flushBeforeWindowClone();
      await openWorkbenchWindow({
        activeProjectSessionId: session.id,
        activeProjectId: session.projectId,
      });
    },
    [flushBeforeWindowClone],
  );

  const commandKeymapQuery = useCommandKeymapState();

  useWorkbenchShortcuts({
    projectOrder,
    switchToProjectIndex: navigateToProjectIndex,
    onRequestNewWindow: window.api?.onRequestNewWindow
      ? undefined
      : () => {
          void handleRequestNewWindow();
        },
    onRequestCommandPalette: workbenchCommands.openCommandPalette,
    onRequestGoToPages: workbenchCommands.goToPages,
    onRequestGoToSettings: workbenchCommands.goToSettings,
    onRequestLatestToastAction: toast.runLatestAction,
    onRequestContentSearch: handleOpenContentSearch,
    onRequestSettingsToggle: workbenchCommands.toggleSettings,
    onRequestKeyboardShortcuts: workbenchCommands.openKeyboardShortcuts,
    onRequestCreatePage: () =>
      workbenchCommands.execute(CREATE_PAGE_COMMAND_ID, "keyboard_shortcut"),
    onRequestCreatePageExpanded: () =>
      workbenchCommands.execute(CREATE_PAGE_EXPANDED_COMMAND_ID, "keyboard_shortcut"),
    navigateBack: (source) => {
      workbenchCommands.navigate("back", source);
    },
    navigateForward: (source) => {
      workbenchCommands.navigate("forward", source);
    },
    onToggleSidebar: workbenchCommands.toggleSidebar,
    onRequestRenameThread: workbenchCommands.renameThread,
    onRequestWorkbenchCommand: shouldUseRendererWorkbenchCommandFallback(
      Boolean(window.api?.onWorkbenchCommand),
    )
      ? (commandId) => workbenchCommands.execute(commandId, "keyboard_shortcut")
      : undefined,
    commandKeymapState: commandKeymapQuery.data,
  });

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--background)">
        <div className="text-sm text-(--foreground-secondary)">Loading...</div>
      </div>
    );
  }

  if (!workbenchV2Enabled) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--background) text-sm text-(--foreground-secondary)">
        workbenchV2 is disabled. Set localStorage `workbenchV2=true` to use the new shell.
      </div>
    );
  }

  return (
    <WorkbenchRuntime
      windowSessionId={windowSessionBootstrap.session.id}
      initialWindowLayoutSnapshot={initialWindowLayoutSnapshot}
      projects={projects}
      hasMoreProjects={hasMoreProjects}
      loadingMoreProjects={loadingMoreProjects}
      onLoadMoreProjects={loadMoreProjects}
      projectCatalogError={projectsError}
      onRetryProjects={refreshProjects}
      recentPageSessions={recentPageSessions}
      sidebar={sidebar}
      pageStageCloseRef={pageStageCloseRef}
      pageStagePersistRef={pageStagePersistRef}
      pendingPageDeepLinkOpen={pendingDeepLinkOpen}
      pendingViewDeepLinkOpen={pendingViewDeepLinkOpen}
      pendingSessionOpen={pendingSessionDeepLinkOpen}
      onPageDeepLinkHandled={handlePageDeepLinkHandled}
      onViewDeepLinkHandled={handleViewDeepLinkHandled}
      onOpenProjectSessionInNewWindow={handleOpenProjectSessionInNewWindow}
      openPageStage={navigateToPage}
      setSidebarCollapsed={setSidebarCollapsed}
      setSidebarWidth={setSidebarWidth}
      setSidebarCollapsibleSectionCollapsed={setSidebarCollapsibleSectionCollapsed}
      onLeavePageStage={recordPageLeave}
      pageStageSessionSnapshotRef={pageStageSessionSnapshotRef}
      onRequestProjectPickerOpen={handleOpenProjectPicker}
      projectPickerOpenTick={projectPickerOpenTick}
      taskSearchOpenTick={0}
      threadSearchOpenTick={0}
      onRegisterCommandPort={workbenchCommands.register}
      onCreateProject={handleCreateProject}
      onArchiveProject={handleArchiveProject}
      onUpdateProject={handleUpdateProject}
      onReorderProjects={handleReorderProjects}
      onSetProjectPinned={handleSetProjectPinned}
      onSetPinnedProjectOrder={handleSetPinnedProjectOrder}
      commandKeymapState={commandKeymapQuery.data}
    />
  );
}
