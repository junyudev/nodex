/**
 * Hover peek for a collapsed contextual sidebar.
 *
 * A rail destination opens its sidebar as a floating peek after a short dwell.
 * The peek stays open while the pointer travels from the rail toward the
 * surface (a safe triangle aimed at the surface's near edge), while it rests on
 * the surface or the rail's destination band, while a sidebar-owned menu is
 * open, while focus is inside, and during a drag that started inside. Leaving
 * all of those closes it after a short grace period; Escape, leaving the
 * window, or clicking a non-destination rail button closes it immediately.
 */

export type WorkbenchSidebarPeekArea = "home" | "space";

export const WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE = "data-workbench-sidebar-peek-area";
export const WORKBENCH_SIDEBAR_PEEK_SURFACE_ATTRIBUTE = "data-workbench-sidebar-peek-surface";

export const WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS = 100;
export const WORKBENCH_SIDEBAR_PEEK_SWITCH_DELAY_MS = 300;
export const WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS = 100;
export const WORKBENCH_SIDEBAR_PEEK_AIM_TIMEOUT_MS = 1_000;
const SAFE_TRIANGLE_EDGE_SLOP_PX = 8;

const PEEK_AREA_SELECTOR = `[${WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE}]`;
const PEEK_SURFACE_SELECTOR = `[${WORKBENCH_SIDEBAR_PEEK_SURFACE_ATTRIBUTE}]`;
const RAIL_SELECTOR = "[data-app-navigation-rail]";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface SafeTriangle {
  readonly start: Point;
  readonly endA: Point;
  readonly endB: Point;
}

/** Triangle from the pointer to the destination's near vertical edge, padded vertically. */
export function buildSafeTriangle(pointer: Point, destination: Rect): SafeTriangle | null {
  if (destination.width <= 0 || destination.height <= 0) return null;
  const edgeX = pointer.x <= destination.left ? destination.left : destination.right;
  return {
    start: pointer,
    endA: { x: edgeX, y: destination.top - SAFE_TRIANGLE_EDGE_SLOP_PX },
    endB: { x: edgeX, y: destination.bottom + SAFE_TRIANGLE_EDGE_SLOP_PX },
  };
}

function edgeSign(point: Point, from: Point, to: Point): number {
  return (point.x - to.x) * (from.y - to.y) - (from.x - to.x) * (point.y - to.y);
}

export function isPointInSafeTriangle(point: Point, triangle: SafeTriangle): boolean {
  const a = edgeSign(point, triangle.start, triangle.endA);
  const b = edgeSign(point, triangle.endA, triangle.endB);
  const c = edgeSign(point, triangle.endB, triangle.start);
  const hasNegative = a < 0 || b < 0 || c < 0;
  const hasPositive = a > 0 || b > 0 || c > 0;
  return !(hasNegative && hasPositive);
}

interface PeekTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface WorkbenchSidebarPeekControllerOptions {
  readonly document: Document;
  /** Peek is available only while the contextual sidebar is collapsed and settled. */
  readonly isEnabled: () => boolean;
  readonly onPeekChange: (area: WorkbenchSidebarPeekArea | null) => void;
  readonly timers?: PeekTimers;
}

export interface WorkbenchSidebarPeekController {
  /** Re-evaluate after an external input (enabled state, menu, focus) changes. */
  readonly reconcile: () => void;
  readonly setMenuOpen: (open: boolean) => void;
  readonly setFocusWithin: (focused: boolean) => void;
  readonly close: () => void;
  readonly dispose: () => void;
}

function readPeekArea(element: Element | null): WorkbenchSidebarPeekArea | null {
  const value = element?.getAttribute(WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE);
  return value === "home" || value === "space" ? value : null;
}

export function createWorkbenchSidebarPeekController({
  document,
  isEnabled,
  onPeekChange,
  timers = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
}: WorkbenchSidebarPeekControllerOptions): WorkbenchSidebarPeekController {
  let current: WorkbenchSidebarPeekArea | null = null;
  let hovered: WorkbenchSidebarPeekArea | null = null;
  let pointerInSurface = false;
  let dragging = false;
  let menuOpen = false;
  let focusWithin = false;
  // Escape and explicit rail actions suppress hover reopening until the pointer
  // leaves the rail destinations and the surface.
  let suppressed = false;
  let lastPointer: Point | null = null;
  let openTimer: unknown = null;
  let closeTimer: unknown = null;
  let aimTimer: unknown = null;
  let releaseAim: (() => void) | null = null;

  const clearOpenTimer = () => {
    if (openTimer !== null) timers.clearTimeout(openTimer);
    openTimer = null;
  };
  const clearCloseTimer = () => {
    if (closeTimer !== null) timers.clearTimeout(closeTimer);
    closeTimer = null;
  };
  const dropAim = () => {
    if (aimTimer !== null) timers.clearTimeout(aimTimer);
    aimTimer = null;
    releaseAim?.();
    releaseAim = null;
  };

  const publish = (next: WorkbenchSidebarPeekArea | null) => {
    if (current === next) return;
    current = next;
    onPeekChange(next);
  };

  const closeNow = () => {
    clearOpenTimer();
    clearCloseTimer();
    dropAim();
    pointerInSurface = false;
    publish(null);
  };

  const open = (area: WorkbenchSidebarPeekArea) => {
    clearOpenTimer();
    dropAim();
    publish(area);
  };

  const keptAlive = () =>
    pointerInSurface || dragging || menuOpen || focusWithin || releaseAim !== null;

  const reconcile = () => {
    if (!isEnabled() || suppressed) {
      closeNow();
      return;
    }
    if (current !== null && (menuOpen || focusWithin)) {
      clearOpenTimer();
      clearCloseTimer();
      return;
    }
    if (hovered !== null) {
      clearCloseTimer();
      if (hovered === current) return;
      if (current !== null && releaseAim === null) {
        open(hovered);
        return;
      }
      if (openTimer === null) {
        const target = hovered;
        openTimer = timers.setTimeout(
          () => {
            openTimer = null;
            if (hovered === target) open(target);
          },
          current === null
            ? WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS
            : WORKBENCH_SIDEBAR_PEEK_SWITCH_DELAY_MS,
        );
      }
      return;
    }
    clearOpenTimer();
    if (current === null) return;
    if (keptAlive()) {
      clearCloseTimer();
      return;
    }
    if (closeTimer === null) {
      closeTimer = timers.setTimeout(() => {
        closeTimer = null;
        if (hovered === null && !keptAlive()) publish(null);
      }, WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS);
    }
  };

  const restartAimTimeout = () => {
    if (aimTimer !== null) timers.clearTimeout(aimTimer);
    aimTimer = timers.setTimeout(() => {
      aimTimer = null;
      releaseAim?.();
      releaseAim = null;
      reconcile();
    }, WORKBENCH_SIDEBAR_PEEK_AIM_TIMEOUT_MS);
  };

  /** Keep the peek while the pointer heads from `origin` toward the surface. */
  const aimAtSurface = (origin: Point, source: Element | null) => {
    const surface = document.querySelector(PEEK_SURFACE_SELECTOR);
    if (!surface) return;
    const triangle = buildSafeTriangle(origin, surface.getBoundingClientRect());
    if (!triangle) return;
    dropAim();
    const onMove = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.includes(surface) || (source !== null && path.includes(source))) {
        dropAim();
        return;
      }
      if (isPointInSafeTriangle({ x: event.clientX, y: event.clientY }, triangle)) {
        restartAimTimeout();
        return;
      }
      dropAim();
      reconcile();
    };
    document.addEventListener("pointermove", onMove, true);
    releaseAim = () => document.removeEventListener("pointermove", onMove, true);
    restartAimTimeout();
  };

  const isInRailDestinationBand = (rail: Element, clientY: number) => {
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const area of rail.querySelectorAll(PEEK_AREA_SELECTOR)) {
      const rect = area.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return clientY >= top && clientY <= bottom;
  };

  const handlePointerMove = (event: PointerEvent) => {
    const coarse = event.pointerType === "touch" || event.buttons > 0;
    if (coarse) dropAim();
    const target = event.target instanceof Element ? event.target : null;
    lastPointer = { x: event.clientX, y: event.clientY };
    pointerInSurface = target?.closest(PEEK_SURFACE_SELECTOR) != null;
    const rail = target?.closest(RAIL_SELECTOR) ?? null;
    const areaElement = target?.closest(PEEK_AREA_SELECTOR) ?? null;
    if (rail !== null && areaElement === null && target?.closest("button") != null) {
      hovered = null;
      closeNow();
      return;
    }
    if (!pointerInSurface && current !== null && rail !== null) {
      pointerInSurface = isInRailDestinationBand(rail, event.clientY);
    }
    const nextHovered = coarse ? null : readPeekArea(areaElement);
    if (nextHovered !== hovered) {
      clearOpenTimer();
      suppressed = false;
    }
    hovered = nextHovered;
    if (!pointerInSurface && areaElement === null) suppressed = false;
    reconcile();
  };

  const handlePointerOut = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.buttons > 0 || current === null) return;
    const areaElement =
      event.target instanceof Element ? event.target.closest(PEEK_AREA_SELECTOR) : null;
    if (areaElement === null || readPeekArea(areaElement) !== current) return;
    if (event.relatedTarget instanceof Node && areaElement.contains(event.relatedTarget)) return;
    aimAtSurface(lastPointer ?? { x: event.clientX, y: event.clientY }, areaElement);
  };

  // Leaving the web contents (including onto a native menu) only ends hover; an
  // open sidebar menu or focus inside still keeps the peek.
  const handleDocumentLeave = () => {
    hovered = null;
    pointerInSurface = false;
    dropAim();
    reconcile();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || current === null || menuOpen || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    suppressed = true;
    closeNow();
  };

  const handlePointerDown = () => dropAim();
  const handleDragStart = (event: DragEvent) => {
    dragging =
      event.target instanceof Element && event.target.closest(PEEK_SURFACE_SELECTOR) != null;
  };
  const handleDragEnd = () => {
    dragging = false;
    reconcile();
  };

  document.addEventListener("pointermove", handlePointerMove, { passive: true });
  document.addEventListener("pointerover", handlePointerMove, { passive: true });
  document.addEventListener("pointerout", handlePointerOut, { passive: true });
  document.documentElement.addEventListener("pointerleave", handleDocumentLeave);
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("dragstart", handleDragStart);
  document.addEventListener("dragend", handleDragEnd);
  document.addEventListener("drop", handleDragEnd);

  return {
    reconcile,
    setMenuOpen: (next) => {
      if (menuOpen === next) return;
      menuOpen = next;
      // A menu can close with the pointer outside the surface (for example after
      // choosing an item); give it the same aimed path back as the rail button.
      if (!next && current !== null && lastPointer !== null && !pointerInSurface) {
        aimAtSurface(lastPointer, null);
      }
      reconcile();
    },
    setFocusWithin: (next) => {
      if (focusWithin === next) return;
      focusWithin = next;
      reconcile();
    },
    close: () => {
      hovered = null;
      suppressed = true;
      closeNow();
    },
    dispose: () => {
      clearOpenTimer();
      clearCloseTimer();
      dropAim();
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerover", handlePointerMove);
      document.removeEventListener("pointerout", handlePointerOut);
      document.documentElement.removeEventListener("pointerleave", handleDocumentLeave);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("dragstart", handleDragStart);
      document.removeEventListener("dragend", handleDragEnd);
      document.removeEventListener("drop", handleDragEnd);
    },
  };
}
