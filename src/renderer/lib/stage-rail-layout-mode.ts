export type StageRailLayoutMode = "sliding-window" | "full-rail";

export const STAGE_RAIL_LAYOUT_MODE_STORAGE_KEY = "nodex-stage-rail-layout-mode-v1";
export const DEFAULT_STAGE_RAIL_LAYOUT_MODE: StageRailLayoutMode = "sliding-window";

export function normalizeStageRailLayoutMode(value: unknown): StageRailLayoutMode {
  if (value === "sliding-window" || value === "full-rail") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "full-rail") return normalized;
    if (normalized === "sliding-window") return "sliding-window";
  }

  return DEFAULT_STAGE_RAIL_LAYOUT_MODE;
}

export function readStageRailLayoutMode(): StageRailLayoutMode {
  try {
    const raw = localStorage.getItem(STAGE_RAIL_LAYOUT_MODE_STORAGE_KEY);
    return normalizeStageRailLayoutMode(raw);
  } catch {
    return DEFAULT_STAGE_RAIL_LAYOUT_MODE;
  }
}

export function writeStageRailLayoutMode(value: StageRailLayoutMode): StageRailLayoutMode {
  const normalized = normalizeStageRailLayoutMode(value);
  try {
    localStorage.setItem(STAGE_RAIL_LAYOUT_MODE_STORAGE_KEY, normalized);
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}
