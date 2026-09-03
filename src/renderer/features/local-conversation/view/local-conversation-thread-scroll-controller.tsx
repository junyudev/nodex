import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { CODEX_SHELL_PANEL_TRANSITION } from "../../../lib/codex-panel-motion";
import { cn } from "../../../lib/utils";
import {
  REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE,
  REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
} from "../../../../shared/remote-hosted-pip";
import {
  buildPendingLatestTurnSubmitPlacement,
  resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta,
  type MeasuredTurnHeightDeltaInput,
  type PendingLatestTurnSubmitPlacement,
  type ThreadScrollMode,
  THREAD_NEAR_BOTTOM_THRESHOLD_PX,
} from "./local-conversation-turn-virtualization";
import type { LocalConversationThreadRestoreSnapshot } from "./local-conversation-thread-view-state";

const USER_SCROLL_WHEEL_DELTA_THRESHOLD_PX = 12;
const USER_SCROLL_GRACE_WINDOW_MS = 1_000;
const PROGRAMMATIC_SCROLL_SETTLE_WINDOW_MS = 64;
const SCROLL_TO_BOTTOM_ANIMATION_DURATION_MS = 260;
const WHEEL_DELTA_LINE_HEIGHT_PX = 16;

export interface ThreadScrollPositionSnapshot {
  scrollDistanceFromBottomPx: number;
}

export type ThreadScrollListener = (scrollDistanceFromBottomPx: number) => void;
export type ThreadUserScrollListener = (
  scrollDistanceFromBottomPx: number,
  previousScrollDistanceFromBottomPx?: number,
) => void;

export interface ThreadResponseSpacerState {
  getHeightPx: () => number;
  scrollToBottom: () => void;
}

export interface ThreadScrollModeResolutionInput {
  currentMode: ThreadScrollMode;
  isNearBottom: boolean;
  nowMs: number;
  userScrollGraceUntilMs: number;
  programmaticScrollSettledUntilMs: number;
}

export interface LocalConversationThreadScrollControllerValue {
  isScrolledFromBottom: boolean;
  scrollElement: HTMLDivElement | null;
  notifyContentLayout: () => void;
  suppressAutoStickToBottom: () => void;
  setScrollMode: (mode: ThreadScrollMode) => void;
  getScrollMode: () => ThreadScrollMode;
  addScrollListener: (listener: ThreadScrollListener) => () => void;
  addUserScrollListener: (listener: ThreadUserScrollListener) => () => void;
  clearPendingLatestTurnSubmitPlacement: () => void;
  consumePendingLatestTurnSubmitPlacement: () => PendingLatestTurnSubmitPlacement | null;
  getLastScrollDistanceFromBottomPx: () => number;
  getScrollElement: () => HTMLDivElement | null;
  getScrollDistanceFromBottomPx: () => number;
  maybeStickToBottom: () => void;
  preserveScrollPositionForNextLayout: () => void;
  prepareLatestTurnSubmitPlacement: () => PendingLatestTurnSubmitPlacement | null;
  registerResponseSpacerState: (state: ThreadResponseSpacerState | null) => void;
  responseSpacerState: ThreadResponseSpacerState | null;
  scrollToBottom: () => void;
  jumpToBottom: () => void;
  scrollElementIntoView: (
    targetElement: HTMLElement,
    behavior?: ScrollBehavior,
    block?: ScrollLogicalPosition,
  ) => void;
  scrollToDistanceFromBottomPx: (distanceFromBottomPx: number, behavior?: ScrollBehavior) => void;
  setFooterResizeViewportPreserveDisabled: (disabled: boolean) => void;
  adjustForMeasuredTurnHeightDelta: (
    input: Omit<MeasuredTurnHeightDeltaInput, "currentScrollDistanceFromBottomPx" | "scrollMode">,
  ) => void;
}

export interface LocalConversationThreadScrollLayoutHandle {
  scrollToBottom: () => void;
}

interface LocalConversationThreadScrollLayoutProps {
  children: ReactNode;
  contentX?: number;
  footer?: ReactNode;
  scrollViewClassName?: string;
  contentWrapperClassName?: string;
  initialRestoreSnapshot?: LocalConversationThreadRestoreSnapshot;
}

interface LocalConversationThreadScrollControllerContextValue extends LocalConversationThreadScrollControllerValue {
  registerScrollElement: (element: HTMLDivElement | null) => void;
}

const THREAD_SCROLL_VIEWPORT_CLASS_NAME =
  "thread-scroll-container relative h-full overflow-x-hidden overflow-y-auto [overflow-anchor:none] [scroll-padding-bottom:var(--thread-scroll-padding-bottom,0px)] electron:[scrollbar-gutter:stable_both-edges] pt-(--thread-content-top-inset) [container-name:thread-content] [container-type:inline-size] [&:has([data-thread-scroll-footer='true']:focus-within)]:[scroll-padding-bottom:0px] flex flex-col-reverse";

const THREAD_SCROLL_CONTENT_WRAPPER_CLASS_NAME =
  "mx-auto w-full max-w-(--thread-content-max-width) px-toolbar";

const LocalConversationThreadScrollControllerContext =
  createContext<LocalConversationThreadScrollControllerContextValue | null>(null);

export function isThreadScrollNearBottom({
  scrollDistanceFromBottomPx,
}: ThreadScrollPositionSnapshot): boolean {
  return scrollDistanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX;
}

export function resolveThreadScrollModeForScrollEvent({
  currentMode,
  isNearBottom,
  nowMs,
  userScrollGraceUntilMs,
  programmaticScrollSettledUntilMs,
}: ThreadScrollModeResolutionInput): ThreadScrollMode {
  if (currentMode === "programmaticFind") {
    if (isNearBottom) return "stickToBottom";
    if (nowMs <= programmaticScrollSettledUntilMs) {
      return "programmaticFind";
    }
    return "user";
  }
  if (isNearBottom) return "stickToBottom";
  if (nowMs > programmaticScrollSettledUntilMs && nowMs <= userScrollGraceUntilMs) {
    return "user";
  }
  return currentMode;
}

export function getThreadScrollDistanceFromBottomPx(
  element: Pick<HTMLElement, "scrollTop">,
): number {
  return Math.max(0, -element.scrollTop);
}

function resolveScrollDistanceFromBottomPx(
  element: HTMLDivElement,
  distanceFromBottomPx: number,
): number {
  const maxDistanceFromBottomPx = Math.max(0, element.scrollHeight - element.clientHeight);
  return Math.max(0, Math.min(distanceFromBottomPx, maxDistanceFromBottomPx));
}

export function resolveNativeScrollTopForDistanceFromBottomPx(
  element: HTMLDivElement,
  distanceFromBottomPx: number,
): number {
  const nextDistanceFromBottomPx = resolveScrollDistanceFromBottomPx(element, distanceFromBottomPx);
  return nextDistanceFromBottomPx === 0 ? 0 : -nextDistanceFromBottomPx;
}

function resolveWheelDeltaPx(event: WheelEvent, viewportHeightPx: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * WHEEL_DELTA_LINE_HEIGHT_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewportHeightPx;
  }
  return event.deltaY;
}

export function useLocalConversationThreadScrollController() {
  const context = useContext(LocalConversationThreadScrollControllerContext);
  if (context === null) {
    throw new Error(
      "useLocalConversationThreadScrollController must be used within a LocalConversationThreadScrollControllerProvider",
    );
  }
  return context;
}

function LocalConversationThreadScrollControllerProvider({ children }: { children: ReactNode }) {
  const reducedMotion = useResolvedReducedMotion();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [isScrolledFromBottom, setIsScrolledFromBottom] = useState(false);
  const [responseSpacerState, setResponseSpacerState] = useState<ThreadResponseSpacerState | null>(
    null,
  );
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const responseSpacerStateRef = useRef<ThreadResponseSpacerState | null>(null);
  const scrollModeRef = useRef<ThreadScrollMode>("stickToBottom");
  const lastScrollDistanceFromBottomPxRef = useRef(0);
  const userScrollGraceUntilRef = useRef(0);
  const programmaticScrollSettledUntilRef = useRef(0);
  const programmaticFindSettleTimeoutRef = useRef<number | null>(null);
  const scrollListenersRef = useRef(new Set<ThreadScrollListener>());
  const userScrollListenersRef = useRef(new Set<ThreadUserScrollListener>());
  const footerResizeViewportPreserveDisabledRef = useRef(false);
  const scrollToBottomAnimationFrameRef = useRef<number | null>(null);
  const pendingPreserveRef = useRef<{
    distanceFromBottomPx: number;
    frameId: number;
    scrollElement: HTMLDivElement;
    scrollHeightPx: number;
    wheelDistanceFromBottomPx: number;
  } | null>(null);
  const pendingLatestTurnSubmitPlacementRef = useRef<PendingLatestTurnSubmitPlacement | null>(null);

  const registerScrollElement = useCallback((element: HTMLDivElement | null) => {
    scrollElementRef.current = element;
    setScrollElement(element);
  }, []);

  useEffect(() => {
    responseSpacerStateRef.current = responseSpacerState;
  }, [responseSpacerState]);

  const cancelPendingPreserve = useCallback(() => {
    const pending = pendingPreserveRef.current;
    if (pending === null) return;
    window.cancelAnimationFrame(pending.frameId);
    pendingPreserveRef.current = null;
  }, []);

  const cancelScrollToBottomAnimation = useCallback(() => {
    if (scrollToBottomAnimationFrameRef.current === null) return;
    window.cancelAnimationFrame(scrollToBottomAnimationFrameRef.current);
    scrollToBottomAnimationFrameRef.current = null;
  }, []);

  const recordScrollDistance = useCallback(
    (
      scrollDistanceFromBottomPx: number,
      opts?: { userInitiated?: boolean; previousScrollDistanceFromBottomPx?: number },
    ) => {
      const previousScrollDistanceFromBottomPx =
        opts?.previousScrollDistanceFromBottomPx ?? lastScrollDistanceFromBottomPxRef.current;
      lastScrollDistanceFromBottomPxRef.current = scrollDistanceFromBottomPx;
      const isNearBottom = isThreadScrollNearBottom({ scrollDistanceFromBottomPx });
      const nextIsScrolledFromBottom = !isNearBottom;
      setIsScrolledFromBottom((current) =>
        current === nextIsScrolledFromBottom ? current : nextIsScrolledFromBottom,
      );

      for (const listener of scrollListenersRef.current) {
        listener(scrollDistanceFromBottomPx);
      }

      if (opts?.userInitiated !== true) return;
      for (const listener of userScrollListenersRef.current) {
        listener(scrollDistanceFromBottomPx, previousScrollDistanceFromBottomPx);
      }
    },
    [],
  );

  const writeNativeScrollDistance = useCallback(
    (element: HTMLDivElement, distanceFromBottomPx: number, behavior: ScrollBehavior) => {
      const nextDistanceFromBottomPx = resolveScrollDistanceFromBottomPx(
        element,
        distanceFromBottomPx,
      );
      element.scrollTo({
        behavior,
        top: nextDistanceFromBottomPx === 0 ? 0 : -nextDistanceFromBottomPx,
      });
      recordScrollDistance(nextDistanceFromBottomPx);
    },
    [recordScrollDistance],
  );

  const setScrollMode = useCallback((mode: ThreadScrollMode) => {
    if (scrollModeRef.current === mode) return;
    scrollModeRef.current = mode;

    if (programmaticFindSettleTimeoutRef.current !== null) {
      window.clearTimeout(programmaticFindSettleTimeoutRef.current);
      programmaticFindSettleTimeoutRef.current = null;
    }

    if (mode !== "programmaticFind") {
      return;
    }

    programmaticFindSettleTimeoutRef.current = window.setTimeout(() => {
      programmaticFindSettleTimeoutRef.current = null;
      if (scrollModeRef.current !== "programmaticFind") {
        return;
      }

      const element = scrollElementRef.current;
      if (!element) {
        scrollModeRef.current = "user";
        return;
      }

      const isNearBottom = isThreadScrollNearBottom({
        scrollDistanceFromBottomPx: getThreadScrollDistanceFromBottomPx(element),
      });
      scrollModeRef.current = isNearBottom ? "stickToBottom" : "user";
      setIsScrolledFromBottom(!isNearBottom);
    }, PROGRAMMATIC_SCROLL_SETTLE_WINDOW_MS);
  }, []);

  const getScrollMode = useCallback(() => scrollModeRef.current, []);

  const getScrollElement = useCallback(() => scrollElementRef.current, []);

  const getLastScrollDistanceFromBottomPx = useCallback(
    () => lastScrollDistanceFromBottomPxRef.current,
    [],
  );

  const getScrollDistanceFromBottomPx = useCallback(() => {
    const element = scrollElementRef.current;
    if (element === null) return lastScrollDistanceFromBottomPxRef.current;
    const distanceFromBottomPx = getThreadScrollDistanceFromBottomPx(element);
    lastScrollDistanceFromBottomPxRef.current = distanceFromBottomPx;
    return distanceFromBottomPx;
  }, []);

  const addScrollListener = useCallback((listener: ThreadScrollListener) => {
    scrollListenersRef.current.add(listener);
    return () => {
      scrollListenersRef.current.delete(listener);
    };
  }, []);

  const addUserScrollListener = useCallback((listener: ThreadUserScrollListener) => {
    userScrollListenersRef.current.add(listener);
    return () => {
      userScrollListenersRef.current.delete(listener);
    };
  }, []);

  const registerResponseSpacerState = useCallback((state: ThreadResponseSpacerState | null) => {
    if (responseSpacerStateRef.current === state) return;
    responseSpacerStateRef.current = state;
    setResponseSpacerState(state);
  }, []);

  const prepareLatestTurnSubmitPlacement = useCallback(() => {
    const element = scrollElementRef.current;
    const placement = buildPendingLatestTurnSubmitPlacement({
      distanceFromBottomPx: getScrollDistanceFromBottomPx(),
      responseSpacerHeightPx: responseSpacerStateRef.current?.getHeightPx() ?? 0,
      scrollHeightPx: element?.scrollHeight ?? null,
    });
    pendingLatestTurnSubmitPlacementRef.current = placement;
    return placement;
  }, [getScrollDistanceFromBottomPx]);

  const consumePendingLatestTurnSubmitPlacement = useCallback(() => {
    const placement = pendingLatestTurnSubmitPlacementRef.current;
    pendingLatestTurnSubmitPlacementRef.current = null;
    return placement;
  }, []);

  const clearPendingLatestTurnSubmitPlacement = useCallback(() => {
    pendingLatestTurnSubmitPlacementRef.current = null;
  }, []);

  const scrollToDistanceFromBottomPx = useCallback(
    (distanceFromBottomPx: number, behavior: ScrollBehavior = "auto") => {
      const element = scrollElementRef.current;
      if (element === null) return;
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
      programmaticScrollSettledUntilRef.current =
        performance.now() + PROGRAMMATIC_SCROLL_SETTLE_WINDOW_MS;
      writeNativeScrollDistance(element, distanceFromBottomPx, behavior);
    },
    [cancelPendingPreserve, cancelScrollToBottomAnimation, writeNativeScrollDistance],
  );

  const scrollElementIntoView = useCallback(
    (
      targetElement: HTMLElement,
      behavior: ScrollBehavior = "auto",
      block: ScrollLogicalPosition = "start",
    ) => {
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
      programmaticScrollSettledUntilRef.current =
        performance.now() + PROGRAMMATIC_SCROLL_SETTLE_WINDOW_MS;
      targetElement.scrollIntoView({ behavior, block, inline: "nearest" });
    },
    [cancelPendingPreserve, cancelScrollToBottomAnimation],
  );

  const setFooterResizeViewportPreserveDisabled = useCallback(
    (disabled: boolean) => {
      footerResizeViewportPreserveDisabledRef.current = disabled;
      if (disabled) {
        cancelPendingPreserve();
      }
    },
    [cancelPendingPreserve],
  );

  const preserveScrollPositionForNextLayout = useCallback(() => {
    const element = scrollElementRef.current;
    if (element === null || footerResizeViewportPreserveDisabledRef.current) return;
    if (pendingPreserveRef.current !== null) return;

    const pending = {
      distanceFromBottomPx: getThreadScrollDistanceFromBottomPx(element),
      frameId: 0,
      scrollElement: element,
      scrollHeightPx: element.scrollHeight,
      wheelDistanceFromBottomPx: 0,
    };
    pending.frameId = window.requestAnimationFrame(() => {
      if (pendingPreserveRef.current !== pending) return;
      pendingPreserveRef.current = null;
      if (scrollElementRef.current !== pending.scrollElement) return;
      if (pending.scrollElement.scrollHeight === pending.scrollHeightPx) return;
      writeNativeScrollDistance(
        pending.scrollElement,
        pending.distanceFromBottomPx + pending.wheelDistanceFromBottomPx,
        "auto",
      );
    });
    pendingPreserveRef.current = pending;
  }, [writeNativeScrollDistance]);

  const maybeStickToBottom = useCallback(() => {
    if (scrollModeRef.current !== "stickToBottom") return;
    const element = scrollElementRef.current;
    if (element === null) return;
    scrollToDistanceFromBottomPx(0, "auto");
  }, [scrollToDistanceFromBottomPx]);

  const notifyContentLayout = useCallback(() => {
    maybeStickToBottom();
  }, [maybeStickToBottom]);

  const adjustForMeasuredTurnHeightDelta = useCallback(
    ({
      heightDeltaPx,
      turnTopDistanceFromBottomPx,
      viewportBottomDistanceFromBottomPx,
    }: Omit<MeasuredTurnHeightDeltaInput, "currentScrollDistanceFromBottomPx" | "scrollMode">) => {
      const element = scrollElementRef.current;
      if (element === null) return;
      const adjustedScrollDistanceFromBottomPx =
        resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta({
          currentScrollDistanceFromBottomPx: getThreadScrollDistanceFromBottomPx(element),
          heightDeltaPx,
          turnTopDistanceFromBottomPx,
          viewportBottomDistanceFromBottomPx,
          scrollMode: scrollModeRef.current,
        });
      if (adjustedScrollDistanceFromBottomPx === null) return;
      scrollToDistanceFromBottomPx(adjustedScrollDistanceFromBottomPx, "auto");
    },
    [scrollToDistanceFromBottomPx],
  );

  const scrollToBottom = useCallback(() => {
    const element = scrollElementRef.current;
    if (element === null) return;
    setScrollMode("stickToBottom");
    cancelPendingPreserve();
    cancelScrollToBottomAnimation();

    const initialDistanceFromBottomPx = getThreadScrollDistanceFromBottomPx(element);
    if (reducedMotion || initialDistanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
      writeNativeScrollDistance(element, 0, "auto");
      return;
    }

    const startedAtMs = performance.now();
    const step = (nowMs: number) => {
      const currentElement = scrollElementRef.current;
      if (currentElement === null) {
        scrollToBottomAnimationFrameRef.current = null;
        return;
      }
      const progress = Math.min(1, (nowMs - startedAtMs) / SCROLL_TO_BOTTOM_ANIMATION_DURATION_MS);
      const nextDistanceFromBottomPx = initialDistanceFromBottomPx * (1 - progress) ** 3;
      writeNativeScrollDistance(currentElement, nextDistanceFromBottomPx, "auto");
      if (progress < 1) {
        scrollToBottomAnimationFrameRef.current = window.requestAnimationFrame(step);
        return;
      }
      writeNativeScrollDistance(currentElement, 0, "auto");
      scrollToBottomAnimationFrameRef.current = null;
    };
    scrollToBottomAnimationFrameRef.current = window.requestAnimationFrame(step);
  }, [
    cancelPendingPreserve,
    cancelScrollToBottomAnimation,
    reducedMotion,
    setScrollMode,
    writeNativeScrollDistance,
  ]);

  const jumpToBottom = useCallback(() => {
    setScrollMode("stickToBottom");
    scrollToDistanceFromBottomPx(0, "auto");
  }, [scrollToDistanceFromBottomPx, setScrollMode]);

  const suppressAutoStickToBottom = useCallback(() => {
    setScrollMode("user");
  }, [setScrollMode]);

  useEffect(() => {
    if (scrollElement === null) return;

    let mounted = true;
    const updateScrolledFromBottom = (isNearBottom: boolean) => {
      if (!mounted) return;
      setIsScrolledFromBottom(!isNearBottom);
    };

    const syncFromScrollPosition = () => {
      const previousScrollDistanceFromBottomPx = lastScrollDistanceFromBottomPxRef.current;
      const scrollDistanceFromBottomPx = getThreadScrollDistanceFromBottomPx(scrollElement);
      const isNearBottom = isThreadScrollNearBottom({ scrollDistanceFromBottomPx });
      const nextMode = resolveThreadScrollModeForScrollEvent({
        currentMode: scrollModeRef.current,
        isNearBottom,
        nowMs: performance.now(),
        userScrollGraceUntilMs: userScrollGraceUntilRef.current,
        programmaticScrollSettledUntilMs: programmaticScrollSettledUntilRef.current,
      });
      if (nextMode !== scrollModeRef.current) {
        scrollModeRef.current = nextMode;
      }
      updateScrolledFromBottom(isNearBottom);
      recordScrollDistance(scrollDistanceFromBottomPx, {
        previousScrollDistanceFromBottomPx,
        userInitiated: performance.now() <= userScrollGraceUntilRef.current,
      });
    };

    const initialDistanceFromBottomPx = getThreadScrollDistanceFromBottomPx(scrollElement);
    lastScrollDistanceFromBottomPxRef.current = initialDistanceFromBottomPx;
    updateScrolledFromBottom(
      isThreadScrollNearBottom({
        scrollDistanceFromBottomPx: initialDistanceFromBottomPx,
      }),
    );

    const frameId = window.requestAnimationFrame(() => {
      maybeStickToBottom();
    });

    const handleWheel = (event: WheelEvent) => {
      const pendingPreserve = pendingPreserveRef.current;
      if (pendingPreserve !== null) {
        pendingPreserve.wheelDistanceFromBottomPx -= resolveWheelDeltaPx(
          event,
          scrollElement.clientHeight,
        );
      }
      if (event.deltaY !== 0) {
        userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
      }
      if (event.deltaY < -USER_SCROLL_WHEEL_DELTA_THRESHOLD_PX) {
        setScrollMode("user");
      }
      cancelScrollToBottomAnimation();
    };

    const handlePointerDown = () => {
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
      userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
    };

    const handleScroll = () => {
      syncFromScrollPosition();
    };

    scrollElement.addEventListener("wheel", handleWheel, { passive: true });
    scrollElement.addEventListener("pointerdown", handlePointerDown, { passive: true });
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      mounted = false;
      window.cancelAnimationFrame(frameId);
      scrollElement.removeEventListener("wheel", handleWheel);
      scrollElement.removeEventListener("pointerdown", handlePointerDown);
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [
    cancelPendingPreserve,
    cancelScrollToBottomAnimation,
    maybeStickToBottom,
    recordScrollDistance,
    scrollElement,
    setScrollMode,
  ]);

  useEffect(
    () => () => {
      if (programmaticFindSettleTimeoutRef.current !== null) {
        window.clearTimeout(programmaticFindSettleTimeoutRef.current);
      }
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
    },
    [cancelPendingPreserve, cancelScrollToBottomAnimation],
  );

  const controller = useMemo<LocalConversationThreadScrollControllerContextValue>(
    () => ({
      addScrollListener,
      addUserScrollListener,
      adjustForMeasuredTurnHeightDelta,
      clearPendingLatestTurnSubmitPlacement,
      consumePendingLatestTurnSubmitPlacement,
      getLastScrollDistanceFromBottomPx,
      getScrollDistanceFromBottomPx,
      getScrollElement,
      getScrollMode,
      isScrolledFromBottom,
      jumpToBottom,
      maybeStickToBottom,
      notifyContentLayout,
      preserveScrollPositionForNextLayout,
      prepareLatestTurnSubmitPlacement,
      registerScrollElement,
      registerResponseSpacerState,
      responseSpacerState,
      scrollElementIntoView,
      scrollElement,
      scrollToBottom,
      scrollToDistanceFromBottomPx,
      setFooterResizeViewportPreserveDisabled,
      setScrollMode,
      suppressAutoStickToBottom,
    }),
    [
      addScrollListener,
      addUserScrollListener,
      adjustForMeasuredTurnHeightDelta,
      clearPendingLatestTurnSubmitPlacement,
      consumePendingLatestTurnSubmitPlacement,
      getLastScrollDistanceFromBottomPx,
      getScrollDistanceFromBottomPx,
      getScrollElement,
      getScrollMode,
      isScrolledFromBottom,
      jumpToBottom,
      maybeStickToBottom,
      notifyContentLayout,
      preserveScrollPositionForNextLayout,
      prepareLatestTurnSubmitPlacement,
      registerResponseSpacerState,
      responseSpacerState,
      scrollElementIntoView,
      scrollElement,
      scrollToBottom,
      scrollToDistanceFromBottomPx,
      setFooterResizeViewportPreserveDisabled,
      registerScrollElement,
      setScrollMode,
      suppressAutoStickToBottom,
    ],
  );

  return (
    <LocalConversationThreadScrollControllerContext.Provider value={controller}>
      {children}
    </LocalConversationThreadScrollControllerContext.Provider>
  );
}

export function EnsureLocalConversationThreadScrollController({
  children,
}: {
  children: ReactNode;
}) {
  const context = useContext(LocalConversationThreadScrollControllerContext);
  if (context !== null) return <>{children}</>;
  return (
    <LocalConversationThreadScrollControllerProvider>
      {children}
    </LocalConversationThreadScrollControllerProvider>
  );
}

export const LocalConversationThreadScrollLayout = forwardRef<
  LocalConversationThreadScrollLayoutHandle,
  LocalConversationThreadScrollLayoutProps
>(function LocalConversationThreadScrollLayout(
  {
    children,
    contentX,
    footer,
    initialRestoreSnapshot,
    scrollViewClassName,
    contentWrapperClassName,
  },
  ref,
) {
  const controller = useLocalConversationThreadScrollController();
  const reducedMotion = useResolvedReducedMotion();
  const footerRef = useRef<HTMLDivElement | null>(null);
  const preserveScrollPositionForNextLayout = controller.preserveScrollPositionForNextLayout;
  const scrollElement = controller.scrollElement;
  const restoredElementRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!scrollElement || restoredElementRef.current === scrollElement) return;
    restoredElementRef.current = scrollElement;
    const distanceFromBottomPx = initialRestoreSnapshot?.distanceFromBottomPx ?? 0;
    if (distanceFromBottomPx > THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
      controller.suppressAutoStickToBottom();
    } else {
      controller.setScrollMode("stickToBottom");
    }
    controller.scrollToDistanceFromBottomPx(
      distanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX ? 0 : distanceFromBottomPx,
      "auto",
    );
  }, [controller, initialRestoreSnapshot, scrollElement]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: controller.scrollToBottom,
    }),
    [controller.scrollToBottom],
  );

  useEffect(() => {
    const footerElement = footerRef.current;
    if (!scrollElement || !footerElement) return undefined;

    const syncFooterPadding = () => {
      preserveScrollPositionForNextLayout();
      const footerHeight = footerElement.getBoundingClientRect().height;
      scrollElement.style.setProperty("--thread-scroll-padding-bottom", `${footerHeight + 16}px`);
    };

    syncFooterPadding();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncFooterPadding);
      return () => {
        window.removeEventListener("resize", syncFooterPadding);
      };
    }

    const resizeObserver = new ResizeObserver(syncFooterPadding);
    resizeObserver.observe(footerElement);
    return () => {
      resizeObserver.disconnect();
    };
  }, [footer, preserveScrollPositionForNextLayout, scrollElement]);

  const motionStyle = contentX == null ? undefined : { x: contentX };

  return (
    <div
      data-thread-user-message-navigation-portal-target="true"
      className="relative h-full flex-1 [content-visibility:auto]"
    >
      <div
        ref={controller.registerScrollElement}
        data-local-conversation-thread-body="true"
        {...{
          [REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE]: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
        }}
        className={cn(THREAD_SCROLL_VIEWPORT_CLASS_NAME, scrollViewClassName)}
      >
        <motion.div
          style={motionStyle}
          transition={reducedMotion ? { duration: 0 } : CODEX_SHELL_PANEL_TRANSITION}
          className="flex min-h-full shrink-0 flex-col justify-start"
        >
          <div
            data-mcp-app-portal-target="true"
            className={cn(
              THREAD_SCROLL_CONTENT_WRAPPER_CLASS_NAME,
              "relative flex flex-1 shrink-0 flex-col pb-8",
              contentWrapperClassName,
            )}
          >
            {children}
          </div>
          {footer ? (
            <div
              ref={footerRef}
              data-thread-scroll-footer="true"
              className="sticky bottom-0 z-10 mt-auto w-full pb-4"
            >
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex h-full w-full justify-center pt-4">
                <div className="z-0 h-full w-full bg-gradient-to-t from-token-main-surface-primary via-token-main-surface-primary extension:from-token-bg-primary extension:via-token-bg-primary" />
              </div>
              <div
                {...{ [REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE]: "thread-footer" }}
                className="relative z-10 flex flex-col"
              >
                {footer}
              </div>
            </div>
          ) : null}
        </motion.div>
      </div>
    </div>
  );
});
