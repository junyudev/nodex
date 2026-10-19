import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  animate,
  AnimatePresence,
  motion,
  MotionConfig,
  useDragControls,
  useMotionValue,
  type MotionValue,
  type PanInfo,
} from "motion/react";
import {
  ActivitySpinnerIcon,
  ChatBubbleIcon,
  DragHandleDotsIcon,
  MinimizeIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_PX,
  RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_VAR,
  RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_PX,
  RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR,
} from "@/lib/right-panel-composer-overlay-reserve";
import { APP_SHELL_RIGHT_PANEL_COMPOSER_OVERLAY_LAYER_CLASS } from "@/lib/app-shell-layers";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import { RightPanelComposerPresentationProvider } from "@/features/local-conversation/view/right-panel-composer-presentation";
import type { WorkbenchComposerOverlayState } from "../../../shared/workbench-scene";
import { FloatingComposerHeaderSlotContext } from "./floating-composer-header-slot";
import {
  DEFAULT_FLOATING_COMPOSER_MINIMIZED_DOCK,
  FLOATING_COMPOSER_BUBBLE_SIZE_PX,
  FLOATING_COMPOSER_EDGE_PX,
  FLOATING_COMPOSER_FRAME_INSET_PX,
  FLOATING_COMPOSER_HEADER_HEIGHT_PX,
  FLOATING_COMPOSER_SURFACE_INSET_PX,
  clampFloatingComposerFrameWidth,
  isFloatingComposerPaneNarrow,
  isFloatingComposerPointerOnPaneEdge,
  isTopFloatingComposerDock,
  resolveFloatingComposerDockForRect,
  resolveFloatingComposerDockScaleOrigin,
  resolveFloatingComposerDragConstraints,
  resolveFloatingComposerDragTarget,
  resolveFloatingComposerExpandedHeight,
  resolveFloatingComposerExpandedHeightBounds,
  resolveFloatingComposerFrameWidth,
  resolveFloatingComposerResizeOffset,
  resolveMinimizedFloatingComposerDock,
  type FloatingComposerCornerDock,
  type FloatingComposerDock,
} from "./floating-composer-layout";
import { useFloatingComposerPreference } from "./floating-composer-preference";

export type FloatingComposerAttention = "none" | "activity" | "request";

/** A floating composer's placement: shown or minimized, where it rests, where its bubble rests. */
export type FloatingComposerState = WorkbenchComposerOverlayState;

/** A Scene-owned floating composer. */
export interface FloatingComposerControl {
  readonly state: FloatingComposerState;
  readonly attention: FloatingComposerAttention;
  readonly onStateChange: (patch: Partial<FloatingComposerState>) => void;
}

export interface FloatingComposerMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
}

/** How a pane hosts its floating composer. */
export interface FloatingComposerPlacement {
  readonly control?: FloatingComposerControl;
  /** Pane content scrolls clear of a bottom-docked composer. */
  readonly reserveContent?: boolean;
  /** Header title; a chat picker in the context rail stands in for it. */
  readonly title?: string;
  /** Placement actions offered by the move handle's menu, before `Minimize composer`. */
  readonly menuItems?: readonly FloatingComposerMenuItem[];
  /** Dropping the composer on the pane's leading edge returns the chat beside the content. */
  readonly onDropBesideContent?: () => void;
}

interface FloatingComposerProps extends FloatingComposerPlacement {
  /** The pane the composer floats over. */
  readonly target: HTMLElement | null;
  /** Content-owned status, combined with the Scene's. */
  readonly attention?: FloatingComposerAttention;
  /** Keeps the header open while the body has no composer to focus. */
  readonly headerPinned?: boolean;
  /** Conversation shown above the composer while expanded; without it the composer stays compact. */
  readonly transcript?: ReactNode;
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Notices stacked beside a compact composer, or beside its bubble while hovered. */
  readonly previews?: ReactNode;
  readonly children: ReactNode;
}

export interface FloatingComposerPortalGeometry {
  height: number;
  left: number;
  top: number;
  width: number;
  zoom: number;
  /** The pane's own toolbar strip, which top docks stay below. */
  toolbarHeight: number;
}

type DockApproach = "none" | "near" | "minimize";
type ResizeEdges = { readonly horizontal?: "left" | "right"; readonly vertical?: "top" | "bottom" };

const NO_MENU_ITEMS: readonly FloatingComposerMenuItem[] = [];
const SURFACE_RADIUS_PX = 22;
const BUBBLE_RADIUS_PX = FLOATING_COMPOSER_BUBBLE_SIZE_PX / 2;
const PRESENTATION_TRANSITION = { duration: 0.3, ease: [0.23, 1, 0.32, 1] } as const;
const DOCK_SPRING = { type: "spring", bounce: 0.16, duration: 0.42 } as const;
const INTERACTIVE_TARGET_SELECTOR =
  "button, a, input, textarea, select, label, [contenteditable='true'], [role='button'], [role='menuitem'], [role='separator']";
const COMPOSER_INPUT_SELECTOR = "[data-codex-composer='true']";
/** Portaled UI opened from inside the composer that still counts as the composer. */
const COMPOSER_FLOATING_UI_SELECTOR =
  "[data-slot='dropdown-content'], [data-slot='popover-content'], [role='menu'], [role='listbox'], [role='dialog'], [data-radix-popper-content-wrapper]";
const ATTENTION_LABELS: Record<Exclude<FloatingComposerAttention, "none">, string> = {
  activity: "Running",
  request: "Needs input",
};

/** The pane's box in the portal's CSS pixels. */
export function resolveFloatingComposerPortalGeometry({
  rect,
  zoom,
  toolbarHeight = 0,
}: {
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  zoom: number;
  toolbarHeight?: number;
}): FloatingComposerPortalGeometry {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const height = Math.max(0, rect.height) / safeZoom;
  return {
    height,
    left: rect.left / safeZoom,
    top: rect.top / safeZoom,
    width: rect.width / safeZoom,
    zoom: safeZoom,
    toolbarHeight: Math.min(Math.max(0, toolbarHeight), height),
  };
}

function readPixelProperty(target: HTMLElement, property: string): number | null {
  const view = target.ownerDocument.defaultView;
  if (!view) return null;
  const value = Number.parseFloat(view.getComputedStyle(target).getPropertyValue(property));
  return Number.isFinite(value) ? value : null;
}

function readWindowZoom(target: HTMLElement): number {
  const zoom = readPixelProperty(target, "--codex-window-zoom");
  return zoom !== null && zoom > 0 ? zoom : 1;
}

function findInlineCustomPropertyOwner(target: HTMLElement, property: string): HTMLElement | null {
  let current: HTMLElement | null = target;
  while (current) {
    if (current.style.getPropertyValue(property).trim()) return current;
    current = current.parentElement;
  }
  return null;
}

function mergeAttention(
  left: FloatingComposerAttention,
  right: FloatingComposerAttention,
): FloatingComposerAttention {
  if (left === "request" || right === "request") return "request";
  if (left === "activity" || right === "activity") return "activity";
  return "none";
}

/** Whether a React event comes from inside its handler's element rather than through a portal. */
function isDomDescendant(event: { currentTarget: Element; target: EventTarget }): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target);
}

/** Whether `target` belongs to the composer: inside its frame or in UI it opened. */
function isComposerOwnedTarget(target: EventTarget | null, frame: HTMLElement | null): boolean {
  if (!frame || !target || typeof (target as Node).nodeType !== "number") return false;
  if (frame.contains(target as Node)) return true;
  return target instanceof Element && target.closest(COMPOSER_FLOATING_UI_SELECTOR) !== null;
}

/** Keeps a body portal over the pane and publishes the pane's scroll reserve. */
function usePaneGeometry(target: HTMLElement | null, reservePx: number) {
  const [geometry, setGeometry] = useState<FloatingComposerPortalGeometry | null>(null);

  const syncGeometry = useEffectEvent(() => {
    if (!target) return;
    setGeometry(
      resolveFloatingComposerPortalGeometry({
        rect: target.getBoundingClientRect(),
        zoom: readWindowZoom(target),
        toolbarHeight: readPixelProperty(target, "--height-toolbar-pane") ?? 0,
      }),
    );
  });

  useLayoutEffect(() => {
    if (!target) return;
    target.style.setProperty(
      RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_VAR,
      `${RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_PX}px`,
    );
    target.style.setProperty(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR, `${reservePx}px`);
    syncGeometry();
    return () => {
      target.style.removeProperty(RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_VAR);
      target.style.removeProperty(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR);
    };
  }, [reservePx, target]);

  useLayoutEffect(() => {
    if (!target) return;
    const view = target.ownerDocument.defaultView;
    if (!view) return;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncGeometry);
    resizeObserver?.observe(target);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(syncGeometry);
    for (const owner of new Set(
      [
        findInlineCustomPropertyOwner(target, "--app-shell-bottom-panel-height"),
        findInlineCustomPropertyOwner(target, "--codex-window-zoom"),
      ].filter((candidate): candidate is HTMLElement => candidate !== null),
    )) {
      mutationObserver?.observe(owner, { attributes: true, attributeFilter: ["style"] });
    }
    view.addEventListener("resize", syncGeometry);
    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      view.removeEventListener("resize", syncGeometry);
    };
  }, [target]);

  return target ? geometry : null;
}

/**
 * Glides a dragged box into its new dock. `settle` records where the box was released; once the
 * dock change commits — synchronously or after its owner echoes it back — the offsets jump so the
 * box stays put, then spring home.
 */
function useDockSettle({
  dock,
  elementRef,
  offsetX,
  offsetY,
  zoom,
  reducedMotion,
}: {
  dock: FloatingComposerDock;
  elementRef: RefObject<HTMLElement | null>;
  offsetX: MotionValue<number>;
  offsetY: MotionValue<number>;
  zoom: number;
  reducedMotion: boolean;
}) {
  const releasedRef = useRef<{
    readonly from: FloatingComposerDock;
    readonly left: number;
    readonly top: number;
  } | null>(null);

  const springHome = () => {
    const transition = reducedMotion ? { duration: 0 } : DOCK_SPRING;
    void animate(offsetX, 0, transition);
    void animate(offsetY, 0, transition);
  };

  // Runs after every commit: the new dock may arrive in this commit or a later one.
  useLayoutEffect(() => {
    const released = releasedRef.current;
    if (!released || released.from === dock) return;
    releasedRef.current = null;
    const rect = elementRef.current?.getBoundingClientRect();
    if (rect) {
      offsetX.jump(offsetX.get() + (released.left - rect.left) / zoom);
      offsetY.jump(offsetY.get() + (released.top - rect.top) / zoom);
    }
    springHome();
  });

  return {
    settle(nextDock: FloatingComposerDock, commit: (dock: FloatingComposerDock) => void) {
      if (nextDock === dock) {
        springHome();
        return;
      }
      const rect = elementRef.current?.getBoundingClientRect();
      releasedRef.current = rect ? { from: dock, left: rect.left, top: rect.top } : null;
      commit(nextDock);
    },
    springHome,
  };
}

/** CSS anchoring for a box resting at `dock`, `inset` px from the pane edges. */
function dockAnchorStyle(dock: FloatingComposerDock, inset: number): CSSProperties {
  const vertical = isTopFloatingComposerDock(dock) ? { top: inset } : { bottom: inset };
  if (dock === "bottom-center") return { ...vertical, left: "50%", translate: "-50% 0" };
  return dock.endsWith("left") ? { ...vertical, left: inset } : { ...vertical, right: inset };
}

function HeaderIconButton({
  label,
  className,
  children,
  ...props
}: {
  label: string;
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"button">, "aria-label">) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "no-drag relative flex size-7 shrink-0 cursor-interaction items-center justify-center rounded-full text-token-description-foreground outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border data-[state=open]:bg-token-foreground/5",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function ResizeEdge({
  edges,
  label,
  onStart,
}: {
  edges: ResizeEdges;
  label?: string;
  onStart: (edges: ResizeEdges, event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { horizontal, vertical } = edges;
  if (horizontal && vertical) {
    const descending = (horizontal === "left") === (vertical === "top");
    return (
      <div
        aria-hidden="true"
        data-floating-composer-resize-corner={`${vertical}-${horizontal}`}
        className={cn(
          "group absolute z-50 flex size-4 touch-none select-none",
          vertical === "top" ? "-top-2" : "-bottom-2",
          horizontal === "left" ? "-left-2" : "-right-2",
          descending ? "cursor-nwse-resize" : "cursor-nesw-resize",
        )}
        onPointerDown={(event) => onStart(edges, event)}
      >
        <div
          className={cn(
            "pointer-events-none m-auto h-px w-2 bg-token-foreground/25 opacity-0 group-hover:opacity-100 group-active:opacity-100",
            descending ? "rotate-45" : "-rotate-45",
          )}
        />
      </div>
    );
  }
  const verticalStrip = horizontal !== undefined;
  return (
    <div
      role="separator"
      aria-orientation={verticalStrip ? "vertical" : "horizontal"}
      aria-label={label}
      className={cn(
        "group no-drag absolute z-40 flex touch-none select-none",
        verticalStrip
          ? cn("inset-y-0 w-4 cursor-col-resize", horizontal === "left" ? "-left-2" : "-right-2")
          : cn("inset-x-0 h-4 cursor-row-resize", vertical === "top" ? "-top-2" : "-bottom-2"),
      )}
      onPointerDown={(event) => onStart(edges, event)}
    >
      <div
        className={cn(
          "pointer-events-none m-auto opacity-0 group-hover:opacity-100 group-active:opacity-100",
          verticalStrip
            ? "h-full w-px bg-linear-to-b from-transparent via-token-foreground/25 to-transparent"
            : "h-px w-full bg-linear-to-r from-transparent via-token-foreground/25 to-transparent",
        )}
      />
    </div>
  );
}

/**
 * A composer that floats over a full-width pane. It rests in a dock, reveals its header while in
 * use, expands into its conversation, can be dragged to another dock, resized, and minimized to a
 * bubble that keeps its own corner.
 */
export function FloatingComposer({
  target,
  control,
  reserveContent = true,
  title,
  menuItems = NO_MENU_ITEMS,
  onDropBesideContent,
  attention: contentAttention = "none",
  headerPinned = false,
  transcript,
  expanded: expandedRequested = false,
  onExpandedChange,
  previews,
  children,
}: FloatingComposerProps) {
  const surfaceLayoutId = useId();
  const titleId = useId();
  const reducedMotion = useResolvedReducedMotion();
  const { preference, update: updatePreference } = useFloatingComposerPreference();
  const [localState, setLocalState] = useState<FloatingComposerState>({ visible: true });
  const state = control?.state ?? localState;
  const updateState = (patch: Partial<FloatingComposerState>) => {
    if (control) control.onStateChange(patch);
    else setLocalState((current) => ({ ...current, ...patch }));
  };
  const visible = state.visible;
  const attention = mergeAttention(control?.attention ?? "none", contentAttention);
  const hasTranscript = transcript !== undefined && transcript !== null && transcript !== false;
  const expanded = visible && hasTranscript && expandedRequested;

  const geometry = usePaneGeometry(
    target,
    visible && reserveContent && !isTopFloatingComposerDock(state.dock ?? preference.dock)
      ? RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_PX
      : 0,
  );
  const zoom = geometry?.zoom ?? 1;
  const paneWidth = geometry?.width ?? 0;
  // The float area excludes the pane's toolbar strip.
  const paneHeight = geometry ? geometry.height - geometry.toolbarHeight : 0;
  const pane = { width: paneWidth, height: paneHeight };
  const narrow = isFloatingComposerPaneNarrow(paneWidth);
  const dock: FloatingComposerDock = narrow ? "bottom-center" : (state.dock ?? preference.dock);
  const minimizedDock: FloatingComposerCornerDock =
    state.minimizedDock ?? DEFAULT_FLOATING_COMPOSER_MINIMIZED_DOCK;

  const paneRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const frameDragControls = useDragControls();
  const bubbleDragControls = useDragControls();
  const offsetX = useMotionValue(0);
  const offsetY = useMotionValue(0);
  const bubbleX = useMotionValue(0);
  const bubbleY = useMotionValue(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [bubbleDragging, setBubbleDragging] = useState(false);
  const [bubbleHovered, setBubbleHovered] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paneDropActive, setPaneDropActive] = useState(false);
  // Near a corner the frame shrinks slightly; with the pointer in the corner, release minimizes.
  const [dockApproach, setDockApproach] = useState<DockApproach>("none");
  const [liveSize, setLiveSize] = useState<{ width?: number; height?: number } | null>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  const [compactFrameHeight, setCompactFrameHeight] = useState(0);
  const draggedRef = useRef(false);
  const restoreFocusRef = useRef(false);

  const frameSettle = useDockSettle({
    dock,
    elementRef: frameRef,
    offsetX,
    offsetY,
    zoom,
    reducedMotion,
  });
  const bubbleSettle = useDockSettle({
    dock: minimizedDock,
    elementRef: bubbleRef,
    offsetX: bubbleX,
    offsetY: bubbleY,
    zoom,
    reducedMotion,
  });

  const frameWidth =
    liveSize?.width ?? resolveFloatingComposerFrameWidth(preference.width, paneWidth);
  const expandedHeight =
    liveSize?.height ??
    resolveFloatingComposerExpandedHeight(preference.height, paneHeight, compactFrameHeight);
  const chromeRevealed =
    expanded || headerPinned || composerFocused || dragging || resizing || menuOpen;

  const setDock = (next: FloatingComposerDock) => {
    updatePreference({ dock: next });
    updateState({ dock: next });
  };
  const setExpanded = (next: boolean) => {
    if (next === expanded || (next && !hasTranscript)) return;
    onExpandedChange?.(next);
  };

  const focusComposer = () => {
    requestAnimationFrame(() => {
      composerRef.current?.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)?.focus();
    });
  };

  // Measures the frame for its drag bounds; an expanded frame never ends shorter than its compact form.
  const frameMounted = visible && geometry !== null;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frameMounted || !frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setFrameHeight(frame.offsetHeight);
      if (!expanded) setCompactFrameHeight(frame.offsetHeight);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [expanded, frameMounted]);

  const collapseOnOutsidePointer = useEffectEvent((event: PointerEvent) => {
    if (!expanded || dragging || resizing) return;
    if (isComposerOwnedTarget(event.target, frameRef.current)) return;
    setExpanded(false);
  });

  useEffect(() => {
    if (!expanded) return;
    const ownerDocument = target?.ownerDocument ?? globalThis.document;
    ownerDocument?.addEventListener("pointerdown", collapseOnOutsidePointer, true);
    return () => ownerDocument?.removeEventListener("pointerdown", collapseOnOutsidePointer, true);
  }, [expanded, target]);

  useLayoutEffect(() => {
    if (visible || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const frame = requestAnimationFrame(() => bubbleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const toPanePoint = (point: { x: number; y: number }) => {
    const paneRect = paneRef.current?.getBoundingClientRect();
    // Drag points are already divided by the window zoom; pane rects are not.
    return {
      x: point.x - (paneRect?.left ?? 0) / zoom,
      y: point.y - (paneRect?.top ?? 0) / zoom,
    };
  };

  const readPaneRect = (element: HTMLElement | null) => {
    const pane = paneRef.current;
    if (!pane || !element) return null;
    const paneRect = pane.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      pane: { width: paneRect.width / zoom, height: paneRect.height / zoom },
      rect: {
        x: (rect.left - paneRect.left) / zoom,
        y: (rect.top - paneRect.top) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      },
    };
  };

  const minimize = (patch: Partial<FloatingComposerState> = {}) => {
    restoreFocusRef.current = frameRef.current?.contains(document.activeElement) ?? false;
    setComposerFocused(false);
    setMenuOpen(false);
    offsetX.jump(0);
    offsetY.jump(0);
    if (expanded) onExpandedChange?.(false);
    updateState({ ...patch, visible: false });
  };

  const restore = () => {
    setBubbleHovered(false);
    updateState({ visible: true });
    focusComposer();
  };

  const startFrameDrag = (event: ReactPointerEvent) => {
    if (narrow || event.button !== 0 || event.ctrlKey) return;
    draggedRef.current = false;
    frameDragControls.start(event, { snapToCursor: false });
  };

  const handleFramePointerDownCapture = (event: ReactPointerEvent<HTMLElement>) => {
    draggedRef.current = false;
    if (!(event.target instanceof Element)) return;
    // The header and, while compact, the frame's own margin move the composer.
    const fromHeader = event.target.closest("[data-floating-composer-drag-handle]") !== null;
    const fromFrameMargin = !expanded && event.target === event.currentTarget;
    if (!fromHeader && !fromFrameMargin) return;
    if (event.target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
    startFrameDrag(event);
  };

  const readDragTarget = (info: PanInfo) => {
    const metrics = readPaneRect(frameRef.current);
    if (!metrics) return null;
    const pointer = toPanePoint(info.point);
    return {
      pointer,
      ...resolveFloatingComposerDragTarget({ rect: metrics.rect, pane: metrics.pane, pointer }),
    };
  };

  const handleFrameDrag = (_event: PointerEvent, info: PanInfo) => {
    const dragTarget = readDragTarget(info);
    if (!dragTarget) return;
    setPaneDropActive(
      Boolean(onDropBesideContent) && isFloatingComposerPointerOnPaneEdge(dragTarget.pointer.x),
    );
    setDockApproach(dragTarget.minimize ? "minimize" : dragTarget.nearDock ? "near" : "none");
  };

  const handleFrameDragEnd = (_event: PointerEvent, info: PanInfo) => {
    setDragging(false);
    setDockApproach("none");
    setPaneDropActive(false);
    const dragTarget = readDragTarget(info);
    if (!dragTarget) return;
    if (onDropBesideContent && isFloatingComposerPointerOnPaneEdge(dragTarget.pointer.x)) {
      offsetX.jump(0);
      offsetY.jump(0);
      onDropBesideContent();
      return;
    }
    if (dragTarget.minimize) {
      minimize({ minimizedDock: resolveMinimizedFloatingComposerDock(dragTarget.dock) });
      return;
    }
    frameSettle.settle(dragTarget.dock, setDock);
  };

  const handleBubbleDragEnd = () => {
    setBubbleDragging(false);
    const metrics = readPaneRect(bubbleRef.current);
    if (!metrics) return;
    const nextDock = resolveMinimizedFloatingComposerDock(
      resolveFloatingComposerDockForRect(metrics.rect, metrics.pane, { minimized: true }),
    );
    bubbleSettle.settle(nextDock, (corner) =>
      updateState({ minimizedDock: resolveMinimizedFloatingComposerDock(corner) }),
    );
  };

  const cancelDrag = useEffectEvent(() => {
    frameDragControls.cancel();
    bubbleDragControls.cancel();
    setDragging(false);
    setBubbleDragging(false);
    setDockApproach("none");
    setPaneDropActive(false);
    frameSettle.springHome();
    bubbleSettle.springHome();
  });

  useEffect(() => {
    if (!dragging && !bubbleDragging) return;
    const view = target?.ownerDocument.defaultView;
    if (!view) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    };
    view.addEventListener("keydown", handleKeyDown, true);
    view.addEventListener("blur", cancelDrag);
    view.addEventListener("pointercancel", cancelDrag, true);
    return () => {
      view.removeEventListener("keydown", handleKeyDown, true);
      view.removeEventListener("blur", cancelDrag);
      view.removeEventListener("pointercancel", cancelDrag, true);
    };
  }, [bubbleDragging, dragging, target]);

  const startResize = (edges: ResizeEdges, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !geometry) return;
    event.preventDefault();
    event.stopPropagation();
    const view = event.currentTarget.ownerDocument.defaultView;
    if (!view) return;
    const pointerId = event.pointerId;
    const startPointer = { x: event.clientX / zoom, y: event.clientY / zoom };
    const startWidth = frameWidth;
    const startHeight = expandedHeight;
    const startOffset = offsetX.get();
    const heightBounds = resolveFloatingComposerExpandedHeightBounds(
      paneHeight,
      compactFrameHeight,
    );
    let size: { width?: number; height?: number } = {};
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const next: { width?: number; height?: number } = {};
      if (edges.horizontal) {
        const delta = moveEvent.clientX / zoom - startPointer.x;
        next.width = clampFloatingComposerFrameWidth(
          startWidth + (edges.horizontal === "left" ? -delta : delta),
          paneWidth,
        );
        offsetX.set(
          resolveFloatingComposerResizeOffset({
            dock,
            edge: edges.horizontal,
            startWidth,
            startOffset,
            width: next.width,
            pane,
            height: startHeight,
          }),
        );
      }
      if (edges.vertical) {
        const delta = moveEvent.clientY / zoom - startPointer.y;
        next.height = Math.min(
          Math.max(startHeight + (edges.vertical === "top" ? -delta : delta), heightBounds.minimum),
          heightBounds.maximum,
        );
      }
      size = next;
      setLiveSize(next);
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      view.removeEventListener("pointermove", onMove, true);
      view.removeEventListener("pointerup", onEnd, true);
      view.removeEventListener("pointercancel", onEnd, true);
      setResizing(false);
      const patch: { width?: number; height?: number } = {};
      if (size.width !== undefined && size.width !== startWidth) {
        patch.width = size.width - 2 * FLOATING_COMPOSER_SURFACE_INSET_PX;
      }
      if (size.height !== undefined && size.height !== startHeight) patch.height = size.height;
      if (patch.width !== undefined || patch.height !== undefined) updatePreference(patch);
      setLiveSize(null);
      frameSettle.springHome();
    };
    view.addEventListener("pointermove", onMove, true);
    view.addEventListener("pointerup", onEnd, true);
    view.addEventListener("pointercancel", onEnd, true);
  };

  const handleFocusCapture = (event: ReactFocusEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest(COMPOSER_INPUT_SELECTOR)) {
      setComposerFocused(true);
    }
  };

  const handleBlurCapture = (event: ReactFocusEvent<HTMLElement>) => {
    const frame = event.currentTarget;
    if (isComposerOwnedTarget(event.relatedTarget, frame)) return;
    if (event.relatedTarget === null) {
      // Focus left the window or landed nowhere; keep the header while focus is still ours.
      queueMicrotask(() => {
        const ownerDocument = frame.ownerDocument;
        if (
          !ownerDocument.hasFocus() ||
          !isComposerOwnedTarget(ownerDocument.activeElement, frame)
        ) {
          setComposerFocused(false);
        }
      });
      return;
    }
    setComposerFocused(false);
    if (expanded) setExpanded(false);
  };

  const handleFrameKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      !expanded ||
      !isDomDescendant(event) ||
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.repeat ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
  };

  // On the frame: the context rail is portaled into the header, so its clicks bubble through the
  // composer rather than the header row.
  const handleFrameClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!hasTranscript || draggedRef.current || event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element) || !isDomDescendant(event)) return;
    if (!target.closest("[data-floating-composer-header]")) return;
    if (target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
    setExpanded(!expanded);
  };

  if (!target || !geometry) return null;

  // Numeric bounds: motion re-fits ref bounds on every resize, which would halt the glide home.
  const frameDragConstraints = resolveFloatingComposerDragConstraints({
    dock,
    box: { width: frameWidth, height: expanded ? expandedHeight : frameHeight },
    pane,
    inset: FLOATING_COMPOSER_FRAME_INSET_PX,
  });
  const bubbleDragConstraints = resolveFloatingComposerDragConstraints({
    dock: minimizedDock,
    box: { width: FLOATING_COMPOSER_BUBBLE_SIZE_PX, height: FLOATING_COMPOSER_BUBBLE_SIZE_PX },
    pane,
    inset: FLOATING_COMPOSER_EDGE_PX,
  });
  const portalStyle: CSSProperties = {
    height: geometry.height,
    left: geometry.left,
    top: geometry.top,
    width: geometry.width,
    zoom: geometry.zoom,
  };
  const presenceTransition = reducedMotion ? { duration: 0 } : PRESENTATION_TRANSITION;
  const exitTransition = { duration: reducedMotion ? 0 : 0.12 };
  const attentionLabel = attention === "none" ? null : ATTENTION_LABELS[attention];
  const dockedTop = isTopFloatingComposerDock(dock);
  const bubbleDockedTop = isTopFloatingComposerDock(minimizedDock);
  const verticalResizeEdge = dockedTop ? "bottom" : "top";
  const showPreviews = Boolean(previews) && visible && !expanded && !dragging;
  const showBubblePreviews = Boolean(previews) && !visible && bubbleHovered && !bubbleDragging;
  const surfaceChromeClass =
    "composer-surface-chrome pointer-events-none absolute bg-token-input-background/90 backdrop-blur-lg electron:dark:bg-token-dropdown-background";

  const status =
    attention === "none" ? null : (
      <span
        role="status"
        aria-label={attentionLabel ?? undefined}
        className="flex size-7 shrink-0 items-center justify-center text-token-description-foreground"
      >
        {attention === "activity" ? (
          <ActivitySpinnerIcon className="icon-sm" />
        ) : (
          <span className="size-2 rounded-full bg-token-charts-blue" />
        )}
      </span>
    );

  const header = (
    <motion.header
      data-floating-composer-drag-handle="true"
      aria-hidden={!chromeRevealed || undefined}
      inert={!chromeRevealed}
      className="relative min-h-0 shrink-0 overflow-hidden"
      initial={false}
      animate={{
        height: chromeRevealed ? FLOATING_COMPOSER_HEADER_HEIGHT_PX : 0,
        opacity: chromeRevealed ? 1 : 0,
      }}
      transition={presenceTransition}
    >
      {hasTranscript ? (
        <button
          type="button"
          aria-label={expanded ? "Collapse composer" : "Expand composer"}
          aria-expanded={expanded}
          className="pointer-events-none absolute inset-0 rounded-[inherit] focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset"
          onClick={() => setExpanded(!expanded)}
        />
      ) : null}
      <div
        data-floating-composer-header="true"
        className={cn(
          "flex h-[46px] min-w-0 touch-none items-center justify-between gap-1 select-none",
          expanded ? "px-1.5" : "border-b border-token-border px-2",
          hasTranscript ? (expanded ? "cursor-s-resize" : "cursor-n-resize") : "cursor-interaction",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <NodexTooltip tooltipContent="Minimize" side="top" delayOpen>
            <HeaderIconButton label="Minimize composer" onClick={() => minimize()}>
              <MinimizeIcon className="icon-sm" />
            </HeaderIconButton>
          </NodexTooltip>
          {status}
          {title ? (
            <h2
              id={titleId}
              className="max-w-80 min-w-0 shrink truncate px-1 text-base font-medium text-token-description-foreground"
            >
              {title}
            </h2>
          ) : null}
          <div
            ref={setHeaderSlot}
            data-floating-composer-header-slot="true"
            className="flex min-w-0 flex-1 items-center gap-1"
          />
        </div>
        {/* Events from the portaled menu bubble through here in React; only the handle's own count. */}
        <span
          className="contents"
          onPointerDownCapture={(event) => {
            if (event.button !== 0 || !isDomDescendant(event)) return;
            event.preventDefault();
            event.stopPropagation();
            draggedRef.current = false;
            startFrameDrag(event);
          }}
          onClickCapture={(event) => {
            if (!isDomDescendant(event)) return;
            event.preventDefault();
            event.stopPropagation();
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            setMenuOpen((open) => !open);
          }}
        >
          <NodexDropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
            side={dockedTop ? "bottom" : "top"}
            contentWidth="menu"
            triggerTooltipContent={
              menuOpen || dragging
                ? undefined
                : narrow
                  ? "Composer options"
                  : "Drag to move · Click for options"
            }
            triggerButton={
              <HeaderIconButton
                label="Move composer"
                className={narrow ? undefined : "cursor-grab active:cursor-grabbing"}
              >
                <DragHandleDotsIcon className="icon-sm" />
              </HeaderIconButton>
            }
          >
            {menuItems.map((item) => (
              <NodexDropdownItem key={item.id} leftSlot={item.icon} onSelect={item.onSelect}>
                {item.label}
              </NodexDropdownItem>
            ))}
            {menuItems.length > 0 ? <NodexDropdownSeparator /> : null}
            <NodexDropdownItem leftSlot={<MinimizeIcon />} onSelect={() => minimize()}>
              Minimize composer
            </NodexDropdownItem>
          </NodexDropdownMenu>
        </span>
      </div>
    </motion.header>
  );

  const frame = (
    <motion.section
      key="frame"
      ref={frameRef}
      role="region"
      aria-label={title ? undefined : "Composer"}
      aria-labelledby={title ? titleId : undefined}
      tabIndex={-1}
      data-floating-composer-frame="true"
      data-floating-composer-dock={dock}
      data-floating-composer-presentation={expanded ? "expanded" : "compact"}
      data-floating-composer-chrome={chromeRevealed ? "revealed" : "hidden"}
      className="pointer-events-auto absolute flex flex-col outline-none"
      style={{
        ...dockAnchorStyle(dock, FLOATING_COMPOSER_FRAME_INSET_PX),
        ...resolveFloatingComposerDockScaleOrigin(dock),
        width: frameWidth,
        x: offsetX,
        y: offsetY,
      }}
      initial={{ opacity: 0 }}
      animate={{
        opacity: dockApproach === "minimize" ? 0.6 : 1,
        scale: dockApproach === "none" ? 1 : 0.95,
        height: expanded ? expandedHeight : "auto",
      }}
      exit={{ opacity: 0, transition: exitTransition }}
      transition={{
        ...presenceTransition,
        height: resizing ? { duration: 0 } : presenceTransition,
      }}
      drag={!narrow}
      dragControls={frameDragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={frameDragConstraints}
      onDragStart={() => {
        draggedRef.current = true;
        setMenuOpen(false);
        setDragging(true);
      }}
      onDrag={handleFrameDrag}
      onDragEnd={handleFrameDragEnd}
      onPointerDownCapture={handleFramePointerDownCapture}
      onClickCapture={(event) => {
        if (!draggedRef.current || event.detail === 0) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleFrameClick}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      onKeyDown={handleFrameKeyDown}
    >
      {showPreviews ? (
        <div
          data-floating-composer-previews="true"
          className={cn(
            "absolute flex max-h-[min(22rem,50vh)] flex-col gap-3 overflow-y-auto overscroll-contain",
            dockedTop ? "top-full pt-3" : "bottom-full pb-3",
          )}
          style={{
            left: FLOATING_COMPOSER_SURFACE_INSET_PX,
            right: FLOATING_COMPOSER_SURFACE_INSET_PX,
          }}
        >
          {previews}
        </div>
      ) : null}
      <motion.div
        layoutId={surfaceLayoutId}
        aria-hidden="true"
        className={surfaceChromeClass}
        style={{
          borderRadius: SURFACE_RADIUS_PX,
          top: 0,
          right: FLOATING_COMPOSER_SURFACE_INSET_PX,
          bottom: FLOATING_COMPOSER_SURFACE_INSET_PX,
          left: FLOATING_COMPOSER_SURFACE_INSET_PX,
        }}
        transition={presenceTransition}
      />
      <ResizeEdge
        edges={{ horizontal: "left" }}
        label="Resize composer width"
        onStart={startResize}
      />
      <ResizeEdge
        edges={{ horizontal: "right" }}
        label="Resize composer width"
        onStart={startResize}
      />
      {expanded ? (
        <>
          <ResizeEdge
            edges={{ vertical: verticalResizeEdge }}
            label="Resize composer height"
            onStart={startResize}
          />
          <ResizeEdge
            edges={{ horizontal: "left", vertical: verticalResizeEdge }}
            onStart={startResize}
          />
          <ResizeEdge
            edges={{ horizontal: "right", vertical: verticalResizeEdge }}
            onStart={startResize}
          />
        </>
      ) : null}
      <div
        className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", !expanded && "justify-end")}
        style={{
          marginInline: FLOATING_COMPOSER_SURFACE_INSET_PX,
          marginBottom: FLOATING_COMPOSER_SURFACE_INSET_PX,
        }}
      >
        {header}
        {expanded ? (
          <div data-floating-composer-transcript="true" className="flex min-h-0 flex-1 flex-col">
            {transcript}
          </div>
        ) : null}
        {expanded ? <div aria-hidden="true" className="border-t border-token-border" /> : null}
        <div ref={composerRef} className="mt-auto shrink-0 py-1">
          <FloatingComposerHeaderSlotContext.Provider value={headerSlot}>
            <RightPanelComposerPresentationProvider visible>
              {children}
            </RightPanelComposerPresentationProvider>
          </FloatingComposerHeaderSlotContext.Provider>
        </div>
      </div>
    </motion.section>
  );

  const bubble = (
    <motion.button
      key="bubble"
      ref={bubbleRef}
      type="button"
      aria-label="Restore composer"
      aria-description={attentionLabel ?? undefined}
      data-floating-composer-bubble="true"
      data-floating-composer-dock={minimizedDock}
      className="pointer-events-auto absolute flex cursor-interaction touch-none items-center justify-center text-token-description-foreground outline-none hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border"
      style={{
        ...dockAnchorStyle(minimizedDock, FLOATING_COMPOSER_EDGE_PX),
        borderRadius: BUBBLE_RADIUS_PX,
        width: FLOATING_COMPOSER_BUBBLE_SIZE_PX,
        height: FLOATING_COMPOSER_BUBBLE_SIZE_PX,
        x: bubbleX,
        y: bubbleY,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: exitTransition }}
      transition={presenceTransition}
      drag={!narrow}
      dragControls={bubbleDragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={bubbleDragConstraints}
      onDragStart={() => {
        draggedRef.current = true;
        setBubbleDragging(true);
      }}
      onDragEnd={handleBubbleDragEnd}
      onPointerDown={(event) => {
        draggedRef.current = false;
        if (narrow || event.button !== 0) return;
        bubbleDragControls.start(event, { snapToCursor: false });
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setBubbleHovered(true);
      }}
      onKeyDown={(event) => {
        if (!previews || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        setBubbleHovered(true);
        requestAnimationFrame(() =>
          paneRef.current
            ?.querySelector<HTMLElement>("[data-floating-composer-bubble-previews] button")
            ?.focus(),
        );
      }}
      onClick={(event) => {
        if (event.detail !== 0 && draggedRef.current) return;
        restore();
      }}
    >
      <motion.span
        layoutId={surfaceLayoutId}
        aria-hidden="true"
        className={cn(surfaceChromeClass, "inset-0")}
        style={{ borderRadius: BUBBLE_RADIUS_PX }}
        transition={presenceTransition}
      />
      <span className="relative flex items-center justify-center">
        {attention === "activity" ? (
          <ActivitySpinnerIcon className="icon-sm" />
        ) : (
          <ChatBubbleIcon className="icon-sm" />
        )}
        {attention === "request" ? (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-token-charts-blue ring-2 ring-token-input-background"
          />
        ) : null}
      </span>
    </motion.button>
  );

  const bubbleOffset = FLOATING_COMPOSER_EDGE_PX + FLOATING_COMPOSER_BUBBLE_SIZE_PX;
  const bubblePreviews = showBubblePreviews ? (
    <div
      data-floating-composer-bubble-previews="true"
      className={cn(
        "pointer-events-auto absolute flex w-80 max-w-[calc(100%-2rem)] flex-col gap-3",
        bubbleDockedTop ? "pt-3" : "pb-3",
      )}
      style={{
        ...(bubbleDockedTop ? { top: bubbleOffset } : { bottom: bubbleOffset }),
        ...(minimizedDock.endsWith("left")
          ? { left: FLOATING_COMPOSER_EDGE_PX }
          : { right: FLOATING_COMPOSER_EDGE_PX }),
      }}
      onClickCapture={() => setBubbleHovered(false)}
    >
      {previews}
    </div>
  ) : null;

  const overlay = (
    <div
      data-testid="right-panel-composer-overlay-host"
      data-overlay-attention={attention}
      className={cn(
        "pointer-events-none fixed",
        APP_SHELL_RIGHT_PANEL_COMPOSER_OVERLAY_LAYER_CLASS,
      )}
      style={portalStyle}
    >
      <MotionConfig transformPagePoint={(point) => ({ x: point.x / zoom, y: point.y / zoom })}>
        <div
          ref={paneRef}
          data-testid="right-panel-composer-overlay"
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{ top: geometry.toolbarHeight }}
          onPointerLeave={() => setBubbleHovered(false)}
        >
          {paneDropActive ? (
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-2 left-2 w-1/3 rounded-2xl bg-token-charts-blue/10 ring-1 ring-token-charts-blue/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            />
          ) : null}
          <AnimatePresence initial={false}>{visible ? frame : bubble}</AnimatePresence>
          {bubblePreviews}
        </div>
      </MotionConfig>
    </div>
  );

  return createPortal(overlay, target.ownerDocument.body);
}
