export const STAGE_PANEL_MIN_WIDTH = 280;
export const STAGE_PANEL_MAX_WIDTH = 1400;
export const STAGE_PANEL_RESIZE_KEYBOARD_STEP = 24;
export const STAGE_PANEL_RESIZE_LEFT_EDGE = "left" as const;
export const STAGE_PANEL_RESIZE_RIGHT_EDGE = "right" as const;

export type StagePanelResizeEdge =
  | typeof STAGE_PANEL_RESIZE_LEFT_EDGE
  | typeof STAGE_PANEL_RESIZE_RIGHT_EDGE;

interface ResizePanelPairInput {
  leftStartWidth: number;
  rightStartWidth: number;
  deltaPx: number;
  minPanelWidth?: number;
  maxPanelWidth?: number;
}

interface ResizePanelPairResult {
  leftWidth: number;
  rightWidth: number;
}

interface ResizeSinglePanelInput {
  startWidth: number;
  deltaPx: number;
  edge: StagePanelResizeEdge;
  minPanelWidth?: number;
  maxPanelWidth?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeWidth(width: number, fallback: number): number {
  if (!Number.isFinite(width) || width <= 0) return fallback;
  return width;
}

export function clampStagePanelWidth(
  width: number,
  minPanelWidth: number = STAGE_PANEL_MIN_WIDTH,
  maxPanelWidth: number = STAGE_PANEL_MAX_WIDTH,
): number {
  const safeMin = Number.isFinite(minPanelWidth) ? minPanelWidth : STAGE_PANEL_MIN_WIDTH;
  const safeMax = Number.isFinite(maxPanelWidth) ? maxPanelWidth : STAGE_PANEL_MAX_WIDTH;
  const lower = Math.min(safeMin, safeMax);
  const upper = Math.max(safeMin, safeMax);
  const safeWidth = sanitizeWidth(width, lower);
  return clamp(Math.round(safeWidth), lower, upper);
}

export function resolveResizedPanelPair({
  leftStartWidth,
  rightStartWidth,
  deltaPx,
  minPanelWidth = STAGE_PANEL_MIN_WIDTH,
  maxPanelWidth = STAGE_PANEL_MAX_WIDTH,
}: ResizePanelPairInput): ResizePanelPairResult {
  const safeMin = Math.max(0, Math.round(minPanelWidth));
  const safeMax = Math.max(safeMin, Math.round(maxPanelWidth));

  const safeLeftStart = sanitizeWidth(leftStartWidth, safeMin || 1);
  const safeRightStart = sanitizeWidth(rightStartWidth, safeMin || 1);
  const totalWidth = safeLeftStart + safeRightStart;

  if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
    return {
      leftWidth: safeMin,
      rightWidth: safeMin,
    };
  }

  const leftLowerBound = Math.max(safeMin, totalWidth - safeMax);
  const leftUpperBound = Math.min(safeMax, totalWidth - safeMin);

  if (leftLowerBound > leftUpperBound) {
    const midpoint = Math.round(totalWidth / 2);
    return {
      leftWidth: midpoint,
      rightWidth: Math.max(0, Math.round(totalWidth) - midpoint),
    };
  }

  const safeDelta = Number.isFinite(deltaPx) ? deltaPx : 0;
  const nextLeft = clamp(safeLeftStart + safeDelta, leftLowerBound, leftUpperBound);
  const roundedLeft = Math.round(nextLeft);
  const roundedRight = Math.round(totalWidth - nextLeft);

  return {
    leftWidth: roundedLeft,
    rightWidth: roundedRight,
  };
}

export function resolveResizedPanelWidth({
  startWidth,
  deltaPx,
  edge,
  minPanelWidth = STAGE_PANEL_MIN_WIDTH,
  maxPanelWidth = STAGE_PANEL_MAX_WIDTH,
}: ResizeSinglePanelInput): number {
  const safeStart = sanitizeWidth(startWidth, minPanelWidth);
  const safeDelta = Number.isFinite(deltaPx) ? deltaPx : 0;
  const directionalDelta = edge === STAGE_PANEL_RESIZE_LEFT_EDGE ? -safeDelta : safeDelta;
  return clampStagePanelWidth(safeStart + directionalDelta, minPanelWidth, maxPanelWidth);
}
