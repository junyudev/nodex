import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
  type MotionValue,
  type Transition,
} from "motion/react";

export const CODEX_SHELL_PANEL_TRANSITION = {
  type: "spring",
  duration: 0.5,
  bounce: 0.1,
} as const;

export const CODEX_SUMMARY_PANEL_TRANSITION = {
  type: "spring",
  duration: 0.3,
  bounce: 0.01,
} as const;

export const CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION: Transition = {
  duration: 0.5,
  ease: [0.19, 1, 0.22, 1],
};

export const CODEX_SUMMARY_PANEL_WIDTH = 300;
export const CODEX_SUMMARY_PANEL_GAP = 8;
export const CODEX_SUMMARY_TARGET_CONTENT_WIDTH = 736;
export const CODEX_SUMMARY_OVERLAY_AVAILABLE_WIDTH = 180;
export const CODEX_SUMMARY_GUTTER_AVAILABLE_WIDTH = 400;
export const CODEX_SUMMARY_SHIFT_X = -((CODEX_SUMMARY_PANEL_WIDTH + CODEX_SUMMARY_PANEL_GAP) / 2);
export const CODEX_SHELL_MEDIUM_WIDTH_PX = 960;
export const CODEX_SHELL_NARROW_WIDTH_PX = 720;
export const CODEX_THREAD_EDGE_SCROLL_MIN_WIDTH_REM = 96;

export type ThreadSummaryPanelLayoutMode = "overlay" | "shift" | "gutter";
export type AppShellMainContentLayout = "default" | "full-bleed" | "thread-edge-scroll";

export interface CodexAnimatedPanelState {
  progress: MotionValue<number>;
  opacity: MotionValue<number>;
  animatedSize: MotionValue<number>;
  targetSize: MotionValue<number>;
  mounted: boolean;
  animating: boolean;
}

export function clampCodexPanelProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

export function resolveCodexAnimatedPanelSize(progress: number, targetSize: number): number {
  if (!Number.isFinite(targetSize) || targetSize <= 0) return 0;
  return clampCodexPanelProgress(progress) * targetSize;
}

export function resolveCodexSummaryPanelLayoutMode(
  mainContentTargetWidth: number,
): ThreadSummaryPanelLayoutMode {
  const availableWidth = (mainContentTargetWidth - CODEX_SUMMARY_TARGET_CONTENT_WIDTH) / 2;
  if (availableWidth < CODEX_SUMMARY_OVERLAY_AVAILABLE_WIDTH) return "overlay";
  if (availableWidth < CODEX_SUMMARY_GUTTER_AVAILABLE_WIDTH) return "shift";
  return "gutter";
}

export function resolveCodexSummaryContentShift({
  layoutMode,
  pinnedOpen,
}: {
  layoutMode: ThreadSummaryPanelLayoutMode;
  pinnedOpen: boolean;
}): number {
  if (!pinnedOpen) return 0;
  if (layoutMode !== "shift") return 0;
  return CODEX_SUMMARY_SHIFT_X;
}

export function resolveCodexMainContentTargetWidth({
  shellWidth,
  leftSidebarOpen,
  leftSidebarWidth,
  rightPanelOpen,
  rightPanelWidth,
  rightPanelFullWidth = false,
}: {
  shellWidth: number;
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  rightPanelFullWidth?: boolean;
}): number {
  if (!Number.isFinite(shellWidth) || shellWidth <= 0) return 0;
  if (rightPanelFullWidth) return 0;
  const reservedLeftWidth =
    leftSidebarOpen && Number.isFinite(leftSidebarWidth) ? Math.max(0, leftSidebarWidth) : 0;
  const reservedRightWidth =
    rightPanelOpen && Number.isFinite(rightPanelWidth) ? Math.max(0, rightPanelWidth) : 0;
  return Math.max(0, shellWidth - reservedLeftWidth - reservedRightWidth);
}

export function resolveCodexHeaderEdgeScroll({
  layout,
  mainContentWidth,
  rootFontSizePx = 16,
  rightPanelFullWidth = false,
}: {
  layout: AppShellMainContentLayout;
  mainContentWidth: number;
  rootFontSizePx?: number;
  rightPanelFullWidth?: boolean;
}): boolean {
  if (layout !== "thread-edge-scroll") return false;
  if (rightPanelFullWidth) return false;
  const normalizedRootFontSize =
    Number.isFinite(rootFontSizePx) && rootFontSizePx > 0 ? rootFontSizePx : 16;
  return mainContentWidth >= CODEX_THREAD_EDGE_SCROLL_MIN_WIDTH_REM * normalizedRootFontSize;
}

export function shouldSnapCodexMotion(
  reducedMotion: boolean | null,
  animateLayout = true,
): boolean {
  return reducedMotion === true || !animateLayout;
}

/** Keeps every conversation surface on one interruptible summary-placement animation. */
export function useCodexAnimatedContentShift({
  mainContentWidth,
  pinnedOpen,
  reducedMotion,
  resetKey,
  fullWidth,
}: {
  mainContentWidth: MotionValue<number>;
  pinnedOpen: boolean;
  reducedMotion: boolean;
  resetKey: string | null;
  fullWidth: boolean;
}): MotionValue<number> {
  const resolveTarget = useCallback(
    (width: number) =>
      resolveCodexSummaryContentShift({
        layoutMode: resolveCodexSummaryPanelLayoutMode(width),
        pinnedOpen: pinnedOpen && !fullWidth,
      }),
    [fullWidth, pinnedOpen],
  );
  const contentX = useMotionValue(resolveTarget(mainContentWidth.get()));
  const previousPresentation = useRef({ resetKey, fullWidth });
  const targetRef = useRef(contentX.get());
  const animationRef = useRef<ReturnType<typeof animate> | null>(null);
  const updateTarget = useCallback(
    (width: number, snap: boolean) => {
      const targetX = resolveTarget(width);
      if (!snap && !reducedMotion && targetRef.current === targetX) return;
      targetRef.current = targetX;
      animationRef.current?.stop();
      animationRef.current = null;
      if (snap || reducedMotion) {
        contentX.jump(targetX);
        return;
      }
      animationRef.current = animate(contentX, targetX, CODEX_SHELL_PANEL_TRANSITION);
    },
    [contentX, reducedMotion, resolveTarget],
  );

  useMotionValueEvent(mainContentWidth, "change", (width) => {
    updateTarget(width, width === 0 || mainContentWidth.getPrevious() === 0);
  });

  useLayoutEffect(() => {
    const previous = previousPresentation.current;
    previousPresentation.current = { resetKey, fullWidth };
    updateTarget(
      mainContentWidth.get(),
      previous.resetKey !== resetKey || previous.fullWidth !== fullWidth,
    );
  }, [fullWidth, mainContentWidth, resetKey, updateTarget]);

  useEffect(() => () => animationRef.current?.stop(), []);

  return contentX;
}

export function useCodexAnimatedPanelState({
  open,
  targetSize,
  reducedMotion,
  animateLayout = true,
  resetKey,
}: {
  open: boolean;
  targetSize: MotionValue<number>;
  reducedMotion: boolean | null;
  animateLayout?: boolean;
  resetKey?: string | number | null;
}): CodexAnimatedPanelState {
  const initialProgress = open ? 1 : 0;
  const progress = useMotionValue(initialProgress);
  const opacity = useTransform(progress, clampCodexPanelProgress);
  const animatedSize = useTransform([progress, targetSize], ([latestProgress, latestTargetSize]) =>
    resolveCodexAnimatedPanelSize(Number(latestProgress), Number(latestTargetSize)),
  );
  const [mounted, setMounted] = useState(open);
  const [animating, setAnimating] = useState(false);
  const mountedRef = useRef(open);
  const openRef = useRef(open);
  const resetKeyRef = useRef(resetKey);
  const animationRef = useRef<ReturnType<typeof animate> | null>(null);
  const animationGenerationRef = useRef(0);

  const setMountedIfChanged = (nextMounted: boolean) => {
    if (mountedRef.current === nextMounted) return;
    mountedRef.current = nextMounted;
    setMounted(nextMounted);
  };

  useMotionValueEvent(progress, "change", (latestProgress) => {
    setMountedIfChanged(openRef.current || clampCodexPanelProgress(latestProgress) > 0);
  });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const nextProgress = open ? 1 : 0;
    const resetChanged = resetKeyRef.current !== resetKey;
    animationGenerationRef.current += 1;
    const generation = animationGenerationRef.current;
    resetKeyRef.current = resetKey;
    animationRef.current?.stop();
    animationRef.current = null;

    if (resetChanged || shouldSnapCodexMotion(reducedMotion, animateLayout)) {
      setAnimating(false);
      progress.set(nextProgress);
      setMountedIfChanged(open);
      return undefined;
    }

    if (clampCodexPanelProgress(progress.get()) === nextProgress) {
      setAnimating(false);
      setMountedIfChanged(open || nextProgress > 0);
      return undefined;
    }

    if (open) {
      setMountedIfChanged(true);
    }

    setAnimating(true);
    const controls = animate(progress, nextProgress, {
      ...CODEX_SHELL_PANEL_TRANSITION,
      onComplete: () => {
        if (animationGenerationRef.current === generation) {
          setAnimating(false);
        }
        if (!open && clampCodexPanelProgress(progress.get()) === 0) {
          setMountedIfChanged(false);
        }
      },
    });
    animationRef.current = controls;

    return () => {
      controls.stop();
    };
  }, [animateLayout, open, progress, reducedMotion, resetKey]);

  return {
    progress,
    opacity,
    animatedSize,
    targetSize,
    // Opening content belongs to this commit; state only retains it while closing.
    mounted: open || mounted,
    animating,
  };
}
