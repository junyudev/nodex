import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { WORKBENCH_SURFACE_GUTTER_PX } from "@/lib/workbench-shell-geometry";
import {
  CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
  clampCodexSidebarWidth,
  shouldCollapseCodexSidebarResizeWidth,
} from "@/lib/codex-sidebar-auto-reveal";
import { useCodexSidebarMotionState } from "@/lib/codex-sidebar-motion";
import { useDistinctState } from "@/lib/use-distinct-state";
import {
  WORKBENCH_SIDEBAR_PEEK_SURFACE_ATTRIBUTE,
  createWorkbenchSidebarPeekController,
  type WorkbenchSidebarPeekArea,
  type WorkbenchSidebarPeekController,
} from "@/lib/workbench-sidebar-peek";
import type { SidebarResizePhase, SidebarResizeSurface } from "./workbench-session-sidebar";

interface WorkbenchSidebarChromeInput {
  readonly persistedCollapsed?: boolean;
  readonly persistedWidth?: number;
  readonly reducedMotion: boolean | null;
  readonly workbenchRootRef: RefObject<HTMLDivElement | null>;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly onWidthChange?: (width: number) => void;
}

/**
 * Owns transient sidebar geometry, persisted-state synchronization, and the
 * collapsed-sidebar hover peek. Pointer tracking lives in the peek controller,
 * outside React state, so editor gestures do not cause Workbench re-renders.
 */
export function useWorkbenchSidebarChrome({
  persistedCollapsed,
  persistedWidth,
  reducedMotion,
  workbenchRootRef,
  onCollapsedChange,
  onWidthChange,
}: WorkbenchSidebarChromeInput) {
  const [localSidebarCollapsed, setLocalSidebarCollapsed] = useState(false);
  const [localSidebarWidth, setLocalSidebarWidth] = useState(CODEX_SIDEBAR_WIDTH_DEFAULT_PX);
  const [peekArea, setPeekArea] = useDistinctState<WorkbenchSidebarPeekArea | null>(null);
  const [floatingSidebarResizing, setFloatingSidebarResizing] = useDistinctState(false);
  const [sidebarClickInFlight, setSidebarClickInFlight] = useState(false);
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const peekControllerRef = useRef<WorkbenchSidebarPeekController | null>(null);
  // The floating surface keeps its last destination through its exit animation.
  const [peekDestination, setPeekDestination] = useState<WorkbenchSidebarPeekArea | null>(null);
  const peekAvailabilityRef = useRef({ collapsed: false, animating: false });
  const pendingSidebarPersistedOpenRef = useRef<boolean | null>(null);

  const sidebarCollapsed = persistedCollapsed ?? localSidebarCollapsed;
  const storedSidebarWidth = persistedWidth ?? localSidebarWidth;
  const sidebarWidth = sidebarDragWidth ?? storedSidebarWidth;
  const motion = useCodexSidebarMotionState({
    initialOpen: !sidebarCollapsed,
    targetWidth: sidebarWidth,
    reducedMotion,
  });
  const sidebarOpen = motion.logicalOpen;
  const sidebarLogicalCollapsed = !sidebarOpen;
  const sidebarAnimating = motion.animating;

  const applySidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      if (onCollapsedChange) {
        onCollapsedChange(collapsed);
        return;
      }
      setLocalSidebarCollapsed(collapsed);
    },
    [onCollapsedChange],
  );

  const setSidebarCollapsed = useCallback(
    (
      collapsed: boolean,
      options: {
        animate?: boolean;
      } = {},
    ) => {
      const nextOpen = !collapsed;
      motion.setOpen(nextOpen, { animate: options.animate });
      peekControllerRef.current?.close();
      pendingSidebarPersistedOpenRef.current = nextOpen;
      applySidebarCollapsed(collapsed);
    },
    [applySidebarCollapsed, motion],
  );

  const applySidebarWidth = useCallback(
    (
      width: number,
      phase: SidebarResizePhase = "end",
      surface: SidebarResizeSurface = "inline",
    ) => {
      if (surface === "inline" && shouldCollapseCodexSidebarResizeWidth(width)) {
        setSidebarDragWidth(null);
        setSidebarCollapsed(true);
        return;
      }

      const requestedWidth =
        surface === "floating" && phase !== "reset" ? width + WORKBENCH_SURFACE_GUTTER_PX : width;
      const nextWidth = clampCodexSidebarWidth(requestedWidth);
      motion.setTargetWidth(nextWidth);
      if (phase === "live") {
        setSidebarDragWidth(nextWidth);
        return;
      }

      setSidebarDragWidth(null);
      if (onWidthChange) {
        onWidthChange(nextWidth);
        return;
      }
      setLocalSidebarWidth(nextWidth);
    },
    [motion, onWidthChange, setSidebarCollapsed],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed(motion.getOpen());
  }, [motion, setSidebarCollapsed]);

  const showRealSidebarFromFloatingPanel = useCallback(() => {
    setSidebarCollapsed(false, { animate: false });
  }, [setSidebarCollapsed]);

  useEffect(() => {
    const persistedOpen = !sidebarCollapsed;
    const pendingPersistedOpen = pendingSidebarPersistedOpenRef.current;
    if (pendingPersistedOpen !== null) {
      if (persistedOpen === pendingPersistedOpen) {
        pendingSidebarPersistedOpenRef.current = null;
        return;
      }
      if (motion.getOpen() === pendingPersistedOpen) return;
    }

    if (motion.getOpen() === persistedOpen) return;
    motion.setOpen(persistedOpen);
  }, [motion, sidebarCollapsed]);

  const getWindowZoom = useCallback(() => {
    const root = workbenchRootRef.current;
    if (!root) return 1;
    const raw = window.getComputedStyle(root).getPropertyValue("--codex-window-zoom");
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }, [workbenchRootRef]);

  useEffect(() => {
    const controller = createWorkbenchSidebarPeekController({
      document,
      isEnabled: () =>
        peekAvailabilityRef.current.collapsed && !peekAvailabilityRef.current.animating,
      onPeekChange: (area) => {
        setPeekArea(area);
        if (area !== null) setPeekDestination(area);
      },
    });
    peekControllerRef.current = controller;
    const syncFocusWithin = () => {
      const activeElement = document.activeElement;
      controller.setFocusWithin(
        activeElement instanceof Element &&
          activeElement.closest(`[${WORKBENCH_SIDEBAR_PEEK_SURFACE_ATTRIBUTE}]`) !== null,
      );
    };
    document.addEventListener("focusin", syncFocusWithin);
    document.addEventListener("focusout", syncFocusWithin);
    return () => {
      document.removeEventListener("focusin", syncFocusWithin);
      document.removeEventListener("focusout", syncFocusWithin);
      controller.dispose();
      peekControllerRef.current = null;
    };
  }, [setPeekArea]);

  useEffect(() => {
    peekAvailabilityRef.current = {
      collapsed: sidebarLogicalCollapsed,
      animating: sidebarAnimating,
    };
    peekControllerRef.current?.reconcile();
  }, [sidebarAnimating, sidebarLogicalCollapsed]);

  const setPeekMenuOpen = useCallback((open: boolean) => {
    peekControllerRef.current?.setMenuOpen(open);
  }, []);

  return {
    applySidebarWidth,
    floatingSidebarResizing,
    getWindowZoom,
    motion,
    peekArea,
    peekDestination,
    setFloatingSidebarResizing,
    setPeekMenuOpen,
    setSidebarCollapsed,
    setSidebarClickInFlight,
    showRealSidebarFromFloatingPanel,
    sidebarAnimating,
    sidebarClickInFlight,
    sidebarCollapsed,
    sidebarLogicalCollapsed,
    sidebarOpen,
    sidebarWidth,
    toggleSidebarCollapsed,
  };
}
