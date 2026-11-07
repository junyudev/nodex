import type { PanelId, WorkbenchPanelSplitSide } from "@/lib/types";

export type PanelGroupBodyDropZone = "center" | WorkbenchPanelSplitSide;

export type PanelTabDragData = Record<string | symbol, unknown> & {
  type: "project-session-panel-tab";
  sessionId: string;
  panelId: PanelId;
  leafId: string;
  tabId: string;
};

export type PanelTabRowDropData = Record<string | symbol, unknown> & {
  type: "project-session-panel-tab-row";
  sessionId: string;
  panelId: PanelId;
  leafId: string;
};

export type PanelGroupBodyDropData = Record<string | symbol, unknown> & {
  type: "project-session-panel-body";
  sessionId: string;
  panelId: PanelId;
  leafId: string;
};

export type PanelTabDropIntent =
  | {
      kind: "tab-row";
      panelId: PanelId;
      leafId: string;
      targetIndex: number;
      markerLeft: number;
    }
  | {
      kind: "body";
      panelId: PanelId;
      leafId: string;
      zone: PanelGroupBodyDropZone;
    };

export type PanelTabDropCommit =
  | {
      kind: "reorder";
      leafId: string;
      tabId: string;
      targetIndex: number;
    }
  | {
      kind: "move";
      tabId: string;
      targetPanelId: PanelId;
      targetLeafId: string;
      targetIndex?: number;
    }
  | {
      kind: "split";
      tabId: string;
      targetPanelId: PanelId;
      targetLeafId: string;
      side: WorkbenchPanelSplitSide;
    };

export interface PanelTabRect {
  id: string;
  left: number;
  right: number;
}

export interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const PANEL_TAB_DRAG_TYPE = "project-session-panel-tab";
const PANEL_TAB_ROW_DROP_TYPE = "project-session-panel-tab-row";
const PANEL_BODY_DROP_TYPE = "project-session-panel-body";
const BODY_EDGE_FACTOR = 0.1;
const DEFAULT_EMPTY_ROW_MARKER_LEFT = 4;

export function buildPanelTabDragData(input: {
  sessionId: string;
  panelId: PanelId;
  leafId: string;
  tabId: string;
}): PanelTabDragData {
  return { type: PANEL_TAB_DRAG_TYPE, ...input };
}

export function buildPanelTabRowDropData(input: {
  sessionId: string;
  panelId: PanelId;
  leafId: string;
}): PanelTabRowDropData {
  return { type: PANEL_TAB_ROW_DROP_TYPE, ...input };
}

export function buildPanelGroupBodyDropData(input: {
  sessionId: string;
  panelId: PanelId;
  leafId: string;
}): PanelGroupBodyDropData {
  return { type: PANEL_BODY_DROP_TYPE, ...input };
}

export function isPanelTabDragData(
  value: Record<string | symbol, unknown>,
): value is PanelTabDragData {
  return (
    value.type === PANEL_TAB_DRAG_TYPE &&
    typeof value.sessionId === "string" &&
    isPanelId(value.panelId) &&
    typeof value.leafId === "string" &&
    typeof value.tabId === "string"
  );
}

export function isPanelTabRowDropData(
  value: Record<string | symbol, unknown>,
): value is PanelTabRowDropData {
  return (
    value.type === PANEL_TAB_ROW_DROP_TYPE &&
    typeof value.sessionId === "string" &&
    isPanelId(value.panelId) &&
    typeof value.leafId === "string"
  );
}

export function isPanelGroupBodyDropData(
  value: Record<string | symbol, unknown>,
): value is PanelGroupBodyDropData {
  return (
    value.type === PANEL_BODY_DROP_TYPE &&
    typeof value.sessionId === "string" &&
    isPanelId(value.panelId) &&
    typeof value.leafId === "string"
  );
}

export function resolvePanelTabRowInsertion(input: {
  pointerClientX: number;
  rowLeft: number;
  rowScrollLeft: number;
  tabRects: readonly PanelTabRect[];
}): { targetIndex: number; markerLeft: number } {
  if (input.tabRects.length === 0) {
    return {
      targetIndex: 0,
      markerLeft: input.rowScrollLeft + DEFAULT_EMPTY_ROW_MARKER_LEFT,
    };
  }

  for (let index = 0; index < input.tabRects.length; index += 1) {
    const tabRect = input.tabRects[index];
    if (!tabRect) continue;
    const midpoint = tabRect.left + (tabRect.right - tabRect.left) / 2;
    if (input.pointerClientX < midpoint) {
      return {
        targetIndex: index,
        markerLeft: input.rowScrollLeft + tabRect.left - input.rowLeft,
      };
    }
  }

  const lastRect = input.tabRects[input.tabRects.length - 1];
  return {
    targetIndex: input.tabRects.length,
    markerLeft: input.rowScrollLeft + (lastRect?.right ?? input.rowLeft) - input.rowLeft,
  };
}

export function resolveSameLeafInsertionIndex(input: {
  tabIds: readonly string[];
  sourceTabId: string;
  targetIndex: number;
}): number | null {
  const sourceIndex = input.tabIds.indexOf(input.sourceTabId);
  if (sourceIndex < 0) return null;

  const clampedTargetIndex = Math.min(Math.max(0, input.targetIndex), input.tabIds.length);
  if (clampedTargetIndex === sourceIndex || clampedTargetIndex === sourceIndex + 1) {
    return null;
  }

  return clampedTargetIndex > sourceIndex ? clampedTargetIndex - 1 : clampedTargetIndex;
}

export function resolvePanelGroupBodyDropZone(input: {
  pointerClientX: number;
  pointerClientY: number;
  rect: PanelRect;
}): PanelGroupBodyDropZone {
  const edgeWidth = input.rect.width * BODY_EDGE_FACTOR;
  const edgeHeight = input.rect.height * BODY_EDGE_FACTOR;
  const localX = input.pointerClientX - input.rect.left;
  const localY = input.pointerClientY - input.rect.top;

  if (localX <= edgeWidth) return "left";
  if (localX >= input.rect.width - edgeWidth) return "right";
  if (localY <= edgeHeight) return "up";
  if (localY >= input.rect.height - edgeHeight) return "down";

  return "center";
}

export function resolvePanelTabDropCommit(
  source: PanelTabDragData,
  intent: PanelTabDropIntent,
): PanelTabDropCommit | null {
  if (intent.kind === "tab-row") {
    if (source.panelId === intent.panelId && source.leafId === intent.leafId) {
      return {
        kind: "reorder",
        leafId: intent.leafId,
        tabId: source.tabId,
        targetIndex: intent.targetIndex,
      };
    }

    return {
      kind: "move",
      tabId: source.tabId,
      targetPanelId: intent.panelId,
      targetLeafId: intent.leafId,
      targetIndex: intent.targetIndex,
    };
  }

  if (intent.zone === "center") {
    if (source.panelId === intent.panelId && source.leafId === intent.leafId) return null;
    return {
      kind: "move",
      tabId: source.tabId,
      targetPanelId: intent.panelId,
      targetLeafId: intent.leafId,
    };
  }

  return {
    kind: "split",
    tabId: source.tabId,
    targetPanelId: intent.panelId,
    targetLeafId: intent.leafId,
    side: intent.zone,
  };
}

function isPanelId(value: unknown): value is PanelId {
  return value === "right" || value === "bottom";
}
