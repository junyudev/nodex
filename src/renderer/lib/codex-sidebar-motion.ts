import { useCallback, useEffect, useRef } from "react";
import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  CODEX_SHELL_PANEL_TRANSITION,
  clampCodexPanelProgress,
  resolveCodexAnimatedPanelSize,
} from "./codex-panel-motion";
import {
  isCodexSidebarExpandedMounted,
  resolveCodexSidebarToggleTargetProgress,
  shouldAnimateCodexSidebarToggle,
} from "./codex-sidebar-auto-reveal";
import { useDistinctState } from "./use-distinct-state";

export interface CodexSidebarMotionSetOpenOptions {
  animate?: boolean;
}

export interface CodexSidebarMotionSetOpenResolution {
  targetProgress: 0 | 1;
  shouldAnimate: boolean;
}

export interface CodexSidebarMotionState {
  progress: MotionValue<number>;
  opacity: MotionValue<number>;
  animatedWidth: MotionValue<number>;
  targetWidth: MotionValue<number>;
  logicalOpen: boolean;
  mounted: boolean;
  animating: boolean;
  getOpen: () => boolean;
  setOpen: (
    nextOpen: boolean,
    options?: CodexSidebarMotionSetOpenOptions,
  ) => CodexSidebarMotionSetOpenResolution;
  setTargetWidth: (width: number) => void;
}

export function resolveCodexSidebarMotionMounted({
  logicalOpen,
  progress,
}: {
  logicalOpen: boolean;
  progress: number;
}): boolean {
  return isCodexSidebarExpandedMounted({ open: logicalOpen, progress });
}

export function resolveCodexSidebarMotionSetOpen({
  nextOpen,
  animate: animateLayout,
  reducedMotion,
}: {
  nextOpen: boolean;
  animate?: boolean;
  reducedMotion: boolean | null;
}): CodexSidebarMotionSetOpenResolution {
  return {
    targetProgress: resolveCodexSidebarToggleTargetProgress(nextOpen),
    shouldAnimate: shouldAnimateCodexSidebarToggle({
      animate: animateLayout,
      reducedMotion,
    }),
  };
}

export function shouldCommitCodexSidebarMotionCompletion({
  completionGeneration,
  currentGeneration,
}: {
  completionGeneration: number;
  currentGeneration: number;
}): boolean {
  return completionGeneration === currentGeneration;
}

export function useCodexSidebarMotionState({
  initialOpen,
  targetWidth,
  reducedMotion,
}: {
  initialOpen: boolean;
  targetWidth: number;
  reducedMotion: boolean | null;
}): CodexSidebarMotionState {
  const progress = useMotionValue(initialOpen ? 1 : 0);
  const targetWidthMotionValue = useMotionValue(targetWidth);
  const opacity = useTransform(progress, clampCodexPanelProgress);
  const animatedWidth = useTransform(
    [progress, targetWidthMotionValue],
    ([latestProgress, latestTargetWidth]) =>
      resolveCodexAnimatedPanelSize(Number(latestProgress), Number(latestTargetWidth)),
  );
  const [logicalOpen, setLogicalOpenIfChanged, getLogicalOpen] = useDistinctState(initialOpen);
  const [mounted, setMountedIfChanged] = useDistinctState(initialOpen);
  const [animating, setAnimatingIfChanged] = useDistinctState(false);
  const reducedMotionRef = useRef(reducedMotion);
  const animationRef = useRef<ReturnType<typeof animate> | null>(null);
  const animationGenerationRef = useRef(0);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  const setTargetWidth = useCallback(
    (width: number) => {
      targetWidthMotionValue.set(width);
    },
    [targetWidthMotionValue],
  );

  useEffect(() => {
    setTargetWidth(targetWidth);
  }, [setTargetWidth, targetWidth]);

  useMotionValueEvent(progress, "change", (latestProgress) => {
    setMountedIfChanged(
      resolveCodexSidebarMotionMounted({
        logicalOpen: getLogicalOpen(),
        progress: latestProgress,
      }),
    );
  });

  const getOpen = getLogicalOpen;

  const setOpen = useCallback(
    (
      nextOpen: boolean,
      options: CodexSidebarMotionSetOpenOptions = {},
    ): CodexSidebarMotionSetOpenResolution => {
      const resolution = resolveCodexSidebarMotionSetOpen({
        nextOpen,
        animate: options.animate,
        reducedMotion: reducedMotionRef.current,
      });
      const { targetProgress, shouldAnimate } = resolution;

      animationGenerationRef.current += 1;
      const generation = animationGenerationRef.current;
      animationRef.current?.stop();
      animationRef.current = null;

      setLogicalOpenIfChanged(nextOpen);

      const currentProgress = clampCodexPanelProgress(progress.get());
      if (nextOpen || currentProgress > 0) {
        setMountedIfChanged(true);
      }

      if (!shouldAnimate) {
        setAnimatingIfChanged(false);
        progress.set(targetProgress);
        setMountedIfChanged(
          resolveCodexSidebarMotionMounted({
            logicalOpen: nextOpen,
            progress: targetProgress,
          }),
        );
        return resolution;
      }

      if (currentProgress === targetProgress) {
        setAnimatingIfChanged(false);
        setMountedIfChanged(
          resolveCodexSidebarMotionMounted({
            logicalOpen: nextOpen,
            progress: targetProgress,
          }),
        );
        return resolution;
      }

      setAnimatingIfChanged(true);
      const controls = animate(progress, targetProgress, {
        ...CODEX_SHELL_PANEL_TRANSITION,
        onComplete: () => {
          if (
            !shouldCommitCodexSidebarMotionCompletion({
              completionGeneration: generation,
              currentGeneration: animationGenerationRef.current,
            })
          )
            return;

          animationRef.current = null;
          setAnimatingIfChanged(false);
          setMountedIfChanged(
            resolveCodexSidebarMotionMounted({
              logicalOpen: getLogicalOpen(),
              progress: progress.get(),
            }),
          );
        },
      });
      animationRef.current = controls;
      return resolution;
    },
    [getLogicalOpen, progress, setAnimatingIfChanged, setLogicalOpenIfChanged, setMountedIfChanged],
  );

  useEffect(
    () => () => {
      animationGenerationRef.current += 1;
      animationRef.current?.stop();
      animationRef.current = null;
    },
    [],
  );

  return {
    progress,
    opacity,
    animatedWidth,
    targetWidth: targetWidthMotionValue,
    logicalOpen,
    mounted,
    animating,
    getOpen,
    setOpen,
    setTargetWidth,
  };
}
