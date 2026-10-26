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
    stop();
    cancelPendingUserScrollDecay();
    writeHeight(0);
  };
  const trimTo = (targetHeightPx: number): boolean => {
    const previous = height.get();
    const next = Math.max(0, Math.min(previous, targetHeightPx));
    if (previous <= next) return false;
    const scrollElement = scrollController.getScrollElement();
    const distance = scrollElement === null ? 0 : scrollController.getScrollDistanceFromBottomPx();
    writeHeight(next);
    // Space removed below a top-origin reader leaves its native position unchanged, so this is a
    // no-op unless the browser clamped; an in-flight wheel animation keeps its full travel.
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
  const animatePlacement = () => {
    const distance = scrollController.getLastScrollDistanceFromBottomPx() - 1;
    if (prefersReducedMotion || distance <= 0) {
      scrollController.scrollToDistanceFromBottomPx(1, "instant");
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
        // Settle any physical-pixel remainder left by the last animated write.
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
      if (restartPlacement) stop();
      const trimmed = trimTo(
        resolveResponseSpacerHeightPx({ viewportHeightPx, scrollPaddingBottomPx: padding }),
      );
      if (!restartPlacement) return;
      if (!trimmed)
        scrollController.compensateScrollToDistanceFromBottomPx(
          scrollController.getScrollDistanceFromBottomPx(),
        );
      animatePlacement();
    },
    place: () => {
      const scrollElement = scrollController.getScrollElement();
      if (!scrollElement) return;
      cancelPendingUserScrollDecay();
      stop();
      viewportHeightPx = scrollElement.clientHeight;
      scrollPaddingBottomPx = readThreadScrollPaddingBottomPx(scrollElement);
      const previousHeight = height.get();
      const distance = scrollController.getScrollDistanceFromBottomPx();
      scrollController.holdViewport();
      writeHeight(resolveResponseSpacerHeightPx({ viewportHeightPx, scrollPaddingBottomPx }));
      if (!prefersReducedMotion)
        scrollController.compensateScrollToDistanceFromBottomPx(
          distance + height.get() - previousHeight,
        );
      animatePlacement();
    },
  };
}

export type ThreadResponseSpaceController = ReturnType<typeof createThreadResponseSpaceController>;
