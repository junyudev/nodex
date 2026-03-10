import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { WorkbenchResumeSnapshot } from "../shared/workbench-resume";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE_NAME = "workbench-resume-v1.json";
const MAX_RECENT_CARD_SESSIONS = 10;
const VALID_VIEWS = new Set(["kanban", "list", "toggle-list", "canvas", "calendar"]);
const VALID_STAGE_IDS = new Set(["db", "cards", "threads", "files"]);
const VALID_STAGE_DIRECTIONS = new Set(["left", "right"]);

function normalizeViewsByProject(value: unknown): WorkbenchResumeSnapshot["viewsByProject"] {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<WorkbenchResumeSnapshot["viewsByProject"]>((acc, [projectId, view]) => {
    if (typeof projectId !== "string" || projectId.length === 0) return acc;
    if (typeof view !== "string" || !VALID_VIEWS.has(view)) return acc;
    acc[projectId] = view as WorkbenchResumeSnapshot["viewsByProject"][string];
    return acc;
  }, {});
}

function normalizeRecentCardSessions(value: unknown): WorkbenchResumeSnapshot["recentCardSessions"] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (entry): entry is WorkbenchResumeSnapshot["recentCardSessions"][number] =>
        typeof entry === "object"
        && entry !== null
        && typeof (entry as { id?: unknown }).id === "string"
        && typeof (entry as { projectId?: unknown }).projectId === "string"
        && typeof (entry as { cardId?: unknown }).cardId === "string"
        && typeof (entry as { titleSnapshot?: unknown }).titleSnapshot === "string"
        && typeof (entry as { lastOpenedAt?: unknown }).lastOpenedAt === "string",
    )
    .slice(0, MAX_RECENT_CARD_SESSIONS);
}

export function normalizeWorkbenchResumeSnapshot(value: unknown): WorkbenchResumeSnapshot | null {
  if (typeof value !== "object" || value === null) return null;

  const snapshot = value as Partial<WorkbenchResumeSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return null;
  if (typeof snapshot.dbProjectId !== "string") return null;
  if (typeof snapshot.threadsProjectId !== "string") return null;
  if (typeof snapshot.focusedStage !== "string" || !VALID_STAGE_IDS.has(snapshot.focusedStage)) return null;
  if (typeof snapshot.stageNavDirection !== "string" || !VALID_STAGE_DIRECTIONS.has(snapshot.stageNavDirection)) {
    return null;
  }
  if (typeof snapshot.activeCardsTabId !== "string") return null;
  if (
    snapshot.activeRecentSessionId !== null
    && snapshot.activeRecentSessionId !== undefined
    && typeof snapshot.activeRecentSessionId !== "string"
  ) {
    return null;
  }
  if (typeof snapshot.activeThreadsTabId !== "string") return null;
  if (typeof snapshot.cardStage !== "object" || snapshot.cardStage === null) return null;
  if (typeof snapshot.cardStage.open !== "boolean") return null;
  if (typeof snapshot.cardStage.projectId !== "string") return null;
  if (snapshot.cardStage.cardId !== null && typeof snapshot.cardStage.cardId !== "string") return null;

  return {
    version: SNAPSHOT_VERSION,
    dbProjectId: snapshot.dbProjectId,
    threadsProjectId: snapshot.threadsProjectId,
    viewsByProject: normalizeViewsByProject(snapshot.viewsByProject),
    focusedStage: snapshot.focusedStage,
    stageNavDirection: snapshot.stageNavDirection,
    activeCardsTabId: snapshot.activeCardsTabId,
    activeRecentSessionId: snapshot.activeRecentSessionId ?? null,
    activeThreadsTabId: snapshot.activeThreadsTabId,
    recentCardSessions: normalizeRecentCardSessions(snapshot.recentCardSessions),
    cardStage: {
      open: snapshot.cardStage.open,
      projectId: snapshot.cardStage.projectId,
      cardId: snapshot.cardStage.cardId ?? null,
    },
  };
}

export class WorkbenchResumeState {
  private readonly restoreEligibleWindowIds = new Set<number>();
  private readonly snapshotPath: string;

  constructor(userDataPath: string) {
    this.snapshotPath = join(userDataPath, SNAPSHOT_FILE_NAME);
  }

  markWindowEligible(webContentsId: number): void {
    this.restoreEligibleWindowIds.add(webContentsId);
  }

  clearWindowEligibility(webContentsId: number): void {
    this.restoreEligibleWindowIds.delete(webContentsId);
  }

  readSnapshot(): WorkbenchResumeSnapshot | null {
    try {
      const raw = readFileSync(this.snapshotPath, "utf8");
      return normalizeWorkbenchResumeSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  saveSnapshotForWindow(
    webContentsId: number,
    lastFocusedWindowId: number | null,
    openWindowCount: number,
    snapshot: WorkbenchResumeSnapshot,
  ): boolean {
    if (openWindowCount > 1 && webContentsId !== lastFocusedWindowId) {
      return false;
    }

    const normalized = normalizeWorkbenchResumeSnapshot(snapshot);
    if (!normalized) {
      return false;
    }

    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    writeFileSync(this.snapshotPath, JSON.stringify(normalized, null, 2), "utf8");
    return true;
  }

  consumeSnapshotForWindow(webContentsId: number): WorkbenchResumeSnapshot | null {
    if (!this.restoreEligibleWindowIds.delete(webContentsId)) {
      return null;
    }

    return this.readSnapshot();
  }
}

export const workbenchResumeStateTestHelpers = {
  normalizeWorkbenchResumeSnapshot,
};
