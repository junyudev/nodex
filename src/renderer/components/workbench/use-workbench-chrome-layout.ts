import {
  readWindowFullscreen,
  subscribeWindowFullscreen,
  synchronizeWindowAppearance,
} from "@/lib/application-menu";
import { readThemePreference } from "@/lib/theme-preferences";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  resolveWindowContentCaptionClearance,
  measureWorkbenchWindowControlsOverlay,
  normalizeWorkbenchWindowZoom,
  resolveWorkbenchHeaderSafeInsets,
  type WorkbenchNativeControlInsets,
  type WorkbenchWindowControlsOverlay,
} from "../../../shared/workbench-window-chrome";
import {
  WORKBENCH_APPLICATION_MENU_HEIGHT_PX,
  WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
  WORKBENCH_SURFACE_GUTTER_PX,
} from "../../../shared/workbench-window-chrome";
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
  readonly applicationMenuBarEnabled?: boolean;
  readonly isMacPlatform: boolean;
  readonly reducedMotion: boolean | null;
  /** The content panel fills the Scene, covering the Conversation. */
  readonly rightPanelFullWidth: boolean;
  /**
   * The Scene is in full view, whichever surface fills it: the content panel keeps its full-width
   * frame, and its tab strip keeps the titlebar, even while the Chat tab is selected.
   */
  readonly rightPanelFullView: boolean;
  /** The content panel's physical side; the Conversation's titlebar row follows it. */
  readonly rightPanelSide: "left" | "right";
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

function readWindowControlsOverlay(): (WorkbenchWindowControlsOverlay & EventTarget) | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (
    navigator as Navigator & {
      readonly windowControlsOverlay?: WorkbenchWindowControlsOverlay & EventTarget;
    }
  ).windowControlsOverlay;
}

function sameControlInsets(
  left: WorkbenchNativeControlInsets | null,
  right: WorkbenchNativeControlInsets | null,
): boolean {
  return left?.left === right?.left && left?.right === right?.right;
}

function readRootFontSize(): number {
  if (typeof window === "undefined") return 16;
  const parsedFontSize = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize : 16;
}

function readShellBodyFallbackSize(applicationMenuBarEnabled: boolean, root: HTMLElement | null) {
  if (typeof window === "undefined") {
    return { height: 0, width: 0 };
  }
  const windowZoom = readWindowZoom(root);
  return {
    height: Math.max(
      0,
      window.innerHeight / windowZoom -
        (applicationMenuBarEnabled
          ? WORKBENCH_APPLICATION_MENU_HEIGHT_PX
          : WORKBENCH_TITLEBAR_HEIGHT_PX) -
        WORKBENCH_SURFACE_GUTTER_PX,
    ),
    width: Math.max(
      0,
      window.innerWidth / windowZoom -
        WORKBENCH_NAVIGATION_RAIL_WIDTH_PX -
        WORKBENCH_SURFACE_GUTTER_PX,
    ),
  };
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
  applicationMenuBarEnabled = false,
  reducedMotion,
  rightPanelFullWidth,
  rightPanelFullView,
  rightPanelSide,
  rightPanelOpen,
  rightPanelRequestedWidth: persistedRightPanelWidth,
  rootRef,
  sidebarLogicalCollapsed,
  sidebarMotion,
  sidebarOpen,
}: WorkbenchChromeLayoutInput) {
  const readFallbackSize = useCallback(
    () => readShellBodyFallbackSize(applicationMenuBarEnabled, rootRef.current),
    [applicationMenuBarEnabled, rootRef],
  );
  const [initialShellBodySize] = useState(() =>
    readShellBodyFallbackSize(applicationMenuBarEnabled, null),
  );
  const measuredBodySize = useElementSizeMotionValues({
    initialHeight: initialShellBodySize.height,
    initialWidth: initialShellBodySize.width,
    readFallbackSize,
  });
  // Windows measures the full-height sidebar row; panel sizing uses the content below its header.
  const contentBodyHeight = useTransform(measuredBodySize.height, (height) =>
    Math.max(0, height - (applicationMenuBarEnabled ? WORKBENCH_TITLEBAR_HEIGHT_PX : 0)),
  );
  const shellBodySize = { ...measuredBodySize, height: contentBodyHeight };
  const rootFontSize = useMotionValue(readRootFontSize());
  useLayoutEffect(() => {
    if (!applicationMenuBarEnabled) return;
    document.documentElement.style.setProperty(
      "--app-shell-application-menu-height",
      `${WORKBENCH_APPLICATION_MENU_HEIGHT_PX}px`,
    );
    return () => {
      document.documentElement.style.removeProperty("--app-shell-application-menu-height");
      document.documentElement.style.removeProperty("--window-content-actions-top");
      document.documentElement.style.removeProperty("--window-content-top");
    };
  }, [applicationMenuBarEnabled]);
  const [fullscreen, setFullscreen] = useState(false);
  const [windowZoom, setWindowZoom] = useState(1);
  const [windowControlsOverlay, setWindowControlsOverlay] =
    useState<WorkbenchNativeControlInsets | null>(null);
  const rightPanelRequestedWidth = useMotionValue(
    persistedRightPanelWidth ?? RIGHT_PANEL_DEFAULT_WIDTH,
  );
  const bottomPanelRequestedHeight = useMotionValue(
    persistedBottomPanelHeight ?? BOTTOM_PANEL_DEFAULT_HEIGHT,
  );

  const appliedPanelSizes = useRef<{
    sessionId: string | null;
    rightWidth: number | null;
    bottomHeight: number | null;
  } | null>(null);
  useLayoutEffect(() => {
    const previous = appliedPanelSizes.current;
    if (
      previous?.sessionId !== activeSessionId ||
      previous.rightWidth !== persistedRightPanelWidth
    ) {
      rightPanelRequestedWidth.set(persistedRightPanelWidth ?? RIGHT_PANEL_DEFAULT_WIDTH);
    }
    if (
      previous?.sessionId !== activeSessionId ||
      previous.bottomHeight !== persistedBottomPanelHeight
    ) {
      bottomPanelRequestedHeight.set(persistedBottomPanelHeight ?? BOTTOM_PANEL_DEFAULT_HEIGHT);
    }
    appliedPanelSizes.current = {
      sessionId: activeSessionId,
      rightWidth: persistedRightPanelWidth,
      bottomHeight: persistedBottomPanelHeight,
    };
  }, [
    activeSessionId,
    persistedRightPanelWidth,
    persistedBottomPanelHeight,
    rightPanelRequestedWidth,
    bottomPanelRequestedHeight,
  ]);

  useEffect(() => {
    if (!applicationMenuBarEnabled) return;
    let active = true;
    let observed = false;
    const release = subscribeWindowFullscreen((value) => {
      observed = true;
      setFullscreen(value);
    });
    void readWindowFullscreen()
      .then((value) => {
        if (active && !observed) setFullscreen(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      release();
    };
  }, [applicationMenuBarEnabled]);

  useEffect(() => {
    const overlay = readWindowControlsOverlay();
    let lastAppearance = "";
    const measure = () => {
      const pageZoomFactor = normalizeWorkbenchWindowZoom(window.api?.getWindowZoomFactor?.() ?? 1);
      rootFontSize.set(readRootFontSize());
      const shellZoom = readWindowZoom(rootRef.current);
      setWindowZoom(shellZoom * pageZoomFactor);
      if (applicationMenuBarEnabled) {
        const theme = readThemePreference();
        const appearanceKey = `${theme}:${shellZoom}:${pageZoomFactor}`;
        if (lastAppearance !== appearanceKey) {
          lastAppearance = appearanceKey;
          void synchronizeWindowAppearance({ theme, shellZoom }).catch(() => {});
        }
      }
      const overlayInsets = measureWorkbenchWindowControlsOverlay(
        overlay,
        window.innerWidth,
        pageZoomFactor,
      );
      if (applicationMenuBarEnabled) {
        const clearance = resolveWindowContentCaptionClearance(
          overlayInsets?.right ?? 0,
          overlay?.visible ? (overlay.getTitlebarAreaRect().height ?? 0) : 0,
          fullscreen,
        );
        for (const [key, value] of [
          ["--window-content-actions-top", clearance.actionsTop],
          ["--window-content-top", clearance.contentTop],
        ] as const) {
          const next = `${value}px`;
          if (document.documentElement.style.getPropertyValue(key) !== next)
            document.documentElement.style.setProperty(key, next);
        }
      }
      setWindowControlsOverlay((current) =>
        sameControlInsets(current, overlayInsets) ? current : overlayInsets,
      );
    };
    measure();
    const observer = applicationMenuBarEnabled ? new MutationObserver(measure) : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    if (rootRef.current)
      observer?.observe(rootRef.current, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    overlay?.addEventListener("geometrychange", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      overlay?.removeEventListener("geometrychange", measure);
    };
  }, [applicationMenuBarEnabled, fullscreen, rootFontSize, rootRef]);

  const rightPanelFullWidthValue = useSyncedMotionValue(rightPanelFullWidth ? 1 : 0);
  const rightPanelFullViewValue = useSyncedMotionValue(rightPanelFullView ? 1 : 0);
  const rightPanelOnLeftValue = useSyncedMotionValue(rightPanelSide === "left" ? 1 : 0);
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
    [shellMainContentWidth, regularRightPanelWidth, rightPanelFullViewValue],
    ([latestSizingWidth, latestRegularWidth, latestFullWidth]) =>
      Number(latestFullWidth) > 0
        ? Math.max(Number(latestSizingWidth), Number(latestRegularWidth))
        : Number(latestRegularWidth),
  );
  const rightPanelMotion = useCodexAnimatedPanelState({
    open: rightPanelOpen || rightPanelFullView,
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
    [rightPanelMotion.progress, rightPanelMotion.targetSize, rightPanelFullViewValue],
    ([latestProgress, latestTargetSize, latestFullWidth]) =>
      Number(latestFullWidth) > 0
        ? 0
        : resolveCodexAnimatedPanelSize(Number(latestProgress), Number(latestTargetSize)),
  );
  const destinationRouteHeaderSlotSuppressed = useSyncedMotionValue(destinationRouteOpen ? 1 : 0);
  // The titlebar row above the content panel belongs to its tab strip, on the panel's side.
  const rightHeaderShellSlotWidth = useTransform(
    [rightPanelAnimatedWidth, destinationRouteHeaderSlotSuppressed, rightPanelOnLeftValue],
    ([latestRightPanelWidth, latestSuppressed, latestOnLeft]) =>
      Number(latestSuppressed) > 0 || Number(latestOnLeft) > 0 ? 0 : Number(latestRightPanelWidth),
  );
  const leftHeaderContentWidth = useTransform(
    [rightPanelAnimatedWidth, destinationRouteHeaderSlotSuppressed, rightPanelOnLeftValue],
    ([latestRightPanelWidth, latestSuppressed, latestOnLeft]) =>
      Number(latestSuppressed) > 0 || Number(latestOnLeft) === 0
        ? 0
        : Number(latestRightPanelWidth),
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
      windowControlsOverlay,
      fullscreen,
      applicationMenu: applicationMenuBarEnabled,
    });
  const workspaceSafeLeft = applicationMenuBarEnabled ? 8 : safeHeaderLeftWidth;
  const collapsedHeaderLeftFallbackWidth =
    workspaceSafeLeft +
    (applicationMenuBarEnabled ? 0 : LEFT_HEADER_COLLAPSED_RAIL_FALLBACK_WIDTH_PX);
  const effectiveHeaderLeftWidth = applicationMenuBarEnabled
    ? Math.max(headerLeftWidth, workspaceSafeLeft)
    : sidebarLogicalCollapsed
      ? Math.max(headerLeftWidth, collapsedHeaderLeftFallbackWidth)
      : Math.max(headerLeftWidth, workspaceSafeLeft + 24);
  const sidebarHeaderWidth = useTransform(
    [sidebarMotion.animatedWidth, leftHeaderContentWidth],
    ([width, contentWidth]) =>
      Number(width) + WORKBENCH_NAVIGATION_RAIL_WIDTH_PX + Number(contentWidth),
  );
  // A left content panel extends the left slot to the Conversation's edge; its tab strip reserves
  // the window controls itself, as a full view does.
  const collapsedSidebarHeaderWidth = useTransform(
    leftHeaderContentWidth,
    (contentWidth) => WORKBENCH_NAVIGATION_RAIL_WIDTH_PX + contentWidth,
  );
  const workspaceHeaderLeft = useTransform(sidebarMotion.animatedWidth, (width) =>
    applicationMenuBarEnabled ? WORKBENCH_NAVIGATION_RAIL_WIDTH_PX + width : 0,
  );
  const applicationMenuLeftSlotWidth = useTransform(leftHeaderContentWidth, (width) =>
    Math.max(width, effectiveHeaderLeftWidth),
  );
  const headerLeftShellSlotWidth =
    sidebarLogicalCollapsed && rightPanelFullView
      ? 0
      : applicationMenuBarEnabled
        ? applicationMenuLeftSlotWidth
        : sidebarMotion.mounted
          ? sidebarHeaderWidth
          : rightPanelSide === "left"
            ? collapsedSidebarHeaderWidth
            : effectiveHeaderLeftWidth;
  const headerLeftShellSlotMinWidth = applicationMenuBarEnabled
    ? 0
    : sidebarMotion.mounted
      ? sidebarLogicalCollapsed
        ? effectiveHeaderLeftWidth
        : Math.max(headerLeftWidth, workspaceSafeLeft + 24)
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
    workspaceHeaderLeft,
    headerLeftFallbackRailWidth: applicationMenuBarEnabled
      ? 0
      : LEFT_HEADER_COLLAPSED_RAIL_FALLBACK_WIDTH_PX,
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
