import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkbenchShell } from "@/components/workbench/workbench-shell";
import { useProjects } from "@/lib/use-projects";
import {
  resolveSlidingWindowFocusIntent,
  resolveExpandedStages,
  STAGE_ORDER,
  useWorkbenchState,
  type StageId,
  type StageNavDirection,
  type WorkbenchView,
} from "@/lib/use-workbench-state";
import { useCardStageState } from "@/lib/use-card-stage";
import { useWorkbenchShortcuts } from "@/lib/use-workbench-shortcuts";
import { invoke } from "@/lib/api";
import { registerAppCloseFlushHandler } from "@/lib/app-close-flush";
import {
  navigateBackInHistory,
  navigateForwardInHistory,
  readNavigationHistoryState,
  recordNavigationTransition,
  writeNavigationHistoryState,
  type NavigationHistoryState,
  type NavigationSnapshot,
} from "@/lib/workbench-navigation-history";
import {
  readStageRailLayoutMode,
  type StageRailLayoutMode,
  writeStageRailLayoutMode,
} from "@/lib/stage-rail-layout-mode";
import {
  buildWorkbenchResumeSnapshot,
  consumeWorkbenchResumeSnapshot,
  saveWorkbenchResumeSnapshot,
} from "@/lib/workbench-resume";
import { clearActiveDevStoryFromLocation, resolveActiveDevStory } from "@/lib/dev-story";
import { StageThreadsDevStoryPage } from "@/components/workbench/stage-threads/stage-threads-dev-story";
import { CardStageDevStoryPage } from "@/components/kanban/card-stage/card-stage-dev-story";
import { GeneralDevStoryPage } from "@/components/dev-story/general-dev-story-page";
import { AppStartupScreen } from "@/components/app-startup-screen";
import type { CardStageSessionSnapshot } from "@/components/kanban/card-stage/types";
import type { WorkbenchResumeSnapshot } from "@/lib/types";
import type {
  AppInitializationStep,
  DatabaseMigrationProgress,
} from "../shared/app-startup";

const WORKBENCH_V2_FLAG_KEY = "workbenchV2";

function readWorkbenchV2Flag(): boolean {
  try {
    return localStorage.getItem(WORKBENCH_V2_FLAG_KEY) !== "false";
  } catch {
    return true;
  }
}

function WorkbenchApp({ initialResumeSnapshot }: { initialResumeSnapshot: WorkbenchResumeSnapshot | null }) {
  const activeDevStory = resolveActiveDevStory();
  const workbenchV2Enabled = readWorkbenchV2Flag();
  const [stageRailLayoutMode, setStageRailLayoutModeState] = useState<StageRailLayoutMode>(() =>
    readStageRailLayoutMode(),
  );
  const { projects, loading, createProject, deleteProject, renameProject, refresh } = useProjects();
  const {
    dbProjectId,
    threadsProjectId,
    spaces,
    activeView,
    activeSearchQuery,
    viewsByProject,
    searchByProject,
    sidebar,
    focusedStage,
    stageNavDirection,
    cardsTabs,
    activeCardsTabId,
    threadsTabs,
    activeThreadsTabId,
    terminalTabs,
    activeTerminalTabId,
    filesTabs,
    activeFilesTabId,
    stagePanelWidths,
    slidingWindowPaneCount,
    terminalPanelOpen,
    terminalPanelHeight,
    recentCardSessions,
    activeRecentSessionId,
    setDbProject: setDbProjectState,
    setThreadsProjectId: setThreadsProjectIdState,
    setView: setWorkbenchView,
    setSearchQuery,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarTopLevelSectionVisible,
    setSidebarTopLevelSectionItemLimit,
    moveSidebarTopLevelSectionBy,
    setFocusedStage: setFocusedStageState,
    setSidebarStageExpanded,
    isSidebarStageExpanded,
    setSidebarSectionExpanded,
    isSidebarSectionExpanded,
    setSidebarSectionShowAll,
    isSidebarSectionShowAll,
    setActiveCardsTab: setActiveCardsTabState,
    setActiveThreadsTab: setActiveThreadsTabState,
    setThreadsTabs,
    setActiveTerminalTab,
    setActiveFilesTab: setActiveFilesTabState,
    setStagePanelWidths,
    stepSlidingWindowPaneCount,
    setTerminalPanelOpen,
    setTerminalPanelHeight,
    toggleTerminalPanel,
    openProjectTerminalTab,
    openCardTerminalTab,
    closeTerminalTab,
    recordRecentCardLeave,
    selectRecentCardSession: selectRecentCardSessionState,
    setActiveRecentCardSession: setActiveRecentCardSessionState,
    closeRecentCardSession,
  } = useWorkbenchState(projects, {
    stageCollapseEnabled: stageRailLayoutMode === "full-rail",
    initialResumeSnapshot,
  });
  const [projectPickerOpenTick, setProjectPickerOpenTick] = useState(0);
  const [taskSearchOpenTick, setTaskSearchOpenTick] = useState(0);
  const [commandPaletteOpenTick, setCommandPaletteOpenTick] = useState(0);
  const [settingsToggleTick, setSettingsToggleTick] = useState(0);

  const setStageRailLayoutMode = useCallback((value: StageRailLayoutMode) => {
    const normalized = writeStageRailLayoutMode(value);
    setStageRailLayoutModeState(normalized);
  }, []);

  const {
    state: cardStageState,
    openCardStage: openCardStageState,
    closeCardStage: closeCardStageState,
    cardStageCardId,
  } = useCardStageState(initialResumeSnapshot?.cardStage ?? null);
  const cardStageCloseRef = useRef<(() => Promise<void>) | null>(null);
  const cardStagePersistRef = useRef<(() => Promise<void>) | null>(null);
  const cardStageSessionSnapshotRef = useRef<CardStageSessionSnapshot | null>(null);

  const [pendingReminderOpen, setPendingReminderOpen] = useState<{
    projectId: string;
    cardId: string;
    occurrenceStart: string;
  } | null>(null);
  const [pendingDeepLinkOpen, setPendingDeepLinkOpen] = useState<{
    projectId: string;
    cardId: string;
  } | null>(null);
  const cardStageStateRef = useRef(cardStageState);
  const resumeValidationStartedRef = useRef(false);
  const [navigationHistory, setNavigationHistory] = useState<NavigationHistoryState>(() => readNavigationHistoryState());

  useEffect(() => {
    cardStageStateRef.current = cardStageState;
  }, [cardStageState]);

  const resolvedDbProjectId = useMemo(() => {
    if (projects.some((project) => project.id === dbProjectId)) return dbProjectId;
    return projects[0]?.id ?? "default";
  }, [dbProjectId, projects]);

  const resolvedView = useMemo<WorkbenchView>(
    () => viewsByProject[resolvedDbProjectId] ?? activeView,
    [viewsByProject, resolvedDbProjectId, activeView],
  );

  const resolvedSearchQuery = useMemo(
    () => searchByProject[resolvedDbProjectId] ?? activeSearchQuery,
    [searchByProject, resolvedDbProjectId, activeSearchQuery],
  );
  const currentNavigationSnapshot = useMemo<NavigationSnapshot>(() => ({
    dbProjectId: resolvedDbProjectId,
    activeView: resolvedView,
    focusedStage,
    stageNavDirection,
    cardStage: cardStageState,
    activeCardsTabId,
    activeRecentSessionId,
    threadsProjectId,
    activeThreadsTabId,
    activeFilesTabId,
  }), [
    activeCardsTabId,
    activeFilesTabId,
    activeRecentSessionId,
    activeThreadsTabId,
    cardStageState,
    focusedStage,
    resolvedDbProjectId,
    resolvedView,
    stageNavDirection,
    threadsProjectId,
  ]);
  const currentNavigationSnapshotRef = useRef(currentNavigationSnapshot);

  useEffect(() => {
    currentNavigationSnapshotRef.current = currentNavigationSnapshot;
  }, [currentNavigationSnapshot]);

  useEffect(() => {
    writeNavigationHistoryState(navigationHistory);
  }, [navigationHistory]);

  const resolveProjectView = useCallback((projectId: string): WorkbenchView => {
    return viewsByProject[projectId] ?? "kanban";
  }, [viewsByProject]);

  const recordNavigation = useCallback((nextSnapshot: NavigationSnapshot) => {
    setNavigationHistory((prev) => recordNavigationTransition(prev, currentNavigationSnapshotRef.current, nextSnapshot));
  }, []);

  useEffect(() => {
    return registerAppCloseFlushHandler(async () => {
      await cardStagePersistRef.current?.();
      const snapshot = buildWorkbenchResumeSnapshot({
        dbProjectId,
        threadsProjectId,
        viewsByProject,
        focusedStage,
        stageNavDirection,
        activeCardsTabId,
        activeRecentSessionId,
        activeThreadsTabId,
        recentCardSessions,
        cardStageState: cardStageStateRef.current,
      });
      await saveWorkbenchResumeSnapshot(snapshot);
    });
  }, [
    activeCardsTabId,
    activeRecentSessionId,
    activeThreadsTabId,
    dbProjectId,
    focusedStage,
    recentCardSessions,
    stageNavDirection,
    threadsProjectId,
    viewsByProject,
  ]);

  useEffect(() => {
    if (!initialResumeSnapshot) return;
    if (loading) return;
    if (resumeValidationStartedRef.current) return;
    resumeValidationStartedRef.current = true;

    let cancelled = false;
    void (async () => {
      const invalidRecentSessionIds = await Promise.all(
        initialResumeSnapshot.recentCardSessions.slice(0, 10).map(async (session) => {
          try {
            const result = await invoke("card:get", session.projectId, session.cardId);
            return result ? null : session.id;
          } catch {
            return session.id;
          }
        }),
      );

      let activeCardMissing = false;
      if (initialResumeSnapshot.cardStage.open && initialResumeSnapshot.cardStage.cardId) {
        try {
          const result = await invoke(
            "card:get",
            initialResumeSnapshot.cardStage.projectId,
            initialResumeSnapshot.cardStage.cardId,
          );
          activeCardMissing = !result;
        } catch {
          activeCardMissing = true;
        }
      }

      if (cancelled) return;

      invalidRecentSessionIds
        .filter((sessionId): sessionId is string => typeof sessionId === "string")
        .forEach((sessionId) => {
          closeRecentCardSession(sessionId);
        });

      if (!activeCardMissing) return;

      const matchingSession = initialResumeSnapshot.recentCardSessions.find((session) =>
        session.projectId === initialResumeSnapshot.cardStage.projectId
        && session.cardId === initialResumeSnapshot.cardStage.cardId
      );
      if (matchingSession) {
        closeRecentCardSession(matchingSession.id);
      }

      const currentCardStageState = cardStageStateRef.current;
      if (
        currentCardStageState.open
        && currentCardStageState.projectId === initialResumeSnapshot.cardStage.projectId
        && currentCardStageState.cardId === initialResumeSnapshot.cardStage.cardId
      ) {
        closeCardStageState();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [closeCardStageState, closeRecentCardSession, initialResumeSnapshot, loading]);

  const handleCreateProject = useCallback(
    async (
      id: string,
      name: string,
      description?: string,
      icon?: string,
      workspacePath?: string | null,
    ) => {
      const result = await createProject(id, name, description, icon, workspacePath);
      if (result) await refresh();
      return result;
    },
    [createProject, refresh],
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      const success = await deleteProject(projectId);
      if (success) await refresh();
      return success;
    },
    [deleteProject, refresh],
  );

  const handleRenameProject = useCallback(
    async (
      oldId: string,
      newId: string,
      name?: string,
      icon?: string,
      workspacePath?: string | null,
    ) => {
      const result = await renameProject(oldId, newId, name, undefined, icon, workspacePath);
      if (result) await refresh();
      return result;
    },
    [renameProject, refresh],
  );

  const recordCardLeave = useCallback((snapshot: CardStageSessionSnapshot) => {
    recordRecentCardLeave(snapshot.projectId, snapshot.cardId, snapshot.titleSnapshot);
  }, [recordRecentCardLeave]);

  const openCardStageSession = useCallback(
    async (projectId: string, cardId: string) => {
      const isSwitchingCards =
        cardStageState.open
        && (
          cardStageState.projectId !== projectId
          || cardStageState.cardId !== cardId
        );

      if (isSwitchingCards) {
        await cardStagePersistRef.current?.();
        const leavingSnapshot = cardStageSessionSnapshotRef.current;
        if (
          leavingSnapshot
          && (
            leavingSnapshot.projectId !== projectId
            || leavingSnapshot.cardId !== cardId
          )
        ) {
          recordCardLeave(leavingSnapshot);
        }
      }

      const existingSession = recentCardSessions.find((session) =>
        session.projectId === projectId && session.cardId === cardId
      );
      setActiveRecentCardSessionState(existingSession?.id ?? null);

      openCardStageState(projectId, cardId);
    },
    [
      cardStageState.cardId,
      cardStageState.open,
      cardStageState.projectId,
      openCardStageState,
      recentCardSessions,
      recordCardLeave,
      setActiveRecentCardSessionState,
    ],
  );

  const openRecentSession = useCallback(
    async (sessionId: string) => {
      const session = recentCardSessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;

      if (
        cardStageState.open
        && cardStageState.projectId === session.projectId
        && cardStageState.cardId === session.cardId
      ) {
        selectRecentCardSessionState(session.id);
        return;
      }

      selectRecentCardSessionState(session.id);
      await openCardStageSession(session.projectId, session.cardId);
    },
    [cardStageState, openCardStageSession, recentCardSessions, selectRecentCardSessionState],
  );

  const handleCloseRecentSession = useCallback(
    (sessionId: string) => {
      const closing = recentCardSessions.find((session) => session.id === sessionId);
      closeRecentCardSession(sessionId);

      if (!closing) return;
      if (!cardStageState.open) return;
      if (cardStageState.projectId !== closing.projectId) return;
      if (cardStageState.cardId !== closing.cardId) return;

      closeCardStageState();
    },
    [closeCardStageState, closeRecentCardSession, cardStageState, recentCardSessions],
  );

  const prevActiveProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevProjectId = prevActiveProjectIdRef.current;
    if (prevProjectId && prevProjectId !== resolvedDbProjectId) {
      void cardStagePersistRef.current?.();
    }
    prevActiveProjectIdRef.current = resolvedDbProjectId;
  }, [resolvedDbProjectId]);

  const handleReminderHandled = useCallback(
    (payload: { projectId: string; cardId: string; occurrenceStart: string }) => {
      setPendingReminderOpen((current) => {
        if (!current) return null;
        if (
          current.projectId !== payload.projectId ||
          current.cardId !== payload.cardId ||
          current.occurrenceStart !== payload.occurrenceStart
        ) {
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

  const focusStageWithNearestIntent = useCallback(
    (
      projectId: string,
      stageId: StageId,
      fallbackDirection?: StageNavDirection,
    ) => {
      if (stageRailLayoutMode !== "sliding-window") {
        setFocusedStageState(projectId, stageId);
        return;
      }

      const slidingWindowVisibleStages = resolveExpandedStages(
        focusedStage,
        stageNavDirection,
        slidingWindowPaneCount,
        false,
      );
      const { direction } = resolveSlidingWindowFocusIntent(
        stageId,
        slidingWindowVisibleStages,
        slidingWindowPaneCount,
        fallbackDirection ?? stageNavDirection,
      );
      setFocusedStageState(projectId, stageId, direction);
    },
    [
      focusedStage,
      setFocusedStageState,
      slidingWindowPaneCount,
      stageNavDirection,
      stageRailLayoutMode,
    ],
  );

  const resolveNavigationStageDirection = useCallback((
    stageId: StageId,
    fallbackDirection?: StageNavDirection,
  ): StageNavDirection => {
    if (stageRailLayoutMode !== "sliding-window") {
      return fallbackDirection ?? stageNavDirection;
    }

    const slidingWindowVisibleStages = resolveExpandedStages(
      focusedStage,
      stageNavDirection,
      slidingWindowPaneCount,
      false,
    );
    const { direction } = resolveSlidingWindowFocusIntent(
      stageId,
      slidingWindowVisibleStages,
      slidingWindowPaneCount,
      fallbackDirection ?? stageNavDirection,
    );
    return direction;
  }, [focusedStage, slidingWindowPaneCount, stageNavDirection, stageRailLayoutMode]);

  const applyNavigationSnapshot = useCallback(async (snapshot: NavigationSnapshot) => {
    setDbProjectState(snapshot.dbProjectId);
    setWorkbenchView(snapshot.dbProjectId, snapshot.activeView);
    setActiveCardsTabState(snapshot.dbProjectId, snapshot.activeCardsTabId);
    setActiveRecentCardSessionState(snapshot.activeRecentSessionId);
    setThreadsProjectIdState(snapshot.threadsProjectId);
    setActiveThreadsTabState(snapshot.threadsProjectId, snapshot.activeThreadsTabId);
    setActiveFilesTabState(snapshot.dbProjectId, snapshot.activeFilesTabId);
    if (snapshot.cardStage.open && snapshot.cardStage.cardId) {
      await openCardStageSession(snapshot.cardStage.projectId, snapshot.cardStage.cardId);
    } else {
      closeCardStageState();
    }
    setFocusedStageState(snapshot.dbProjectId, snapshot.focusedStage, snapshot.stageNavDirection);
  }, [
    closeCardStageState,
    openCardStageSession,
    setActiveCardsTabState,
    setActiveFilesTabState,
    setActiveRecentCardSessionState,
    setActiveThreadsTabState,
    setDbProjectState,
    setFocusedStageState,
    setThreadsProjectIdState,
    setWorkbenchView,
  ]);

  const navigateToStage = useCallback((projectId: string, stageId: StageId, fallbackDirection?: StageNavDirection) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      focusedStage: stageId,
      stageNavDirection: resolveNavigationStageDirection(stageId, fallbackDirection),
    };
    recordNavigation(nextSnapshot);
    focusStageWithNearestIntent(projectId, stageId, fallbackDirection);
  }, [focusStageWithNearestIntent, recordNavigation, resolveNavigationStageDirection]);

  const navigateToProject = useCallback((projectId: string) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      dbProjectId: projectId,
      activeView: resolveProjectView(projectId),
    };
    recordNavigation(nextSnapshot);
    setDbProjectState(projectId);
  }, [recordNavigation, resolveProjectView, setDbProjectState]);

  const navigateToProjectIndex = useCallback((index: number) => {
    const projectId = spaces[index]?.projectId;
    if (!projectId) return;
    navigateToProject(projectId);
  }, [navigateToProject, spaces]);

  const navigateToDbView = useCallback((projectId: string, view: WorkbenchView) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      dbProjectId: projectId,
      activeView: view,
      focusedStage: "db",
      stageNavDirection: resolveNavigationStageDirection("db"),
    };
    recordNavigation(nextSnapshot);
    setWorkbenchView(projectId, view);
    focusStageWithNearestIntent(projectId, "db");
  }, [focusStageWithNearestIntent, recordNavigation, resolveNavigationStageDirection, setWorkbenchView]);

  const navigateToCard = useCallback(async (
    projectId: string,
    cardId: string,
    _titleSnapshot?: string,
    options?: {
      setDbProjectId?: string;
      activeCardsTabId?: string;
      activeRecentSessionId?: string | null;
    },
  ) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      dbProjectId: options?.setDbProjectId ?? currentNavigationSnapshotRef.current.dbProjectId,
      activeView: resolveProjectView(options?.setDbProjectId ?? currentNavigationSnapshotRef.current.dbProjectId),
      cardStage: {
        open: true,
        projectId,
        cardId,
      },
      activeCardsTabId: options?.activeCardsTabId ?? currentNavigationSnapshotRef.current.activeCardsTabId,
      activeRecentSessionId: options?.activeRecentSessionId ?? currentNavigationSnapshotRef.current.activeRecentSessionId,
      focusedStage: "cards",
      stageNavDirection: resolveNavigationStageDirection("cards"),
    };
    recordNavigation(nextSnapshot);
    if (options?.setDbProjectId) {
      setDbProjectState(options.setDbProjectId);
    }
    await openCardStageSession(projectId, cardId);
    focusStageWithNearestIntent(options?.setDbProjectId ?? projectId, "cards");
  }, [focusStageWithNearestIntent, openCardStageSession, recordNavigation, resolveNavigationStageDirection, resolveProjectView, setDbProjectState]);

  const navigateToRecentSession = useCallback(async (sessionId: string) => {
    const session = recentCardSessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      cardStage: {
        open: true,
        projectId: session.projectId,
        cardId: session.cardId,
      },
      activeCardsTabId: `session:${session.id}`,
      activeRecentSessionId: session.id,
      focusedStage: "cards",
      stageNavDirection: resolveNavigationStageDirection("cards"),
    };
    recordNavigation(nextSnapshot);
    await openRecentSession(sessionId);
    focusStageWithNearestIntent(session.projectId, "cards");
  }, [focusStageWithNearestIntent, openRecentSession, recentCardSessions, recordNavigation, resolveNavigationStageDirection]);

  const navigateToCardsTab = useCallback((projectId: string, tabId: string, activeSessionId: string | null) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      activeCardsTabId: tabId,
      activeRecentSessionId: activeSessionId,
    };
    recordNavigation(nextSnapshot);
    setActiveCardsTabState(projectId, tabId);
    setActiveRecentCardSessionState(activeSessionId);
  }, [recordNavigation, setActiveCardsTabState, setActiveRecentCardSessionState]);

  const navigateToThreadTab = useCallback((projectId: string, tabId: string, focusStage = true) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      threadsProjectId: projectId,
      activeThreadsTabId: tabId,
      focusedStage: focusStage ? "threads" : currentNavigationSnapshotRef.current.focusedStage,
      stageNavDirection: focusStage
        ? resolveNavigationStageDirection("threads")
        : currentNavigationSnapshotRef.current.stageNavDirection,
    };
    recordNavigation(nextSnapshot);
    setThreadsProjectIdState(projectId);
    setActiveThreadsTabState(projectId, tabId);
    if (focusStage) {
      focusStageWithNearestIntent(projectId, "threads");
    }
  }, [focusStageWithNearestIntent, recordNavigation, resolveNavigationStageDirection, setActiveThreadsTabState, setThreadsProjectIdState]);

  const navigateToFilesTab = useCallback((projectId: string, tabId: string) => {
    const nextSnapshot: NavigationSnapshot = {
      ...currentNavigationSnapshotRef.current,
      activeFilesTabId: tabId === "diff" ? "diff" : "diff",
      focusedStage: "files",
      stageNavDirection: resolveNavigationStageDirection("files"),
    };
    recordNavigation(nextSnapshot);
    setActiveFilesTabState(projectId, tabId);
    focusStageWithNearestIntent(projectId, "files");
  }, [focusStageWithNearestIntent, recordNavigation, resolveNavigationStageDirection, setActiveFilesTabState]);

  const navigateBack = useCallback(async () => {
    const result = navigateBackInHistory(navigationHistory, currentNavigationSnapshotRef.current);
    if (!result.snapshot) return;
    setNavigationHistory(result.historyState);
    await applyNavigationSnapshot(result.snapshot);
  }, [applyNavigationSnapshot, navigationHistory]);

  const navigateForward = useCallback(async () => {
    const result = navigateForwardInHistory(navigationHistory, currentNavigationSnapshotRef.current);
    if (!result.snapshot) return;
    setNavigationHistory(result.historyState);
    await applyNavigationSnapshot(result.snapshot);
  }, [applyNavigationSnapshot, navigationHistory]);

  useEffect(() => {
    if (!window.api) return;
    return window.api.on("reminder:open", (...args: unknown[]) => {
      const payload = args[0] as {
        projectId?: unknown;
        cardId?: unknown;
        occurrenceStart?: unknown;
      } | undefined;

      if (!payload) return;
      if (
        typeof payload.projectId !== "string" ||
        typeof payload.cardId !== "string" ||
        typeof payload.occurrenceStart !== "string"
      ) {
        return;
      }

      setPendingReminderOpen({
        projectId: payload.projectId,
        cardId: payload.cardId,
        occurrenceStart: payload.occurrenceStart,
      });
      navigateToProject(payload.projectId);
    });
  }, [navigateToProject]);

  useEffect(() => {
    if (!window.api) return;
    return window.api.on("deeplink:open-card", (...args: unknown[]) => {
      const payload = args[0] as {
        projectId?: unknown;
        cardId?: unknown;
      } | undefined;

      if (!payload) return;
      if (
        typeof payload.projectId !== "string"
        || typeof payload.cardId !== "string"
      ) {
        return;
      }

      setPendingDeepLinkOpen({
        projectId: payload.projectId,
        cardId: payload.cardId,
      });
      navigateToProject(payload.projectId);
    });
  }, [navigateToProject]);

  useEffect(() => {
    if (!pendingReminderOpen) return;
    if (pendingReminderOpen.projectId !== resolvedDbProjectId) return;
    if (resolvedView === "calendar") return;

    navigateToDbView(resolvedDbProjectId, "calendar");
  }, [navigateToDbView, pendingReminderOpen, resolvedDbProjectId, resolvedView]);

  useEffect(() => {
    if (!pendingDeepLinkOpen) return;
    if (pendingDeepLinkOpen.projectId !== resolvedDbProjectId) return;

    void navigateToCard(pendingDeepLinkOpen.projectId, pendingDeepLinkOpen.cardId, undefined, {
      setDbProjectId: pendingDeepLinkOpen.projectId,
    });
    setPendingDeepLinkOpen(null);
  }, [navigateToCard, pendingDeepLinkOpen, resolvedDbProjectId]);

  const handleShortcutFocusAdjacentStage = useCallback((projectId: string, direction: -1 | 1) => {
    if (stageRailLayoutMode !== "sliding-window") {
      navigateToStage(projectId, STAGE_ORDER[(STAGE_ORDER.indexOf(focusedStage) + (direction > 0 ? 1 : STAGE_ORDER.length - 1)) % STAGE_ORDER.length] as StageId, direction > 0 ? "right" : "left");
      return;
    }

    const currentIndex = STAGE_ORDER.indexOf(focusedStage);
    if (currentIndex < 0) return;
    const nextIndex =
      direction > 0
        ? (currentIndex + 1) % STAGE_ORDER.length
        : (currentIndex - 1 + STAGE_ORDER.length) % STAGE_ORDER.length;
    const nextStage = STAGE_ORDER[nextIndex];
    navigateToStage(projectId, nextStage, direction > 0 ? "right" : "left");
  }, [focusedStage, navigateToStage, stageRailLayoutMode]);

  const handleShortcutSwitchToStageIndex = useCallback((projectId: string, index: number) => {
    if (index < 0 || index >= STAGE_ORDER.length) return;
    navigateToStage(projectId, STAGE_ORDER[index] as StageId);
  }, [navigateToStage]);

  const handleOpenTaskSearch = useCallback((projectId: string) => {
    setTaskSearchOpenTick((tick) => tick + 1);
    focusStageWithNearestIntent(projectId, "db");
  }, [focusStageWithNearestIntent]);

  const handleToggleSettings = useCallback(() => {
    setSettingsToggleTick((tick) => tick + 1);
  }, []);

  const handleOpenCommandPalette = useCallback(() => {
    setCommandPaletteOpenTick((tick) => tick + 1);
  }, []);

  useWorkbenchShortcuts({
    spaces,
    dbProjectId: resolvedDbProjectId,
    focusedStage,
    focusAdjacentStage: handleShortcutFocusAdjacentStage,
    switchToStageIndex: handleShortcutSwitchToStageIndex,
    switchToProjectIndex: navigateToProjectIndex,
    toggleTerminalPanel,
    onRequestNewWindow: () => {
      void invoke("window:new");
    },
    onRequestCommandPalette: handleOpenCommandPalette,
    onRequestProjectPicker: handleOpenProjectPicker,
    onRequestTaskSearch: handleOpenTaskSearch,
    onRequestSettingsToggle: handleToggleSettings,
    navigateBack: () => {
      void navigateBack();
    },
    navigateForward: () => {
      void navigateForward();
    },
  });

  if (activeDevStory === "threads-panel") {
    return (
      <StageThreadsDevStoryPage
        onExit={() => {
          clearActiveDevStoryFromLocation();
        }}
      />
    );
  }

  if (activeDevStory === "card-stage") {
    return (
      <CardStageDevStoryPage
        onExit={() => {
          clearActiveDevStoryFromLocation();
        }}
      />
    );
  }

  if (activeDevStory === "ui-components") {
    return (
      <GeneralDevStoryPage
        onExit={() => {
          clearActiveDevStoryFromLocation();
        }}
      />
    );
  }

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

  if (projects.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--background)">
        <div className="text-sm text-(--foreground-secondary)">No projects found.</div>
      </div>
    );
  }

  return (
    <WorkbenchShell
      projects={projects}
      dbProjectId={resolvedDbProjectId}
      threadsProjectId={threadsProjectId}
      activeView={resolvedView}
      activeSearchQuery={resolvedSearchQuery}
      spaces={spaces}
      recentCardSessions={recentCardSessions}
      activeRecentSessionId={activeRecentSessionId}
      sidebar={sidebar}
      focusedStage={focusedStage}
      stageNavDirection={stageNavDirection}
      cardsTabs={cardsTabs}
      activeCardsTabId={activeCardsTabId}
      threadsTabs={threadsTabs}
      activeThreadsTabId={activeThreadsTabId}
      terminalTabs={terminalTabs}
      activeTerminalTabId={activeTerminalTabId}
      filesTabs={filesTabs}
      activeFilesTabId={activeFilesTabId}
      stagePanelWidths={stagePanelWidths}
      stageRailLayoutMode={stageRailLayoutMode}
      onStageRailLayoutModeChange={setStageRailLayoutMode}
      slidingWindowPaneCount={slidingWindowPaneCount}
      terminalPanelOpen={terminalPanelOpen}
      terminalPanelHeight={terminalPanelHeight}
      cardStageState={cardStageState}
      cardStageCardId={cardStageState.projectId === resolvedDbProjectId ? cardStageCardId : undefined}
      cardStageCloseRef={cardStageCloseRef}
      cardStagePersistRef={cardStagePersistRef}
      pendingReminderOpen={pendingReminderOpen}
      onReminderHandled={handleReminderHandled}
      openCardStage={navigateToCard}
      setDbProject={navigateToProject}
      setSearchQuery={setSearchQuery}
      setSidebarCollapsed={setSidebarCollapsed}
      setSidebarWidth={setSidebarWidth}
      setSidebarTopLevelSectionVisible={setSidebarTopLevelSectionVisible}
      setSidebarTopLevelSectionItemLimit={setSidebarTopLevelSectionItemLimit}
      moveSidebarTopLevelSectionBy={moveSidebarTopLevelSectionBy}
      setSidebarStageExpanded={setSidebarStageExpanded}
      isSidebarStageExpanded={isSidebarStageExpanded}
      setSidebarSectionExpanded={setSidebarSectionExpanded}
      isSidebarSectionExpanded={isSidebarSectionExpanded}
      setSidebarSectionShowAll={setSidebarSectionShowAll}
      isSidebarSectionShowAll={isSidebarSectionShowAll}
      setActiveThreadsTab={setActiveThreadsTabState}
      setThreadsTabs={setThreadsTabs}
      setActiveTerminalTab={setActiveTerminalTab}
      setStagePanelWidths={setStagePanelWidths}
      stepSlidingWindowPaneCount={stepSlidingWindowPaneCount}
      setTerminalPanelOpen={setTerminalPanelOpen}
      setTerminalPanelHeight={setTerminalPanelHeight}
      openProjectTerminalTab={openProjectTerminalTab}
      openCardTerminalTab={openCardTerminalTab}
      closeTerminalTab={closeTerminalTab}
      closeRecentCardSession={handleCloseRecentSession}
      closeCardStage={closeCardStageState}
      onLeaveCardStageCard={recordCardLeave}
      cardStageSessionSnapshotRef={cardStageSessionSnapshotRef}
      onRequestProjectPickerOpen={handleOpenProjectPicker}
      projectPickerOpenTick={projectPickerOpenTick}
      taskSearchOpenTick={taskSearchOpenTick}
      commandPaletteOpenTick={commandPaletteOpenTick}
      settingsToggleTick={settingsToggleTick}
      onCreateProject={handleCreateProject}
      onDeleteProject={handleDeleteProject}
      onRenameProject={handleRenameProject}
      navigateToStage={navigateToStage}
      navigateToDbView={navigateToDbView}
      navigateToRecentSession={navigateToRecentSession}
      navigateToCardsTab={navigateToCardsTab}
      navigateToThreadTab={navigateToThreadTab}
      navigateToFilesTab={navigateToFilesTab}
      canNavigateBack={navigationHistory.backStack.length > 0}
      canNavigateForward={navigationHistory.forwardStack.length > 0}
      onNavigateBack={() => {
        void navigateBack();
      }}
      onNavigateForward={() => {
        void navigateForward();
      }}
    />
  );
}

export default function App() {
  const [bootstrapState, setBootstrapState] = useState<{
    ready: boolean;
    snapshot: WorkbenchResumeSnapshot | null;
    step: AppInitializationStep;
    migrationProgress: DatabaseMigrationProgress | null;
  }>({
    ready: false,
    snapshot: null,
    step: { phase: "app_waiting" },
    migrationProgress: null,
  });

  useEffect(() => {
    let cancelled = false;
    const unsubscribers: Array<() => void> = [];

    if (window.api?.onInitializationStep) {
      unsubscribers.push(
        window.api.onInitializationStep((step) => {
          if (cancelled) return;
          setBootstrapState((current) => ({ ...current, step }));
        }),
      );
    }

    if (window.api?.onDatabaseMigrationProgress) {
      unsubscribers.push(
        window.api.onDatabaseMigrationProgress((migrationProgress) => {
          if (cancelled) return;
          setBootstrapState((current) => ({ ...current, migrationProgress }));
        }),
      );
    }

    const bootstrapPromise = window.api?.awaitInitialization
      ? window.api.awaitInitialization().then(() => consumeWorkbenchResumeSnapshot())
      : consumeWorkbenchResumeSnapshot();

    void bootstrapPromise
      .then((snapshot) => {
        if (cancelled) return;
        setBootstrapState({
          ready: true,
          snapshot,
          step: { phase: "done" },
          migrationProgress: { type: "Done" },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrapState({
          ready: true,
          snapshot: null,
          step: { phase: "done" },
          migrationProgress: { type: "Done" },
        });
      });

    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  if (!bootstrapState.ready) {
    return (
      <AppStartupScreen
        step={bootstrapState.step}
        migrationProgress={bootstrapState.migrationProgress}
      />
    );
  }

  return <WorkbenchApp initialResumeSnapshot={bootstrapState.snapshot} />;
}
