import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  FileText,
  LayoutGrid,
  PenLine,
  SquareKanban,
  Table2,
} from "lucide-react";
import { CardIcon } from "./card-icon";
import { CommandPalette } from "./command-palette";
import { DbViewToolbar } from "./db-view-toolbar";
import {
  type DbViewPrefs,
  type SupportedDbView,
  viewSupportsDbViewPrefs,
} from "../../lib/db-view-prefs";
import { ThreadsIcon } from "./threads-icon";
import { ToggleListIcon } from "./toggle-list-icon";
import { MainViewHost } from "./main-view-host";
import { SettingsOverlay } from "./workbench-settings-overlay";
import {
  LeftSidebar,
  type StageSidebarGroup,
  type StageSidebarItem,
  type StageSidebarSection,
} from "./left-sidebar";
import { StageMinimap } from "./stage-minimap";
import { StageRail, type StageRailStage } from "./stage-rail";
import { StageTabStrip } from "./stage-tab-strip";
import { StageThreads } from "./stage-threads";
import { resolveThreadCardStatus } from "./stage-threads/thread-card-fetch";
import { StageFilesPlaceholder } from "./stage-files-placeholder";
import { HistoryPanel } from "@/components/kanban/history-panel";
import { CardStage } from "@/components/kanban/card-stage";
import { TerminalPanel } from "@/components/kanban/terminal-panel";
import { invoke } from "@/lib/api";
import {
  FLOATING_SIDEBAR_TRANSITION_DURATION_MS,
  FLOATING_SIDEBAR_TRANSITION_TIMING_FUNCTION,
  SIDEBAR_HOVER_KEEP_OPEN_MS,
  SIDEBAR_HOVER_OPEN_DELAY_MS,
  SIDEBAR_HOVER_TRIGGER_WIDTH_PX,
} from "../../lib/floating-sidebar";
import {
  readNextPanelPeekPx,
  writeNextPanelPeekPx,
} from "@/lib/stage-rail-peek";
import {
  readThreadPanelHideThinkingWhenDone,
  writeThreadPanelHideThinkingWhenDone,
} from "@/lib/thread-panel-thinking-visibility";
import {
  readThreadPromptSubmitShortcut,
  writeThreadPromptSubmitShortcut,
} from "@/lib/thread-panel-prompt-submit-shortcut";
import {
  readWorktreeStartMode,
  writeWorktreeStartMode,
} from "@/lib/worktree-start-mode";
import {
  readWorktreeAutoBranchPrefix,
  writeWorktreeAutoBranchPrefix,
} from "@/lib/worktree-branch-prefix";
import {
  DEFAULT_CODEX_COLLABORATION_MODE,
  getDraftCollaborationModeStorageKey,
  getThreadCollaborationModeStorageKey,
  readCollaborationModeForContextKey,
  writeCollaborationModeForContextKey,
} from "@/lib/codex-collaboration-mode-settings";
import {
  readSmartPrefixParsingEnabled,
  readStripSmartPrefixFromTitleEnabled,
  writeSmartPrefixParsingEnabled,
  writeStripSmartPrefixFromTitleEnabled,
} from "@/lib/smart-prefix-parsing";
import type { StageRailLayoutMode } from "@/lib/stage-rail-layout-mode";
import { useCodex } from "@/lib/use-codex";
import { useKanban } from "@/lib/use-kanban";
import { KANBAN_STATUS_LABELS } from "@/lib/kanban-options";
import { StatusIcon as SharedStatusIcon } from "@/lib/status-chip";
import { cn } from "@/lib/utils";
import { TOGGLE_LIST_STATUS_ORDER } from "../../lib/toggle-list/types";
import {
  resolveVisibleSidebarTopLevelSections,
  type SidebarSectionItemLimit,
  type SidebarTopLevelSectionId,
  type SidebarTopLevelSectionsPrefs,
} from "../../lib/sidebar-section-prefs";
import type {
  Card,
  CardInput,
  CardUpdateMutationResult,
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  Project,
} from "@/lib/types";
import type { CardStageState } from "@/lib/use-card-stage";
import {
  NEW_THREAD_STAGE_TAB_ID,
  resolveSlidingWindowFocusIntent,
  resolveExpandedStages,
  STAGE_ORDER,
} from "@/lib/use-workbench-state";
import type {
  CardsStageTab,
  FilesStageTab,
  RecentCardSession,
  SidebarGroupId,
  SpaceRef,
  StageNavDirection,
  StageId,
  StagePanelWidths,
  TerminalStageTab,
  ThreadsStageTab,
  WorkbenchView,
} from "@/lib/use-workbench-state";
import type { CardStageSessionSnapshot } from "@/components/kanban/card-stage/types";

interface WorkbenchShellProps {
  projects: Project[];
  dbProjectId: string;
  threadsProjectId: string;
  activeView: WorkbenchView;
  activeSearchQuery: string;
  activeDbViewPrefs: DbViewPrefs | null;
  spaces: SpaceRef[];
  recentCardSessions: RecentCardSession[];
  activeRecentSessionId: string | null;
  sidebar: {
    collapsed: boolean;
    width: number;
    topLevelSectionOrder: SidebarTopLevelSectionId[];
    topLevelSections: SidebarTopLevelSectionsPrefs;
  };
  focusedStage: StageId;
  cardsTabs: CardsStageTab[];
  activeCardsTabId: string;
  threadsTabs: ThreadsStageTab[];
  activeThreadsTabId: string;
  terminalTabs: TerminalStageTab[];
  activeTerminalTabId: string;
  filesTabs: FilesStageTab[];
  activeFilesTabId: string;
  stagePanelWidths: StagePanelWidths;
  stageRailLayoutMode: StageRailLayoutMode;
  onStageRailLayoutModeChange: (mode: StageRailLayoutMode) => void;
  stageNavDirection: StageNavDirection;
  slidingWindowPaneCount: number;
  terminalPanelOpen: boolean;
  terminalPanelHeight: number;
  cardStageState: CardStageState;
  cardStageCardId?: string;
  cardStageCloseRef: React.RefObject<(() => Promise<void>) | null>;
  cardStagePersistRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  pendingReminderOpen?: {
    projectId: string;
    cardId: string;
    occurrenceStart: string;
  } | null;
  onReminderHandled?: (payload: {
    projectId: string;
    cardId: string;
    occurrenceStart: string;
  }) => void;
  openCardStage: (
    projectId: string,
    cardId: string,
    titleSnapshot?: string,
  ) => void;
  setDbProject: (projectId: string) => void;
  setSearchQuery: (projectId: string, value: string) => void;
  setDbViewPrefs: (
    projectId: string,
    view: SupportedDbView,
    update: (prev: DbViewPrefs) => DbViewPrefs,
  ) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarTopLevelSectionVisible: (sectionId: SidebarTopLevelSectionId, visible: boolean) => void;
  setSidebarTopLevelSectionItemLimit: (
    sectionId: SidebarTopLevelSectionId,
    itemLimit: SidebarSectionItemLimit,
  ) => void;
  moveSidebarTopLevelSectionBy: (sectionId: SidebarTopLevelSectionId, direction: -1 | 1) => void;
  setSidebarStageExpanded: (projectId: string, stageId: SidebarGroupId, expanded: boolean) => void;
  isSidebarStageExpanded: (projectId: string, stageId: SidebarGroupId) => boolean;
  setSidebarSectionExpanded: (projectId: string, sectionId: string, expanded: boolean) => void;
  isSidebarSectionExpanded: (projectId: string, sectionId: string) => boolean;
  setSidebarSectionShowAll: (projectId: string, sectionId: string, showAll: boolean) => void;
  isSidebarSectionShowAll: (projectId: string, sectionId: string) => boolean;
  setActiveThreadsTab: (projectId: string, tabId: string) => void;
  setThreadsTabs: (projectId: string, tabs: ThreadsStageTab[]) => void;
  setActiveTerminalTab: (projectId: string, tabId: string) => void;
  setStagePanelWidths: (projectId: string, widths: StagePanelWidths) => void;
  stepSlidingWindowPaneCount: (action: "decrease" | "increase") => void;
  setTerminalPanelOpen: (projectId: string, open: boolean) => void;
  setTerminalPanelHeight: (projectId: string, height: number) => void;
  openProjectTerminalTab: (projectId: string) => string;
  openCardTerminalTab: (projectId: string, sessionRefId: string, cardId: string, title: string) => string;
  closeTerminalTab: (projectId: string, tabId: string) => void;
  closeRecentCardSession: (sessionId: string) => void;
  closeCardStage: () => void;
  onLeaveCardStageCard: (snapshot: CardStageSessionSnapshot) => void;
  cardStageSessionSnapshotRef?: React.MutableRefObject<CardStageSessionSnapshot | null>;
  onRequestProjectPickerOpen: () => void;
  projectPickerOpenTick: number;
  taskSearchOpenTick: number;
  commandPaletteOpenTick: number;
  settingsToggleTick: number;
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
  navigateToStage: (projectId: string, stageId: StageId, fallbackDirection?: StageNavDirection) => void;
  navigateToDbView: (projectId: string, view: WorkbenchView) => void;
  navigateToRecentSession: (sessionId: string) => void | Promise<void>;
  navigateToCardsTab: (projectId: string, tabId: string, activeSessionId: string | null) => void;
  navigateToThreadTab: (projectId: string, tabId: string, focusStage?: boolean) => void;
  navigateToFilesTab: (projectId: string, tabId: string) => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}

const DB_VIEW_TABS: Array<{ id: WorkbenchView; label: string }> = [
  { id: "kanban", label: "Board" },
  { id: "list", label: "Table" },
  { id: "toggle-list", label: "List" },
  { id: "canvas", label: "Canvas" },
  { id: "calendar", label: "Calendar" },
];

const DB_VIEW_ICONS: Record<WorkbenchView, StageSidebarItem["icon"]> = {
  kanban: SquareKanban,
  list: Table2,
  "toggle-list": ToggleListIcon,
  canvas: PenLine,
  calendar: CalendarDays,
};

const STAGE_ICONS: Record<StageId, StageSidebarGroup["icon"]> = {
  db: LayoutGrid,
  cards: CardIcon,
  threads: ThreadsIcon,
  files: FileText,
};
const COLLAPSE_CONTROL_TRAFFIC_LIGHT_OFFSET_PX = 90;
const SIDEBAR_COLLAPSE_TRANSITION_MS = 220;
const FALLBACK_COLLABORATION_MODE_PRESETS: CodexCollaborationModePreset[] = [
  {
    name: "Default",
    mode: "default",
    model: null,
    reasoningEffort: undefined,
  },
  {
    name: "Plan",
    mode: "plan",
    model: null,
    reasoningEffort: undefined,
  },
];

function RunningThreadSpinnerIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex size-3.5 items-center justify-center text-[color-mix(in_srgb,var(--sidebar-foreground)_70%,transparent)]", className)}>
      <span className="inline-flex animate-spin animation-duration-[2000ms]" style={{ animationDelay: "-703ms" }}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden className="size-3.5 shrink-0">
          <path
            d="M10 2C5.58172 2 2 5.58172 2 10C2 14.4183 5.58172 18 10 18C14.4183 18 18 14.4183 18 10C18 5.58172 14.4183 2 10 2ZM10 4C13.3137 4 16 6.68629 16 10C16 13.3137 13.3137 16 10 16C6.68629 16 4 13.3137 4 10C4 6.68629 6.68629 4 10 4Z"
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            style={{
              maskImage: "conic-gradient(transparent 0deg, currentColor 360deg)",
              maskMode: "alpha",
              maskSize: "contain",
            }}
          />
        </svg>
      </span>
    </span>
  );
}

export function WorkbenchShell({
  projects,
  dbProjectId,
  threadsProjectId,
  activeView,
  activeSearchQuery,
  activeDbViewPrefs,
  spaces,
  recentCardSessions,
  activeRecentSessionId,
  sidebar,
  focusedStage,
  activeCardsTabId,
  threadsTabs,
  activeThreadsTabId,
  terminalTabs,
  activeTerminalTabId,
  filesTabs,
  activeFilesTabId,
  stagePanelWidths,
  stageRailLayoutMode,
  onStageRailLayoutModeChange,
  stageNavDirection,
  slidingWindowPaneCount,
  terminalPanelOpen,
  terminalPanelHeight,
  cardStageState,
  cardStageCardId,
  cardStageCloseRef,
  cardStagePersistRef,
  pendingReminderOpen,
  onReminderHandled,
  openCardStage,
  setDbProject,
  setSearchQuery,
  setDbViewPrefs,
  setSidebarCollapsed,
  setSidebarWidth,
  setSidebarTopLevelSectionVisible,
  setSidebarTopLevelSectionItemLimit,
  moveSidebarTopLevelSectionBy,
  setSidebarStageExpanded,
  isSidebarStageExpanded,
  setSidebarSectionExpanded,
  isSidebarSectionExpanded,
  setSidebarSectionShowAll,
  isSidebarSectionShowAll,
  setActiveThreadsTab,
  setThreadsTabs,
  setActiveTerminalTab,
  setStagePanelWidths,
  stepSlidingWindowPaneCount,
  setTerminalPanelOpen,
  setTerminalPanelHeight,
  openProjectTerminalTab,
  openCardTerminalTab,
  closeTerminalTab,
  closeRecentCardSession,
  closeCardStage,
  onLeaveCardStageCard,
  cardStageSessionSnapshotRef,
  onRequestProjectPickerOpen,
  projectPickerOpenTick,
  taskSearchOpenTick,
  commandPaletteOpenTick,
  settingsToggleTick,
  onCreateProject,
  onDeleteProject,
  onRenameProject,
  navigateToStage,
  navigateToDbView,
  navigateToRecentSession,
  navigateToCardsTab,
  navigateToThreadTab,
  navigateToFilesTab,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
}: WorkbenchShellProps) {
  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const canRequestNewWindow = typeof window !== "undefined" && Boolean(window.api);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(() => !sidebar.collapsed);
  const [hoverSidebarOpen, setHoverSidebarOpen] = useState(false);
  const sidebarHideTimeoutRef = useRef<number | null>(null);
  const hoverSidebarOpenTimeoutRef = useRef<number | null>(null);
  const hoverSidebarCloseTimeoutRef = useRef<number | null>(null);
  const [nextPanelPeekPx, setNextPanelPeekPxState] = useState<number>(() => readNextPanelPeekPx());
  const [hideThinkingWhenDone, setHideThinkingWhenDoneState] = useState<boolean>(() =>
    readThreadPanelHideThinkingWhenDone(),
  );
  const [smartPrefixParsingEnabled, setSmartPrefixParsingEnabledState] = useState<boolean>(() =>
    readSmartPrefixParsingEnabled(),
  );
  const [stripSmartPrefixFromTitleEnabled, setStripSmartPrefixFromTitleEnabledState] = useState<boolean>(() =>
    readStripSmartPrefixFromTitleEnabled(),
  );
  const [threadPromptSubmitShortcut, setThreadPromptSubmitShortcutState] = useState(() =>
    readThreadPromptSubmitShortcut(),
  );
  const [worktreeStartMode, setWorktreeStartModeState] = useState(() =>
    readWorktreeStartMode(),
  );
  const [worktreeAutoBranchPrefix, setWorktreeAutoBranchPrefixState] = useState(() =>
    readWorktreeAutoBranchPrefix(),
  );
  const [availableCollaborationModes, setAvailableCollaborationModes] = useState<CodexCollaborationModePreset[]>(
    FALLBACK_COLLABORATION_MODE_PRESETS,
  );
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<CodexCollaborationModeKind>(
    DEFAULT_CODEX_COLLABORATION_MODE,
  );
  const [activeThreadCardColumnId, setActiveThreadCardColumnId] = useState<string | null>(null);
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const taskSearchInputRef = useRef<HTMLInputElement>(null);
  const previousTaskSearchOpenTickRef = useRef(taskSearchOpenTick);
  const previousCommandPaletteOpenTickRef = useRef(commandPaletteOpenTick);
  const previousSettingsToggleTickRef = useRef(settingsToggleTick);
  const {
    state: codexState,
    threads: codexThreads,
    availableModels,
    threadSettings,
    reasoningEffortOptions,
    permissionMode,
    approvalQueue,
    userInputQueue,
    planImplementationQueue,
    loadThreads: loadCodexThreads,
    listCollaborationModes,
    readThread: readCodexThread,
    startThreadForCard,
    startTurn,
    sendPromptToThread,
    steerTurn,
    interruptTurn,
    respondApproval,
    respondUserInput,
    resolvePlanImplementation,
    refreshAccount,
    startChatGptLogin,
    startApiKeyLogin,
    cancelLogin,
    logout,
    setPermissionMode,
    setThreadModel,
    setThreadReasoningEffort,
  } = useCodex(threadsProjectId);
  const cardStageProjectId = cardStageState.projectId || dbProjectId;
  const {
    board: cardStageBoard,
    cardIndex: cardStageCardIndex,
    loading: cardStageBoardLoading,
    updateCard: updateCardForCardStage,
    patchCard: patchCardForCardStage,
    deleteCard: deleteCardForCardStage,
    moveCard: moveCardForCardStage,
    completeOccurrence: completeOccurrenceForCardStage,
    skipOccurrence: skipOccurrenceForCardStage,
  } = useKanban({
    projectId: cardStageProjectId,
  });
  const {
    board: activeProjectBoard,
    pendingMutationCount: activeProjectPendingMutationCount,
    lastMutationError: activeProjectLastMutationError,
    clearLastMutationError: clearActiveProjectLastMutationError,
  } = useKanban({
    projectId: dbProjectId,
  });
  const [mutationErrorToast, setMutationErrorToast] = useState<string | null>(null);
  const activeDbRulesView = viewSupportsDbViewPrefs(activeView) ? activeView : null;
  const activeProjectTags = useMemo(() => {
    if (!activeProjectBoard) return [];
    return Array.from(
      new Set(activeProjectBoard.columns.flatMap((column) => column.cards.flatMap((card) => card.tags))),
    ).sort((left, right) => left.localeCompare(right));
  }, [activeProjectBoard]);
  const updateActiveDbViewPrefs = activeDbRulesView
    ? (update: (prev: DbViewPrefs) => DbViewPrefs) => setDbViewPrefs(dbProjectId, activeDbRulesView, update)
    : null;

  const setNextPanelPeekPx = useCallback((value: number) => {
    const normalized = writeNextPanelPeekPx(value);
    setNextPanelPeekPxState(normalized);
  }, []);

  const setHideThinkingWhenDone = useCallback((value: boolean) => {
    const normalized = writeThreadPanelHideThinkingWhenDone(value);
    setHideThinkingWhenDoneState(normalized);
  }, []);
  const setSmartPrefixParsingEnabled = useCallback((value: boolean) => {
    const normalized = writeSmartPrefixParsingEnabled(value);
    setSmartPrefixParsingEnabledState(normalized);
  }, []);
  const setStripSmartPrefixFromTitleEnabled = useCallback((value: boolean) => {
    const normalized = writeStripSmartPrefixFromTitleEnabled(value);
    setStripSmartPrefixFromTitleEnabledState(normalized);
  }, []);
  const setThreadPromptSubmitShortcut = useCallback((value: "enter" | "mod-enter") => {
    const normalized = writeThreadPromptSubmitShortcut(value);
    setThreadPromptSubmitShortcutState(normalized);
  }, []);
  const setWorktreeStartMode = useCallback((value: "autoBranch" | "detachedHead") => {
    const normalized = writeWorktreeStartMode(value);
    setWorktreeStartModeState(normalized);
  }, []);
  const setWorktreeAutoBranchPrefix = useCallback((value: string) => {
    const normalized = writeWorktreeAutoBranchPrefix(value);
    setWorktreeAutoBranchPrefixState(normalized);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void listCollaborationModes()
      .then((presets) => {
        if (cancelled) return;
        if (!Array.isArray(presets) || presets.length === 0) {
          setAvailableCollaborationModes(FALLBACK_COLLABORATION_MODE_PRESETS);
          return;
        }

        const dedupedByMode = new Map<CodexCollaborationModeKind, CodexCollaborationModePreset>();
        for (const preset of presets) {
          if (preset.mode !== "default" && preset.mode !== "plan") continue;
          if (dedupedByMode.has(preset.mode)) continue;
          dedupedByMode.set(preset.mode, preset);
        }

        const resolved = Array.from(dedupedByMode.values());
        setAvailableCollaborationModes(
          resolved.length > 0 ? resolved : FALLBACK_COLLABORATION_MODE_PRESETS,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableCollaborationModes(FALLBACK_COLLABORATION_MODE_PRESETS);
      });

    return () => {
      cancelled = true;
    };
  }, [listCollaborationModes]);

  const openTaskSearch = useCallback((selectQuery = false) => {
    setTaskSearchOpen(true);
    window.requestAnimationFrame(() => {
      const input = taskSearchInputRef.current;
      if (!input) return;
      input.focus();
      if (selectQuery) input.select();
    });
  }, []);

  const closeTaskSearch = useCallback(() => {
    setTaskSearchOpen(false);
  }, []);

  useEffect(() => {
    if (!activeProjectLastMutationError) return;
    setMutationErrorToast(activeProjectLastMutationError);
    clearActiveProjectLastMutationError();
  }, [activeProjectLastMutationError, clearActiveProjectLastMutationError]);

  useEffect(() => {
    if (!mutationErrorToast) return;
    const timeout = window.setTimeout(() => {
      setMutationErrorToast(null);
    }, 4000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [mutationErrorToast]);

  useEffect(() => {
    const handleCardConflict = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail || detail.projectId !== dbProjectId) return;
      setMutationErrorToast("Card changed in another window. Reloaded latest.");
    };

    window.addEventListener("nodex:card-update-conflict", handleCardConflict as EventListener);
    return () => {
      window.removeEventListener("nodex:card-update-conflict", handleCardConflict as EventListener);
    };
  }, [dbProjectId]);

  useEffect(() => {
    if (previousTaskSearchOpenTickRef.current === taskSearchOpenTick) return;
    previousTaskSearchOpenTickRef.current = taskSearchOpenTick;
    openTaskSearch(true);
  }, [openTaskSearch, taskSearchOpenTick]);

  useEffect(() => {
    if (previousCommandPaletteOpenTickRef.current === commandPaletteOpenTick) return;
    previousCommandPaletteOpenTickRef.current = commandPaletteOpenTick;
    setCommandPaletteOpen(true);
  }, [commandPaletteOpenTick]);

  useEffect(() => {
    if (previousSettingsToggleTickRef.current === settingsToggleTick) return;
    previousSettingsToggleTickRef.current = settingsToggleTick;
    setSettingsOpen((open) => !open);
  }, [settingsToggleTick]);

  const slidingWindowVisibleStages = useMemo(
    () => resolveExpandedStages(focusedStage, stageNavDirection, slidingWindowPaneCount, false),
    [focusedStage, slidingWindowPaneCount, stageNavDirection],
  );
  const sidebarVisibleStageSet = useMemo(() => {
    if (stageRailLayoutMode !== "sliding-window") {
      return new Set<StageId>(STAGE_ORDER);
    }

    return new Set<StageId>(slidingWindowVisibleStages);
  }, [slidingWindowVisibleStages, stageRailLayoutMode]);
  const isSidebarStageVisible = useCallback(
    (stageId: StageId) => sidebarVisibleStageSet.has(stageId),
    [sidebarVisibleStageSet],
  );

  const handleOpenCardStageFromView = useCallback(
    (
      projectId: string,
      cardId: string,
      titleSnapshot?: string,
    ) => {
      openCardStage(projectId, cardId, titleSnapshot);
    },
    [openCardStage],
  );

  const handleStageRailFocus = useCallback((stageId: StageId) => {
    if (stageRailLayoutMode !== "sliding-window") {
      navigateToStage(dbProjectId, stageId);
      return;
    }

    const { direction } = resolveSlidingWindowFocusIntent(
      stageId,
      slidingWindowVisibleStages,
      slidingWindowPaneCount,
      stageNavDirection,
    );
    navigateToStage(dbProjectId, stageId, direction);
  }, [
    dbProjectId,
    navigateToStage,
    slidingWindowVisibleStages,
    slidingWindowPaneCount,
    stageNavDirection,
    stageRailLayoutMode,
  ]);

  const handleCommandPaletteSetView = useCallback((view: WorkbenchView) => {
    navigateToDbView(dbProjectId, view);
  }, [dbProjectId, navigateToDbView]);

  const handleCommandPaletteToggleTerminal = useCallback(() => {
    setTerminalPanelOpen(dbProjectId, !terminalPanelOpen);
  }, [dbProjectId, setTerminalPanelOpen, terminalPanelOpen]);

  const clearSidebarHideTimeout = useCallback(() => {
    if (sidebarHideTimeoutRef.current === null) return;
    window.clearTimeout(sidebarHideTimeoutRef.current);
    sidebarHideTimeoutRef.current = null;
  }, []);

  const clearHoverSidebarOpenTimeout = useCallback(() => {
    if (hoverSidebarOpenTimeoutRef.current === null) return;
    window.clearTimeout(hoverSidebarOpenTimeoutRef.current);
    hoverSidebarOpenTimeoutRef.current = null;
  }, []);

  const clearHoverSidebarCloseTimeout = useCallback(() => {
    if (hoverSidebarCloseTimeoutRef.current === null) return;
    window.clearTimeout(hoverSidebarCloseTimeoutRef.current);
    hoverSidebarCloseTimeoutRef.current = null;
  }, []);

  const closeHoverSidebar = useCallback(() => {
    clearHoverSidebarOpenTimeout();
    clearHoverSidebarCloseTimeout();
    window.requestAnimationFrame(() => {
      setHoverSidebarOpen(false);
    });
  }, [clearHoverSidebarCloseTimeout, clearHoverSidebarOpenTimeout]);

  const scheduleHoverSidebarOpen = useCallback(() => {
    if (!sidebar.collapsed || sidebarVisible) return;

    clearHoverSidebarCloseTimeout();
    if (hoverSidebarOpen || hoverSidebarOpenTimeoutRef.current !== null) return;

    hoverSidebarOpenTimeoutRef.current = window.setTimeout(() => {
      hoverSidebarOpenTimeoutRef.current = null;
      window.requestAnimationFrame(() => {
        setHoverSidebarOpen(true);
      });
    }, SIDEBAR_HOVER_OPEN_DELAY_MS);
  }, [clearHoverSidebarCloseTimeout, hoverSidebarOpen, sidebar.collapsed, sidebarVisible]);

  const scheduleHoverSidebarClose = useCallback(() => {
    if (!sidebar.collapsed || !hoverSidebarOpen) return;

    clearHoverSidebarOpenTimeout();
    if (hoverSidebarCloseTimeoutRef.current !== null) return;

    hoverSidebarCloseTimeoutRef.current = window.setTimeout(() => {
      hoverSidebarCloseTimeoutRef.current = null;
      closeHoverSidebar();
    }, SIDEBAR_HOVER_KEEP_OPEN_MS);
  }, [clearHoverSidebarOpenTimeout, closeHoverSidebar, hoverSidebarOpen, sidebar.collapsed]);

  const toggleSidebarCollapsed = useCallback(() => {
    if (sidebar.collapsed) {
      clearHoverSidebarOpenTimeout();
      clearHoverSidebarCloseTimeout();
      setHoverSidebarOpen(false);
      setSidebarVisible(true);
    }
    setSidebarCollapsed(!sidebar.collapsed);
  }, [clearHoverSidebarCloseTimeout, clearHoverSidebarOpenTimeout, setSidebarCollapsed, sidebar.collapsed]);

  useEffect(() => {
    if (sidebar.collapsed) return;
    clearHoverSidebarOpenTimeout();
    clearHoverSidebarCloseTimeout();
    setHoverSidebarOpen(false);
    setSidebarVisible(true);
  }, [clearHoverSidebarCloseTimeout, clearHoverSidebarOpenTimeout, sidebar.collapsed]);

  useEffect(() => {
    if (!sidebar.collapsed) {
      clearSidebarHideTimeout();
      return;
    }
    if (!sidebarVisible) return;

    clearSidebarHideTimeout();
    sidebarHideTimeoutRef.current = window.setTimeout(() => {
      setSidebarVisible(false);
      sidebarHideTimeoutRef.current = null;
    }, SIDEBAR_COLLAPSE_TRANSITION_MS);

    return clearSidebarHideTimeout;
  }, [clearSidebarHideTimeout, sidebar.collapsed, sidebarVisible]);

  useEffect(() => {
    return () => {
      clearSidebarHideTimeout();
      clearHoverSidebarOpenTimeout();
      clearHoverSidebarCloseTimeout();
    };
  }, [clearHoverSidebarCloseTimeout, clearHoverSidebarOpenTimeout, clearSidebarHideTimeout]);

  useEffect(() => {
    if (!hoverSidebarOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeHoverSidebar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeHoverSidebar, hoverSidebarOpen]);

  const decreaseSlidingWindowPaneCount = useCallback(() => {
    if (stageRailLayoutMode !== "sliding-window") return;
    stepSlidingWindowPaneCount("decrease");
  }, [
    stepSlidingWindowPaneCount,
    stageRailLayoutMode,
  ]);

  const increaseSlidingWindowPaneCount = useCallback(() => {
    if (stageRailLayoutMode !== "sliding-window") return;
    stepSlidingWindowPaneCount("increase");
  }, [
    stepSlidingWindowPaneCount,
    stageRailLayoutMode,
  ]);

  const decreasePaneCountButton = (
    <button
      type="button"
      onClick={decreaseSlidingWindowPaneCount}
      disabled={stageRailLayoutMode !== "sliding-window" || slidingWindowPaneCount <= 1}
      title="Decrease visible panes"
      aria-label="Decrease visible panes"
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-lg transition-colors",
        stageRailLayoutMode !== "sliding-window" || slidingWindowPaneCount <= 1
          ? "cursor-not-allowed text-(--foreground-secondary) opacity-30"
          : "text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8.5 3.5L5 7L8.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  const increasePaneCountButton = (
    <button
      type="button"
      onClick={increaseSlidingWindowPaneCount}
      disabled={stageRailLayoutMode !== "sliding-window" || slidingWindowPaneCount >= STAGE_ORDER.length}
      title="Increase visible panes"
      aria-label="Increase visible panes"
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-lg transition-colors",
        stageRailLayoutMode !== "sliding-window" || slidingWindowPaneCount >= STAGE_ORDER.length
          ? "cursor-not-allowed text-(--foreground-secondary) opacity-30"
          : "text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.5 3.5L9 7L5.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  const activeTerminalTab = useMemo(
    () => terminalTabs.find((tab) => tab.id === activeTerminalTabId) ?? terminalTabs[0] ?? null,
    [terminalTabs, activeTerminalTabId],
  );

  const codexThreadTabs = useMemo<ThreadsStageTab[]>(
    () => [
      { id: NEW_THREAD_STAGE_TAB_ID, title: "New thread", preview: "" },
      ...codexThreads.map((thread) => ({
        id: thread.threadId,
        title: thread.threadName?.trim() || thread.threadPreview || thread.threadId,
        preview: thread.threadPreview,
      })),
    ],
    [codexThreads],
  );

  useEffect(() => {
    setThreadsTabs(threadsProjectId, codexThreadTabs);
  }, [threadsProjectId, codexThreadTabs, setThreadsTabs]);

  const resolvedThreadsTabs = codexThreadTabs.length > 0 ? codexThreadTabs : threadsTabs;
  const resolvedActiveThreadsTabId = useMemo(() => {
    if (resolvedThreadsTabs.some((tab) => tab.id === activeThreadsTabId)) return activeThreadsTabId;
    return resolvedThreadsTabs[0]?.id ?? "";
  }, [activeThreadsTabId, resolvedThreadsTabs]);

  useEffect(() => {
    if (resolvedActiveThreadsTabId === activeThreadsTabId) return;
    setActiveThreadsTab(threadsProjectId, resolvedActiveThreadsTabId);
  }, [threadsProjectId, activeThreadsTabId, resolvedActiveThreadsTabId, setActiveThreadsTab]);

  const activeThreadTab = useMemo(
    () => resolvedThreadsTabs.find((tab) => tab.id === resolvedActiveThreadsTabId) ?? null,
    [resolvedThreadsTabs, resolvedActiveThreadsTabId],
  );

  const isNewThreadTab = resolvedActiveThreadsTabId === NEW_THREAD_STAGE_TAB_ID;

  const runningThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of codexThreads) {
      const detail = codexState.threadDetailsById[thread.threadId];
      const hasInProgressTurn = detail?.turns.some((turn) => turn.status === "inProgress") ?? false;
      if (thread.statusType === "active" || hasInProgressTurn) ids.add(thread.threadId);
    }
    return ids;
  }, [codexState.threadDetailsById, codexThreads]);

  const activeThreadDetail = useMemo(() => {
    if (!activeThreadTab || activeThreadTab.id === NEW_THREAD_STAGE_TAB_ID) return null;
    const detail = codexState.threadDetailsById[activeThreadTab.id];
    if (!detail) return null;

    const summary = codexThreads.find((thread) => thread.threadId === activeThreadTab.id);
    if (!summary) return detail;

    return {
      ...detail,
      statusType: summary.statusType,
      statusActiveFlags: summary.statusActiveFlags,
      updatedAt: Math.max(detail.updatedAt, summary.updatedAt),
    };
  }, [activeThreadTab, codexState.threadDetailsById, codexThreads]);

  useEffect(() => {
    if (!activeThreadTab) return;
    if (activeThreadTab.id === NEW_THREAD_STAGE_TAB_ID) return;
    if (codexState.threadDetailsById[activeThreadTab.id]) return;
    void readCodexThread(activeThreadTab.id, true).catch(() => { });
  }, [activeThreadTab, codexState.threadDetailsById, readCodexThread]);

  const activeCardsSessionId = activeCardsTabId.startsWith("session:")
    ? activeCardsTabId.slice("session:".length)
    : null;
  const activeCardStageCardId = cardStageState.open ? cardStageState.cardId : null;
  const activeCardStageCard = useMemo(
    () => (activeCardStageCardId ? cardStageCardIndex.get(activeCardStageCardId) ?? null : null),
    [activeCardStageCardId, cardStageCardIndex],
  );
  const activeCardStageColumnId = activeCardStageCard?.columnId ?? "";
  const cardStageColumnName = useMemo(
    () => activeCardStageCard?.columnName ?? KANBAN_STATUS_LABELS[activeCardStageColumnId] ?? "",
    [activeCardStageCard?.columnName, activeCardStageColumnId],
  );
  const cardStageAvailableTags = useMemo(() => {
    if (!cardStageBoard) return [];
    const uniqueTags = new Set(
      cardStageBoard.columns.flatMap((column) => column.cards.flatMap((card) => card.tags ?? [])),
    );
    return Array.from(uniqueTags);
  }, [cardStageBoard]);
  const historyOverlayOpen = activeCardsTabId === "history" && Boolean(activeCardStageCard);

  const currentCardStageSession = useMemo(() => {
    if (!activeCardStageCardId) return null;
    return (
      recentCardSessions.find(
        (session) =>
          session.projectId === cardStageState.projectId &&
          session.cardId === activeCardStageCardId,
      ) ?? null
    );
  }, [activeCardStageCardId, cardStageState.projectId, recentCardSessions]);

  const dbSidebarItems: StageSidebarItem[] = DB_VIEW_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: DB_VIEW_ICONS[tab.id],
    active: activeView === tab.id,
    onSelect: () => navigateToDbView(dbProjectId, tab.id),
  }));

  const cardsSidebarSections = useMemo<StageSidebarSection[]>(() => {
    const statusSections = TOGGLE_LIST_STATUS_ORDER.flatMap<StageSidebarSection>((statusId) => {
      const column = activeProjectBoard?.columns.find((candidate) => candidate.id === statusId);
      if (!column || column.cards.length === 0) return [];

      const StatusSectionIcon = ({ className }: { className?: string }) => (
        <SharedStatusIcon
          statusId={statusId}
          label={column.name || KANBAN_STATUS_LABELS[statusId] || statusId}
          className={className}
        />
      );

      return [{
        id: `cards:status:${statusId}`,
        label: column.name || KANBAN_STATUS_LABELS[statusId] || statusId,
        count: column.cards.length,
        icon: StatusSectionIcon,
        collapsible: true,
        items: column.cards.map((card) => ({
          id: `project-card:${card.id}`,
          label: card.title,
          active:
            isSidebarStageVisible("cards")
            && cardStageState.projectId === dbProjectId
            && activeCardStageCardId === card.id,
          onSelect: () => {
            openCardStage(dbProjectId, card.id, card.title);
          },
        })),
      }];
    });

    return statusSections;
  }, [
    activeCardStageCardId,
    activeProjectBoard,
    cardStageState.projectId,
    dbProjectId,
    isSidebarStageVisible,
    openCardStage,
  ]);

  const recentSidebarSections = useMemo<StageSidebarSection[]>(() => {
    if (recentCardSessions.length === 0) return [];

    return [{
      id: "recents:list",
      items: recentCardSessions.map((session) => ({
        id: `session:${session.id}`,
        label: session.titleSnapshot || session.cardId,
        active: isSidebarStageVisible("cards") && session.id === activeCardsSessionId,
        closable: true,
        onClose: () => closeRecentCardSession(session.id),
        onSelect: () => {
          void navigateToRecentSession(session.id);
        },
      })),
    }];
  }, [
    activeCardsSessionId,
    closeRecentCardSession,
    isSidebarStageVisible,
    navigateToRecentSession,
    recentCardSessions,
  ]);

  const threadSummaryById = useMemo(
    () => new Map(codexThreads.map((thread) => [thread.threadId, thread])),
    [codexThreads],
  );

  const threadsSidebarItems: StageSidebarItem[] = resolvedThreadsTabs.map((tab) => {
    const summary = threadSummaryById.get(tab.id);
    const isRunningThread = runningThreadIds.has(tab.id);
    return {
      id: tab.id,
      label: tab.title,
      icon: isRunningThread ? RunningThreadSpinnerIcon : undefined,
      updatedAtMs: summary?.updatedAt,
      active: isSidebarStageVisible("threads") && tab.id === resolvedActiveThreadsTabId,
      onSelect: () => navigateToThreadTab(summary?.projectId ?? threadsProjectId, tab.id),
    };
  });

  const filesSidebarItems: StageSidebarItem[] = filesTabs.map((tab) => ({
    id: tab.id,
    label: tab.title,
    active: isSidebarStageVisible("files") && tab.id === activeFilesTabId,
    onSelect: () => navigateToFilesTab(dbProjectId, tab.id),
  }));

  const dbStageGroup: StageSidebarGroup = {
    id: "db",
    label: "Views",
    hideHeader: true,
    icon: STAGE_ICONS.db,
    active: isSidebarStageVisible("db"),
    expanded: isSidebarStageExpanded(dbProjectId, "db"),
    onFocus: () => handleStageRailFocus("db"),
    onToggleExpanded: () =>
      setSidebarStageExpanded(dbProjectId, "db", !isSidebarStageExpanded(dbProjectId, "db")),
    sections: [{ id: "db:views", items: dbSidebarItems }],
    items: dbSidebarItems,
  };

  const topLevelStageGroups = new Map<SidebarTopLevelSectionId, StageSidebarGroup>([
    [
      "recents",
      {
        id: "recents",
        label: "Recents",
        active: isSidebarStageVisible("cards") && recentSidebarSections.some((section) =>
          section.items.some((item) => item.active),
        ),
        expanded: isSidebarStageExpanded(dbProjectId, "recents"),
        onFocus: () => handleStageRailFocus("cards"),
        onToggleExpanded: () =>
          setSidebarStageExpanded(dbProjectId, "recents", !isSidebarStageExpanded(dbProjectId, "recents")),
        sections: recentSidebarSections,
        items: recentSidebarSections.flatMap((section) => section.items),
      },
    ],
    [
      "cards",
      {
        id: "cards",
        label: "Cards",
        icon: STAGE_ICONS.cards,
        active: isSidebarStageVisible("cards"),
        expanded: isSidebarStageExpanded(dbProjectId, "cards"),
        onFocus: () => handleStageRailFocus("cards"),
        onToggleExpanded: () =>
          setSidebarStageExpanded(dbProjectId, "cards", !isSidebarStageExpanded(dbProjectId, "cards")),
        sections: cardsSidebarSections,
        items: cardsSidebarSections.flatMap((section) => section.items),
      },
    ],
    [
      "threads",
      {
        id: "threads",
        label: "Threads",
        icon: STAGE_ICONS.threads,
        active: isSidebarStageVisible("threads"),
        expanded: isSidebarStageExpanded(dbProjectId, "threads"),
        onFocus: () => handleStageRailFocus("threads"),
        onToggleExpanded: () =>
          setSidebarStageExpanded(dbProjectId, "threads", !isSidebarStageExpanded(dbProjectId, "threads")),
        sections: [{ id: "threads:list", items: threadsSidebarItems }],
        items: threadsSidebarItems,
      },
    ],
    [
      "files",
      {
        id: "files",
        label: "Diffs",
        icon: STAGE_ICONS.files,
        active: isSidebarStageVisible("files"),
        expanded: isSidebarStageExpanded(dbProjectId, "files"),
        onFocus: () => handleStageRailFocus("files"),
        onToggleExpanded: () =>
          setSidebarStageExpanded(dbProjectId, "files", !isSidebarStageExpanded(dbProjectId, "files")),
        sections: [{ id: "files:list", items: filesSidebarItems }],
        items: filesSidebarItems,
      },
    ],
  ]);

  const orderedTopLevelSectionIds = resolveVisibleSidebarTopLevelSections(
    sidebar.topLevelSectionOrder,
    sidebar.topLevelSections,
  );
  const sidebarSectionExpandedState = useMemo(() => {
    const stateBySection: Record<string, boolean> = {};
    for (const group of [dbStageGroup, ...topLevelStageGroups.values()]) {
      for (const section of group.sections) {
        stateBySection[section.id] = isSidebarSectionExpanded(dbProjectId, section.id);
      }
    }
    return stateBySection;
  }, [dbProjectId, dbStageGroup, isSidebarSectionExpanded, topLevelStageGroups]);
  const sidebarSectionShowAllState = useMemo(() => {
    const stateBySection: Record<string, boolean> = {};
    for (const group of [dbStageGroup, ...topLevelStageGroups.values()]) {
      for (const section of group.sections) {
        stateBySection[section.id] = isSidebarSectionShowAll(dbProjectId, section.id);
      }
    }
    return stateBySection;
  }, [dbProjectId, dbStageGroup, isSidebarSectionShowAll, topLevelStageGroups]);
  const stageGroups: StageSidebarGroup[] = [
    dbStageGroup,
    ...orderedTopLevelSectionIds.flatMap((sectionId, index, visibleIds) => {
      const group = topLevelStageGroups.get(sectionId);
      if (!group) return [];
      const sectionPrefs = sidebar.topLevelSections[sectionId];
      return [{
        ...group,
        moreActions: {
          itemLimit: sectionPrefs.itemLimit,
          canMoveUp: index > 0,
          canMoveDown: index < visibleIds.length - 1,
          onItemLimitChange: (itemLimit: SidebarSectionItemLimit) =>
            setSidebarTopLevelSectionItemLimit(sectionId, itemLimit),
          onMoveUp: () => moveSidebarTopLevelSectionBy(sectionId, -1),
          onMoveDown: () => moveSidebarTopLevelSectionBy(sectionId, 1),
          onHide: () => setSidebarTopLevelSectionVisible(sectionId, false),
        },
      }];
    }),
  ];

  const linkedThreadsForCardStageCard = useMemo(() => {
    if (!activeCardStageCardId) return [];
    return codexThreads
      .filter((thread) => thread.cardId === activeCardStageCardId)
      .map((thread) => ({
        threadId: thread.threadId,
        title: thread.threadName?.trim() || thread.threadPreview || thread.threadId,
        preview: thread.threadPreview,
        statusType: thread.statusType,
        statusActiveFlags: thread.statusActiveFlags,
        archived: thread.archived,
        updatedAt: thread.updatedAt,
      }));
  }, [activeCardStageCardId, codexThreads]);

  const activeThreadsProject = useMemo(
    () => projects.find((project) => project.id === threadsProjectId) ?? null,
    [projects, threadsProjectId],
  );

  const newThreadTarget = useMemo(() => {
    if (!activeCardStageCard || !cardStageState.projectId) return null;
    return {
      projectId: cardStageState.projectId,
      projectName: projects.find((project) => project.id === cardStageState.projectId)?.name ?? cardStageState.projectId,
      cardId: activeCardStageCard.id,
      cardTitle: activeCardStageCard.title,
      columnId: activeCardStageColumnId,
      runInTarget: activeCardStageCard.runInTarget,
    };
  }, [activeCardStageCard, activeCardStageColumnId, cardStageState.projectId, projects]);
  const newThreadStartProgress = useMemo(() => {
    if (!newThreadTarget) return null;
    const key = `${newThreadTarget.projectId}:${newThreadTarget.cardId}`;
    const progress = codexState.threadStartProgressByTarget?.[key];
    if (!progress) return null;
    return {
      phase: progress.phase,
      message: progress.message,
      outputText: progress.outputText,
      updatedAt: progress.updatedAt,
    };
  }, [codexState.threadStartProgressByTarget, newThreadTarget]);
  const activeCollaborationModeContextKey = useMemo(() => {
    if (!isNewThreadTab) {
      if (!resolvedActiveThreadsTabId || resolvedActiveThreadsTabId === NEW_THREAD_STAGE_TAB_ID) return null;
      return getThreadCollaborationModeStorageKey(resolvedActiveThreadsTabId);
    }

    if (!newThreadTarget) return null;
    return getDraftCollaborationModeStorageKey(newThreadTarget.projectId, newThreadTarget.cardId);
  }, [isNewThreadTab, newThreadTarget, resolvedActiveThreadsTabId]);

  useEffect(() => {
    if (!activeCollaborationModeContextKey) {
      setSelectedCollaborationMode(DEFAULT_CODEX_COLLABORATION_MODE);
      return;
    }
    setSelectedCollaborationMode(readCollaborationModeForContextKey(activeCollaborationModeContextKey));
  }, [activeCollaborationModeContextKey]);

  const handleCollaborationModeChange = useCallback((mode: CodexCollaborationModeKind) => {
    if (!activeCollaborationModeContextKey) {
      setSelectedCollaborationMode(DEFAULT_CODEX_COLLABORATION_MODE);
      return;
    }
    const nextMode = writeCollaborationModeForContextKey(activeCollaborationModeContextKey, mode);
    setSelectedCollaborationMode(nextMode);
  }, [activeCollaborationModeContextKey]);
  const handleCardStagePatch = useCallback((columnId: string, cardId: string, updates: Partial<CardInput>) => {
    if (!cardStageProjectId) return;
    patchCardForCardStage(columnId, cardId, updates);
  }, [cardStageProjectId, patchCardForCardStage]);
  const handleCardStageUpdate = useCallback(async (columnId: string, cardId: string, updates: Partial<CardInput>) => {
    if (!cardStageProjectId) {
      return {
        status: "error",
        error: "No active project selected",
      } as CardUpdateMutationResult;
    }
    return updateCardForCardStage(columnId, cardId, updates);
  }, [cardStageProjectId, updateCardForCardStage]);
  const handleCardStageDelete = useCallback(async (columnId: string, cardId: string) => {
    if (!cardStageProjectId) return;
    await deleteCardForCardStage(columnId, cardId);
  }, [cardStageProjectId, deleteCardForCardStage]);
  const handleCardStageMove = useCallback(async (fromStatus: Card["status"], cardId: string, toStatus: Card["status"]) => {
    if (!cardStageProjectId) return;
    await moveCardForCardStage({ cardId, fromStatus, toStatus });
  }, [cardStageProjectId, moveCardForCardStage]);
  const handleCardStageCompleteOccurrence = useCallback(async (cardId: string, occurrenceStart: Date) => {
    if (!cardStageProjectId) return;
    await completeOccurrenceForCardStage({ cardId, occurrenceStart, source: "card-stage" });
  }, [cardStageProjectId, completeOccurrenceForCardStage]);
  const handleCardStageSkipOccurrence = useCallback(async (cardId: string, occurrenceStart: Date) => {
    if (!cardStageProjectId) return;
    await skipOccurrenceForCardStage({ cardId, occurrenceStart, source: "card-stage" });
  }, [cardStageProjectId, skipOccurrenceForCardStage]);

  useEffect(() => {
    const activeThreadCardId = activeThreadDetail?.cardId;
    const activeThreadProjectId = activeThreadDetail?.projectId ?? threadsProjectId;
    if (!activeThreadCardId) {
      setActiveThreadCardColumnId(null);
      return;
    }

    let cancelled = false;
    void invoke("card:get", activeThreadProjectId, activeThreadCardId)
      .then((result) => {
        if (cancelled) return;
        setActiveThreadCardColumnId(resolveThreadCardStatus(result));
      })
      .catch(() => {
        if (cancelled) return;
        setActiveThreadCardColumnId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeThreadDetail?.cardId, activeThreadDetail?.projectId, threadsProjectId]);

  const handleOpenCardFromThread = useCallback(async (cardId: string) => {
    const projectId = activeThreadDetail?.projectId ?? threadsProjectId;
    await openCardStage(projectId, cardId);
  }, [activeThreadDetail?.projectId, openCardStage, threadsProjectId]);

  const stages: StageRailStage[] = [
    {
      id: "db",
      title: "Views",
      icon: STAGE_ICONS.db,
      hideHeader: true,
      content: (
        <div className="flex h-full min-h-0 flex-col bg-(--background)">
          <DbViewToolbar
            items={dbSidebarItems}
            activeSearchQuery={activeSearchQuery}
            taskSearchOpen={taskSearchOpen}
            searchShortcutLabel={isMac ? "⌘F" : "Ctrl+F"}
            taskSearchInputRef={taskSearchInputRef}
            rulesView={activeDbRulesView}
            dbViewPrefs={activeDbViewPrefs}
            availableTags={activeProjectTags}
            onUpdateDbViewPrefs={updateActiveDbViewPrefs}
            onSearchQueryChange={(value) => setSearchQuery(dbProjectId, value)}
            onOpenTaskSearch={openTaskSearch}
            onCloseTaskSearch={closeTaskSearch}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <MainViewHost
              projectId={dbProjectId}
              projects={projects}
              view={activeView}
              searchQuery={activeSearchQuery}
              dbViewPrefs={activeDbViewPrefs}
              onUpdateDbViewPrefs={updateActiveDbViewPrefs}
              cardStageCardId={cardStageCardId}
              cardStageCloseRef={cardStageCloseRef}
              pendingReminderOpen={pendingReminderOpen}
              onReminderHandled={onReminderHandled}
              openCardStage={handleOpenCardStageFromView}
            />
          </div>
        </div>
      ),
    },
    {
      id: "cards",
      title: "Cards",
      icon: STAGE_ICONS.cards,
      hideHeader: true,
      content: (
        <div className="h-full min-h-0 bg-(--background)">
          {activeCardStageCard ? (
            <CardStage
              onClose={closeCardStage}
              onLeaveCard={onLeaveCardStageCard}
              closeRef={cardStageCloseRef}
              persistRef={cardStagePersistRef}
              sessionSnapshotRef={cardStageSessionSnapshotRef}
              card={activeCardStageCard}
              columnId={activeCardStageColumnId}
              columnName={cardStageColumnName}
              projectId={cardStageState.projectId}
              projectWorkspacePath={projects.find((project) => project.id === cardStageState.projectId)?.workspacePath ?? null}
              availableTags={cardStageAvailableTags}
              onUpdate={handleCardStageUpdate}
              onPatch={handleCardStagePatch}
              onDelete={handleCardStageDelete}
              onMove={handleCardStageMove}
              onCompleteOccurrence={handleCardStageCompleteOccurrence}
              onSkipOccurrence={handleCardStageSkipOccurrence}
              onOpenHistoryPanel={() => {
                navigateToCardsTab(dbProjectId, "history", null);
              }}
              onOpenTerminalPanel={() => {
                const sessionRefId = currentCardStageSession?.id ?? activeRecentSessionId ?? `ephemeral:${activeCardStageCard.id}`;
                openCardTerminalTab(cardStageState.projectId, sessionRefId, activeCardStageCard.id, activeCardStageCard.title);
                setTerminalPanelOpen(cardStageState.projectId, true);
              }}
              linkedCodexThreads={linkedThreadsForCardStageCard}
              onOpenCodexThread={async (threadId) => {
                navigateToThreadTab(cardStageState.projectId, threadId);
              }}
              onOpenNewCodexThread={() => {
                navigateToThreadTab(cardStageState.projectId, NEW_THREAD_STAGE_TAB_ID);
              }}
              onStartThreadSection={async ({ projectId, cardId, prompt }) => {
                const detail = await startThreadForCard({
                  projectId,
                  cardId,
                  prompt,
                  collaborationMode: selectedCollaborationMode,
                  worktreeStartMode,
                  worktreeBranchPrefix: worktreeAutoBranchPrefix,
                });
                await loadCodexThreads(projectId);
                return { threadId: detail.threadId };
              }}
              onSendThreadSectionPrompt={async ({ projectId, threadId, prompt }) => {
                await sendPromptToThread(threadId, prompt, {
                  projectId,
                  collaborationMode: selectedCollaborationMode,
                });
                await loadCodexThreads(projectId);
              }}
              terminalPanelActive={
                terminalPanelOpen &&
                activeTerminalTab?.kind === "card" &&
                activeTerminalTab.cardId === activeCardStageCard.id
              }
              historyPanelActive={historyOverlayOpen}
            />
          ) : cardStageState.open && cardStageState.cardId && cardStageBoardLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-(--foreground-tertiary)">
              Loading card...
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-(--foreground-tertiary)">
              Select a card session to open the editor.
            </div>
          )}
          {activeCardStageCard ? (
            <HistoryPanel
              projectId={cardStageState.projectId}
              cardId={activeCardStageCard.id}
              open={historyOverlayOpen}
              onClose={() => {
                const fallbackSessionId =
                  currentCardStageSession?.projectId === cardStageState.projectId
                    ? currentCardStageSession?.id
                    : activeCardsSessionId;
                navigateToCardsTab(
                  dbProjectId,
                  fallbackSessionId ? `session:${fallbackSessionId}` : "",
                  fallbackSessionId ?? null,
                );
              }}
            />
          ) : null}
        </div>
      ),
    },
    {
      id: "threads",
      title: "Threads",
      icon: STAGE_ICONS.threads,
      hideHeader: true,
      content: (
        <StageThreads
          projectId={threadsProjectId}
          projectWorkspacePath={activeThreadsProject?.workspacePath ?? null}
          isNewThreadTab={isNewThreadTab}
          newThreadTarget={newThreadTarget}
          activeThreadCardColumnId={activeThreadCardColumnId}
          threadStartProgress={newThreadStartProgress}
          thread={activeThreadDetail}
          connection={codexState.connection}
          account={codexState.account}
          availableModels={availableModels}
          collaborationModes={availableCollaborationModes}
          selectedCollaborationMode={selectedCollaborationMode}
          selectedModel={threadSettings.model}
          selectedReasoningEffort={threadSettings.reasoningEffort}
          reasoningEffortOptions={reasoningEffortOptions}
          permissionMode={permissionMode}
          hideThinkingWhenDone={hideThinkingWhenDone}
          promptSubmitShortcut={threadPromptSubmitShortcut}
          approvalQueue={approvalQueue}
          userInputQueue={userInputQueue}
          planImplementationQueue={planImplementationQueue}
          onModelChange={(model) => {
            setThreadModel(model);
          }}
          onCollaborationModeChange={handleCollaborationModeChange}
          onReasoningEffortChange={(reasoningEffort) => {
            setThreadReasoningEffort(reasoningEffort);
          }}
          onPermissionModeChange={(mode) => {
            void setPermissionMode(threadsProjectId, mode);
          }}
          onRefreshAccount={refreshAccount}
          onStartChatGptLogin={startChatGptLogin}
          onStartApiKeyLogin={startApiKeyLogin}
          onCancelLogin={async (loginId) => {
            await cancelLogin(loginId);
          }}
          onLogout={async () => {
            await logout();
          }}
          onStartThreadForCard={async (input) => {
            const detail = await startThreadForCard({
              projectId: input.projectId,
              cardId: input.cardId,
              prompt: input.prompt,
              collaborationMode: selectedCollaborationMode,
              worktreeStartMode,
              worktreeBranchPrefix: worktreeAutoBranchPrefix,
            });
            const nextMode = writeCollaborationModeForContextKey(
              getThreadCollaborationModeStorageKey(detail.threadId),
              selectedCollaborationMode,
            );
            setSelectedCollaborationMode(nextMode);
            await loadCodexThreads(input.projectId);
            navigateToThreadTab(input.projectId, detail.threadId);
          }}
          onSendPrompt={async (prompt, opts) => {
            if (!activeThreadTab || activeThreadTab.id === NEW_THREAD_STAGE_TAB_ID) return;
            await startTurn(
              activeThreadTab.id,
              prompt,
              {
                projectId: activeThreadDetail?.projectId ?? threadsProjectId,
                collaborationMode: opts?.collaborationMode ?? selectedCollaborationMode,
              },
            );
          }}
          onSteerPrompt={async (turnId, prompt) => {
            if (!activeThreadTab || activeThreadTab.id === NEW_THREAD_STAGE_TAB_ID) return;
            await steerTurn(activeThreadTab.id, turnId, prompt);
          }}
          onInterruptTurn={async (turnId) => {
            if (!activeThreadTab || activeThreadTab.id === NEW_THREAD_STAGE_TAB_ID) return;
            await interruptTurn(activeThreadTab.id, turnId);
          }}
          onRespondApproval={async (requestId, decision) => {
            await respondApproval(requestId, decision);
          }}
          onRespondUserInput={async (requestId, answers) => {
            await respondUserInput(requestId, answers);
          }}
          onResolvePlanImplementationRequest={(threadId, turnId) => {
            resolvePlanImplementation(threadId, turnId);
          }}
          onOpenCard={(cardId) => {
            void handleOpenCardFromThread(cardId);
          }}
        />
      ),
    },
    {
      id: "files",
      title: "Diffs",
      icon: STAGE_ICONS.files,
      hideHeader: true,
      content: <StageFilesPlaceholder />,
    },
  ];

  const isMacPlatform = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const showFloatingSidebar = sidebar.collapsed;
  const showInlineSidebar = sidebarVisible;
  const isSidebarAnimatingOut = sidebar.collapsed && sidebarVisible;
  const showCollapsedTitlebarCollapseControl = sidebar.collapsed && !isSidebarAnimatingOut && !hoverSidebarOpen;
  const sidebarCollapseControlButton = (
    <button
      type="button"
      onClick={toggleSidebarCollapsed}
      title={sidebar.collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={sidebar.collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="inline-flex size-6 items-center justify-center rounded-lg text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
        {/* Collapsed: full-height divider line (original icon) */}
        <line
          x1="4.5" y1="1.5" x2="4.5" y2="12.5"
          stroke="currentColor" strokeWidth="1.5"
          style={{ opacity: sidebar.collapsed ? 1 : 0 }}
        />
        {/* Expanded: small vertical bar */}
        <rect
          x="3.5" y="3.5" width="2" height="7" rx="0.75"
          fill="currentColor"
          style={{ opacity: sidebar.collapsed ? 0 : 1 }}
        />
      </svg>
    </button>
  );

  return (
    <div className="relative flex h-screen">
      <CommandPalette
        open={commandPaletteOpen}
        openTriggerTick={commandPaletteOpenTick}
        projects={projects}
        activeProjectId={dbProjectId}
        activeView={activeView}
        focusedStage={focusedStage}
        recentCardSessions={recentCardSessions}
        onOpenChange={setCommandPaletteOpen}
        onOpenCard={openCardStage}
        onFocusStage={handleStageRailFocus}
        onSetView={handleCommandPaletteSetView}
        canGoBack={canNavigateBack}
        canGoForward={canNavigateForward}
        onGoBack={onNavigateBack}
        onGoForward={onNavigateForward}
        onOpenProjectPicker={() => {
          onRequestProjectPickerOpen();
        }}
        onOpenTaskSearch={() => {
          openTaskSearch(true);
        }}
        onToggleTerminal={handleCommandPaletteToggleTerminal}
        onOpenSettings={() => {
          setSettingsOpen(true);
        }}
        onRequestNewWindow={canRequestNewWindow ? () => {
          void invoke("window:new");
        } : undefined}
      />
      {sidebar.collapsed ? (
        <div
          aria-hidden
          data-sidebar-hover-trigger="true"
          className="absolute inset-y-0 left-0 z-40"
          style={{ width: SIDEBAR_HOVER_TRIGGER_WIDTH_PX }}
          onMouseEnter={scheduleHoverSidebarOpen}
          onMouseLeave={clearHoverSidebarOpenTimeout}
        />
      ) : null}

      {showInlineSidebar ? (
        <div
          className={cn(
            "relative h-full min-h-0 shrink-0 overflow-hidden",
            isSidebarAnimatingOut
              ? "transition-shell-resize duration-220 ease-emphasized motion-reduce:transition-none -translate-x-1 opacity-0"
              : "translate-x-0 opacity-100",
          )}
          style={{ width: isSidebarAnimatingOut ? 0 : sidebar.width }}
        >
          <LeftSidebar
            projects={projects}
            spaces={spaces}
            activeProjectId={dbProjectId}
            stageGroups={stageGroups}
            collapsed={false}
            width={sidebar.width}
            expandedSections={sidebarSectionExpandedState}
            showAllItemsBySection={sidebarSectionShowAllState}
            onResizeWidth={setSidebarWidth}
            onSetSectionExpanded={(sectionId, expanded) =>
              setSidebarSectionExpanded(dbProjectId, sectionId, expanded)}
            onSetSectionShowAll={(sectionId, showAll) =>
              setSidebarSectionShowAll(dbProjectId, sectionId, showAll)}
            onSelectSpace={setDbProject}
            onOpenSettings={() => setSettingsOpen(true)}
            projectPickerOpenTick={projectPickerOpenTick}
            onCreateProject={onCreateProject}
            onDeleteProject={onDeleteProject}
            onRenameProject={onRenameProject}
          />
        </div>
      ) : null}

      {showFloatingSidebar ? (
        <div
          aria-hidden={!hoverSidebarOpen}
          className="pointer-events-none absolute inset-y-0 left-0 z-50"
        >
          <div
            className="absolute inset-y-0 overflow-hidden rounded-r-2xl border border-l-0 border-(--border) bg-(--background-secondary)"
            style={{
              width: sidebar.width,
              left: hoverSidebarOpen ? 0 : -sidebar.width,
              boxShadow: hoverSidebarOpen ? "0 24px 56px rgba(0,0,0,0.24)" : "none",
              pointerEvents: hoverSidebarOpen ? "auto" : "none",
              transitionProperty: "left, box-shadow",
              transitionDuration: `${FLOATING_SIDEBAR_TRANSITION_DURATION_MS}ms`,
              transitionTimingFunction: FLOATING_SIDEBAR_TRANSITION_TIMING_FUNCTION,
            }}
            onMouseEnter={clearHoverSidebarCloseTimeout}
            onMouseLeave={scheduleHoverSidebarClose}
          >
            <LeftSidebar
              projects={projects}
              spaces={spaces}
              activeProjectId={dbProjectId}
              stageGroups={stageGroups}
              collapsed={false}
              width={sidebar.width}
              expandedSections={sidebarSectionExpandedState}
              showAllItemsBySection={sidebarSectionShowAllState}
              onResizeWidth={setSidebarWidth}
              onSetSectionExpanded={(sectionId, expanded) =>
                setSidebarSectionExpanded(dbProjectId, sectionId, expanded)}
              onSetSectionShowAll={(sectionId, showAll) =>
                setSidebarSectionShowAll(dbProjectId, sectionId, showAll)}
              onSelectSpace={setDbProject}
              onOpenSettings={() => setSettingsOpen(true)}
              projectPickerOpenTick={projectPickerOpenTick}
              onCreateProject={onCreateProject}
              onDeleteProject={onDeleteProject}
              onRenameProject={onRenameProject}
            />
          </div>
        </div>
      ) : null}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-(--background)">
        <section
          className="grid h-toolbar shrink-0 grid-cols-[1fr_auto_1fr] items-center px-2"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <div className="flex items-center">
            {/* Non-Mac collapse control when sidebar is hidden */}
            {!isMacPlatform && showCollapsedTitlebarCollapseControl ? (
              <div
                className="inline-flex items-center"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {sidebarCollapseControlButton}
              </div>
            ) : null}
          </div>
          <div className="justify-self-center">
            <div
              className="flex items-center gap-3"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              {decreasePaneCountButton}
              <StageMinimap
                focusedStage={focusedStage}
                stageNavDirection={stageNavDirection}
                layoutMode={stageRailLayoutMode}
                slidingWindowPaneCount={slidingWindowPaneCount}
                onFocusStage={(stageId) => handleStageRailFocus(stageId)}
              />
              {increasePaneCountButton}
            </div>
          </div>
          <div className="flex items-center justify-end gap-0.5">
            {activeProjectPendingMutationCount > 0 ? (
              <span
                className="mr-1 inline-flex items-center rounded-full border border-(--border) bg-(--background-secondary) px-2 py-0.5 text-xs font-medium text-(--foreground-secondary)"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                Syncing...
              </span>
            ) : null}
            {mutationErrorToast ? (
              <button
                type="button"
                onClick={() => setMutationErrorToast(null)}
                className="mr-1 inline-flex max-w-70 items-center rounded-full border border-(--destructive)/30 bg-(--destructive)/10 px-2 py-0.5 text-xs font-medium text-(--destructive)"
                title={mutationErrorToast}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {mutationErrorToast}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setTerminalPanelOpen(dbProjectId, !terminalPanelOpen)}
              title={terminalPanelOpen ? "Hide terminal" : "Show terminal"}
              aria-label={terminalPanelOpen ? "Hide terminal" : "Show terminal"}
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-lg transition-colors",
                terminalPanelOpen
                  ? "bg-(--foreground)/10 text-(--foreground) hover:bg-(--foreground)/15"
                  : "text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)",
              )}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4 5.5L6 7.5L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="7.5" y1="9.5" x2="10" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </section>

        <StageRail
          stages={stages}
          layoutMode={stageRailLayoutMode}
          focusedStage={focusedStage}
          stageNavDirection={stageNavDirection}
          slidingWindowPaneCount={slidingWindowPaneCount}
          panelWidths={stagePanelWidths}
          nextPanelPeekPx={nextPanelPeekPx}
          onPanelWidthsChange={(widths) => setStagePanelWidths(dbProjectId, widths)}
          onFocusStage={handleStageRailFocus}
        />

        {terminalPanelOpen && (
          <section className="shrink-0 overflow-hidden border-t border-(--border)">
            <header className="flex h-8 items-center gap-2 bg-(--background-secondary) px-2">
              <span className="shrink-0 text-xs font-medium text-(--foreground-secondary)">Terminal</span>
              <StageTabStrip
                className="min-w-0 flex-1"
                tabs={terminalTabs.map((tab) => ({
                  id: tab.id,
                  label: tab.title,
                  muted: tab.kind === "project",
                  closable: terminalTabs.length > 1,
                }))}
                activeTabId={activeTerminalTabId}
                onSelect={(tabId) => {
                  setActiveTerminalTab(dbProjectId, tabId);
                }}
                onCloseTab={(tabId) => {
                  const tabProjectId = terminalTabs.find((tab) => tab.id === tabId)?.projectId ?? dbProjectId;
                  closeTerminalTab(tabProjectId, tabId);
                }}
                onAddTab={() => {
                  openProjectTerminalTab(dbProjectId);
                }}
                addLabel="Open project shell"
              />
              <button
                type="button"
                onClick={() => setTerminalPanelOpen(dbProjectId, false)}
                title="Hide terminal panel"
                className={cn(
                  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  "text-(--foreground-tertiary) hover:text-(--foreground-secondary)",
                  "transition-colors hover:bg-(--background-tertiary)",
                )}
              >
                <ChevronDown className="size-3.5" />
              </button>
            </header>

            {!activeTerminalTab ? (
              <div className="flex h-55 items-center justify-center text-sm text-(--foreground-tertiary)">
                Open a terminal tab.
              </div>
            ) : activeTerminalTab.kind === "project" ? (
              <TerminalPanel
                projectId={activeTerminalTab.projectId}
                cardId={activeTerminalTab.projectId}
                mode="project"
                sessionId={activeTerminalTab.sessionId}
                panelHeight={terminalPanelHeight}
                onPanelHeightChange={(height) => setTerminalPanelHeight(dbProjectId, height)}
                onClose={() => closeTerminalTab(activeTerminalTab.projectId, activeTerminalTab.id)}
              />
            ) : activeTerminalTab.cardId ? (
              <TerminalPanel
                projectId={activeTerminalTab.projectId}
                cardId={activeTerminalTab.cardId}
                mode="card"
                sessionId={activeTerminalTab.sessionId}
                panelHeight={terminalPanelHeight}
                onPanelHeightChange={(height) => setTerminalPanelHeight(dbProjectId, height)}
                onClose={() => closeTerminalTab(activeTerminalTab.projectId, activeTerminalTab.id)}
              />
            ) : (
              <div className="flex h-55 items-center justify-center text-sm text-(--foreground-tertiary)">
                This card terminal is unavailable because the card session is no longer active.
              </div>
            )}
          </section>
        )}
      </main>

      <SettingsOverlay
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        sidebarTopLevelSectionOrder={sidebar.topLevelSectionOrder}
        sidebarTopLevelSections={sidebar.topLevelSections}
        onSidebarTopLevelSectionVisibleChange={setSidebarTopLevelSectionVisible}
        stageRailLayoutMode={stageRailLayoutMode}
        onStageRailLayoutModeChange={onStageRailLayoutModeChange}
        nextPanelPeekPx={nextPanelPeekPx}
        onNextPanelPeekPxChange={setNextPanelPeekPx}
        hideThinkingWhenDone={hideThinkingWhenDone}
        onHideThinkingWhenDoneChange={setHideThinkingWhenDone}
        threadPromptSubmitShortcut={threadPromptSubmitShortcut}
        onThreadPromptSubmitShortcutChange={setThreadPromptSubmitShortcut}
        worktreeStartMode={worktreeStartMode}
        onWorktreeStartModeChange={setWorktreeStartMode}
        worktreeAutoBranchPrefix={worktreeAutoBranchPrefix}
        onWorktreeAutoBranchPrefixChange={setWorktreeAutoBranchPrefix}
        smartPrefixParsingEnabled={smartPrefixParsingEnabled}
        onSmartPrefixParsingEnabledChange={setSmartPrefixParsingEnabled}
        stripSmartPrefixFromTitleEnabled={stripSmartPrefixFromTitleEnabled}
        onStripSmartPrefixFromTitleEnabledChange={setStripSmartPrefixFromTitleEnabled}
      />

      {/* Fixed sidebar toggle — rendered last so it paints above drag regions */}
      {isMacPlatform ? (
        <div
          className="fixed z-50 flex items-center justify-center"
          style={{
            left: COLLAPSE_CONTROL_TRAFFIC_LIGHT_OFFSET_PX,
            top: 12,
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          {sidebarCollapseControlButton}
        </div>
      ) : null}
    </div>
  );
}
