import { getIntl } from "@/lib/i18n";
import { WORKFLOW_STATUS_ORDER, type WorkflowStatus } from "../../shared/workflow-status";
import {
  LEGACY_WORKFLOW_STATUS_ORDER,
  WORKFLOW_STATUS_CUTOVER_MAP,
} from "../../shared/workflow-status-cutover";

export const DEFAULT_BOARD_COLUMN_WIDTH = 288;
export const MIN_BOARD_COLUMN_WIDTH = 224;
export const MAX_BOARD_COLUMN_WIDTH = 416;
export const BOARD_COLUMN_WIDTH_STEP = 32;
export const COLLAPSED_BOARD_COLUMN_WIDTH = 64;

export const BOARD_COLUMN_WIDTH_PRESETS = [
  {
    get label() {
      return getIntl().formatMessage({
        id: "lib.boardColumnLayout.narrow",
        defaultMessage: "Narrow",
      });
    },
    width: 240,
  },
  {
    get label() {
      return getIntl().formatMessage({
        id: "lib.boardColumnLayout.default",
        defaultMessage: "Default",
      });
    },
    width: DEFAULT_BOARD_COLUMN_WIDTH,
  },
  {
    get label() {
      return getIntl().formatMessage({ id: "lib.boardColumnLayout.wide", defaultMessage: "Wide" });
    },
    width: 360,
  },
] as const;

export interface BoardColumnLayout {
  collapsed: boolean;
  width: number;
}

export type BoardColumnLayoutPrefs = Partial<Record<WorkflowStatus, Partial<BoardColumnLayout>>>;

const STORAGE_KEY_PREFIX = "nodex-board-column-layout-v1";

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}:${projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function clampBoardColumnWidth(value: unknown): number {
  if (!Number.isFinite(value)) return DEFAULT_BOARD_COLUMN_WIDTH;

  const rounded = Math.round(Number(value));
  return Math.min(MAX_BOARD_COLUMN_WIDTH, Math.max(MIN_BOARD_COLUMN_WIDTH, rounded));
}

export function getBoardColumnLayout(
  prefs: BoardColumnLayoutPrefs | null | undefined,
  columnId: WorkflowStatus,
): BoardColumnLayout {
  const columnPrefs = prefs?.[columnId];

  return {
    collapsed: columnPrefs?.collapsed === true,
    width: clampBoardColumnWidth(columnPrefs?.width),
  };
}

export function normalizeBoardColumnLayoutPrefs(value: unknown): BoardColumnLayoutPrefs {
  if (!isRecord(value)) return {};

  const normalized: BoardColumnLayoutPrefs = {};

  for (const status of WORKFLOW_STATUS_ORDER) {
    const legacyStatus = LEGACY_WORKFLOW_STATUS_ORDER.find(
      (candidate) => WORKFLOW_STATUS_CUTOVER_MAP[candidate] === status,
    );
    const candidate =
      value[status] ?? (legacyStatus === undefined ? undefined : value[legacyStatus]);
    if (!isRecord(candidate)) continue;

    const next: Partial<BoardColumnLayout> = {};
    if (typeof candidate.collapsed === "boolean") {
      next.collapsed = candidate.collapsed;
    }
    if (candidate.width !== undefined) {
      next.width = clampBoardColumnWidth(candidate.width);
    }
    if (next.collapsed === undefined && next.width === undefined) {
      continue;
    }
    normalized[status] = next;
  }

  return normalized;
}

export function readBoardColumnLayoutPrefs(projectId: string): BoardColumnLayoutPrefs {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    return normalizeBoardColumnLayoutPrefs(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function writeBoardColumnLayoutPrefs(
  projectId: string,
  prefs: BoardColumnLayoutPrefs,
): BoardColumnLayoutPrefs {
  const normalized = normalizeBoardColumnLayoutPrefs(prefs);

  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(normalized));
  } catch {
    // localStorage may be unavailable.
  }

  return normalized;
}

export function updateBoardColumnLayoutPrefs(
  current: BoardColumnLayoutPrefs,
  columnId: WorkflowStatus,
  patch: Partial<BoardColumnLayout>,
): BoardColumnLayoutPrefs {
  const previous = getBoardColumnLayout(current, columnId);
  const next = {
    ...current,
    [columnId]: {
      collapsed: patch.collapsed ?? previous.collapsed,
      width: patch.width === undefined ? previous.width : clampBoardColumnWidth(patch.width),
    },
  };

  return normalizeBoardColumnLayoutPrefs(next);
}
