import { CARD_STATUS_ORDER, type CardStatus } from "../../shared/card-status";

export const DEFAULT_KANBAN_COLUMN_WIDTH = 288;
export const MIN_KANBAN_COLUMN_WIDTH = 224;
export const MAX_KANBAN_COLUMN_WIDTH = 416;
export const KANBAN_COLUMN_WIDTH_STEP = 32;
export const COLLAPSED_KANBAN_COLUMN_WIDTH = 64;

export const KANBAN_COLUMN_WIDTH_PRESETS = [
  { label: "Narrow", width: 240 },
  { label: "Default", width: DEFAULT_KANBAN_COLUMN_WIDTH },
  { label: "Wide", width: 360 },
] as const;

export interface KanbanColumnLayout {
  collapsed: boolean;
  width: number;
}

export type KanbanColumnLayoutPrefs = Partial<Record<CardStatus, Partial<KanbanColumnLayout>>>;

const STORAGE_KEY_PREFIX = "nodex-kanban-column-layout-v1";

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}:${projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function clampKanbanColumnWidth(value: unknown): number {
  if (!Number.isFinite(value)) return DEFAULT_KANBAN_COLUMN_WIDTH;

  const rounded = Math.round(Number(value));
  return Math.min(MAX_KANBAN_COLUMN_WIDTH, Math.max(MIN_KANBAN_COLUMN_WIDTH, rounded));
}

export function getKanbanColumnLayout(
  prefs: KanbanColumnLayoutPrefs | null | undefined,
  columnId: CardStatus,
): KanbanColumnLayout {
  const columnPrefs = prefs?.[columnId];

  return {
    collapsed: columnPrefs?.collapsed === true,
    width: clampKanbanColumnWidth(columnPrefs?.width),
  };
}

export function normalizeKanbanColumnLayoutPrefs(value: unknown): KanbanColumnLayoutPrefs {
  if (!isRecord(value)) return {};

  const normalized: KanbanColumnLayoutPrefs = {};

  for (const status of CARD_STATUS_ORDER) {
    const candidate = value[status];
    if (!isRecord(candidate)) continue;

    const next: Partial<KanbanColumnLayout> = {};
    if (typeof candidate.collapsed === "boolean") {
      next.collapsed = candidate.collapsed;
    }
    if (candidate.width !== undefined) {
      next.width = clampKanbanColumnWidth(candidate.width);
    }
    if (next.collapsed === undefined && next.width === undefined) {
      continue;
    }
    normalized[status] = next;
  }

  return normalized;
}

export function readKanbanColumnLayoutPrefs(projectId: string): KanbanColumnLayoutPrefs {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    return normalizeKanbanColumnLayoutPrefs(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function writeKanbanColumnLayoutPrefs(
  projectId: string,
  prefs: KanbanColumnLayoutPrefs,
): KanbanColumnLayoutPrefs {
  const normalized = normalizeKanbanColumnLayoutPrefs(prefs);

  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(normalized));
  } catch {
    // localStorage may be unavailable.
  }

  return normalized;
}

export function updateKanbanColumnLayoutPrefs(
  current: KanbanColumnLayoutPrefs,
  columnId: CardStatus,
  patch: Partial<KanbanColumnLayout>,
): KanbanColumnLayoutPrefs {
  const previous = getKanbanColumnLayout(current, columnId);
  const next = {
    ...current,
    [columnId]: {
      collapsed: patch.collapsed ?? previous.collapsed,
      width: patch.width === undefined ? previous.width : clampKanbanColumnWidth(patch.width),
    },
  };

  return normalizeKanbanColumnLayoutPrefs(next);
}
