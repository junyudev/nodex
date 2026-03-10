import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Project,
  WorkbenchRecentCardSession,
  WorkbenchResumeSnapshot,
} from "./types";
import {
  createDefaultDockTree,
  type DockTreeNode,
} from "./dock-layout";
import {
  clampStagePanelWidth,
  STAGE_PANEL_MAX_WIDTH,
  STAGE_PANEL_MIN_WIDTH,
} from "./stage-panel-resize";
import {
  moveSidebarTopLevelSection,
  normalizeSidebarTopLevelSectionOrder,
  normalizeSidebarTopLevelSectionsPrefs,
  type SidebarSectionItemLimit,
  type SidebarTopLevelSectionId,
  type SidebarTopLevelSectionsPrefs,
} from "./sidebar-section-prefs";

export type WorkbenchView = "kanban" | "list" | "toggle-list" | "canvas" | "calendar";
export type StageId = "db" | "cards" | "threads" | "files";
export type StageNavDirection = "left" | "right";
export type SidebarGroupId = StageId | "recents";
export type {
  SidebarSectionItemLimit,
  SidebarTopLevelSectionId,
  SidebarTopLevelSectionsPrefs,
} from "./sidebar-section-prefs";

export const STAGE_ORDER: StageId[] = ["db", "cards", "threads", "files"];
export const NEW_THREAD_STAGE_TAB_ID = "thread:new";

export interface SpaceRef {
  projectId: string;
  colorToken: string;
  initial: string;
}

export type RecentCardSession = WorkbenchRecentCardSession;

export interface CardsStageTab {
  id: string;
  kind: "history" | "session";
  title: string;
  sessionId?: string;
}

export interface ThreadsStageTab {
  id: string;
  title: string;
  preview: string;
}

export interface TerminalStageTab {
  id: string;
  kind: "project" | "card";
  projectId: string;
  title: string;
  sessionId: string;
  cardId?: string;
  sessionRefId?: string;
}

export interface FilesStageTab {
  id: "diff";
  title: string;
}

export type StagePanelWidths = Partial<Record<StageId, number>>;
export type StageCollapsedState = Partial<Record<StageId, boolean>>;

const WORKBENCH_STORAGE_KEY = "nodex-workbench-v1";
const SIDEBAR_STORAGE_KEY = "nodex-sidebar-v1";
const DOCK_STORAGE_KEY = "nodex-dock-layout-v1";
const RECENT_STORAGE_KEY = "nodex-recent-card-sessions-v1";
const WINDOW_LOCAL_STORAGE_KEYS = new Set([
  WORKBENCH_STORAGE_KEY,
  RECENT_STORAGE_KEY,
]);
const VALID_VIEWS: WorkbenchView[] = ["kanban", "list", "toggle-list", "canvas", "calendar"];
const SIDEBAR_GROUP_IDS: SidebarGroupId[] = ["db", "recents", "cards", "threads", "files"];
const MAX_RECENT_CARD_SESSIONS = 10;
const HISTORY_TAB_ID = "history";
const NEW_THREAD_STAGE_TAB_TITLE = "New thread";

interface SidebarPrefs {
  collapsed: boolean;
  width: number;
  topLevelSectionOrder: SidebarTopLevelSectionId[];
  topLevelSections: SidebarTopLevelSectionsPrefs;
}

interface WorkbenchPrefs {
  dbProjectId?: string;
  threadsProjectId?: string;
  viewsByProject: Record<string, WorkbenchView>;
  searchByProject: Record<string, string>;
  spaceOrder: string[];
  activeRecentSessionId: string | null;
  focusedStage?: StageId;
  stageNavDirection?: StageNavDirection;
  sidebarStageExpandedByProject?: Record<string, Partial<Record<SidebarGroupId, boolean>>>;
  activeCardsTabId?: string;
  threadsTabs?: ThreadsStageTab[];
  activeThreadsTabId?: string;
  terminalTabs?: TerminalStageTab[];
  activeTerminalTabId?: string;
  filesTabs?: FilesStageTab[];
  activeFilesTabId?: string;
  stagePanelWidths?: StagePanelWidths;
  stageCollapsed?: StageCollapsedState;
  slidingWindowPaneCount?: number;
  terminalPanelOpen?: boolean;
  terminalPanelHeight?: number;
}

interface DockPrefs {
  width: number;
  tree: DockTreeNode;
}

interface WorkbenchState {
  dbProjectId: string;
  threadsProjectId: string;
  viewsByProject: Record<string, WorkbenchView>;
  searchByProject: Record<string, string>;
  spaceOrder: string[];
  sidebar: SidebarPrefs;
  dock: DockPrefs;
  recentCardSessions: RecentCardSession[];
  activeRecentSessionId: string | null;
  focusedStage: StageId;
  stageNavDirection: StageNavDirection;
  sidebarStageExpandedByProject: Record<string, Partial<Record<SidebarGroupId, boolean>>>;
  activeCardsTabId: string;
  threadsTabs: ThreadsStageTab[];
  activeThreadsTabId: string;
  terminalTabs: TerminalStageTab[];
  activeTerminalTabId: string;
  filesTabs: FilesStageTab[];
  activeFilesTabId: string;
  stagePanelWidths: StagePanelWidths;
  stageCollapsed: StageCollapsedState;
  slidingWindowPaneCount: number;
  terminalPanelOpen: boolean;
  terminalPanelHeight: number;
}

const DEFAULT_SIDEBAR_WIDTH = 280;
const DEFAULT_DOCK_WIDTH = 560;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const DOCK_MIN_WIDTH = 360;
const DOCK_MAX_WIDTH = 1100;
const TERMINAL_PANEL_MIN_HEIGHT = 120;
const TERMINAL_PANEL_MAX_HEIGHT = 600;
const TERMINAL_PANEL_DEFAULT_HEIGHT = 260;
const SLIDING_WINDOW_MIN_PANES = 1;
const SLIDING_WINDOW_MAX_PANES = STAGE_ORDER.length;
const SLIDING_WINDOW_DEFAULT_PANES = 2;
const SPACE_COLOR_PALETTE = [
  "#5e9fe8",
  "#72bc8f",
  "#de9255",
  "#bf8eda",
  "#eac26b",
  "#e97366",
  "#46a171",
  "#2783de",
];

const DEFAULT_FILES_TABS: FilesStageTab[] = [
  { id: "diff", title: "Diffs" },
];

function makeProjectTerminalTab(projectId: string): TerminalStageTab {
  return {
    id: `project:${projectId}`,
    kind: "project",
    projectId,
    title: "Project Shell",
    sessionId: `project:${projectId}`,
  };
}

function isWorkbenchView(value: unknown): value is WorkbenchView {
  return typeof value === "string" && VALID_VIEWS.includes(value as WorkbenchView);
}

function isStageId(value: unknown): value is StageId {
  return typeof value === "string" && STAGE_ORDER.includes(value as StageId);
}

function isStageDirection(value: unknown): value is StageNavDirection {
  return value === "left" || value === "right";
}

function normalizeViewMap(value: unknown): Record<string, WorkbenchView> {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<Record<string, WorkbenchView>>((acc, [projectId, view]) => {
    if (!isWorkbenchView(view)) return acc;
    acc[projectId] = view;
    return acc;
  }, {});
}

function normalizeSearchMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<Record<string, string>>((acc, [projectId, search]) => {
    if (typeof search !== "string") return acc;
    acc[projectId] = search;
    return acc;
  }, {});
}

function normalizeSpaceOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeRecentSessions(value: unknown): RecentCardSession[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item): item is RecentCardSession =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { projectId?: unknown }).projectId === "string" &&
        typeof (item as { cardId?: unknown }).cardId === "string" &&
        typeof (item as { titleSnapshot?: unknown }).titleSnapshot === "string" &&
        typeof (item as { lastOpenedAt?: unknown }).lastOpenedAt === "string",
    )
    .slice(0, MAX_RECENT_CARD_SESSIONS);
}

function findRecentCardSession(
  recentSessions: readonly RecentCardSession[],
  projectId: string,
  cardId: string,
): RecentCardSession | null {
  return recentSessions.find((session) => session.projectId === projectId && session.cardId === cardId) ?? null;
}

function recordRecentCardLeaveInList(
  recentSessions: readonly RecentCardSession[],
  projectId: string,
  cardId: string,
  titleSnapshot: string,
): RecentCardSession[] {
  const existing = findRecentCardSession(recentSessions, projectId, cardId);
  if (existing) {
    return recentSessions.map((session) =>
      session.id === existing.id
        ? {
            ...session,
            titleSnapshot,
          }
        : session,
    );
  }

  return [{
    id: crypto.randomUUID(),
    projectId,
    cardId,
    titleSnapshot,
    lastOpenedAt: new Date().toISOString(),
  }, ...recentSessions].slice(0, MAX_RECENT_CARD_SESSIONS);
}

function normalizeStageMap(value: unknown): Record<string, StageId> {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<Record<string, StageId>>((acc, [projectId, stage]) => {
    if (!isStageId(stage)) return acc;
    acc[projectId] = stage;
    return acc;
  }, {});
}

function isSidebarGroupId(value: string): value is SidebarGroupId {
  return SIDEBAR_GROUP_IDS.includes(value as SidebarGroupId);
}

function normalizeSidebarStageExpanded(
  value: unknown,
): Record<string, Partial<Record<SidebarGroupId, boolean>>> {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<Record<string, Partial<Record<SidebarGroupId, boolean>>>>(
    (acc, [projectId, stageMap]) => {
      if (typeof stageMap !== "object" || stageMap === null) return acc;
      const parsed = Object.entries(stageMap).reduce<Partial<Record<SidebarGroupId, boolean>>>(
        (stageAcc, [stageId, expanded]) => {
          if (!isSidebarGroupId(stageId)) return stageAcc;
          if (typeof expanded !== "boolean") return stageAcc;
          stageAcc[stageId] = expanded;
          return stageAcc;
        },
        {},
      );
      acc[projectId] = parsed;
      return acc;
    },
    {},
  );
}

function normalizeThreadsTabs(value: unknown): ThreadsStageTab[] {
  if (!Array.isArray(value)) return [];
  const parsed = value
    .filter(
      (tab): tab is ThreadsStageTab =>
        typeof tab === "object" &&
        tab !== null &&
        typeof (tab as { id?: unknown }).id === "string" &&
        typeof (tab as { title?: unknown }).title === "string" &&
        typeof (tab as { preview?: unknown }).preview === "string",
    )
    .filter((tab) => tab.id !== NEW_THREAD_STAGE_TAB_ID)
    .slice(0, 31);
  return ensureThreadsTabs(parsed);
}

function normalizeTerminalTabs(
  value: unknown,
  defaultProjectId: string,
): TerminalStageTab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (tab): tab is TerminalStageTab =>
        typeof tab === "object" &&
        tab !== null &&
        typeof (tab as { id?: unknown }).id === "string" &&
        ((tab as { kind?: unknown }).kind === "project" ||
          (tab as { kind?: unknown }).kind === "card") &&
        typeof (tab as { title?: unknown }).title === "string" &&
        typeof (tab as { sessionId?: unknown }).sessionId === "string",
    )
    .map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      projectId:
        typeof (tab as { projectId?: unknown }).projectId === "string"
          ? (tab as { projectId: string }).projectId
          : defaultProjectId,
      title: tab.title,
      sessionId: tab.sessionId,
      cardId: tab.cardId,
      sessionRefId: tab.sessionRefId,
    }))
    .slice(0, 32);
}

function normalizeFilesTabs(value: unknown): FilesStageTab[] {
  if (!Array.isArray(value)) return [];
  const hasCurrentTab = value.some(
    (tab) =>
      typeof tab === "object" &&
      tab !== null &&
      (tab as { id?: unknown }).id === "diff",
  );
  return hasCurrentTab ? [...DEFAULT_FILES_TABS] : [];
}

function normalizeStagePanelWidths(
  value: unknown,
): StagePanelWidths {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<StagePanelWidths>((acc, [stageId, width]) => {
    if (!isStageId(stageId)) return acc;
    if (typeof width !== "number" || !Number.isFinite(width)) return acc;
    acc[stageId] = clampStagePanelWidth(width, STAGE_PANEL_MIN_WIDTH, STAGE_PANEL_MAX_WIDTH);
    return acc;
  }, {});
}

function normalizeStageCollapsedState(value: unknown): StageCollapsedState {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<StageCollapsedState>((acc, [stageId, collapsed]) => {
    if (!isStageId(stageId)) return acc;
    if (typeof collapsed !== "boolean") return acc;
    acc[stageId] = collapsed;
    return acc;
  }, {});
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value !== "boolean") return null;
  return value;
}

function clampSlidingWindowPaneCount(value: number): number {
  if (!Number.isFinite(value)) return SLIDING_WINDOW_DEFAULT_PANES;
  return clamp(
    Math.round(value),
    SLIDING_WINDOW_MIN_PANES,
    SLIDING_WINDOW_MAX_PANES,
  );
}

function normalizeSlidingWindowPaneCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampSlidingWindowPaneCount(value);
}

function resolvePersistedSlidingWindowPaneCount(persistedPaneCount: unknown): number {
  const nextCount = normalizeSlidingWindowPaneCount(persistedPaneCount);
  if (nextCount !== null) return nextCount;
  return SLIDING_WINDOW_DEFAULT_PANES;
}

function clampTerminalPanelHeight(height: number): number {
  if (!Number.isFinite(height)) return TERMINAL_PANEL_DEFAULT_HEIGHT;
  return clamp(
    Math.round(height),
    TERMINAL_PANEL_MIN_HEIGHT,
    TERMINAL_PANEL_MAX_HEIGHT,
  );
}

function normalizeTerminalPanelHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampTerminalPanelHeight(value);
}

function makeDefaultStageCollapsedState(): StageCollapsedState {
  return {
    files: true,
  };
}

function resolveEffectiveStageCollapsedState(
  collapsedState: StageCollapsedState,
  stageCollapseEnabled: boolean,
): StageCollapsedState {
  if (!stageCollapseEnabled) return {};
  return collapsedState;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getPreferredStorage(key: string): Storage {
  return WINDOW_LOCAL_STORAGE_KEYS.has(key) ? sessionStorage : localStorage;
}

function readJson<T>(key: string): T | null {
  try {
    const preferredStorage = getPreferredStorage(key);
    const raw = preferredStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    try {
      if (!WINDOW_LOCAL_STORAGE_KEYS.has(key)) return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    const storage = getPreferredStorage(key);
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore localStorage failures
  }
}

function hashProjectId(projectId: string): number {
  let hash = 0;
  for (let index = 0; index < projectId.length; index += 1) {
    hash = (hash * 31 + projectId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function makeSpaceRef(projectId: string): SpaceRef {
  const colorToken = SPACE_COLOR_PALETTE[hashProjectId(projectId) % SPACE_COLOR_PALETTE.length];
  const initial = projectId.slice(0, 1).toUpperCase() || "?";
  return { projectId, colorToken, initial };
}

interface LoadInitialStateOptions {
  resumeSnapshot?: WorkbenchResumeSnapshot | null;
}

function loadInitialState(options: LoadInitialStateOptions = {}): WorkbenchState {
  const persistedWorkbench = readJson<Partial<WorkbenchPrefs>>(WORKBENCH_STORAGE_KEY);
  const persistedSidebar = readJson<Partial<SidebarPrefs>>(SIDEBAR_STORAGE_KEY);
  const persistedDock = readJson<Partial<DockPrefs>>(DOCK_STORAGE_KEY);
  const persistedRecent = readJson<unknown>(RECENT_STORAGE_KEY);
  const resumeSnapshot = options.resumeSnapshot ?? null;
  const dbProjectId =
    resumeSnapshot?.dbProjectId ||
    (typeof persistedWorkbench?.dbProjectId === "string" && persistedWorkbench.dbProjectId) ||
    "default";
  const threadsProjectId =
    resumeSnapshot?.threadsProjectId ||
    (typeof persistedWorkbench?.threadsProjectId === "string" && persistedWorkbench.threadsProjectId) ||
    dbProjectId;
  const terminalTabs = ensureTerminalTabs(
    dbProjectId,
    normalizeTerminalTabs(persistedWorkbench?.terminalTabs, dbProjectId),
  );
  const threadsTabs = ensureThreadsTabs(normalizeThreadsTabs(persistedWorkbench?.threadsTabs));
  const filesTabs = ensureFilesTabs(normalizeFilesTabs(persistedWorkbench?.filesTabs));
  const focusedStage =
    (resumeSnapshot && isStageId(resumeSnapshot.focusedStage) && resumeSnapshot.focusedStage) ||
    (isStageId(persistedWorkbench?.focusedStage) && persistedWorkbench.focusedStage) ||
    "db";
  const stageNavDirection =
    (resumeSnapshot
      && isStageDirection(resumeSnapshot.stageNavDirection)
      && resumeSnapshot.stageNavDirection) ||
    (isStageDirection(persistedWorkbench?.stageNavDirection) && persistedWorkbench.stageNavDirection) ||
    "right";
  const activeTerminalTabId =
    (typeof persistedWorkbench?.activeTerminalTabId === "string" && persistedWorkbench.activeTerminalTabId) ||
    terminalTabs[0]?.id ||
    "";
  const activeThreadsTabId =
    (typeof resumeSnapshot?.activeThreadsTabId === "string" && resumeSnapshot.activeThreadsTabId) ||
    (typeof persistedWorkbench?.activeThreadsTabId === "string" && persistedWorkbench.activeThreadsTabId) ||
    threadsTabs[0]?.id ||
    "";
  const activeFilesTabId =
    (typeof persistedWorkbench?.activeFilesTabId === "string" && persistedWorkbench.activeFilesTabId) ||
    filesTabs[0]?.id ||
    "diff";
  const activeCardsTabId =
    (typeof resumeSnapshot?.activeCardsTabId === "string" && resumeSnapshot.activeCardsTabId) ||
    (typeof persistedWorkbench?.activeCardsTabId === "string" && persistedWorkbench.activeCardsTabId) ||
    "";
  const activeRecentSessionId = resumeSnapshot
    ? (typeof resumeSnapshot.activeRecentSessionId === "string" ? resumeSnapshot.activeRecentSessionId : null)
    : ((typeof persistedWorkbench?.activeRecentSessionId === "string" &&
      persistedWorkbench.activeRecentSessionId) ||
      null);
  const stagePanelWidths = normalizeStagePanelWidths(persistedWorkbench?.stagePanelWidths);
  const normalizedStageCollapsed = normalizeStageCollapsedState(persistedWorkbench?.stageCollapsed);
  const stageCollapsed = Object.keys(normalizedStageCollapsed).length > 0
    ? normalizedStageCollapsed
    : makeDefaultStageCollapsedState();
  const slidingWindowPaneCount = resolvePersistedSlidingWindowPaneCount(
    persistedWorkbench?.slidingWindowPaneCount,
  );
  const terminalPanelOpen = normalizeBoolean(persistedWorkbench?.terminalPanelOpen) ?? false;
  const terminalPanelHeight =
    normalizeTerminalPanelHeight(persistedWorkbench?.terminalPanelHeight) ??
    TERMINAL_PANEL_DEFAULT_HEIGHT;

  return {
    dbProjectId,
    threadsProjectId,
    viewsByProject: resumeSnapshot
      ? normalizeViewMap(resumeSnapshot.viewsByProject)
      : normalizeViewMap(persistedWorkbench?.viewsByProject),
    searchByProject: normalizeSearchMap(persistedWorkbench?.searchByProject),
    spaceOrder: normalizeSpaceOrder(persistedWorkbench?.spaceOrder),
    sidebar: {
      collapsed: Boolean(persistedSidebar?.collapsed),
      width: clamp(
        typeof persistedSidebar?.width === "number" ? persistedSidebar.width : DEFAULT_SIDEBAR_WIDTH,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      ),
      topLevelSectionOrder: normalizeSidebarTopLevelSectionOrder(persistedSidebar?.topLevelSectionOrder),
      topLevelSections: normalizeSidebarTopLevelSectionsPrefs(persistedSidebar?.topLevelSections),
    },
    dock: {
      width: clamp(
        typeof persistedDock?.width === "number" ? persistedDock.width : DEFAULT_DOCK_WIDTH,
        DOCK_MIN_WIDTH,
        DOCK_MAX_WIDTH,
      ),
      tree:
        typeof persistedDock?.tree === "object" && persistedDock.tree !== null
          ? (persistedDock.tree as DockTreeNode)
          : createDefaultDockTree(),
    },
    recentCardSessions: resumeSnapshot
      ? normalizeRecentSessions(resumeSnapshot.recentCardSessions).slice(0, MAX_RECENT_CARD_SESSIONS)
      : normalizeRecentSessions(persistedRecent).slice(0, MAX_RECENT_CARD_SESSIONS),
    activeRecentSessionId,
    focusedStage,
    stageNavDirection,
    sidebarStageExpandedByProject: normalizeSidebarStageExpanded(
      persistedWorkbench?.sidebarStageExpandedByProject,
    ),
    activeCardsTabId,
    threadsTabs,
    activeThreadsTabId,
    terminalTabs,
    activeTerminalTabId,
    filesTabs,
    activeFilesTabId,
    stagePanelWidths,
    stageCollapsed,
    slidingWindowPaneCount,
    terminalPanelOpen,
    terminalPanelHeight,
  };
}

function reconcileSpaceOrder(order: string[], projects: Project[]): string[] {
  const projectIds = new Set(projects.map((project) => project.id));
  const next = order.filter((projectId) => projectIds.has(projectId));

  projects.forEach((project) => {
    if (next.includes(project.id)) return;
    next.push(project.id);
  });

  return next;
}

function ensureActiveProject(current: string, projects: Project[]): string {
  if (projects.some((project) => project.id === current)) return current;
  return projects[0]?.id ?? "default";
}

function ensureSidebarStageState(
  value: Partial<Record<SidebarGroupId, boolean>> | undefined,
): Partial<Record<SidebarGroupId, boolean>> {
  if (!value) return {};
  return SIDEBAR_GROUP_IDS.reduce<Partial<Record<SidebarGroupId, boolean>>>((acc, groupId) => {
    const expanded = value[groupId];
    if (typeof expanded === "boolean") {
      acc[groupId] = expanded;
    }
    return acc;
  }, {});
}

function ensureFilesTabs(tabs: FilesStageTab[] | undefined): FilesStageTab[] {
  if (!tabs || tabs.length === 0) return [...DEFAULT_FILES_TABS];
  return [{ id: "diff", title: "Diffs" }];
}

function ensureThreadsTabs(tabs: ThreadsStageTab[] | undefined): ThreadsStageTab[] {
  if (!tabs || tabs.length === 0) {
    return [{ id: NEW_THREAD_STAGE_TAB_ID, title: NEW_THREAD_STAGE_TAB_TITLE, preview: "" }];
  }

  const deduped = tabs.reduce<ThreadsStageTab[]>((acc, tab) => {
    if (tab.id === NEW_THREAD_STAGE_TAB_ID) return acc;
    if (acc.some((existing) => existing.id === tab.id)) return acc;
    acc.push(tab);
    return acc;
  }, []);

  return [
    { id: NEW_THREAD_STAGE_TAB_ID, title: NEW_THREAD_STAGE_TAB_TITLE, preview: "" },
    ...deduped.slice(0, 31),
  ];
}

function ensureTerminalTabs(projectId: string, tabs: TerminalStageTab[] | undefined): TerminalStageTab[] {
  if (!tabs || tabs.length === 0) return [makeProjectTerminalTab(projectId)];
  return tabs;
}

function stageIndexOf(stageId: StageId): number {
  return STAGE_ORDER.indexOf(stageId);
}

function resolveNearestExpandedStage(
  currentStage: StageId,
  collapsedState: StageCollapsedState,
): StageId {
  if (collapsedState[currentStage] !== true) return currentStage;

  const currentIndex = stageIndexOf(currentStage);
  for (let step = 1; step < STAGE_ORDER.length; step += 1) {
    const rightIndex = currentIndex + step;
    if (rightIndex < STAGE_ORDER.length) {
      const rightStage = STAGE_ORDER[rightIndex];
      if (collapsedState[rightStage] !== true) return rightStage;
    }

    const leftIndex = currentIndex - step;
    if (leftIndex >= 0) {
      const leftStage = STAGE_ORDER[leftIndex];
      if (collapsedState[leftStage] !== true) return leftStage;
    }
  }

  return currentStage;
}

export function resolveExpandedStages(
  focusedStage: StageId,
  direction: StageNavDirection,
  paneCount: number,
  isNarrow: boolean,
): StageId[] {
  if (isNarrow) return [focusedStage];
  const resolvedPaneCount = clampSlidingWindowPaneCount(paneCount);
  if (resolvedPaneCount >= STAGE_ORDER.length) return [...STAGE_ORDER];

  const focusedIndex = stageIndexOf(focusedStage);
  if (focusedIndex < 0) return STAGE_ORDER.slice(0, resolvedPaneCount);

  const maxWindowStart = STAGE_ORDER.length - resolvedPaneCount;
  const startIndex = direction === "left"
    ? Math.max(0, focusedIndex - (resolvedPaneCount - 1))
    : Math.min(maxWindowStart, focusedIndex);

  return STAGE_ORDER.slice(startIndex, startIndex + resolvedPaneCount);
}

export function resolveNearestSlidingWindowDirection(
  focusedStage: StageId,
  visibleStages: readonly StageId[],
  paneCount: number,
  fallbackDirection: StageNavDirection,
): StageNavDirection {
  if (visibleStages.length < 2) return fallbackDirection;

  const currentWindowStart = stageIndexOf(visibleStages[0]);
  if (currentWindowStart < 0) return fallbackDirection;

  const leftWindowStart = stageIndexOf(resolveExpandedStages(focusedStage, "left", paneCount, false)[0]);
  const rightWindowStart = stageIndexOf(resolveExpandedStages(focusedStage, "right", paneCount, false)[0]);
  if (leftWindowStart < 0 || rightWindowStart < 0) return fallbackDirection;

  const leftDistance = Math.abs(leftWindowStart - currentWindowStart);
  const rightDistance = Math.abs(rightWindowStart - currentWindowStart);
  if (leftDistance === rightDistance) return fallbackDirection;

  return leftDistance < rightDistance ? "left" : "right";
}

export function resolveSlidingWindowFocusIntent(
  focusedStage: StageId,
  visibleStages: readonly StageId[],
  paneCount: number,
  fallbackDirection: StageNavDirection,
): { direction: StageNavDirection } {
  return {
    direction: resolveNearestSlidingWindowDirection(focusedStage, visibleStages, paneCount, fallbackDirection),
  };
}

export function resolveEffectiveSlidingWindowPaneCount(
  requestedPaneCount: number,
  availableWidthPx: number,
): number {
  const normalizedRequestedPaneCount = clampSlidingWindowPaneCount(requestedPaneCount);
  if (!Number.isFinite(availableWidthPx) || availableWidthPx <= 0) return normalizedRequestedPaneCount;
  const maxByWidth = Math.max(
    SLIDING_WINDOW_MIN_PANES,
    Math.floor(availableWidthPx / STAGE_PANEL_MIN_WIDTH),
  );
  return clampSlidingWindowPaneCount(Math.min(normalizedRequestedPaneCount, maxByWidth));
}

function makeCardsStageTabs(
  recentSessions: RecentCardSession[],
): CardsStageTab[] {
  return recentSessions.map((session) => ({
    id: `session:${session.id}`,
    kind: "session" as const,
    title: session.titleSnapshot || session.cardId,
    sessionId: session.id,
  }));
}

interface UseWorkbenchStateOptions {
  stageCollapseEnabled?: boolean;
  initialResumeSnapshot?: WorkbenchResumeSnapshot | null;
}

export function useWorkbenchState(
  projects: Project[],
  options: UseWorkbenchStateOptions = {},
) {
  const stageCollapseEnabled = options.stageCollapseEnabled ?? true;
  const [state, setState] = useState<WorkbenchState>(() =>
    loadInitialState({ resumeSnapshot: options.initialResumeSnapshot }),
  );

  useEffect(() => {
    if (projects.length === 0) return;

    setState((prev) => {
      const spaceOrder = reconcileSpaceOrder(prev.spaceOrder, projects);
      const dbProjectId = ensureActiveProject(prev.dbProjectId, projects);
      const threadsProjectId = ensureActiveProject(prev.threadsProjectId, projects);

      const viewsByProject = { ...prev.viewsByProject };
      const searchByProject = { ...prev.searchByProject };
      const projectIds = new Set(projects.map((project) => project.id));

      Object.keys(viewsByProject).forEach((projectId) => {
        if (projectIds.has(projectId)) return;
        delete viewsByProject[projectId];
      });

      Object.keys(searchByProject).forEach((projectId) => {
        if (projectIds.has(projectId)) return;
        delete searchByProject[projectId];
      });

      projects.forEach((project) => {
        if (viewsByProject[project.id]) return;
        viewsByProject[project.id] = "kanban";
      });

      const recentCardSessions = prev.recentCardSessions.filter((session) =>
        projectIds.has(session.projectId),
      );

      const activeRecentSessionId =
        prev.activeRecentSessionId &&
        recentCardSessions.some((session) => session.id === prev.activeRecentSessionId)
          ? prev.activeRecentSessionId
          : null;

      const sidebarStageExpandedByProject = { ...prev.sidebarStageExpandedByProject };
      const slidingWindowPaneCount = clampSlidingWindowPaneCount(prev.slidingWindowPaneCount);
      const terminalPanelOpen = prev.terminalPanelOpen;
      const terminalPanelHeight = clampTerminalPanelHeight(prev.terminalPanelHeight);

      Object.keys(sidebarStageExpandedByProject).forEach((projectId) => {
        if (!projectIds.has(projectId)) delete sidebarStageExpandedByProject[projectId];
      });

      projects.forEach((project) => {
        const projectId = project.id;
        sidebarStageExpandedByProject[projectId] = ensureSidebarStageState(
          sidebarStageExpandedByProject[projectId],
        );
      });

      const cardsTabs = makeCardsStageTabs(recentCardSessions);
      const hasActiveCardsTab =
        (prev.activeCardsTabId === HISTORY_TAB_ID && cardsTabs.length > 0) ||
        cardsTabs.some((tab) => tab.id === prev.activeCardsTabId);
      const activeCardsTabId = hasActiveCardsTab
        ? prev.activeCardsTabId
        : cardsTabs[0]?.id ?? "";

      const threadsTabs = ensureThreadsTabs(prev.threadsTabs);
      const activeThreadsTabId = threadsTabs.some((tab) => tab.id === prev.activeThreadsTabId)
        ? prev.activeThreadsTabId
        : threadsTabs[0]?.id ?? "";

      const sessionLookup = new Map(
        recentCardSessions.map((session) => [session.id, session]),
      );
      const terminalTabs = ensureTerminalTabs(dbProjectId, prev.terminalTabs).map((tab) => {
        if (tab.kind !== "card") return tab;
        if (!tab.sessionRefId) return tab;
        const session = sessionLookup.get(tab.sessionRefId);
        if (!session) return tab;
        return {
          ...tab,
          projectId: session.projectId,
          title: session.titleSnapshot || session.cardId,
          cardId: session.cardId,
          sessionId: session.cardId,
        };
      });
      const activeTerminalTabId = terminalTabs.some((tab) => tab.id === prev.activeTerminalTabId)
        ? prev.activeTerminalTabId
        : terminalTabs[0]?.id ?? "";

      const filesTabs = ensureFilesTabs(prev.filesTabs);
      const activeFilesTabId = filesTabs.some((tab) => tab.id === prev.activeFilesTabId)
        ? prev.activeFilesTabId
        : filesTabs[0]?.id ?? "diff";

      const stagePanelWidths = normalizeStagePanelWidths(prev.stagePanelWidths);
      const stageCollapsed = normalizeStageCollapsedState(prev.stageCollapsed);
      const effectiveCollapsedState = resolveEffectiveStageCollapsedState(
        stageCollapsed,
        stageCollapseEnabled,
      );
      const focusedStage = resolveNearestExpandedStage(prev.focusedStage, effectiveCollapsedState);
      const stageNavDirection = isStageDirection(prev.stageNavDirection) ? prev.stageNavDirection : "right";

      return {
        ...prev,
        spaceOrder,
        dbProjectId,
        threadsProjectId,
        viewsByProject,
        searchByProject,
        recentCardSessions,
        activeRecentSessionId,
        focusedStage,
        stageNavDirection,
        sidebarStageExpandedByProject,
        activeCardsTabId,
        threadsTabs,
        activeThreadsTabId,
        terminalTabs,
        activeTerminalTabId,
        filesTabs,
        activeFilesTabId,
        stagePanelWidths,
        stageCollapsed,
        slidingWindowPaneCount,
        terminalPanelOpen,
        terminalPanelHeight,
      };
    });
  }, [projects, stageCollapseEnabled]);

  useEffect(() => {
    writeJson(WORKBENCH_STORAGE_KEY, {
      dbProjectId: state.dbProjectId,
      threadsProjectId: state.threadsProjectId,
      viewsByProject: state.viewsByProject,
      searchByProject: state.searchByProject,
      spaceOrder: state.spaceOrder,
      activeRecentSessionId: state.activeRecentSessionId,
      focusedStage: state.focusedStage,
      stageNavDirection: state.stageNavDirection,
      sidebarStageExpandedByProject: state.sidebarStageExpandedByProject,
      activeCardsTabId: state.activeCardsTabId,
      threadsTabs: state.threadsTabs,
      activeThreadsTabId: state.activeThreadsTabId,
      terminalTabs: state.terminalTabs,
      activeTerminalTabId: state.activeTerminalTabId,
      filesTabs: state.filesTabs,
      activeFilesTabId: state.activeFilesTabId,
      stagePanelWidths: state.stagePanelWidths,
      stageCollapsed: state.stageCollapsed,
      slidingWindowPaneCount: state.slidingWindowPaneCount,
      terminalPanelOpen: state.terminalPanelOpen,
      terminalPanelHeight: state.terminalPanelHeight,
    } satisfies WorkbenchPrefs);

    writeJson(SIDEBAR_STORAGE_KEY, state.sidebar);
    writeJson(DOCK_STORAGE_KEY, state.dock);
    writeJson(RECENT_STORAGE_KEY, state.recentCardSessions);
  }, [state]);

  const spaces = useMemo(
    () => state.spaceOrder.map((projectId) => makeSpaceRef(projectId)),
    [state.spaceOrder],
  );

  const activeView = state.viewsByProject[state.dbProjectId] ?? "kanban";
  const activeSearchQuery = state.searchByProject[state.dbProjectId] ?? "";
  const focusedStage = state.focusedStage;
  const stageNavDirection = state.stageNavDirection;

  const cardsTabs = useMemo(
    () => makeCardsStageTabs(state.recentCardSessions),
    [state.recentCardSessions],
  );
  const activeCardsTabId = state.activeCardsTabId;

  const threadsTabs = state.threadsTabs;
  const activeThreadsTabId = state.activeThreadsTabId;

  const terminalTabs = state.terminalTabs;
  const activeTerminalTabId = state.activeTerminalTabId;

  const filesTabs = state.filesTabs;
  const activeFilesTabId = state.activeFilesTabId;
  const stagePanelWidths = state.stagePanelWidths;
  const stageCollapsed = state.stageCollapsed;
  const slidingWindowPaneCount = clampSlidingWindowPaneCount(state.slidingWindowPaneCount);
  const terminalPanelOpen = state.terminalPanelOpen;
  const terminalPanelHeight = clampTerminalPanelHeight(
    state.terminalPanelHeight,
  );

  const setDbProject = useCallback((projectId: string) => {
    setState((prev) => {
      if (prev.dbProjectId === projectId) return prev;
      return { ...prev, dbProjectId: projectId };
    });
  }, []);

  const setThreadsProjectId = useCallback((projectId: string) => {
    setState((prev) => {
      if (prev.threadsProjectId === projectId) return prev;
      return { ...prev, threadsProjectId: projectId };
    });
  }, []);

  const setView = useCallback((projectId: string, view: WorkbenchView) => {
    setState((prev) => {
      if (prev.viewsByProject[projectId] === view) return prev;
      return {
        ...prev,
        viewsByProject: {
          ...prev.viewsByProject,
          [projectId]: view,
        },
      };
    });
  }, []);

  const setSearchQuery = useCallback((projectId: string, query: string) => {
    setState((prev) => {
      if (prev.searchByProject[projectId] === query) return prev;
      return {
        ...prev,
        searchByProject: {
          ...prev.searchByProject,
          [projectId]: query,
        },
      };
    });
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setState((prev) => {
      if (prev.sidebar.collapsed === collapsed) return prev;
      return {
        ...prev,
        sidebar: {
          ...prev.sidebar,
          collapsed,
        },
      };
    });
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    const nextWidth = clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    setState((prev) => {
      if (prev.sidebar.width === nextWidth) return prev;
      return {
        ...prev,
        sidebar: {
          ...prev.sidebar,
          width: nextWidth,
        },
      };
    });
  }, []);

  const setSidebarTopLevelSectionVisible = useCallback((sectionId: SidebarTopLevelSectionId, visible: boolean) => {
    setState((prev) => {
      const currentSection = prev.sidebar.topLevelSections[sectionId];
      if (currentSection.visible === visible) return prev;
      return {
        ...prev,
        sidebar: {
          ...prev.sidebar,
          topLevelSections: {
            ...prev.sidebar.topLevelSections,
            [sectionId]: {
              ...currentSection,
              visible,
            },
          },
        },
      };
    });
  }, []);

  const setSidebarTopLevelSectionItemLimit = useCallback((
    sectionId: SidebarTopLevelSectionId,
    itemLimit: SidebarSectionItemLimit,
  ) => {
    setState((prev) => {
      const currentSection = prev.sidebar.topLevelSections[sectionId];
      if (currentSection.itemLimit === itemLimit) return prev;
      return {
        ...prev,
        sidebar: {
          ...prev.sidebar,
          topLevelSections: {
            ...prev.sidebar.topLevelSections,
            [sectionId]: {
              ...currentSection,
              itemLimit,
            },
          },
        },
      };
    });
  }, []);

  const moveSidebarTopLevelSectionBy = useCallback((sectionId: SidebarTopLevelSectionId, direction: -1 | 1) => {
    setState((prev) => {
      const nextOrder = moveSidebarTopLevelSection(
        prev.sidebar.topLevelSectionOrder,
        prev.sidebar.topLevelSections,
        sectionId,
        direction,
      );
      if (JSON.stringify(nextOrder) === JSON.stringify(prev.sidebar.topLevelSectionOrder)) return prev;
      return {
        ...prev,
        sidebar: {
          ...prev.sidebar,
          topLevelSectionOrder: nextOrder,
        },
      };
    });
  }, []);

  const setDockWidth = useCallback((width: number) => {
    const nextWidth = clamp(width, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH);
    setState((prev) => {
      if (prev.dock.width === nextWidth) return prev;
      return {
        ...prev,
        dock: {
          ...prev.dock,
          width: nextWidth,
        },
      };
    });
  }, []);

  const setDockTree = useCallback((tree: DockTreeNode) => {
    setState((prev) => ({
      ...prev,
      dock: {
        ...prev.dock,
        tree,
      },
    }));
  }, []);

  const setFocusedStage = useCallback((
    _projectId: string,
    stageId: StageId,
    directionOverride?: StageNavDirection,
  ) => {
    setState((prev) => {
      const stageCollapsedState = resolveEffectiveStageCollapsedState(
        normalizeStageCollapsedState(prev.stageCollapsed),
        stageCollapseEnabled,
      );
      const resolvedStageId = resolveNearestExpandedStage(stageId, stageCollapsedState);
      const prevStage = prev.focusedStage;
      const prevIndex = stageIndexOf(prevStage);
      const nextIndex = stageIndexOf(resolvedStageId);
      const computedDirection =
        nextIndex === prevIndex
          ? prev.stageNavDirection
          : nextIndex > prevIndex
            ? "right"
            : "left";
      const direction = directionOverride ?? computedDirection;

      if (prevStage === resolvedStageId && prev.stageNavDirection === direction) {
        return prev;
      }

      return {
        ...prev,
        focusedStage: resolvedStageId,
        stageNavDirection: direction,
      };
    });
  }, [stageCollapseEnabled]);

  const focusAdjacentStage = useCallback((_projectId: string, direction: -1 | 1) => {
    setState((prev) => {
      const current = prev.focusedStage;
      const stageCollapsedState = resolveEffectiveStageCollapsedState(
        normalizeStageCollapsedState(prev.stageCollapsed),
        stageCollapseEnabled,
      );
      const currentIndex = stageIndexOf(current);
      let nextStage = current;

      for (let step = 1; step <= STAGE_ORDER.length; step += 1) {
        const candidateIndex =
          direction > 0
            ? (currentIndex + step) % STAGE_ORDER.length
            : (currentIndex - step + STAGE_ORDER.length) % STAGE_ORDER.length;
        const candidateStage = STAGE_ORDER[candidateIndex];
        if (stageCollapsedState[candidateStage] === true) continue;
        nextStage = candidateStage;
        break;
      }

      return {
        ...prev,
        focusedStage: nextStage,
        stageNavDirection: direction > 0 ? "right" : "left",
      };
    });
  }, [stageCollapseEnabled]);

  const switchToStageIndex = useCallback((projectId: string, index: number) => {
    if (index < 0 || index >= STAGE_ORDER.length) return;
    setFocusedStage(projectId, STAGE_ORDER[index]);
  }, [setFocusedStage]);

  const setSidebarStageExpanded = useCallback((projectId: string, stageId: SidebarGroupId, expanded: boolean) => {
    setState((prev) => {
      const projectMap = ensureSidebarStageState(prev.sidebarStageExpandedByProject[projectId]);
      if (projectMap[stageId] === expanded) return prev;
      return {
        ...prev,
        sidebarStageExpandedByProject: {
          ...prev.sidebarStageExpandedByProject,
          [projectId]: {
            ...projectMap,
            [stageId]: expanded,
          },
        },
      };
    });
  }, []);

  const setStageCollapsed = useCallback((_projectId: string, stageId: StageId, collapsed: boolean) => {
    setState((prev) => {
      if (!stageCollapseEnabled) return prev;
      const current = normalizeStageCollapsedState(prev.stageCollapsed);
      const nextState: StageCollapsedState = { ...current };

      if (collapsed) {
        nextState[stageId] = true;
      } else {
        nextState[stageId] = false;
      }

      const currentSignature = JSON.stringify(current);
      const nextSignature = JSON.stringify(nextState);
      if (currentSignature === nextSignature) return prev;

      let nextFocusedStage = prev.focusedStage;
      let nextDirection = prev.stageNavDirection;

      if (nextFocusedStage === stageId) {
        const resolvedFocusedStage = resolveNearestExpandedStage(
          stageId,
          resolveEffectiveStageCollapsedState(nextState, stageCollapseEnabled),
        );
        if (resolvedFocusedStage !== nextFocusedStage) {
          nextDirection = stageIndexOf(resolvedFocusedStage) > stageIndexOf(nextFocusedStage) ? "right" : "left";
          nextFocusedStage = resolvedFocusedStage;
        }
      }

      return {
        ...prev,
        focusedStage: nextFocusedStage,
        stageNavDirection: nextDirection,
        stageCollapsed: nextState,
      };
    });
  }, [stageCollapseEnabled]);

  const setActiveCardsTab = useCallback((_projectId: string, tabId: string) => {
    setState((prev) => {
      if (prev.activeCardsTabId === tabId) return prev;
      return {
        ...prev,
        activeCardsTabId: tabId,
      };
    });
  }, []);

  const setActiveThreadsTab = useCallback((projectId: string, tabId: string) => {
    setState((prev) => {
      if (prev.activeThreadsTabId === tabId && prev.threadsProjectId === projectId) return prev;
      return {
        ...prev,
        threadsProjectId: projectId,
        activeThreadsTabId: tabId,
      };
    });
  }, []);

  const setThreadsTabs = useCallback((projectId: string, tabs: ThreadsStageTab[]) => {
    const normalizedTabs = ensureThreadsTabs(tabs);
    setState((prev) => {
      if (projectId !== prev.threadsProjectId) return prev;
      const currentTabs = ensureThreadsTabs(prev.threadsTabs);
      const currentSignature = JSON.stringify(currentTabs);
      const nextSignature = JSON.stringify(normalizedTabs);
      if (currentSignature === nextSignature) return prev;

      const currentActive = prev.activeThreadsTabId;
      const hasActive = normalizedTabs.some((tab) => tab.id === currentActive);
      const nextActive = hasActive ? currentActive : normalizedTabs[0]?.id ?? "";

      return {
        ...prev,
        threadsTabs: normalizedTabs,
        activeThreadsTabId: nextActive,
      };
    });
  }, []);

  const setActiveTerminalTab = useCallback((_projectId: string, tabId: string) => {
    setState((prev) => {
      if (prev.activeTerminalTabId === tabId) return prev;
      return {
        ...prev,
        activeTerminalTabId: tabId,
      };
    });
  }, []);

  const setActiveFilesTab = useCallback((_projectId: string, tabId: string) => {
    const normalizedTabId = tabId === "diff" ? tabId : "diff";
    setState((prev) => {
      if (prev.activeFilesTabId === normalizedTabId) return prev;
      return {
        ...prev,
        activeFilesTabId: normalizedTabId,
      };
    });
  }, []);

  const setStagePanelWidths = useCallback((_projectId: string, widths: StagePanelWidths) => {
    setState((prev) => {
      if (typeof widths !== "object" || widths === null) return prev;

      const current = normalizeStagePanelWidths(prev.stagePanelWidths);
      const nextProjectWidths = { ...current };
      let changed = false;

      Object.entries(widths).forEach(([stageId, width]) => {
        if (!isStageId(stageId)) return;
        if (typeof width !== "number" || !Number.isFinite(width)) return;
        const nextWidth = clampStagePanelWidth(width, STAGE_PANEL_MIN_WIDTH, STAGE_PANEL_MAX_WIDTH);
        if (nextProjectWidths[stageId] === nextWidth) return;
        nextProjectWidths[stageId] = nextWidth;
        changed = true;
      });

      if (!changed) return prev;

      return {
        ...prev,
        stagePanelWidths: nextProjectWidths,
      };
    });
  }, []);

  const setSlidingWindowPaneCount = useCallback((paneCount: number) => {
    const nextPaneCount = clampSlidingWindowPaneCount(paneCount);
    setState((prev) => {
      if (prev.slidingWindowPaneCount === nextPaneCount) return prev;
      return {
        ...prev,
        slidingWindowPaneCount: nextPaneCount,
      };
    });
  }, []);

  const setTerminalPanelOpen = useCallback((_projectId: string, open: boolean) => {
    setState((prev) => {
      if (prev.terminalPanelOpen === open) return prev;
      return {
        ...prev,
        terminalPanelOpen: open,
      };
    });
  }, []);

  const setTerminalPanelHeight = useCallback((_projectId: string, height: number) => {
    const nextHeight = clampTerminalPanelHeight(height);
    setState((prev) => {
      if (prev.terminalPanelHeight === nextHeight) return prev;
      return {
        ...prev,
        terminalPanelHeight: nextHeight,
      };
    });
  }, []);

  const toggleTerminalPanel = useCallback((projectId: string) => {
    void projectId;
    setState((prev) => {
      const nextOpen = !prev.terminalPanelOpen;
      return {
        ...prev,
        terminalPanelOpen: nextOpen,
      };
    });
  }, []);

  const openProjectTerminalTab = useCallback((projectId: string): string => {
    const tabId = `project:${projectId}`;
    setState((prev) => {
      const existingTabs = ensureTerminalTabs(prev.dbProjectId, prev.terminalTabs);
      const existing = existingTabs.find((tab) => tab.id === tabId);
      const nextTabs = existing
        ? existingTabs
        : [...existingTabs, makeProjectTerminalTab(projectId)];

      return {
        ...prev,
        terminalTabs: nextTabs,
        activeTerminalTabId: tabId,
      };
    });
    return tabId;
  }, []);

  const openCardTerminalTab = useCallback(
    (projectId: string, sessionRefId: string, cardId: string, title: string): string => {
      const tabId = `card:${sessionRefId}`;
      const normalizedTitle = title.trim() || cardId;
      setState((prev) => {
        const existingTabs = ensureTerminalTabs(prev.dbProjectId, prev.terminalTabs);
        const existing = existingTabs.find((tab) => tab.id === tabId);
        const nextTabs = existing
          ? existingTabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    projectId,
                    title: normalizedTitle,
                    cardId,
                    sessionId: cardId,
                    sessionRefId,
                  }
                : tab,
            )
          : [
              ...existingTabs,
              {
                id: tabId,
                kind: "card" as const,
                projectId,
                title: normalizedTitle,
                cardId,
                sessionId: cardId,
                sessionRefId,
              },
            ];

        return {
          ...prev,
          terminalTabs: nextTabs,
          activeTerminalTabId: tabId,
        };
      });
      return tabId;
    },
    [],
  );

  const closeTerminalTab = useCallback((projectId: string, tabId: string) => {
    setState((prev) => {
      const existingTabs = ensureTerminalTabs(prev.dbProjectId, prev.terminalTabs);
      const nextTabs = existingTabs.filter((tab) => tab.id !== tabId);
      const finalizedTabs =
        nextTabs.length > 0 ? nextTabs : [makeProjectTerminalTab(projectId)];

      const existingActive = prev.activeTerminalTabId;
      const nextActive =
        existingActive === tabId || !finalizedTabs.some((tab) => tab.id === existingActive)
          ? finalizedTabs[0].id
          : existingActive;

      return {
        ...prev,
        terminalTabs: finalizedTabs,
        activeTerminalTabId: nextActive,
      };
    });
  }, []);

  const cycleProjects = useCallback((direction: -1 | 1) => {
    setState((prev) => {
      if (prev.spaceOrder.length <= 1) return prev;
      const currentIndex = prev.spaceOrder.indexOf(prev.dbProjectId);
      if (currentIndex < 0) return prev;
      const nextIndex =
        direction > 0
          ? (currentIndex + 1) % prev.spaceOrder.length
          : (currentIndex - 1 + prev.spaceOrder.length) % prev.spaceOrder.length;
      return {
        ...prev,
        dbProjectId: prev.spaceOrder[nextIndex],
      };
    });
  }, []);

  const switchToProjectIndex = useCallback((index: number) => {
    setState((prev) => {
      if (index < 0 || index >= prev.spaceOrder.length) return prev;
      return { ...prev, dbProjectId: prev.spaceOrder[index] };
    });
  }, []);

  const recordRecentCardLeave = useCallback(
    (projectId: string, cardId: string, titleSnapshot: string): string | null => {
      let sessionId: string | null = null;
      setState((prev) => {
        const nextRecent = recordRecentCardLeaveInList(prev.recentCardSessions, projectId, cardId, titleSnapshot);
        const targetSession = findRecentCardSession(nextRecent, projectId, cardId);
        if (!targetSession) return prev;
        sessionId = targetSession.id;

        return {
          ...prev,
          activeRecentSessionId: targetSession.id,
          recentCardSessions: nextRecent,
          activeCardsTabId: `session:${targetSession.id}`,
        };
      });

      return sessionId;
    },
    [],
  );

  const selectRecentCardSession = useCallback((sessionId: string) => {
    setState((prev) => {
      const target = prev.recentCardSessions.find((session) => session.id === sessionId);
      if (!target) return prev;

      return {
        ...prev,
        activeRecentSessionId: target.id,
        focusedStage: "cards",
        activeCardsTabId: `session:${target.id}`,
      };
    });
  }, []);

  const setActiveRecentCardSession = useCallback((sessionId: string | null) => {
    setState((prev) => {
      const target = sessionId
        ? prev.recentCardSessions.find((session) => session.id === sessionId) ?? null
        : null;
      const nextActiveRecentSessionId = target?.id ?? null;
      const nextActiveCardsTabId = target ? `session:${target.id}` : "";

      if (
        prev.activeRecentSessionId === nextActiveRecentSessionId
        && prev.activeCardsTabId === nextActiveCardsTabId
      ) {
        return prev;
      }

      return {
        ...prev,
        activeRecentSessionId: nextActiveRecentSessionId,
        activeCardsTabId: nextActiveCardsTabId,
      };
    });
  }, []);

  const closeRecentCardSession = useCallback((sessionId: string) => {
    setState((prev) => {
      const closing = prev.recentCardSessions.find((session) => session.id === sessionId);
      const nextRecent = prev.recentCardSessions.filter((session) => session.id !== sessionId);
      if (nextRecent.length === prev.recentCardSessions.length) return prev;

      const nextActiveSessionId =
        prev.activeRecentSessionId === sessionId ? nextRecent[0]?.id ?? null : prev.activeRecentSessionId;

      const nextActiveCardsTabId =
        closing && prev.activeCardsTabId === `session:${sessionId}`
          ? (nextRecent[0] ? `session:${nextRecent[0].id}` : "")
          : prev.activeCardsTabId;

      return {
        ...prev,
        activeRecentSessionId: nextActiveSessionId,
        recentCardSessions: nextRecent,
        activeCardsTabId: nextActiveCardsTabId,
      };
    });
  }, []);

  const isSidebarStageExpanded = useCallback(
    (projectId: string, stageId: SidebarGroupId): boolean => {
      const value = state.sidebarStageExpandedByProject[projectId]?.[stageId];
      return typeof value === "boolean" ? value : true;
    },
    [state.sidebarStageExpandedByProject],
  );

  const isStageCollapsed = useCallback(
    (_projectId: string, stageId: StageId): boolean => {
      if (!stageCollapseEnabled) return false;
      return state.stageCollapsed[stageId] === true;
    },
    [stageCollapseEnabled, state.stageCollapsed],
  );

  return {
    dbProjectId: state.dbProjectId,
    activeProjectId: state.dbProjectId,
    threadsProjectId: state.threadsProjectId,
    spaces,
    activeView,
    activeSearchQuery,
    viewsByProject: state.viewsByProject,
    searchByProject: state.searchByProject,
    sidebar: state.sidebar,
    dock: state.dock,
    recentCardSessions: state.recentCardSessions,
    activeRecentSessionId: state.activeRecentSessionId,
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
    stageCollapsed,
    slidingWindowPaneCount,
    terminalPanelOpen,
    terminalPanelHeight,
    setDbProject,
    setActiveProject: setDbProject,
    setThreadsProjectId,
    setView,
    setSearchQuery,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarTopLevelSectionVisible,
    setSidebarTopLevelSectionItemLimit,
    moveSidebarTopLevelSectionBy,
    setDockWidth,
    setDockTree,
    setFocusedStage,
    focusAdjacentStage,
    switchToStageIndex,
    setSidebarStageExpanded,
    isSidebarStageExpanded,
    setStageCollapsed,
    isStageCollapsed,
    setActiveCardsTab,
    setActiveThreadsTab,
    setThreadsTabs,
    setActiveTerminalTab,
    setActiveFilesTab,
    setStagePanelWidths,
    setSlidingWindowPaneCount,
    setTerminalPanelOpen,
    setTerminalPanelHeight,
    toggleTerminalPanel,
    openProjectTerminalTab,
    openCardTerminalTab,
    closeTerminalTab,
    cycleProjects,
    switchToProjectIndex,
    recordRecentCardLeave,
    selectRecentCardSession,
    setActiveRecentCardSession,
    closeRecentCardSession,
  };
}

export const workbenchStorageKeys = {
  workbench: WORKBENCH_STORAGE_KEY,
  sidebar: SIDEBAR_STORAGE_KEY,
  dock: DOCK_STORAGE_KEY,
  recent: RECENT_STORAGE_KEY,
};

export const workbenchTestHelpers = {
  clamp,
  isWorkbenchView,
  normalizeViewMap,
  normalizeSearchMap,
  normalizeSpaceOrder,
  normalizeRecentSessions,
  findRecentCardSession,
  recordRecentCardLeaveInList,
  normalizeStageMap,
  normalizeStageCollapsedState,
  clampSlidingWindowPaneCount,
  normalizeSlidingWindowPaneCount,
  resolvePersistedSlidingWindowPaneCount,
  resolveEffectiveStageCollapsedState,
  clampTerminalPanelHeight,
  normalizeSidebarTopLevelSectionOrder,
  normalizeSidebarTopLevelSectionsPrefs,
  moveSidebarTopLevelSection,
  makeDefaultStageCollapsedState,
  resolveNearestExpandedStage,
  reconcileSpaceOrder,
  ensureActiveProject,
  loadInitialState,
  makeSpaceRef,
  resolveExpandedStages,
  resolveNearestSlidingWindowDirection,
  resolveSlidingWindowFocusIntent,
  resolveEffectiveSlidingWindowPaneCount,
};
