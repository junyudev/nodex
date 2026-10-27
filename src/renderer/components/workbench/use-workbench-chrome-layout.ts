import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import {
  normalizeWorkbenchWindowZoom,
  resolveWorkbenchHeaderSafeInsets,
} from "../../../shared/workbench-window-chrome";
import {
  WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
  WORKBENCH_SURFACE_GUTTER_PX,
} from "@/lib/workbench-shell-geometry";
import { useMotionValue, useTransform, type MotionValue } from "motion/react";
import {
  CODEX_SHELL_MEDIUM_WIDTH_PX,
  CODEX_SHELL_NARROW_WIDTH_PX,
  resolveCodexAnimatedPanelSize,
  resolveCodexHeaderEdgeScroll,
  resolveCodexMainContentTargetWidth,
  resolveCodexSummaryPanelLayoutMode,
  useCodexAnimatedPanelState,
} from "@/lib/codex-panel-motion";
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  RIGHT_PANEL_DEFAULT_WIDTH,
  clampBottomPanelHeight,
  clampRegularRightPanelWidth,
} from "@/lib/use-workbench-chrome-commands";
import {
  useElementSizeMotionValues,
  useMotionValueState,
  useSyncedMotionValue,
} from "@/lib/resize-observer-motion-values";

const LEFT_HEADER_COLLAPSED_RAIL_FALLBACK_WIDTH_PX = 126;

export type CodexShellWidthClass = "narrow" | "medium" | "wide";

interface SidebarMotion {
  readonly animatedWidth: MotionValue<number>;
  readonly mounted: boolean;
  readonly targetWidth: MotionValue<number>;
}

interface WorkbenchChromeLayoutInput {
  readonly activeSessionId: string | null;
  readonly destinationRouteOpen: boolean;
  readonly bottomPanelOpen: boolean;
  readonly bottomPanelRequestedHeight: number | null;
  readonly headerLeftWidth: number;
  readonly isMacPlatform: boolean;
  readonly reducedMotion: boolean | null;
  readonly rightPanelFullWidth: boolean;
  readonly rightPanelOpen: boolean;
  readonly rightPanelRequestedWidth: number | null;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly sidebarLogicalCollapsed: boolean;
  readonly sidebarMotion: SidebarMotion;
  readonly sidebarOpen: boolean;
}

function resolveShellWidthClass(width: number): CodexShellWidthClass {
  if (width <= CODEX_SHELL_NARROW_WIDTH_PX) return "narrow";
  if (width <= CODEX_SHELL_MEDIUM_WIDTH_PX) return "medium";
  return "wide";
}

function readWindowZoom(root: HTMLElement | null): number {
  const rawZoom = root ? window.getComputedStyle(root).getPropertyValue("--codex-window-zoom") : "";
  const parsedZoom = Number.parseFloat(rawZoom);
  return normalizeWorkbenchWindowZoom(parsedZoom);
}

function readRootFontSize(): number {
  if (typeof window === "undefined") return 16;
  const parsedFontSize = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize : 16;
}

/**
 * Owns Workbench DOM measurement and animation state. Pointer commands consume
 * its MotionValues, while React consumers only observe settled layout modes.
 */
export function useWorkbenchChromeLayout({
  activeSessionId,
  destinationRouteOpen,
  bottomPanelOpen,
  bottomPanelRequestedHeight: persistedBottomPanelHeight,
  headerLeftWidth,
  isMacPlatform,
  reducedMotion,
  rightPanelFullWidth,
  rightPanelOpen,
  rightPanelRequestedWidth: persistedRightPanelWidth,
  rootRef,
  sidebarLogicalCollapsed,
  sidebarMotion,
  sidebarOpen,
}: WorkbenchChromeLayoutInput) {
  const readShellBodyFallbackSize = useCallback(() => {
    if (typeof window === "undefined") {
      return { height: 0, width: 0 };
    }
    const windowZoom = readWindowZoom(rootRef.current);
    return {
      height: Math.max(
        0,
        window.innerHeight / windowZoom -
          WORKBENCH_TITLEBAR_HEIGHT_PX -
          WORKBENCH_SURFACE_GUTTER_PX,
      ),
      width: Math.max(
        0,
        window.innerWidth / windowZoom -
          WORKBENCH_NAVIGATION_RAIL_WIDTH_PX -
          WORKBENCH_SURFACE_GUTTER_PX,
      ),
    };
  }, [rootRef]);
  const initialShellBodySize = readShellBodyFallbackSize();
  const shellBodySize = useElementSizeMotionValues({
    initialHeight: initialShellBodySize.height,
    initialWidth: initialShellBodySize.width,
    readFallbackSize: readShellBodyFallbackSize,
  });
  const rootFontSize = useMotionValue(readRootFontSize());
  const [windowZoom, setWindowZoom] = useState(1);
  const rightPanelRequestedWidth = useMotionValue(
    persistedRightPanelWidth ?? RIGHT_PANEL_DEFAULT_WIDTH,
  );
  const bottomPanelRequestedHeight = useMotionValue(
    persistedBottomPanelHeight ?? BOTTOM_PANEL_DEFAULT_HEIGHT,
  );

  useLayoutEffect(() => {
    rightPanelRequestedWidth.set(persistedRightPanelWidth ?? RIGHT_PANEL_DEFAULT_WIDTH);
  }, [activeSessionId, persistedRightPanelWidth, rightPanelRequestedWidth]);

  useLayoutEffect(() => {
    bottomPanelRequestedHeight.set(persistedBottomPanelHeight ?? BOTTOM_PANEL_DEFAULT_HEIGHT);
  }, [activeSessionId, bottomPanelRequestedHeight, persistedBottomPanelHeight]);

  useEffect(() => {
    const measure = () => {
      rootFontSize.set(readRootFontSize());
      setWindowZoom(
        readWindowZoom(rootRef.current) *
          normalizeWorkbenchWindowZoom(window.api?.getWindowZoomFactor?.() ?? 1),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [rootFontSize, rootRef]);

  const rightPanelFullWidthValue = useSyncedMotionValue(rightPanelFullWidth ? 1 : 0);
  const rightPanelOpenValue = useSyncedMotionValue(rightPanelOpen ? 1 : 0);
  const sidebarOpenValue = useSyncedMotionValue(sidebarOpen ? 1 : 0);
  const activeSessionValue = useSyncedMotionValue(activeSessionId ? 1 : 0);
  const shellMainContentWidth = useTransform(
    [shellBodySize.width, sidebarMotion.targetWidth, sidebarOpenValue],
    ([latestShellWidth, latestSidebarWidth, latestSidebarOpen]) =>
      Math.max(
        0,
        Number(latestShellWidth) - (Number(latestSidebarOpen) > 0 ? Number(latestSidebarWidth) : 0),
      ),
  );
  const regularRightPanelWidth = useTransform(
    [rightPanelRequestedWidth, shellMainContentWidth],
    ([latestRequestedWidth, latestSizingWidth]) =>
      clampRegularRightPanelWidth(Number(latestRequestedWidth), Number(latestSizingWidth)),
  );
  const bottomPanelHeight = useTransform(
    [bottomPanelRequestedHeight, shellBodySize.height],
    ([latestRequestedHeight, latestShellHeight]) =>
      clampBottomPanelHeight(Number(latestRequestedHeight), Number(latestShellHeight)),
  );
  const rightPanelTargetWidth = useTransform(
    [shellMainContentWidth, regularRightPanelWidth, rightPanelFullWidthValue],
    ([latestSizingWidth, latestRegularWidth, latestFullWidth]) =>
      Number(latestFullWidth) > 0
        ? Math.max(Number(latestSizingWidth), Number(latestRegularWidth))
        : Number(latestRegularWidth),
  );
  const rightPanelMotion = useCodexAnimatedPanelState({
    open: rightPanelOpen,
    targetSize: rightPanelTargetWidth,
    reducedMotion,
    resetKey: activeSessionId,
  });
  const bottomPanelMotion = useCodexAnimatedPanelState({
    open: bottomPanelOpen,
    targetSize: bottomPanelHeight,
    reducedMotion,
    resetKey: activeSessionId,
  });
  const rightPanelAnimatedWidth = useTransform(
    [rightPanelMotion.progress, rightPanelMotion.targetSize, rightPanelFullWidthValue],
    ([latestProgress, latestTargetSize, latestFullWidth]) =>
      Number(latestFullWidth) > 0
        ? 0
        : resolveCodexAnimatedPanelSize(Number(latestProgress), Number(latestTargetSize)),
  );
  const destinationRouteHeaderSlotSuppressed = useSyncedMotionValue(destinationRouteOpen ? 1 : 0);
  const rightHeaderShellSlotWidth = useTransform(
    [rightPanelAnimatedWidth, destinationRouteHeaderSlotSuppressed],
    ([latestRightPanelWidth, latestSuppressed]) =>
      Number(latestSuppressed) > 0 ? 0 : Number(latestRightPanelWidth),
  );
  const bottomPanelAnimatedHeightCss = useTransform(
    bottomPanelMotion.animatedSize,
    (latestHeight) => `${latestHeight}px`,
  );
  const mainContentTargetWidth = useTransform(
    [
      shellBodySize.width,
      sidebarMotion.targetWidth,
      sidebarOpenValue,
      regularRightPanelWidth,
      rightPanelOpenValue,
      rightPanelFullWidthValue,
      activeSessionValue,
    ],
    ([
      latestShellWidth,
      latestSidebarWidth,
      latestSidebarOpen,
      latestRightPanelWidth,
      latestRightPanelOpen,
      latestRightPanelFullWidth,
      latestActiveSession,
    ]) =>
      Number(latestActiveSession) > 0
        ? resolveCodexMainContentTargetWidth({
            shellWidth: Number(latestShellWidth),
            leftSidebarOpen: Number(latestSidebarOpen) > 0,
            leftSidebarWidth: Number(latestSidebarWidth),
            rightPanelOpen: Number(latestRightPanelOpen) > 0,
            rightPanelWidth: Number(latestRightPanelWidth),
            rightPanelFullWidth: Number(latestRightPanelFullWidth) > 0,
          })
        : 0,
  );
  const appShellMainContentLayout = "thread-edge-scroll" as const;
  const appShellHeaderEdgeScrollValue = useTransform(
    [mainContentTargetWidth, rootFontSize, rightPanelFullWidthValue],
    ([latestMainContentWidth, latestRootFontSize, latestRightPanelFullWidth]) =>
      resolveCodexHeaderEdgeScroll({
        layout: appShellMainContentLayout,
        mainContentWidth: Number(latestMainContentWidth),
        rootFontSizePx: Number(latestRootFontSize),
        rightPanelFullWidth: Number(latestRightPanelFullWidth) > 0,
      })
        ? 1
        : 0,
  );
  const appShellHeaderEdgeScroll = useMotionValueState(appShellHeaderEdgeScrollValue) > 0;
  const threadSummaryPanelLayoutModeValue = useTransform(
    mainContentTargetWidth,
    resolveCodexSummaryPanelLayoutMode,
  );
  const threadSummaryPanelLayoutMode = useMotionValueState(threadSummaryPanelLayoutModeValue);
  const shellWidthClassValue = useTransform(shellBodySize.width, resolveShellWidthClass);
  const shellWidthClass = useMotionValueState(shellWidthClassValue);

  const { left: safeHeaderLeftWidth, right: safeHeaderRightWidth } =
    resolveWorkbenchHeaderSafeInsets({
      isMacPlatform,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      windowZoom,
    });
  const collapsedHeaderLeftFallbackWidth =
    safeHeaderLeftWidth + LEFT_HEADER_COLLAPSED_RAIL_FALLBACK_WIDTH_PX;
  const effectiveHeaderLeftWidth = sidebarLogicalCollapsed
    ? Math.max(headerLeftWidth, collapsedHeaderLeftFallbackWidth)
    : Math.max(headerLeftWidth, safeHeaderLeftWidth + 24);
  const sidebarHeaderWidth = useTransform(
    sidebarMotion.animatedWidth,
    (width) => width + WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  );
  const headerLeftShellSlotWidth =
    sidebarLogicalCollapsed && rightPanelFullWidth
      ? 0
      : sidebarMotion.mounted
        ? sidebarHeaderWidth
        : effectiveHeaderLeftWidth;
  const headerLeftShellSlotMinWidth = sidebarMotion.mounted
    ? sidebarLogicalCollapsed
      ? effectiveHeaderLeftWidth
      : Math.max(headerLeftWidth, safeHeaderLeftWidth + 24)
    : effectiveHeaderLeftWidth;

  return {
    appShellHeaderEdgeScroll,
    appShellMainContentLayout,
    bottomPanelAnimatedHeightCss,
    bottomPanelHeight,
    bottomPanelMotion,
    bottomPanelRequestedHeight,
    effectiveHeaderLeftWidth,
    headerLeftShellSlotMinWidth,
    headerLeftShellSlotWidth,
    headerLeftFallbackRailWidth: LEFT_HEADER_COLLAPSED_RAIL_FALLBACK_WIDTH_PX,
    headerLeftFallbackWidth: collapsedHeaderLeftFallbackWidth,
    mainContentTargetWidth,
    realSidebarMounted: sidebarMotion.mounted,
    regularRightPanelWidth,
    rightHeaderShellSlotWidth,
    rightPanelMotion,
    rightPanelRequestedWidth,
    rightPanelTargetWidth,
    safeHeaderLeftWidth,
    safeHeaderRightWidth,
    shellBodySize,
    shellMainContentWidth,
    shellWidthClass,
    threadSummaryPanelLayoutMode,
  };
}
