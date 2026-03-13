import type { CardStageState } from "./use-card-stage";
import type { StageId, StageNavDirection, WorkbenchView } from "./use-workbench-state";

const HISTORY_STORAGE_KEY = "nodex-workbench-navigation-history-v1";
const MAX_HISTORY_ENTRIES = 50;

export interface NavigationSnapshot {
  dbProjectId: string;
  activeView: WorkbenchView;
  focusedStage: StageId;
  stageNavDirection: StageNavDirection;
  cardStage: CardStageState;
  activeCardsTabId: string;
  activeRecentSessionId: string | null;
  threadsProjectId: string;
  activeThreadsTabId: string;
  activeFilesTabId: string;
}

export interface NavigationHistoryState {
  backStack: NavigationSnapshot[];
  forwardStack: NavigationSnapshot[];
}

const EMPTY_HISTORY: NavigationHistoryState = {
  backStack: [],
  forwardStack: [],
};

function isStageId(value: unknown): value is StageId {
  return value === "db" || value === "cards" || value === "threads" || value === "files";
}

function isStageNavDirection(value: unknown): value is StageNavDirection {
  return value === "left" || value === "right";
}

function isWorkbenchView(value: unknown): value is WorkbenchView {
  return value === "kanban" || value === "list" || value === "toggle-list" || value === "canvas" || value === "calendar";
}

function normalizeCardStageState(value: unknown): CardStageState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    open?: unknown;
    projectId?: unknown;
    cardId?: unknown;
  };
  if (typeof candidate.open !== "boolean") return null;
  if (typeof candidate.projectId !== "string") return null;
  if (candidate.cardId !== null && typeof candidate.cardId !== "string") return null;
  return {
    open: candidate.open,
    projectId: candidate.projectId,
    cardId: candidate.cardId ?? null,
  };
}

export function normalizeNavigationSnapshot(value: unknown): NavigationSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const cardStage = normalizeCardStageState(candidate.cardStage);
  if (!cardStage) return null;
  if (typeof candidate.dbProjectId !== "string" || candidate.dbProjectId.length === 0) return null;
  if (!isWorkbenchView(candidate.activeView)) return null;
  if (!isStageId(candidate.focusedStage)) return null;
  if (!isStageNavDirection(candidate.stageNavDirection)) return null;
  if (typeof candidate.activeCardsTabId !== "string") return null;
  if (candidate.activeRecentSessionId !== null && typeof candidate.activeRecentSessionId !== "string") return null;
  if (typeof candidate.threadsProjectId !== "string" || candidate.threadsProjectId.length === 0) return null;
  if (typeof candidate.activeThreadsTabId !== "string") return null;
  if (typeof candidate.activeFilesTabId !== "string") return null;
  return {
    dbProjectId: candidate.dbProjectId,
    activeView: candidate.activeView,
    focusedStage: candidate.focusedStage,
    stageNavDirection: candidate.stageNavDirection,
    cardStage,
    activeCardsTabId: candidate.activeCardsTabId,
    activeRecentSessionId: candidate.activeRecentSessionId,
    threadsProjectId: candidate.threadsProjectId,
    activeThreadsTabId: candidate.activeThreadsTabId,
    activeFilesTabId: candidate.activeFilesTabId,
  };
}

function normalizeHistoryStack(value: unknown): NavigationSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeNavigationSnapshot(item))
    .filter((item): item is NavigationSnapshot => item !== null)
    .slice(-MAX_HISTORY_ENTRIES);
}

export function normalizeNavigationHistoryState(value: unknown): NavigationHistoryState {
  if (typeof value !== "object" || value === null) return EMPTY_HISTORY;
  const candidate = value as Record<string, unknown>;
  return {
    backStack: normalizeHistoryStack(candidate.backStack),
    forwardStack: normalizeHistoryStack(candidate.forwardStack),
  };
}

export function readNavigationHistoryState(): NavigationHistoryState {
  try {
    if (typeof sessionStorage === "undefined") return EMPTY_HISTORY;
    const raw = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return EMPTY_HISTORY;
    return normalizeNavigationHistoryState(JSON.parse(raw));
  } catch {
    return EMPTY_HISTORY;
  }
}

export function writeNavigationHistoryState(state: NavigationHistoryState): NavigationHistoryState {
  const normalized = normalizeNavigationHistoryState(state);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch {
    // Ignore storage write failures and keep runtime state.
  }
  return normalized;
}

export function areNavigationSnapshotsEqual(left: NavigationSnapshot, right: NavigationSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function recordNavigationTransition(
  state: NavigationHistoryState,
  current: NavigationSnapshot,
  next: NavigationSnapshot,
): NavigationHistoryState {
  if (areNavigationSnapshotsEqual(current, next)) return normalizeNavigationHistoryState(state);
  const normalized = normalizeNavigationHistoryState(state);
  const existingBackStack = normalized.backStack;
  const previousSnapshot = existingBackStack[existingBackStack.length - 1];
  const nextBackStack = previousSnapshot && areNavigationSnapshotsEqual(previousSnapshot, current)
    ? existingBackStack
    : [...existingBackStack, current].slice(-MAX_HISTORY_ENTRIES);
  return {
    backStack: nextBackStack,
    forwardStack: [],
  };
}

export function navigateBackInHistory(
  state: NavigationHistoryState,
  current: NavigationSnapshot,
): { historyState: NavigationHistoryState; snapshot: NavigationSnapshot | null } {
  const normalized = normalizeNavigationHistoryState(state);
  const snapshot = normalized.backStack[normalized.backStack.length - 1] ?? null;
  if (!snapshot) {
    return {
      historyState: normalized,
      snapshot: null,
    };
  }

  return {
    historyState: {
      backStack: normalized.backStack.slice(0, -1),
      forwardStack: [current, ...normalized.forwardStack].slice(0, MAX_HISTORY_ENTRIES),
    },
    snapshot,
  };
}

export function navigateForwardInHistory(
  state: NavigationHistoryState,
  current: NavigationSnapshot,
): { historyState: NavigationHistoryState; snapshot: NavigationSnapshot | null } {
  const normalized = normalizeNavigationHistoryState(state);
  const snapshot = normalized.forwardStack[0] ?? null;
  if (!snapshot) {
    return {
      historyState: normalized,
      snapshot: null,
    };
  }

  return {
    historyState: {
      backStack: [...normalized.backStack, current].slice(-MAX_HISTORY_ENTRIES),
      forwardStack: normalized.forwardStack.slice(1),
    },
    snapshot,
  };
}

export const navigationHistoryStorageKey = HISTORY_STORAGE_KEY;

export const navigationHistoryTestHelpers = {
  normalizeNavigationSnapshot,
  normalizeNavigationHistoryState,
  MAX_HISTORY_ENTRIES,
};
