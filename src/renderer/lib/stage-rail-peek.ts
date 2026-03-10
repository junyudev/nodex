export const STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY = "nodex-stage-rail-next-panel-peek-px-v1";
export const DEFAULT_NEXT_PANEL_PEEK_PX = 28;
export const MIN_NEXT_PANEL_PEEK_PX = 0;
export const MIN_ENABLED_NEXT_PANEL_PEEK_PX = 8;
export const MAX_NEXT_PANEL_PEEK_PX = 96;
export const NEXT_PANEL_PEEK_STEP_PX = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeFinitePeekPx(value: number): number {
  const rounded = Math.round(value);
  if (rounded <= MIN_NEXT_PANEL_PEEK_PX) return MIN_NEXT_PANEL_PEEK_PX;
  return clamp(rounded, MIN_ENABLED_NEXT_PANEL_PEEK_PX, MAX_NEXT_PANEL_PEEK_PX);
}

export function normalizeNextPanelPeekPx(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return normalizeFinitePeekPx(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return DEFAULT_NEXT_PANEL_PEEK_PX;
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed)) {
      return normalizeFinitePeekPx(parsed);
    }
  }

  return DEFAULT_NEXT_PANEL_PEEK_PX;
}

export function readNextPanelPeekPx(): number {
  try {
    const raw = localStorage.getItem(STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY);
    if (raw === null) return DEFAULT_NEXT_PANEL_PEEK_PX;
    return normalizeNextPanelPeekPx(raw);
  } catch {
    return DEFAULT_NEXT_PANEL_PEEK_PX;
  }
}

export function writeNextPanelPeekPx(value: number): number {
  const normalized = normalizeNextPanelPeekPx(value);
  try {
    localStorage.setItem(STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY, String(normalized));
  } catch {
    // localStorage may be unavailable
  }
  return normalized;
}
