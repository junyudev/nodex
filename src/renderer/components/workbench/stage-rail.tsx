import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus } from "lucide-react";
import type { StageRailLayoutMode } from "@/lib/stage-rail-layout-mode";
import {
  clampStagePanelWidth,
  resolveResizedPanelPair,
  resolveResizedPanelWidth,
  STAGE_PANEL_MAX_WIDTH,
  STAGE_PANEL_MIN_WIDTH,
  type StagePanelResizeEdge,
  STAGE_PANEL_RESIZE_LEFT_EDGE,
  STAGE_PANEL_RESIZE_KEYBOARD_STEP,
  STAGE_PANEL_RESIZE_RIGHT_EDGE,
} from "../../lib/stage-panel-resize";
import {
  DEFAULT_NEXT_PANEL_PEEK_PX,
  normalizeNextPanelPeekPx,
} from "../../lib/stage-rail-peek";
import { shouldPreventStageRailShiftWheelFromCalendar } from "../../lib/stage-wheel-navigation";
import {
  resolveEffectiveSlidingWindowPaneCount,
  resolveExpandedStages,
  STAGE_ORDER,
  type StageCollapsedState,
  type StageNavDirection,
  type StageId,
  type StagePanelWidths,
} from "../../lib/use-workbench-state";
import { cn } from "../../lib/utils";

const DEFAULT_PANEL_FLEX = "clamp(300px, 31vw, 560px)";
// const DEFAULT_VIEWS_PANEL_FLEX = "clamp(450px, 46.5vw, 840px)";
// const DEFAULT_CARDS_PANEL_FLEX = "clamp(450px, 46.5vw, 840px)";
const DEFAULT_VIEWS_PANEL_FLEX = DEFAULT_PANEL_FLEX;
const DEFAULT_CARDS_PANEL_FLEX = DEFAULT_PANEL_FLEX;
const COLLAPSED_STAGE_WIDTH_PX = 52;

export interface StageRailStage {
  id: StageId;
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  header?: React.ReactNode;
  hideHeader?: boolean;
  content: React.ReactNode;
}

interface StageRailProps {
  stages: StageRailStage[];
  layoutMode?: StageRailLayoutMode;
  focusedStage: StageId;
  stageNavDirection?: StageNavDirection;
  slidingWindowPaneCount?: number;
  panelWidths?: StagePanelWidths;
  collapsedStages?: StageCollapsedState;
  onPanelWidthsChange?: (widths: StagePanelWidths) => void;
  onSetStageCollapsed?: (stageId: StageId, collapsed: boolean) => void;
  onFocusStage: (stageId: StageId) => void;
  nextPanelPeekPx?: number;
  className?: string;
}

type StageRailEntry =
  | { kind: "expanded"; stage: StageRailStage }
  | { kind: "collapsed-group"; stages: StageRailStage[] };

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

export function StageRail({
  stages,
  layoutMode = "full-rail",
  focusedStage,
  stageNavDirection = "right",
  slidingWindowPaneCount = 2,
  panelWidths,
  collapsedStages,
  onPanelWidthsChange,
  onSetStageCollapsed,
  onFocusStage,
  nextPanelPeekPx: nextPanelPeekPxProp = DEFAULT_NEXT_PANEL_PEEK_PX,
  className,
}: StageRailProps) {
  const reducedMotion = useReducedMotion();
  const nextPanelPeekPx = normalizeNextPanelPeekPx(nextPanelPeekPxProp);
  const railViewportRef = useRef<HTMLDivElement | null>(null);
  const slidingWindowContainerRef = useRef<HTMLDivElement | null>(null);
  const [slidingWindowAvailableWidth, setSlidingWindowAvailableWidth] = useState<number>(Number.NaN);
  const [slidingWindowDragWidths, setSlidingWindowDragWidths] = useState<number[] | null>(null);
  const stageRefs = useRef<Partial<Record<StageId, HTMLElement | null>>>({});
  const previousFocusedStageRef = useRef<StageId | null>(null);

  const stageMap = useMemo(() => {
    return stages.reduce<Partial<Record<StageId, StageRailStage>>>(
      (acc, stage) => {
        acc[stage.id] = stage;
        return acc;
      },
      {},
    );
  }, [stages]);

  const orderedStages = useMemo(
    () => STAGE_ORDER.map((stageId) => stageMap[stageId]).filter((stage): stage is StageRailStage => Boolean(stage)),
    [stageMap],
  );

  const normalizedPanelWidths = useMemo(() => {
    return STAGE_ORDER.reduce<StagePanelWidths>((acc, stageId) => {
      const width = panelWidths?.[stageId];
      if (typeof width !== "number" || !Number.isFinite(width)) return acc;
      acc[stageId] = clampStagePanelWidth(width, STAGE_PANEL_MIN_WIDTH, STAGE_PANEL_MAX_WIDTH);
      return acc;
    }, {});
  }, [panelWidths]);

  const normalizedCollapsedStages = useMemo(() => {
    return STAGE_ORDER.reduce<StageCollapsedState>((acc, stageId) => {
      if (collapsedStages?.[stageId] !== true) return acc;
      acc[stageId] = true;
      return acc;
    }, {});
  }, [collapsedStages]);

  const effectiveSlidingWindowPaneCount = useMemo(
    () => resolveEffectiveSlidingWindowPaneCount(slidingWindowPaneCount, slidingWindowAvailableWidth),
    [slidingWindowAvailableWidth, slidingWindowPaneCount],
  );
  const slidingWindowStageIds = useMemo(
    () => resolveExpandedStages(focusedStage, stageNavDirection, effectiveSlidingWindowPaneCount, false),
    [effectiveSlidingWindowPaneCount, focusedStage, stageNavDirection],
  );
  const slidingWindowStages = useMemo(
    () => slidingWindowStageIds
      .map((stageId) => stageMap[stageId])
      .filter((stage): stage is StageRailStage => Boolean(stage)),
    [slidingWindowStageIds, stageMap],
  );

  const isCollapsedStage = useCallback(
    (stageId: StageId): boolean => normalizedCollapsedStages[stageId] === true,
    [normalizedCollapsedStages],
  );

  const railEntries = useMemo(() => {
    const entries: StageRailEntry[] = [];
    let stageIndex = 0;

    while (stageIndex < orderedStages.length) {
      const stage = orderedStages[stageIndex];
      if (!isCollapsedStage(stage.id)) {
        entries.push({ kind: "expanded", stage });
        stageIndex += 1;
        continue;
      }

      const collapsedGroup: StageRailStage[] = [];
      while (stageIndex < orderedStages.length && isCollapsedStage(orderedStages[stageIndex].id)) {
        collapsedGroup.push(orderedStages[stageIndex]);
        stageIndex += 1;
      }

      entries.push({ kind: "collapsed-group", stages: collapsedGroup });
    }

    return entries;
  }, [isCollapsedStage, orderedStages]);

  const handleExpandStage = useCallback(
    (stageId: StageId) => {
      onSetStageCollapsed?.(stageId, false);
      onFocusStage(stageId);
    },
    [onFocusStage, onSetStageCollapsed],
  );

  const handleCollapseStage = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, stageId: StageId) => {
      if (!onSetStageCollapsed) return;
      event.preventDefault();
      event.stopPropagation();
      onSetStageCollapsed(stageId, true);
    },
    [onSetStageCollapsed],
  );

  const handlePanelResizeStart = useCallback(
    (
      event: React.PointerEvent<HTMLDivElement>,
      stageId: StageId,
      edge: StagePanelResizeEdge,
    ) => {
      if (!onPanelWidthsChange) return;
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const stageElement = stageRefs.current[stageId];
      if (!stageElement) return;

      event.preventDefault();
      event.stopPropagation();

      const pointerId = event.pointerId;
      const handleElement = event.currentTarget;
      const startX = event.clientX;
      const startWidth = stageElement.getBoundingClientRect().width;

      try {
        handleElement.setPointerCapture(pointerId);
      } catch {
        // pointer capture is a progressive enhancement
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onPointerMove = (nextEvent: PointerEvent) => {
        if (nextEvent.pointerId !== pointerId) return;

        const width = resolveResizedPanelWidth({
          startWidth,
          deltaPx: nextEvent.clientX - startX,
          edge,
          minPanelWidth: STAGE_PANEL_MIN_WIDTH,
          maxPanelWidth: STAGE_PANEL_MAX_WIDTH,
        });

        onPanelWidthsChange({
          [stageId]: width,
        });
      };

      const cleanup = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        try {
          if (handleElement.hasPointerCapture(pointerId)) {
            handleElement.releasePointerCapture(pointerId);
          }
        } catch {
          // ignore capture release failures
        }
      };

      const onPointerUp = (nextEvent: PointerEvent) => {
        if (nextEvent.pointerId !== pointerId) return;
        cleanup();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [onPanelWidthsChange],
  );

  const handlePanelResizeKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLDivElement>,
      stageId: StageId,
      edge: StagePanelResizeEdge,
    ) => {
      if (!onPanelWidthsChange) return;

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      const stageElement = stageRefs.current[stageId];
      if (!stageElement) return;

      event.preventDefault();
      event.stopPropagation();

      const width = resolveResizedPanelWidth({
        startWidth: stageElement.getBoundingClientRect().width,
        deltaPx:
          event.key === "ArrowRight"
            ? STAGE_PANEL_RESIZE_KEYBOARD_STEP
            : -STAGE_PANEL_RESIZE_KEYBOARD_STEP,
        edge,
        minPanelWidth: STAGE_PANEL_MIN_WIDTH,
        maxPanelWidth: STAGE_PANEL_MAX_WIDTH,
      });

      onPanelWidthsChange({
        [stageId]: width,
      });
    },
    [onPanelWidthsChange],
  );

  const normalizeSlidingWindowWidths = useCallback((rawWidths: number[], containerWidth: number): number[] => {
    if (rawWidths.length === 0) return [];
    const safeContainerWidth = Number.isFinite(containerWidth) && containerWidth > 0
      ? containerWidth
      : rawWidths.length * STAGE_PANEL_MIN_WIDTH;
    const desired = rawWidths.map((width) =>
      clampStagePanelWidth(width, STAGE_PANEL_MIN_WIDTH, STAGE_PANEL_MAX_WIDTH),
    );
    const desiredTotal = desired.reduce((sum, width) => sum + width, 0);
    const scaled = desiredTotal > 0
      ? desired.map((width) => (width / desiredTotal) * safeContainerWidth)
      : desired.map(() => safeContainerWidth / desired.length);

    let widths = scaled.map((width) => Math.max(STAGE_PANEL_MIN_WIDTH, width));
    let total = widths.reduce((sum, width) => sum + width, 0);
    let excess = total - safeContainerWidth;
    for (let iteration = 0; iteration < 6 && excess > 0.1; iteration += 1) {
      const reducible = widths.reduce(
        (sum, width) => sum + Math.max(0, width - STAGE_PANEL_MIN_WIDTH),
        0,
      );
      if (reducible <= 0) break;
      widths = widths.map((width) => {
        const available = Math.max(0, width - STAGE_PANEL_MIN_WIDTH);
        if (available <= 0) return width;
        const reduction = Math.min(available, excess * (available / reducible));
        return width - reduction;
      });
      total = widths.reduce((sum, width) => sum + width, 0);
      excess = total - safeContainerWidth;
    }

    total = widths.reduce((sum, width) => sum + width, 0);
    if (total < safeContainerWidth) {
      const addition = (safeContainerWidth - total) / widths.length;
      widths = widths.map((width) => width + addition);
    }

    const rounded = widths.map((width) => Math.round(width));
    const roundedTotal = rounded.reduce((sum, width) => sum + width, 0);
    const remainder = Math.round(safeContainerWidth - roundedTotal);
    if (rounded.length > 0 && remainder !== 0) {
      const targetIndex = rounded.length - 1;
      rounded[targetIndex] = Math.max(STAGE_PANEL_MIN_WIDTH, rounded[targetIndex] + remainder);
    }

    return rounded;
  }, []);

  const resolveSlidingWindowContainerWidth = useCallback((): number => {
    const measuredWidth = slidingWindowContainerRef.current?.getBoundingClientRect().width ?? Number.NaN;
    if (Number.isFinite(measuredWidth) && measuredWidth > 0) return measuredWidth;
    return Math.max(
      STAGE_PANEL_MIN_WIDTH * Math.max(1, slidingWindowStages.length),
      STAGE_PANEL_MIN_WIDTH,
    );
  }, [slidingWindowStages.length]);

  const resolveCurrentSlidingWindowWidths = useCallback((): number[] => {
    if (slidingWindowStages.length === 0) return [];
    if (slidingWindowDragWidths && slidingWindowDragWidths.length === slidingWindowStages.length) {
      return slidingWindowDragWidths;
    }

    const containerWidth = resolveSlidingWindowContainerWidth();
    const defaultWidth = Math.max(
      STAGE_PANEL_MIN_WIDTH,
      containerWidth / Math.max(1, slidingWindowStages.length),
    );
    const desired = slidingWindowStages.map(
      (stage) => normalizedPanelWidths[stage.id] ?? defaultWidth,
    );
    return normalizeSlidingWindowWidths(desired, containerWidth);
  }, [
    normalizeSlidingWindowWidths,
    normalizedPanelWidths,
    resolveSlidingWindowContainerWidth,
    slidingWindowDragWidths,
    slidingWindowStages,
  ]);

  const commitSlidingWindowWidths = useCallback((widths: number[]) => {
    if (!onPanelWidthsChange) return;
    if (widths.length !== slidingWindowStages.length) return;
    const nextWidths = slidingWindowStages.reduce<StagePanelWidths>((acc, stage, index) => {
      const width = widths[index];
      if (typeof width !== "number" || !Number.isFinite(width)) return acc;
      acc[stage.id] = clampStagePanelWidth(width, STAGE_PANEL_MIN_WIDTH, STAGE_PANEL_MAX_WIDTH);
      return acc;
    }, {});
    onPanelWidthsChange(nextWidths);
  }, [onPanelWidthsChange, slidingWindowStages]);

  const handleSlidingWindowSashPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, separatorIndex: number) => {
      if (!onPanelWidthsChange) return;
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (separatorIndex < 0 || separatorIndex >= slidingWindowStages.length - 1) return;

      event.preventDefault();
      event.stopPropagation();

      const pointerId = event.pointerId;
      const handleElement = event.currentTarget;
      const startX = event.clientX;
      const startWidths = resolveCurrentSlidingWindowWidths();
      const leftStartWidth = startWidths[separatorIndex];
      const rightStartWidth = startWidths[separatorIndex + 1];
      if (!Number.isFinite(leftStartWidth) || !Number.isFinite(rightStartWidth)) return;

      let latestWidths = [...startWidths];
      setSlidingWindowDragWidths(startWidths);

      try {
        handleElement.setPointerCapture(pointerId);
      } catch {
        // pointer capture is a progressive enhancement
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onPointerMove = (nextEvent: PointerEvent) => {
        if (nextEvent.pointerId !== pointerId) return;
        const resizedPair = resolveResizedPanelPair({
          leftStartWidth,
          rightStartWidth,
          deltaPx: nextEvent.clientX - startX,
          minPanelWidth: STAGE_PANEL_MIN_WIDTH,
          maxPanelWidth: STAGE_PANEL_MAX_WIDTH,
        });
        latestWidths = [...startWidths];
        latestWidths[separatorIndex] = resizedPair.leftWidth;
        latestWidths[separatorIndex + 1] = resizedPair.rightWidth;
        setSlidingWindowDragWidths(latestWidths);
      };

      const cleanup = () => {
        commitSlidingWindowWidths(latestWidths);
        setSlidingWindowDragWidths(null);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        try {
          if (handleElement.hasPointerCapture(pointerId)) {
            handleElement.releasePointerCapture(pointerId);
          }
        } catch {
          // ignore capture release failures
        }
      };

      const onPointerUp = (nextEvent: PointerEvent) => {
        if (nextEvent.pointerId !== pointerId) return;
        cleanup();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [
      commitSlidingWindowWidths,
      onPanelWidthsChange,
      resolveCurrentSlidingWindowWidths,
      slidingWindowStages.length,
    ],
  );

  const handleSlidingWindowSashKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, separatorIndex: number) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!onPanelWidthsChange) return;
      if (separatorIndex < 0 || separatorIndex >= slidingWindowStages.length - 1) return;

      event.preventDefault();
      event.stopPropagation();

      const widths = resolveCurrentSlidingWindowWidths();
      const resizedPair = resolveResizedPanelPair({
        leftStartWidth: widths[separatorIndex] ?? STAGE_PANEL_MIN_WIDTH,
        rightStartWidth: widths[separatorIndex + 1] ?? STAGE_PANEL_MIN_WIDTH,
        deltaPx: event.key === "ArrowRight" ? STAGE_PANEL_RESIZE_KEYBOARD_STEP : -STAGE_PANEL_RESIZE_KEYBOARD_STEP,
        minPanelWidth: STAGE_PANEL_MIN_WIDTH,
        maxPanelWidth: STAGE_PANEL_MAX_WIDTH,
      });
      const nextWidths = [...widths];
      nextWidths[separatorIndex] = resizedPair.leftWidth;
      nextWidths[separatorIndex + 1] = resizedPair.rightWidth;
      commitSlidingWindowWidths(nextWidths);
      setSlidingWindowDragWidths(nextWidths);
    },
    [
      commitSlidingWindowWidths,
      onPanelWidthsChange,
      resolveCurrentSlidingWindowWidths,
      slidingWindowStages.length,
    ],
  );

  const resolveDefaultPanelFlex = useCallback(
    (stageId: StageId): string => {
      if (stageId === "db") return DEFAULT_VIEWS_PANEL_FLEX;
      if (stageId === "cards") return DEFAULT_CARDS_PANEL_FLEX;
      return DEFAULT_PANEL_FLEX;
    },
    [],
  );

  useEffect(() => {
    if (layoutMode !== "sliding-window") {
      setSlidingWindowDragWidths(null);
      return;
    }
    const container = slidingWindowContainerRef.current;
    if (!container) return;

    const updateAvailableWidth = () => {
      const width = container.getBoundingClientRect().width;
      setSlidingWindowAvailableWidth(width);
    };

    updateAvailableWidth();
    const observer = new ResizeObserver(updateAvailableWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [layoutMode, slidingWindowStages.length]);

  useEffect(() => {
    if (layoutMode !== "full-rail") return;
    const target = stageRefs.current[focusedStage];
    const scrollViewport = railViewportRef.current ?? target?.parentElement?.parentElement ?? null;
    if (!target) {
      previousFocusedStageRef.current = focusedStage;
      return;
    }

    const focusedStageIndex = orderedStages.findIndex((stage) => stage.id === focusedStage);
    if (focusedStageIndex < 0) {
      previousFocusedStageRef.current = focusedStage;
      return;
    }

    const behavior = reducedMotion ? "auto" : "smooth";
    const isFirstStage = focusedStageIndex === 0;
    const isLastStage = focusedStageIndex === orderedStages.length - 1;
    if (scrollViewport && (isFirstStage || isLastStage)) {
      scrollViewport.scrollTo({
        left: isFirstStage
          ? 0
          : Math.max(0, scrollViewport.scrollWidth - scrollViewport.clientWidth),
        behavior,
      });
      previousFocusedStageRef.current = focusedStage;
      return;
    }

    target.scrollIntoView({
      behavior,
      block: "nearest",
      inline: "nearest",
    });

    const previousFocusedStage = previousFocusedStageRef.current;
    previousFocusedStageRef.current = focusedStage;
    const previousFocusedStageIndex = previousFocusedStage
      ? orderedStages.findIndex((stage) => stage.id === previousFocusedStage)
      : -1;
    const direction =
      previousFocusedStageIndex < 0
        ? 1
        : focusedStageIndex > previousFocusedStageIndex
          ? 1
          : focusedStageIndex < previousFocusedStageIndex
            ? -1
            : 0;

    if (direction === 0) return;

    let adjacentStageIndex = focusedStageIndex + direction;
    if (adjacentStageIndex < 0 || adjacentStageIndex >= orderedStages.length) {
      adjacentStageIndex = focusedStageIndex - direction;
    }
    if (adjacentStageIndex < 0 || adjacentStageIndex >= orderedStages.length) return;

    const adjacentStage = orderedStages[adjacentStageIndex];
    if (!adjacentStage) return;
    const adjacentDirection = adjacentStageIndex > focusedStageIndex ? 1 : -1;

    const adjacentStageElement = stageRefs.current[adjacentStage.id];
    if (!scrollViewport || !adjacentStageElement) return;

    const frameId = window.requestAnimationFrame(() => {
      const viewportRect = scrollViewport.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const adjacentStageRect = adjacentStageElement.getBoundingClientRect();

      if (adjacentDirection > 0) {
        const visibleNextPx = viewportRect.right - adjacentStageRect.left;
        if (visibleNextPx >= nextPanelPeekPx) return;

        const neededShiftPx = nextPanelPeekPx - visibleNextPx;
        // Never shift far enough to hide the focused panel's left edge.
        const maxShiftWithoutClippingFocused = Math.max(0, targetRect.left - viewportRect.left);
        const shiftPx = Math.min(neededShiftPx, maxShiftWithoutClippingFocused);
        if (shiftPx <= 0) return;

        scrollViewport.scrollBy({
          left: shiftPx,
          behavior,
        });
        return;
      }

      const visiblePrevPx = adjacentStageRect.right - viewportRect.left;
      if (visiblePrevPx >= nextPanelPeekPx) return;

      const neededShiftPx = nextPanelPeekPx - visiblePrevPx;
      // Never shift far enough to hide the focused panel's right edge.
      const maxShiftWithoutClippingFocused = Math.max(0, viewportRect.right - targetRect.right);
      const shiftPx = Math.min(neededShiftPx, maxShiftWithoutClippingFocused);
      if (shiftPx <= 0) return;

      scrollViewport.scrollBy({
        left: -shiftPx,
        behavior,
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [focusedStage, layoutMode, nextPanelPeekPx, orderedStages, reducedMotion]);

  useEffect(() => {
    if (layoutMode !== "full-rail") return;
    const viewport = railViewportRef.current;
    if (!viewport) return;

    const handleWheelCapture = (event: WheelEvent) => {
      if (
        !shouldPreventStageRailShiftWheelFromCalendar({
          target: event.target,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey || event.metaKey,
        })
      ) {
        return;
      }

      if (event.cancelable) event.preventDefault();
    };

    viewport.addEventListener("wheel", handleWheelCapture, {
      capture: true,
      passive: false,
    });

    return () => {
      viewport.removeEventListener("wheel", handleWheelCapture, true);
    };
  }, [layoutMode]);

  if (layoutMode === "sliding-window") {
    const currentSlidingWindowWidths = resolveCurrentSlidingWindowWidths();
    const widthTotal = Math.max(
      1,
      currentSlidingWindowWidths.reduce((sum, width) => sum + width, 0),
    );
    return (
      <div
        className={cn("h-full min-h-0 overflow-hidden", className)}
        data-layout-mode="sliding-window"
        data-sliding-window-pane-count={slidingWindowStages.length}
      >
        <div ref={slidingWindowContainerRef} className="flex h-full min-h-0">
          {slidingWindowStages.map((stage, index) => {
            const nextStage = slidingWindowStages[index + 1];
            const paneWidthPercent = `${((currentSlidingWindowWidths[index] ?? 0) / widthTotal) * 100}%`;

            return (
              <Fragment key={stage.id}>
                <section
                  ref={(node) => {
                    stageRefs.current[stage.id] = node;
                  }}
                  data-stage-pane={`window-${index}`}
                  data-stage-id={stage.id}
                  data-focused={focusedStage === stage.id}
                  className={cn(
                    "relative flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden",
                    "transition-shadow-lift duration-200 ease-out motion-reduce:transition-none",
                  )}
                  style={{
                    flex: `0 0 ${paneWidthPercent}`,
                    width: paneWidthPercent,
                    backgroundColor: "color-mix(in srgb, var(--background) 90%, transparent)",
                    backdropFilter: "blur(16px)",
                    WebkitBackdropFilter: "blur(16px)",
                  }}
                  onMouseDown={(mouseEvent) => {
                    if (mouseEvent.button !== 0) return;
                    onFocusStage(stage.id);
                  }}
                >
                  {!stage.hideHeader && (
                    <header className="flex h-7 items-center gap-1 border-b border-(--border) px-2">
                      <button
                        onClick={() => onFocusStage(stage.id)}
                        className={cn(
                          "shrink-0 text-xs font-semibold",
                          focusedStage === stage.id
                            ? "text-(--foreground)"
                            : "text-(--foreground-secondary)",
                        )}
                      >
                        {stage.title}
                      </button>
                      <div className="min-w-0 flex-1">{stage.header}</div>
                    </header>
                  )}
                  <div className="min-h-0 flex-1 overflow-hidden">{stage.content}</div>
                </section>

                {nextStage ? (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize boundary between ${stage.title} and ${nextStage.title}`}
                    aria-valuemin={STAGE_PANEL_MIN_WIDTH}
                    aria-valuemax={STAGE_PANEL_MAX_WIDTH}
                    aria-valuenow={currentSlidingWindowWidths[index + 1] ?? STAGE_PANEL_MIN_WIDTH}
                    tabIndex={0}
                    className="group relative z-20 -mx-1.5 flex w-3 shrink-0 cursor-col-resize touch-none select-none focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:outline-none active:cursor-col-resize"
                    onPointerDown={(pointerEvent) => handleSlidingWindowSashPointerDown(pointerEvent, index)}
                    onKeyDown={(keyboardEvent) => handleSlidingWindowSashKeyDown(keyboardEvent, index)}
                  >
                    <div
                      aria-hidden
                      className="pointer-events-none m-auto h-full w-px bg-linear-to-b from-transparent via-(--border) to-transparent transition-colors group-hover:via-(--foreground-tertiary) group-focus-visible:via-(--accent-blue) group-active:via-(--foreground-tertiary)"
                    />
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={railViewportRef}
      data-layout-mode="full-rail"
      className={cn(
        "notion-scrollbar h-full min-h-0 overflow-x-auto overflow-y-hidden",
        className,
      )}
    >
      <div className="flex h-full min-h-0">
        {railEntries.map((entry) => {
          if (entry.kind === "collapsed-group") {
            const groupHasFocusedStage = entry.stages.some((stage) => stage.id === focusedStage);
            return (
              <section
                key={`collapsed-group:${entry.stages[0]?.id ?? "empty"}`}
                data-collapsed-group="true"
                className="relative h-full min-h-0 shrink-0 overflow-visible"
                style={{
                  flex: `0 0 ${COLLAPSED_STAGE_WIDTH_PX}px`,
                }}
              >
                <div className="mx-auto flex flex-col items-center gap-1.5">
                  {entry.stages.map((stage) => {
                    const Icon = stage.icon;
                    const isFocused = stage.id === focusedStage;

                    return (
                      <button
                        key={stage.id}
                        ref={(node) => {
                          stageRefs.current[stage.id] = node;
                        }}
                        type="button"
                        title={`Expand ${stage.title}`}
                        aria-label={`Expand ${stage.title}`}
                        data-stage-collapsed="true"
                        onClick={() => handleExpandStage(stage.id)}
                        className={cn(
                          "group flex size-9 items-center justify-center rounded-xl border",
                          "bg-[color-mix(in_srgb,var(--background)_90%,var(--background-secondary)_10%)]",
                          "shadow-[0_8px_20px_-16px_color-mix(in_srgb,var(--foreground)_70%,transparent)]",
                          "transition-chrome duration-200 ease-out",
                          "hover:shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--foreground)_20%,transparent)]",
                          isFocused
                            ? "border-(--accent-blue) text-(--accent-blue)"
                            : "border-(--border) text-(--foreground-secondary) hover:text-(--foreground)",
                          "focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:outline-none",
                        )}
                      >
                        {Icon ? (
                          <Icon className="size-4" />
                        ) : (
                          <span className="text-xs font-semibold uppercase">{stage.title.slice(0, 1)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {groupHasFocusedStage && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-2 top-0 h-0.5 rounded-full bg-(--accent-blue)"
                  />
                )}
              </section>
            );
          }

          const stage = entry.stage;
          const isFocused = stage.id === focusedStage;
          const customWidth = normalizedPanelWidths[stage.id];
          const widthForA11y = normalizedPanelWidths[stage.id];

          return (
            <section
              key={stage.id}
              ref={(node) => {
                stageRefs.current[stage.id] = node;
              }}
              data-focused={isFocused}
              className={cn(
                "relative flex h-full min-h-0 flex-col overflow-hidden",
                "transition-stage-resize duration-200 ease-out motion-reduce:transition-none",
              )}
              style={{
                flex: customWidth
                  ? `0 0 ${customWidth}px`
                  : `0 0 ${resolveDefaultPanelFlex(stage.id)}`,
                backgroundColor: "color-mix(in srgb, var(--background) 90%, transparent)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
              }}
              onMouseDown={(mouseEvent) => {
                if (mouseEvent.button !== 0) return;
                onFocusStage(stage.id);
              }}
            >
              {stage.hideHeader && onSetStageCollapsed && (
                <button
                  type="button"
                  aria-label={`Collapse ${stage.title}`}
                  title={`Collapse ${stage.title}`}
                  onClick={(event) => handleCollapseStage(event, stage.id)}
                  className={cn(
                    "absolute top-2 right-2 z-20 inline-flex h-5 w-5 items-center justify-center rounded-md",
                    "text-(--foreground-tertiary) transition-colors",
                    "hover:bg-(--background-tertiary)/50 hover:text-(--foreground-secondary)",
                    "focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:outline-none",
                  )}
                >
                  <Minus className="size-3" />
                </button>
              )}

              {!stage.hideHeader && (
                <header className="flex h-7 items-center gap-1 border-b border-(--border) px-2">
                  <button
                    onClick={() => onFocusStage(stage.id)}
                    className={cn(
                      "shrink-0 text-xs font-semibold",
                      isFocused ? "text-(--foreground)" : "text-(--foreground-secondary)",
                    )}
                  >
                    {stage.title}
                  </button>
                  <div className="min-w-0 flex-1">{stage.header}</div>
                  {onSetStageCollapsed && (
                    <button
                      type="button"
                      aria-label={`Collapse ${stage.title}`}
                      title={`Collapse ${stage.title}`}
                      onClick={(event) => handleCollapseStage(event, stage.id)}
                      className={cn(
                        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
                        "text-(--foreground-tertiary) transition-colors",
                        "hover:bg-(--background-tertiary)/50 hover:text-(--foreground-secondary)",
                        "focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:outline-none",
                      )}
                    >
                      <Minus className="size-3" />
                    </button>
                  )}
                </header>
              )}

              <div className="min-h-0 flex-1 overflow-hidden">{stage.content}</div>

              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize left border of ${stage.title}`}
                aria-valuemin={STAGE_PANEL_MIN_WIDTH}
                aria-valuemax={STAGE_PANEL_MAX_WIDTH}
                aria-valuenow={widthForA11y}
                tabIndex={0}
                onPointerDown={(pointerEvent) => {
                  onFocusStage(stage.id);
                  handlePanelResizeStart(pointerEvent, stage.id, STAGE_PANEL_RESIZE_LEFT_EDGE);
                }}
                onKeyDown={(keyboardEvent) =>
                  handlePanelResizeKeyDown(keyboardEvent, stage.id, STAGE_PANEL_RESIZE_LEFT_EDGE)}
                className={cn(
                  "group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none",
                  "focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:outline-none",
                )}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-full bg-(--border) opacity-0 transition-fade-surface group-hover:bg-(--foreground-tertiary) group-hover:opacity-100 group-focus-visible:bg-(--accent-blue) group-focus-visible:opacity-100"
                />
              </div>

              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize right border of ${stage.title}`}
                aria-valuemin={STAGE_PANEL_MIN_WIDTH}
                aria-valuemax={STAGE_PANEL_MAX_WIDTH}
                aria-valuenow={widthForA11y}
                tabIndex={0}
                onPointerDown={(pointerEvent) => {
                  onFocusStage(stage.id);
                  handlePanelResizeStart(pointerEvent, stage.id, STAGE_PANEL_RESIZE_RIGHT_EDGE);
                }}
                onKeyDown={(keyboardEvent) =>
                  handlePanelResizeKeyDown(keyboardEvent, stage.id, STAGE_PANEL_RESIZE_RIGHT_EDGE)}
                className={cn(
                  "group absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none",
                  "focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:outline-none",
                )}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-full bg-(--border) opacity-0 transition-fade-surface group-hover:bg-(--foreground-tertiary) group-hover:opacity-100 group-focus-visible:bg-(--accent-blue) group-focus-visible:opacity-100"
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
