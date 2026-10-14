import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { motion, type MotionValue } from "motion/react";
import {
  CODEX_SIDEBAR_FLOATING_ASIDE_CLASS,
  CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
} from "@/lib/codex-sidebar-auto-reveal";
import { cn } from "@/lib/utils";

export type SidebarResizePhase = "live" | "end" | "reset";
export type SidebarResizeSurface = "inline" | "floating";

export interface WorkbenchSidebarFrameProps {
  children: ReactNode;
  floating?: boolean;
  header?: ReactNode;
  width: number;
  animatedWidth?: MotionValue<number>;
  contentOpacity?: MotionValue<number>;
  resizeDisabled?: boolean;
  getWindowZoom?: () => number;
  onResizeWidth: (
    width: number,
    phase?: SidebarResizePhase,
    surface?: SidebarResizeSurface,
  ) => void;
  onResizeActiveChange?: (active: boolean) => void;
  testId?: string;
}

/** Shared placement and resize chrome for each contextual sidebar destination. */
export function WorkbenchSidebarFrame({
  children,
  floating = false,
  header,
  width,
  animatedWidth,
  contentOpacity,
  resizeDisabled = false,
  getWindowZoom,
  onResizeWidth,
  onResizeActiveChange,
  testId = "workbench-sidebar",
}: WorkbenchSidebarFrameProps) {
  const [resizing, setResizing] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeSurface: SidebarResizeSurface = floating ? "floating" : "inline";

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const setResizeActive = (active: boolean) => {
    setResizing(active);
    onResizeActiveChange?.(active);
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeDisabled || event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const resolveZoom = getWindowZoom ?? (() => 1);
    const startX = event.clientX / resolveZoom();
    const startWidth = width;
    const pointerId = event.pointerId;
    let lastWidth = startWidth;
    let didMove = false;

    setResizeActive(true);

    const resolveNextWidth = (nextEvent: PointerEvent) =>
      startWidth + (nextEvent.clientX / resolveZoom() - startX);

    function stopResize() {
      resizeCleanupRef.current = null;
      setResizeActive(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    }

    function onPointerMove(nextEvent: PointerEvent) {
      if (nextEvent.pointerId !== pointerId) return;
      nextEvent.preventDefault();
      didMove = didMove || nextEvent.clientX / resolveZoom() !== startX;
      lastWidth = resolveNextWidth(nextEvent);
      onResizeWidth(lastWidth, "live", resizeSurface);
    }

    function onPointerUp(nextEvent: PointerEvent) {
      if (nextEvent.pointerId !== pointerId) return;
      nextEvent.preventDefault();
      if (didMove) onResizeWidth(resolveNextWidth(nextEvent), "end", resizeSurface);
      stopResize();
    }

    function onPointerCancel(nextEvent: PointerEvent) {
      if (nextEvent.pointerId !== pointerId) return;
      if (didMove) onResizeWidth(lastWidth, "end", resizeSurface);
      stopResize();
    }

    resizeCleanupRef.current = stopResize;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const handleResizeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (resizeDisabled || event.detail !== 2) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    setResizeActive(false);
    onResizeWidth(CODEX_SIDEBAR_WIDTH_DEFAULT_PX, "reset", resizeSurface);
  };

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-disabled={resizeDisabled || undefined}
      onClick={handleResizeClick}
      onPointerDown={handleResizePointerDown}
      data-testid="sidebar-resize-strip"
      className={cn(
        "group absolute flex touch-none select-none z-20 -top-toolbar right-0 bottom-0 w-4 translate-x-2",
        resizeDisabled ? "pointer-events-none" : "cursor-col-resize active:cursor-col-resize",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "sidebar-resize-handle-line pointer-events-none m-auto opacity-0",
          "h-full w-px bg-gradient-to-b from-transparent via-token-foreground/25 to-transparent",
          resizing ? "opacity-100" : "group-hover:opacity-100 group-active:opacity-100",
        )}
      />
    </div>
  );

  const sidebar = (
    <motion.aside
      className={cn(
        floating
          ? CODEX_SIDEBAR_FLOATING_ASIDE_CLASS
          : "app-shell-left-panel pointer-events-auto relative flex h-full min-h-0 shrink-0 flex-col overflow-visible browser:bg-token-main-surface-primary",
        resizing && "cursor-col-resize",
        "font-sans text-sm",
      )}
      style={{
        width: floating ? width : (animatedWidth ?? width),
        ...(!floating ? { paddingTop: "var(--height-toolbar)" } : {}),
      }}
      data-testid={floating ? "app-shell-floating-left-panel" : testId}
    >
      {header}
      <motion.div
        className="max-w-full min-h-0 flex-1 overflow-hidden"
        style={{ minWidth: width, width, opacity: floating ? undefined : contentOpacity }}
      >
        {children}
      </motion.div>
      {!floating ? resizeHandle : null}
    </motion.aside>
  );

  if (!floating) return sidebar;

  return (
    <>
      {sidebar}
      {resizeHandle}
    </>
  );
}
