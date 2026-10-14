import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { WORKBENCH_NAVIGATION_RAIL_WIDTH_PX } from "@/lib/workbench-shell-geometry";
import {
  CODEX_SIDEBAR_POINTER_DEFAULT,
  CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
  clampCodexSidebarWidth,
  deriveCodexSidebarFloatingVisibility,
  normalizeCodexSidebarPointer,
  shouldCollapseCodexSidebarResizeWidth,
  shouldClearCodexSidebarHoverSuppression,
  shouldResetCodexSidebarPointerOnWindowMouseOut,
} from "@/lib/codex-sidebar-auto-reveal";
import { useCodexSidebarMotionState } from "@/lib/codex-sidebar-motion";
import { useDistinctState } from "@/lib/use-distinct-state";
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
 * document-level auto-reveal Adapter. Pointer coordinates remain outside React
 * state so editor gestures do not cause full Workbench re-renders.
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
  const [floatingSidebarVisible, setFloatingSidebarVisible, getFloatingSidebarVisible] =
    useDistinctState(false);
  const [floatingSidebarResizing, setFloatingSidebarResizing] = useDistinctState(false);
  const [sidebarHoverSuppressed, setSidebarHoverSuppressed] = useDistinctState(false);
  const [sidebarTriggerHovered, setSidebarTriggerHovered] = useDistinctState(false);
  const [sidebarClickInFlight, setSidebarClickInFlight] = useState(false);
  const [floatingSidebarFocusActive, setFloatingSidebarFocusActive] = useDistinctState(false);
  const [floatingSidebarHoverSurfaceActive, setFloatingSidebarHoverSurfaceActive] =
    useDistinctState(false);
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const sidebarPointerRef = useRef(CODEX_SIDEBAR_POINTER_DEFAULT);
  const sidebarVisibilityInputsRef = useRef({
    sidebarWidth: CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
    sidebarCollapsed: false,
    sidebarAnimating: false,
    floatingSidebarFocusActive: false,
    floatingSidebarHoverSurfaceActive: false,
    sidebarHoverSuppressed: false,
    sidebarTriggerHovered: false,
  });
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
        suppressHoverOpen?: boolean;
      } = {},
    ) => {
      const nextOpen = !collapsed;
      const motionResolution = motion.setOpen(nextOpen, {
        animate: options.animate,
        suppressHoverOpen: options.suppressHoverOpen,
      });
      setSidebarTriggerHovered(false);
      setSidebarHoverSuppressed(motionResolution.suppressHoverOpen);
      setFloatingSidebarVisible(false);
      pendingSidebarPersistedOpenRef.current = nextOpen;
      applySidebarCollapsed(collapsed);
    },
    [
      applySidebarCollapsed,
      motion,
      setFloatingSidebarVisible,
      setSidebarHoverSuppressed,
      setSidebarTriggerHovered,
    ],
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

      const nextWidth = clampCodexSidebarWidth(width);
      motion.setTargetWidth(nextWidth);
      if (surface === "floating") {
        setFloatingSidebarVisible(true);
      }
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
    [motion, onWidthChange, setFloatingSidebarVisible, setSidebarCollapsed],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed(motion.getOpen());
  }, [motion, setSidebarCollapsed]);

  const showRealSidebarFromFloatingPanel = useCallback(() => {
    setSidebarCollapsed(false, {
      animate: false,
      suppressHoverOpen: false,
    });
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

  useEffect(() => {
    if (sidebarLogicalCollapsed) return;
    setFloatingSidebarVisible(false);
    setSidebarHoverSuppressed(false);
  }, [setFloatingSidebarVisible, setSidebarHoverSuppressed, sidebarLogicalCollapsed]);

  const getWindowZoom = useCallback(() => {
    const root = workbenchRootRef.current;
    if (!root) return 1;
    const raw = window.getComputedStyle(root).getPropertyValue("--codex-window-zoom");
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }, [workbenchRootRef]);

  const recomputeFloatingSidebarVisibility = useCallback(
    (pointerX: number | null) => {
      const inputs = sidebarVisibilityInputsRef.current;
      const sidebarPointerX =
        pointerX === null || pointerX < WORKBENCH_NAVIGATION_RAIL_WIDTH_PX
          ? null
          : pointerX - WORKBENCH_NAVIGATION_RAIL_WIDTH_PX;
      if (inputs.sidebarHoverSuppressed) {
        if (
          !shouldClearCodexSidebarHoverSuppression({
            pointerX: sidebarPointerX,
            triggerHovered: inputs.sidebarTriggerHovered,
          })
        ) {
          setFloatingSidebarVisible(false);
          return;
        }
        setSidebarHoverSuppressed(false);
        return;
      }

      setFloatingSidebarVisible(
        deriveCodexSidebarFloatingVisibility({
          pointerX: sidebarPointerX,
          leftPanelWidthPx: inputs.sidebarWidth,
          sidebarOpen: !inputs.sidebarCollapsed,
          sidebarAnimating: inputs.sidebarAnimating,
          hoverSuppressed: false,
          focusOverride: inputs.floatingSidebarFocusActive,
          hoverSurfaceActive: inputs.floatingSidebarHoverSurfaceActive,
          currentlyVisible: getFloatingSidebarVisible(),
        }),
      );
    },
    [getFloatingSidebarVisible, setFloatingSidebarVisible, setSidebarHoverSuppressed],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const nextPointer = normalizeCodexSidebarPointer(
        {
          clientX: event.clientX,
          clientY: event.clientY,
          updatedAt: event.timeStamp || performance.now(),
        },
        sidebarPointerRef.current,
        getWindowZoom(),
      );
      sidebarPointerRef.current = nextPointer;
      recomputeFloatingSidebarVisibility(nextPointer.x);
    };

    const handleWindowMouseOut = (event: MouseEvent) => {
      if (
        !shouldResetCodexSidebarPointerOnWindowMouseOut({
          clientX: event.clientX,
          clientY: event.clientY,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          relatedTarget: event.relatedTarget,
        })
      )
        return;

      sidebarPointerRef.current = CODEX_SIDEBAR_POINTER_DEFAULT;
      recomputeFloatingSidebarVisibility(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("mouseout", handleWindowMouseOut, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("mouseout", handleWindowMouseOut, {
        capture: true,
      });
    };
  }, [getWindowZoom, recomputeFloatingSidebarVisibility]);

  useEffect(() => {
    const updateFloatingSidebarFocusActive = () => {
      const activeElement = document.activeElement;
      setFloatingSidebarFocusActive(
        activeElement instanceof HTMLElement &&
          Boolean(activeElement.closest('[data-sidebar-floating-focus-area="true"]')),
      );
    };

    document.addEventListener("focusin", updateFloatingSidebarFocusActive);
    document.addEventListener("focusout", updateFloatingSidebarFocusActive);
    updateFloatingSidebarFocusActive();
    return () => {
      document.removeEventListener("focusin", updateFloatingSidebarFocusActive);
      document.removeEventListener("focusout", updateFloatingSidebarFocusActive);
    };
  }, [setFloatingSidebarFocusActive]);

  useEffect(() => {
    sidebarVisibilityInputsRef.current = {
      sidebarWidth,
      sidebarCollapsed: sidebarLogicalCollapsed,
      sidebarAnimating,
      floatingSidebarFocusActive,
      floatingSidebarHoverSurfaceActive,
      sidebarHoverSuppressed,
      sidebarTriggerHovered,
    };
    recomputeFloatingSidebarVisibility(sidebarPointerRef.current.x);
  }, [
    floatingSidebarFocusActive,
    floatingSidebarHoverSurfaceActive,
    recomputeFloatingSidebarVisibility,
    sidebarAnimating,
    sidebarHoverSuppressed,
    sidebarLogicalCollapsed,
    sidebarTriggerHovered,
    sidebarWidth,
  ]);

  return {
    applySidebarWidth,
    floatingSidebarFocusActive,
    floatingSidebarHoverSurfaceActive,
    floatingSidebarResizing,
    floatingSidebarVisible,
    getWindowZoom,
    motion,
    setFloatingSidebarFocusActive,
    setFloatingSidebarHoverSurfaceActive,
    setFloatingSidebarResizing,
    setSidebarCollapsed,
    setSidebarClickInFlight,
    setSidebarHoverSuppressed,
    setSidebarTriggerHovered,
    showRealSidebarFromFloatingPanel,
    sidebarAnimating,
    sidebarClickInFlight,
    sidebarCollapsed,
    sidebarLogicalCollapsed,
    sidebarOpen,
    sidebarTriggerHovered,
    sidebarWidth,
    toggleSidebarCollapsed,
  };
}
