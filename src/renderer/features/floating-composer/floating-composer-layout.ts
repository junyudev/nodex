import {
  WORKBENCH_FLOATING_COMPOSER_DOCKS,
  type WorkbenchFloatingComposerCornerDock,
  type WorkbenchFloatingComposerDock,
} from "../../../shared/workbench-scene";

/** Where a floating composer rests inside its pane. */
export type FloatingComposerDock = WorkbenchFloatingComposerDock;
/** Where a minimized composer's bubble rests. */
export type FloatingComposerCornerDock = WorkbenchFloatingComposerCornerDock;

export const DEFAULT_FLOATING_COMPOSER_DOCK: FloatingComposerDock = "bottom-center";
export const DEFAULT_FLOATING_COMPOSER_MINIMIZED_DOCK: FloatingComposerCornerDock = "bottom-right";

/** The floating frame sits this far from the pane edge. */
export const FLOATING_COMPOSER_FRAME_INSET_PX = 10;
/** The visible surface sits this far inside the frame, leaving room for the resize handles. */
export const FLOATING_COMPOSER_SURFACE_INSET_PX = 6;
/** Visible surface distance from the pane edge. */
export const FLOATING_COMPOSER_EDGE_PX =
  FLOATING_COMPOSER_FRAME_INSET_PX + FLOATING_COMPOSER_SURFACE_INSET_PX;
export const FLOATING_COMPOSER_HEADER_HEIGHT_PX = 46;
export const FLOATING_COMPOSER_BUBBLE_SIZE_PX = 36;
export const FLOATING_COMPOSER_MIN_WIDTH_PX = 360;
export const DEFAULT_FLOATING_COMPOSER_WIDTH_PX = 560;
export const FLOATING_COMPOSER_MIN_HEIGHT_PX = 400;
export const DEFAULT_FLOATING_COMPOSER_HEIGHT_PX = 640;
/** An expanded composer keeps this much of the pane's height clear. */
export const FLOATING_COMPOSER_EXPANDED_CLEARANCE_PX = 32;
/** Below this pane width the composer spans the pane at its bottom and cannot move. */
export const FLOATING_COMPOSER_NARROW_PANE_PX = 640;
/** A dragged composer dropped this close to the pane's leading edge returns beside the content. */
export const FLOATING_COMPOSER_PANE_DROP_EDGE_PX = 24;

export interface FloatingComposerPaneSize {
  readonly width: number;
  readonly height: number;
}

export interface FloatingComposerBox {
  readonly width: number;
  readonly height: number;
}

export interface FloatingComposerPoint {
  readonly x: number;
  readonly y: number;
}

export interface FloatingComposerRect extends FloatingComposerPoint, FloatingComposerBox {}

export function isFloatingComposerDock(value: unknown): value is FloatingComposerDock {
  return (WORKBENCH_FLOATING_COMPOSER_DOCKS as readonly unknown[]).includes(value);
}

export function isTopFloatingComposerDock(dock: FloatingComposerDock): boolean {
  return dock.startsWith("top");
}

/** A minimized composer rests in a corner; the centre dock minimizes to the bottom right. */
export function resolveMinimizedFloatingComposerDock(
  dock: FloatingComposerDock,
): FloatingComposerCornerDock {
  return dock === "bottom-center" ? DEFAULT_FLOATING_COMPOSER_MINIMIZED_DOCK : dock;
}

/** Scale origin that keeps a docked box pinned to its dock while it shrinks. */
export function resolveFloatingComposerDockScaleOrigin(dock: FloatingComposerDock): {
  readonly originX: number;
  readonly originY: number;
} {
  return {
    originX: dock === "bottom-center" ? 0.5 : dock.endsWith("right") ? 1 : 0,
    originY: isTopFloatingComposerDock(dock) ? 0 : 1,
  };
}

/**
 * Top-left corner of a box resting at `dock`. `inset` is the box's distance from the pane edge;
 * `topReserve` keeps top docks clear of the pane's own header.
 */
export function resolveFloatingComposerDockOrigin(input: {
  readonly dock: FloatingComposerDock;
  readonly box: FloatingComposerBox;
  readonly pane: FloatingComposerPaneSize;
  readonly inset: number;
  readonly topReserve?: number;
}): FloatingComposerPoint {
  const { dock, box, pane, inset, topReserve = 0 } = input;
  const x =
    dock === "bottom-center"
      ? Math.round((pane.width - box.width) / 2)
      : dock.endsWith("left")
        ? inset
        : pane.width - box.width - inset;
  const y = isTopFloatingComposerDock(dock) ? topReserve + inset : pane.height - box.height - inset;
  return { x, y };
}

/**
 * How far a box resting at `dock` may be dragged while staying `inset` px inside the pane, as
 * offsets from its resting place.
 */
export function resolveFloatingComposerDragConstraints(input: {
  readonly dock: FloatingComposerDock;
  readonly box: FloatingComposerBox;
  readonly pane: FloatingComposerPaneSize;
  readonly inset: number;
}): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} {
  const { box, pane, inset } = input;
  const origin = resolveFloatingComposerDockOrigin(input);
  return {
    left: inset - origin.x,
    right: Math.max(inset, pane.width - box.width - inset) - origin.x,
    top: inset - origin.y,
    bottom: Math.max(inset, pane.height - box.height - inset) - origin.y,
  };
}

/**
 * The dock a released composer settles into: the bottom centre when it rests in the lower half
 * across the middle half of the pane, otherwise the nearest corner.
 */
export function resolveFloatingComposerDockForRect(
  rect: FloatingComposerRect,
  pane: FloatingComposerPaneSize,
  options: { readonly minimized?: boolean } = {},
): FloatingComposerDock {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  if (
    !options.minimized &&
    centerY >= pane.height / 2 &&
    centerX >= pane.width / 4 &&
    centerX <= (pane.width * 3) / 4
  ) {
    return "bottom-center";
  }
  const vertical = centerY < pane.height / 2 ? "top" : "bottom";
  const horizontal = centerX < pane.width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

export function clampFloatingComposerFrameWidth(width: number, paneWidth: number): number {
  const maximum = Math.max(0, paneWidth - 2 * FLOATING_COMPOSER_FRAME_INSET_PX);
  const minimum = Math.min(
    FLOATING_COMPOSER_MIN_WIDTH_PX + 2 * FLOATING_COMPOSER_SURFACE_INSET_PX,
    maximum,
  );
  return Math.min(Math.max(width, minimum), maximum);
}

/** Frame width for a stored surface width. A narrow pane's composer spans the pane. */
export function resolveFloatingComposerFrameWidth(surfaceWidth: number, paneWidth: number): number {
  if (isFloatingComposerPaneNarrow(paneWidth)) {
    return Math.max(0, paneWidth - 2 * FLOATING_COMPOSER_FRAME_INSET_PX);
  }
  return clampFloatingComposerFrameWidth(
    surfaceWidth + 2 * FLOATING_COMPOSER_SURFACE_INSET_PX,
    paneWidth,
  );
}

export function isFloatingComposerPaneNarrow(paneWidth: number): boolean {
  return paneWidth > 0 && paneWidth < FLOATING_COMPOSER_NARROW_PANE_PX;
}

/** Height bounds of an expanded frame; `contentMinimum` is the frame height of its compact form. */
export function resolveFloatingComposerExpandedHeightBounds(
  paneHeight: number,
  contentMinimum = 0,
): { readonly minimum: number; readonly maximum: number } {
  const maximum = Math.max(0, paneHeight - FLOATING_COMPOSER_EXPANDED_CLEARANCE_PX);
  return {
    minimum: Math.min(Math.max(FLOATING_COMPOSER_MIN_HEIGHT_PX, contentMinimum), maximum),
    maximum,
  };
}

/** Expanded frame height for a stored height. */
export function resolveFloatingComposerExpandedHeight(
  storedHeight: number,
  paneHeight: number,
  contentMinimum = 0,
): number {
  const { minimum, maximum } = resolveFloatingComposerExpandedHeightBounds(
    paneHeight,
    contentMinimum,
  );
  return Math.min(Math.max(storedHeight, minimum), maximum);
}

/**
 * Horizontal offset that keeps the edge opposite the dragged one in place while the width changes.
 * The frame glides back to its dock once the resize ends.
 */
export function resolveFloatingComposerResizeOffset(input: {
  readonly dock: FloatingComposerDock;
  readonly edge: "left" | "right";
  readonly startWidth: number;
  readonly startOffset: number;
  readonly width: number;
  readonly pane: FloatingComposerPaneSize;
  readonly height: number;
}): number {
  const { dock, edge, startWidth, startOffset, width, pane, height } = input;
  const origin = (frameWidth: number) =>
    resolveFloatingComposerDockOrigin({
      dock,
      box: { width: frameWidth, height },
      pane,
      inset: FLOATING_COMPOSER_FRAME_INSET_PX,
    }).x;
  const startLeft = origin(startWidth) + startOffset;
  const desiredLeft = edge === "left" ? startLeft + startWidth - width : startLeft;
  const left = Math.min(
    pane.width - width - FLOATING_COMPOSER_FRAME_INSET_PX,
    Math.max(FLOATING_COMPOSER_FRAME_INSET_PX, desiredLeft),
  );
  return left - origin(width);
}

/** A dragged frame within this distance of a corner dock is about to rest there. */
const FLOATING_COMPOSER_DOCK_NEAR_PX = 16;

/**
 * Where a dragged frame is headed. A frame at least half the pane wide follows the pointer
 * horizontally, so a wide composer can still reach a side. Near a corner dock the frame is about
 * to rest there; with the pointer also in that corner, releasing minimizes it there.
 */
export function resolveFloatingComposerDragTarget(input: {
  readonly rect: FloatingComposerRect;
  readonly pane: FloatingComposerPaneSize;
  readonly pointer: FloatingComposerPoint;
}): {
  readonly dock: FloatingComposerDock;
  readonly nearDock: boolean;
  readonly minimize: boolean;
} {
  const { rect, pane, pointer } = input;
  const followsPointer = rect.width >= pane.width / 2 - 2 * FLOATING_COMPOSER_FRAME_INSET_PX;
  const dock = resolveFloatingComposerDockForRect(
    followsPointer ? { ...rect, x: pointer.x - rect.width / 2 } : rect,
    pane,
  );
  const origin = resolveFloatingComposerDockOrigin({
    dock,
    box: rect,
    pane,
    inset: FLOATING_COMPOSER_FRAME_INSET_PX,
  });
  const nearDock =
    dock !== "bottom-center" &&
    Math.abs(rect.x - origin.x) <= FLOATING_COMPOSER_DOCK_NEAR_PX &&
    Math.abs(rect.y - origin.y) <= FLOATING_COMPOSER_DOCK_NEAR_PX;
  return {
    dock,
    nearDock,
    minimize: nearDock && isFloatingComposerPointerNearBubbleCorner({ pointer, pane }),
  };
}

/** Whether a dragged composer's pointer rests in a pane corner, asking it to minimize there. */
export function isFloatingComposerPointerNearBubbleCorner(input: {
  readonly pointer: FloatingComposerPoint;
  readonly pane: FloatingComposerPaneSize;
}): boolean {
  const { pointer, pane } = input;
  const reach = FLOATING_COMPOSER_EDGE_PX + FLOATING_COMPOSER_BUBBLE_SIZE_PX;
  return (
    Math.min(pointer.x, pane.width - pointer.x) <= reach &&
    Math.min(pointer.y, pane.height - pointer.y) <= reach
  );
}

/** Whether a dragged composer's pointer rests on the pane's leading edge. */
export function isFloatingComposerPointerOnPaneEdge(pointerX: number): boolean {
  return pointerX <= FLOATING_COMPOSER_PANE_DROP_EDGE_PX;
}
