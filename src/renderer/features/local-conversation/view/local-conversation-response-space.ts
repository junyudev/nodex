import { animate, cancelFrame, frame, motionValue } from "motion/react";
import type { LocalConversationThreadScrollControllerValue } from "./local-conversation-thread-scroll-controller";
import { resolveResponseSpacerHeightPx } from "./local-conversation-turn-virtualization";

export const THREAD_RESPONSE_PLACEMENT_TRANSITION = {
  type: "spring",
  bounce: 0,
  duration: 0.5,
} as const;

export function readThreadScrollPaddingBottomPx(element: HTMLElement): number {
  const value = Number.parseFloat(element.style.getPropertyValue("--thread-scroll-padding-bottom"));
  return Number.isFinite(value) ? value : 0;
}

type ResponseSpaceScrollController = Pick<
  LocalConversationThreadScrollControllerValue,
  | "getScrollElement"
  | "getScrollDistanceFromBottomPx"
  | "getLastScrollDistanceFromBottomPx"
  | "getUnroundedScrollDistanceFromBottomPx"
  | "compensateScrollToDistanceFromBottomPx"
  | "scrollToDistanceFromBottomPx"
  | "holdViewport"
>;

/** Owns real scroll placement and consumes response growth without translating transcript rows. */
export function createThreadResponseSpaceController(
  initialScrollController: ResponseSpaceScrollController,
) {
  let scrollController = initialScrollController;
  let prefersReducedMotion = true;
  let onReleased: (() => void) | undefined;
  let element: HTMLDivElement | null = null;
  let stopPlacementAnimation: (() => void) | null = null;
  let pendingUserScrollDecayPx = 0;
  let pendingUserScrollElement: HTMLDivElement | null = null;
  let userScrollDecayAnimationFrame: number | null = null;
  let viewportHeightPx: number | null = null;
  let scrollPaddingBottomPx: number | null = null;
  let canPrepareThreadEndContent = false;
  let placementTarget: HTMLElement | undefined;
  const height = motionValue(0);

  const stop = () => {
    stopPlacementAnimation?.();
    stopPlacementAnimation = null;
  };
  const writeHeight = (value: number) => {
    height.set(value);
    if (element) element.style.height = `${value}px`;
  };
  const cancelPendingUserScrollDecay = () => {
    if (userScrollDecayAnimationFrame !== null) {
      window.cancelAnimationFrame(userScrollDecayAnimationFrame);
      userScrollDecayAnimationFrame = null;
    }
    pendingUserScrollDecayPx = 0;
    pendingUserScrollElement = null;
  };
  const clear = () => {
    canPrepareThreadEndContent = false;
    stop();
    cancelPendingUserScrollDecay();
    writeHeight(0);
    placementTarget = undefined;
  };
  const trimTo = (targetHeightPx: number): boolean => {
    const previous = height.get();
    const next = Math.max(0, Math.min(previous, targetHeightPx));
    if (previous <= next) return false;
    const scrollElement = scrollController.getScrollElement();
    const distance = scrollElement === null ? 0 : scrollController.getScrollDistanceFromBottomPx();
    writeHeight(next);
    if (scrollElement) {
      scrollController.compensateScrollToDistanceFromBottomPx(
        Math.max(0, distance - (previous - next)),
      );
    }
    if (next === 0) onReleased?.();
    return true;
  };
  const collapseIfHidden = () => {
    const scrollElement = scrollController.getScrollElement();
    if (height.get() <= 0 || stopPlacementAnimation || !scrollElement || !element) return;
    const viewport = scrollElement.getBoundingClientRect();
    const scale = viewport.height / scrollElement.clientHeight;
    const visibleBottom = viewport.bottom - readThreadScrollPaddingBottomPx(scrollElement) * scale;
    if (element.getBoundingClientRect().top < visibleBottom - scale) return;
    trimTo(0);
  };
  const flushUserScrollDecay = () => {
    userScrollDecayAnimationFrame = null;
    const decay = pendingUserScrollDecayPx;
    const pendingElement = pendingUserScrollElement;
    pendingUserScrollDecayPx = 0;
    pendingUserScrollElement = null;
    if (pendingElement !== scrollController.getScrollElement()) return;
    if (trimTo(height.get() - decay)) collapseIfHidden();
  };
  const getPlacementDistancePx = (scrollElement: HTMLDivElement) => {
    if (!placementTarget) return 1;
    const bounds = scrollElement.getBoundingClientRect();
    const scale = bounds.height / (scrollElement.offsetHeight || scrollElement.clientHeight);
    const paddingTop = Number.parseFloat(getComputedStyle(scrollElement).paddingTop) || 0;
    return (
      scrollController.getScrollDistanceFromBottomPx() -
      (placementTarget.getBoundingClientRect().top - bounds.top) / scale +
      scrollElement.clientTop +
      paddingTop
    );
  };
  const animatePlacement = () => {
    const scrollElement = scrollController.getScrollElement();
    if (!scrollElement) return;
    const placementDistance = Math.max(1, getPlacementDistancePx(scrollElement));
    const distance = scrollController.getLastScrollDistanceFromBottomPx() - placementDistance;
    if (prefersReducedMotion || distance <= 0) {
      scrollController.scrollToDistanceFromBottomPx(placementDistance, "instant");
      return;
    }
    let previousProgress = 0;
    let stopped = false;
    const animation = animate(0, distance, {
      ...THREAD_RESPONSE_PLACEMENT_TRANSITION,
      driver: (update) => {
        let elapsed = 0;
        const tick = ({ delta }: { delta: number }) => {
          elapsed += delta;
          update(elapsed);
        };
        return {
          start: () => frame.update(tick, true),
          stop: () => cancelFrame(tick),
          now: () => elapsed,
        };
      },
      onUpdate: (progress) => {
        if (stopped) return;
        const current = scrollController.getUnroundedScrollDistanceFromBottomPx(
          scrollController.getLastScrollDistanceFromBottomPx(),
        );
        scrollController.compensateScrollToDistanceFromBottomPx(
          Math.max(1, current - (progress - previousProgress)),
        );
        previousProgress = progress;
      },
      onComplete: () => {
        stopPlacementAnimation = null;
        scrollController.compensateScrollToDistanceFromBottomPx(
          scrollController.getUnroundedScrollDistanceFromBottomPx(
            scrollController.getLastScrollDistanceFromBottomPx(),
          ),
        );
      },
    });
    stopPlacementAnimation = () => {
      stopped = true;
      animation.stop();
    };
  };

  return {
    height,
    updateContext: (
      next: ResponseSpaceScrollController,
      reducedMotion: boolean,
      released?: () => void,
    ) => {
      scrollController = next;
      prefersReducedMotion = reducedMotion;
      onReleased = released;
    },
    setElement: (next: HTMLDivElement | null) => {
      element = next;
      if (next) next.style.height = `${height.get()}px`;
    },
    getElement: () => element,
    getHeightPx: () => height.get(),
    stop,
    clear,
    cancelPendingUserScrollDecay,
    consumeGrowth: (growth: number) => writeHeight(Math.max(0, height.get() - Math.max(0, growth))),
    prepareThreadEndContent: () => {
      const scrollElement = scrollController.getScrollElement();
      if (
        !canPrepareThreadEndContent ||
        stopPlacementAnimation ||
        !scrollElement ||
        scrollElement.clientHeight <= 0 ||
        !element
      )
        return;
      const bounds = scrollElement.getBoundingClientRect();
      const visibleBottom =
        bounds.bottom -
        readThreadScrollPaddingBottomPx(scrollElement) *
          (bounds.height / scrollElement.clientHeight);
      if (element.getBoundingClientRect().top > visibleBottom) return;
      canPrepareThreadEndContent = false;
      cancelPendingUserScrollDecay();
      writeHeight(Math.max(0, height.get() - scrollController.getScrollDistanceFromBottomPx()));
      scrollController.compensateScrollToDistanceFromBottomPx(0);
    },
    collapseIfHidden,
    handleScroll: (distance: number) => {
      const scrollElement = scrollController.getScrollElement();
      if (
        height.get() <= 0 ||
        !scrollElement ||
        scrollElement.scrollHeight > scrollElement.clientHeight
      )
        return;
      if (scrollController.getUnroundedScrollDistanceFromBottomPx(distance) === 0) clear();
    },
    handleUserScroll: (distance: number, previous?: number) => {
      stop();
      if (previous === undefined) return;
      if (distance === 0) {
        clear();
        return;
      }
      const decay = distance - previous;
      if (decay <= 0) return;
      canPrepareThreadEndContent = false;
      const scrollElement = scrollController.getScrollElement();
      if (pendingUserScrollElement !== scrollElement) cancelPendingUserScrollDecay();
      pendingUserScrollElement = scrollElement;
      pendingUserScrollDecayPx += decay;
      userScrollDecayAnimationFrame ??= window.requestAnimationFrame(flushUserScrollDecay);
    },
    reconcileViewport: () => {
      const scrollElement = scrollController.getScrollElement();
      if (!scrollElement || scrollElement.clientHeight <= 0) return;
      const padding = readThreadScrollPaddingBottomPx(scrollElement);
      const changed =
        viewportHeightPx !== scrollElement.clientHeight || scrollPaddingBottomPx !== padding;
      viewportHeightPx = scrollElement.clientHeight;
      scrollPaddingBottomPx = padding;
      const restartPlacement = changed && stopPlacementAnimation !== null;
      const couldPrepareThreadEndContent = canPrepareThreadEndContent;
      if (restartPlacement) {
        canPrepareThreadEndContent = false;
        stop();
      }
      const trimmed = trimTo(
        placementTarget
          ? Math.max(0, viewportHeightPx - padding)
          : resolveResponseSpacerHeightPx({ viewportHeightPx, scrollPaddingBottomPx: padding }),
      );
      if (!restartPlacement) return;
      if (!trimmed)
        scrollController.compensateScrollToDistanceFromBottomPx(
          scrollController.getScrollDistanceFromBottomPx(),
        );
      animatePlacement();
      canPrepareThreadEndContent = couldPrepareThreadEndContent;
    },
    place: (target?: HTMLElement) => {
      const scrollElement = scrollController.getScrollElement();
      if (!scrollElement) return;
      canPrepareThreadEndContent = false;
      cancelPendingUserScrollDecay();
      stop();
      placementTarget = target;
      viewportHeightPx = scrollElement.clientHeight;
      scrollPaddingBottomPx = readThreadScrollPaddingBottomPx(scrollElement);
      const previousHeight = height.get();
      const distance = scrollController.getScrollDistanceFromBottomPx();
      const placementDistance = getPlacementDistancePx(scrollElement);
      scrollController.holdViewport();
      writeHeight(
        target
          ? Math.max(0, previousHeight - placementDistance + 1)
          : resolveResponseSpacerHeightPx({ viewportHeightPx, scrollPaddingBottomPx }),
      );
      if (!prefersReducedMotion)
        scrollController.compensateScrollToDistanceFromBottomPx(
          distance + height.get() - previousHeight,
        );
      animatePlacement();
      canPrepareThreadEndContent = true;
    },
  };
}

export type ThreadResponseSpaceController = ReturnType<typeof createThreadResponseSpaceController>;
