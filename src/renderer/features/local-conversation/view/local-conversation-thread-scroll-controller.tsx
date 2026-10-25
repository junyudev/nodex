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
import { motion, type MotionValue } from "motion/react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
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
import {
  normalizeThreadRestoreDistanceFromBottomPx,
  type LocalConversationThreadRestoreSnapshot,
} from "./local-conversation-thread-view-state";
import {
  createLocalConversationNativeFindScroll,
  type LocalConversationNativeFindScroll,
} from "./local-conversation-native-find-scroll";

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
  holdViewport?: () => void;
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
  nativeFindTurnKey: string | null;
  scrollElement: HTMLDivElement | null;
  notifyContentLayout: () => void;
  suppressAutoStickToBottom: () => void;
  setScrollMode: (mode: ThreadScrollMode) => void;
  getScrollMode: () => ThreadScrollMode;
  addScrollListener: (listener: ThreadScrollListener) => () => void;
  addUserScrollListener: (listener: ThreadUserScrollListener) => () => void;
  clearPendingLatestTurnSubmitPlacement: () => void;
  consumePendingLatestTurnSubmitPlacement: () => PendingLatestTurnSubmitPlacement | null;
  hasPendingLatestTurnSubmitPlacement: () => boolean;
  getLastScrollDistanceFromBottomPx: () => number;
  getScrollElement: () => HTMLDivElement | null;
  getScrollDistanceFromBottomPx: () => number;
  getUnroundedScrollDistanceFromBottomPx: (fallback: number) => number;
  compensateScrollToDistanceFromBottomPx: (distance: number) => void;
  holdViewport: () => void;
  shouldFollowContentGrowth: () => boolean;
  maybeStickToBottom: () => void;
  preserveScrollPositionForNextLayout: () => void;
  prepareLatestTurnSubmitPlacement: (options?: {
    readonly placeLatestTurn?: boolean;
  }) => PendingLatestTurnSubmitPlacement | null;
  registerResponseSpacerState: (state: ThreadResponseSpacerState | null) => void;
  responseSpacerState: ThreadResponseSpacerState | null;
  scrollToBottom: () => void;
  jumpToBottom: () => void;
  scrollElementIntoView: (
    targetElement: HTMLElement,
    behavior?: ScrollBehavior,
    block?: ScrollLogicalPosition,
    findNavigation?: {
      readonly turnKey?: string;
      readonly readTarget: () => HTMLElement | null;
      readonly signal?: AbortSignal;
    },
  ) => void;
  scrollToDistanceFromBottomPx: (distanceFromBottomPx: number, behavior?: ScrollBehavior) => void;
  setFooterResizeViewportPreserveDisabled: (disabled: boolean) => void;
  setFooterHeightPx: (height: number) => void;
  adjustForMeasuredTurnHeightDelta: (
    input: Omit<MeasuredTurnHeightDeltaInput, "currentScrollDistanceFromBottomPx" | "scrollMode">,
  ) => void;
}

export interface LocalConversationThreadScrollLayoutHandle {
  scrollToBottom: () => void;
}

interface LocalConversationThreadScrollLayoutProps {
  children: ReactNode;
  contentX?: MotionValue<number>;
  footer?: ReactNode;
  scrollViewClassName?: string;
  contentWrapperClassName?: string;
  initialRestoreSnapshot?: LocalConversationThreadRestoreSnapshot;
}

interface LocalConversationThreadScrollControllerContextValue extends LocalConversationThreadScrollControllerValue {
  registerScrollElement: (element: HTMLDivElement | null) => void;
}

const THREAD_SCROLL_VIEWPORT_CLASS_NAME =
  "thread-scroll-container relative h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none] [scroll-padding-bottom:var(--thread-scroll-padding-bottom,0px)] electron:[scrollbar-gutter:stable_both-edges] pt-(--thread-content-top-inset) [container-name:thread-content] [container-type:inline-size] [&:has([data-thread-scroll-footer='true']:focus-within)]:[scroll-padding-bottom:0px] flex flex-col-reverse outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

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

export function resolveThreadScrollKeyDirection(
  event: KeyboardEvent,
  viewport: HTMLElement,
): "away" | "toward" | null {
  if (event.defaultPrevented) return null;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target !== viewport &&
    (target.isContentEditable ||
      target.closest("input, select, textarea") ||
      ((event.key === " " || event.key === "Spacebar") &&
        target.closest("button, [role='button']")))
  )
    return null;
  switch (event.key) {
    case "ArrowUp":
    case "Home":
    case "PageUp":
      return "away";
    case "ArrowDown":
    case "End":
    case "PageDown":
      return "toward";
    case " ":
    case "Spacebar":
      return event.shiftKey ? "away" : "toward";
    default:
      return null;
  }
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
  const [nativeFindTurnKey, setNativeFindTurnKey] = useState<string | null>(null);
  const [responseSpacerState, setResponseSpacerState] = useState<ThreadResponseSpacerState | null>(
    null,
  );
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const responseSpacerStateRef = useRef<ThreadResponseSpacerState | null>(null);
  const scrollModeRef = useRef<ThreadScrollMode>("stickToBottom");
  const lastScrollDistanceFromBottomPxRef = useRef(0);
  const roundedScrollRequestRef = useRef<{ requested: number; actual: number } | null>(null);
  const userScrollGraceUntilRef = useRef(0);
  const programmaticScrollSettledUntilRef = useRef(0);
  const programmaticFindSettleTimeoutRef = useRef<number | null>(null);
  const scrollListenersRef = useRef(new Set<ThreadScrollListener>());
  const userScrollListenersRef = useRef(new Set<ThreadUserScrollListener>());
  const footerResizeViewportPreserveDisabledRef = useRef(false);
  const footerHeightRef = useRef<{
    readonly element: HTMLDivElement;
    readonly height: number;
  } | null>(null);
  const scrollToBottomAnimationFrameRef = useRef<number | null>(null);
  const pendingPreserveRef = useRef<{
    distanceFromBottomPx: number;
    frameId: number;
    scrollElement: HTMLDivElement;
    scrollHeightPx: number;
    wheelDistanceFromBottomPx: number;
  } | null>(null);
  const pendingLatestTurnSubmitPlacementRef = useRef<PendingLatestTurnSubmitPlacement | null>(null);
  const nativeFindScrollRef = useRef<LocalConversationNativeFindScroll | null>(null);

  const cancelNativeFindScroll = useCallback(() => {
    const navigation = nativeFindScrollRef.current;
    nativeFindScrollRef.current = null;
    navigation?.cancel();
    if (navigation) setNativeFindTurnKey(null);
    if (navigation && scrollModeRef.current === "programmaticFind") scrollModeRef.current = "user";
  }, []);

  const registerScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (scrollElementRef.current !== element) cancelNativeFindScroll();
      scrollElementRef.current = element;
      setScrollElement(element);
    },
    [cancelNativeFindScroll],
  );

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
      const top = nextDistanceFromBottomPx === 0 ? 0 : -nextDistanceFromBottomPx;
      // Even a no-op native write can interrupt an in-flight browser scroll.
      if (element.scrollTop !== top) element.scrollTo({ behavior, top });
      const actual = getThreadScrollDistanceFromBottomPx(element);
      roundedScrollRequestRef.current =
        behavior === "instant" &&
        actual !== nextDistanceFromBottomPx &&
        nextDistanceFromBottomPx > 0 &&
        nextDistanceFromBottomPx < element.scrollHeight - element.clientHeight
          ? { requested: nextDistanceFromBottomPx, actual }
          : null;
      recordScrollDistance(actual);
      // Layout compensation must finish without retiring the current search destination.
      nativeFindScrollRef.current?.resume();
    },
    [recordScrollDistance],
  );

  const setScrollMode = useCallback(
    (mode: ThreadScrollMode) => {
      if (mode !== "programmaticFind") cancelNativeFindScroll();
      else userScrollGraceUntilRef.current = 0;
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
        if (nativeFindScrollRef.current) return;

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
    },
    [cancelNativeFindScroll],
  );

  const getScrollMode = useCallback(() => scrollModeRef.current, []);

  const getScrollElement = useCallback(() => scrollElementRef.current, []);

  const getLastScrollDistanceFromBottomPx = useCallback(
    () => lastScrollDistanceFromBottomPxRef.current,
    [],
  );

  const getScrollDistanceFromBottomPx = useCallback(() => {
    const element = scrollElementRef.current;
    if (element === null) return lastScrollDistanceFromBottomPxRef.current;
    // Geometry consumers must not consume the delta awaiting the native scroll event.
    return getThreadScrollDistanceFromBottomPx(element);
  }, []);

  const getUnroundedScrollDistanceFromBottomPx = useCallback((fallback: number) => {
    const request = roundedScrollRequestRef.current;
    return request?.actual === fallback ? request.requested : fallback;
  }, []);

  const shouldFollowContentGrowth = useCallback(
    () => scrollModeRef.current === "stickToBottom",
    [],
  );

  const holdViewport = useCallback(() => {
    cancelPendingPreserve();
    cancelScrollToBottomAnimation();
    setScrollMode("user");
    responseSpacerStateRef.current?.holdViewport?.();
  }, [cancelPendingPreserve, cancelScrollToBottomAnimation, setScrollMode]);

  const compensateScrollToDistanceFromBottomPx = useCallback(
    (distance: number) => {
      const element = scrollElementRef.current;
      if (!element || scrollToBottomAnimationFrameRef.current !== null) return;
      writeNativeScrollDistance(element, distance, "instant");
    },
    [writeNativeScrollDistance],
  );

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

  const prepareLatestTurnSubmitPlacement = useCallback(
    (options?: { readonly placeLatestTurn?: boolean }) => {
      cancelNativeFindScroll();
      const element = scrollElementRef.current;
      const placement = buildPendingLatestTurnSubmitPlacement({
        distanceFromBottomPx: getScrollDistanceFromBottomPx(),
        responseSpacerHeightPx: responseSpacerStateRef.current?.getHeightPx() ?? 0,
        scrollHeightPx: element?.scrollHeight ?? null,
        placeLatestTurn: options?.placeLatestTurn,
      });
      pendingLatestTurnSubmitPlacementRef.current = placement;
      return placement;
    },
    [cancelNativeFindScroll, getScrollDistanceFromBottomPx],
  );

  const consumePendingLatestTurnSubmitPlacement = useCallback(() => {
    const placement = pendingLatestTurnSubmitPlacementRef.current;
    pendingLatestTurnSubmitPlacementRef.current = null;
    return placement;
  }, []);

  const hasPendingLatestTurnSubmitPlacement = useCallback(
    () => pendingLatestTurnSubmitPlacementRef.current !== null,
    [],
  );

  const clearPendingLatestTurnSubmitPlacement = useCallback(() => {
    pendingLatestTurnSubmitPlacementRef.current = null;
  }, []);

  const scrollToDistanceFromBottomPx = useCallback(
    (distanceFromBottomPx: number, behavior: ScrollBehavior = "auto") => {
      const element = scrollElementRef.current;
      if (element === null) return;
      cancelNativeFindScroll();
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
      programmaticScrollSettledUntilRef.current =
        performance.now() + PROGRAMMATIC_SCROLL_SETTLE_WINDOW_MS;
      if (distanceFromBottomPx === 0 && scrollModeRef.current !== "programmaticFind")
        setScrollMode("stickToBottom");
      writeNativeScrollDistance(element, distanceFromBottomPx, behavior);
    },
    [
      cancelNativeFindScroll,
      cancelPendingPreserve,
      cancelScrollToBottomAnimation,
      setScrollMode,
      writeNativeScrollDistance,
    ],
  );

  const scrollElementIntoView = useCallback(
    (
      targetElement: HTMLElement,
      behavior: ScrollBehavior = "auto",
      block: ScrollLogicalPosition = "start",
      findNavigation?: {
        readonly turnKey?: string;
        readonly readTarget: () => HTMLElement | null;
        readonly signal?: AbortSignal;
      },
    ) => {
      cancelNativeFindScroll();
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
      programmaticScrollSettledUntilRef.current =
        performance.now() + PROGRAMMATIC_SCROLL_SETTLE_WINDOW_MS;
      const element = scrollElementRef.current;
      if (findNavigation && element && behavior === "smooth" && block === "center") {
        setScrollMode("programmaticFind");
        setNativeFindTurnKey(
          findNavigation.turnKey ??
            targetElement.closest<HTMLElement>("[data-turn-key]")?.dataset.turnKey ??
            null,
        );
        const navigation = createLocalConversationNativeFindScroll({
          scrollElement: element,
          readTarget: findNavigation.readTarget,
          signal: findNavigation.signal,
          onFinish: () => {
            if (nativeFindScrollRef.current !== navigation) return;
            nativeFindScrollRef.current = null;
            setNativeFindTurnKey(null);
            if (scrollModeRef.current !== "programmaticFind") return;
            const isNearBottom = isThreadScrollNearBottom({
              scrollDistanceFromBottomPx: getThreadScrollDistanceFromBottomPx(element),
            });
            setScrollMode(isNearBottom ? "stickToBottom" : "user");
            setIsScrolledFromBottom(!isNearBottom);
          },
        });
        nativeFindScrollRef.current = navigation;
        return;
      }
      targetElement.scrollIntoView({ behavior, block, inline: "nearest" });
    },
    [cancelNativeFindScroll, cancelPendingPreserve, cancelScrollToBottomAnimation, setScrollMode],
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

  const setFooterHeightPx = useCallback(
    (height: number) => {
      const element = scrollElementRef.current;
      if (!element) return;
      const previous =
        footerHeightRef.current?.element === element ? footerHeightRef.current.height : null;
      if (previous === height) return;
      element.style.setProperty("--thread-scroll-padding-bottom", `${height + 16}px`);
      footerHeightRef.current = { element, height };
      if (
        previous === null ||
        footerResizeViewportPreserveDisabledRef.current ||
        scrollToBottomAnimationFrameRef.current !== null
      )
        return;
      const distance = getThreadScrollDistanceFromBottomPx(element);
      if (distance <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) return;
      writeNativeScrollDistance(element, distance + height - previous, "instant");
    },
    [writeNativeScrollDistance],
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
    let userScrollDirection: "away" | "toward" | null = null;
    let scrollbarPointerStart: { scrollHeight: number; scrollTop: number } | null = null;
    let touch: Touch | null = null;
    const updateScrolledFromBottom = (isNearBottom: boolean) => {
      if (!mounted) return;
      setIsScrolledFromBottom(!isNearBottom);
    };

    const syncFromScrollPosition = () => {
      const previousScrollDistanceFromBottomPx = lastScrollDistanceFromBottomPxRef.current;
      const scrollDistanceFromBottomPx = getThreadScrollDistanceFromBottomPx(scrollElement);
      const isNearBottom = isThreadScrollNearBottom({ scrollDistanceFromBottomPx });
      if (scrollbarPointerStart) {
        if (
          scrollbarPointerStart.scrollHeight === scrollElement.scrollHeight &&
          scrollbarPointerStart.scrollTop !== scrollElement.scrollTop
        ) {
          userScrollDirection =
            scrollDistanceFromBottomPx > previousScrollDistanceFromBottomPx ? "away" : "toward";
          userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
        }
        scrollbarPointerStart = null;
      }
      const direction =
        scrollDistanceFromBottomPx > previousScrollDistanceFromBottomPx
          ? "away"
          : scrollDistanceFromBottomPx < previousScrollDistanceFromBottomPx
            ? "toward"
            : null;
      const userInitiated =
        direction !== null &&
        direction === userScrollDirection &&
        performance.now() <= userScrollGraceUntilRef.current;
      if (userInitiated) {
        scrollModeRef.current = isNearBottom && direction === "toward" ? "stickToBottom" : "user";
        userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
      }
      if (roundedScrollRequestRef.current?.actual !== scrollDistanceFromBottomPx)
        roundedScrollRequestRef.current = null;
      if (isNearBottom) {
        cancelScrollToBottomAnimation();
        if (userInitiated) userScrollDirection = null;
      }
      updateScrolledFromBottom(isNearBottom);
      recordScrollDistance(scrollDistanceFromBottomPx, {
        previousScrollDistanceFromBottomPx,
        userInitiated,
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
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.shiftKey ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      )
        return;
      const pendingPreserve = pendingPreserveRef.current;
      if (pendingPreserve !== null) {
        pendingPreserve.wheelDistanceFromBottomPx -= resolveWheelDeltaPx(
          event,
          scrollElement.clientHeight,
        );
      }
      userScrollDirection = event.deltaY < 0 ? "away" : "toward";
      userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
      roundedScrollRequestRef.current = null;
      cancelNativeFindScroll();
      cancelScrollToBottomAnimation();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = resolveThreadScrollKeyDirection(event, scrollElement);
      if (!direction) return;
      cancelNativeFindScroll();
      if (event.repeat) return;
      userScrollDirection = direction;
      userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
      roundedScrollRequestRef.current = null;
      cancelScrollToBottomAnimation();
    };
    const handlePointerDown = (event: PointerEvent) => {
      userScrollDirection = null;
      scrollbarPointerStart = null;
      if (event.pointerType !== "mouse" || event.target !== scrollElement) return;
      cancelNativeFindScroll();
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
      roundedScrollRequestRef.current = null;
      scrollbarPointerStart = {
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
      };
    };
    const handlePointerEnd = () => {
      scrollbarPointerStart = null;
    };
    const handleTouchStart = (event: TouchEvent) => {
      touch = event.touches.length === 1 ? (event.touches[0] ?? null) : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const next = event.touches.length === 1 ? event.touches[0] : null;
      if (!touch || !next || touch.identifier !== next.identifier) {
        touch = null;
        return;
      }
      const deltaX = next.clientX - touch.clientX;
      const deltaY = next.clientY - touch.clientY;
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 8) return;
      touch = null;
      if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
      cancelNativeFindScroll();
      userScrollDirection = deltaY > 0 ? "away" : "toward";
      userScrollGraceUntilRef.current = performance.now() + USER_SCROLL_GRACE_WINDOW_MS;
      roundedScrollRequestRef.current = null;
      cancelScrollToBottomAnimation();
    };
    const handleTouchEnd = () => {
      touch = null;
    };

    const handleScroll = () => {
      syncFromScrollPosition();
    };

    scrollElement.addEventListener("wheel", handleWheel, { passive: true });
    scrollElement.addEventListener("pointerdown", handlePointerDown, { passive: true });
    scrollElement.addEventListener("pointerup", handlePointerEnd, { passive: true });
    scrollElement.addEventListener("pointercancel", handlePointerEnd, { passive: true });
    scrollElement.addEventListener("keydown", handleKeyDown);
    scrollElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollElement.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollElement.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      mounted = false;
      window.cancelAnimationFrame(frameId);
      scrollElement.removeEventListener("wheel", handleWheel);
      scrollElement.removeEventListener("pointerdown", handlePointerDown);
      scrollElement.removeEventListener("pointerup", handlePointerEnd);
      scrollElement.removeEventListener("pointercancel", handlePointerEnd);
      scrollElement.removeEventListener("keydown", handleKeyDown);
      scrollElement.removeEventListener("touchstart", handleTouchStart);
      scrollElement.removeEventListener("touchmove", handleTouchMove);
      scrollElement.removeEventListener("touchend", handleTouchEnd);
      scrollElement.removeEventListener("touchcancel", handleTouchEnd);
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [
    cancelNativeFindScroll,
    cancelPendingPreserve,
    cancelScrollToBottomAnimation,
    maybeStickToBottom,
    recordScrollDistance,
    scrollElement,
    setScrollMode,
  ]);

  useEffect(
    () => () => {
      cancelNativeFindScroll();
      if (programmaticFindSettleTimeoutRef.current !== null) {
        window.clearTimeout(programmaticFindSettleTimeoutRef.current);
      }
      cancelPendingPreserve();
      cancelScrollToBottomAnimation();
    },
    [cancelNativeFindScroll, cancelPendingPreserve, cancelScrollToBottomAnimation],
  );

  const controller = useMemo<LocalConversationThreadScrollControllerContextValue>(
    () => ({
      addScrollListener,
      addUserScrollListener,
      compensateScrollToDistanceFromBottomPx,
      getUnroundedScrollDistanceFromBottomPx,
      holdViewport,
      shouldFollowContentGrowth,
      adjustForMeasuredTurnHeightDelta,
      clearPendingLatestTurnSubmitPlacement,
      consumePendingLatestTurnSubmitPlacement,
      hasPendingLatestTurnSubmitPlacement,
      getLastScrollDistanceFromBottomPx,
      getScrollDistanceFromBottomPx,
      getScrollElement,
      getScrollMode,
      isScrolledFromBottom,
      nativeFindTurnKey,
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
      setFooterHeightPx,
      setScrollMode,
      suppressAutoStickToBottom,
    }),
    [
      addScrollListener,
      addUserScrollListener,
      compensateScrollToDistanceFromBottomPx,
      getUnroundedScrollDistanceFromBottomPx,
      holdViewport,
      shouldFollowContentGrowth,
      adjustForMeasuredTurnHeightDelta,
      clearPendingLatestTurnSubmitPlacement,
      consumePendingLatestTurnSubmitPlacement,
      hasPendingLatestTurnSubmitPlacement,
      getLastScrollDistanceFromBottomPx,
      getScrollDistanceFromBottomPx,
      getScrollElement,
      getScrollMode,
      isScrolledFromBottom,
      nativeFindTurnKey,
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
      setFooterHeightPx,
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
  const registerScrollElement = controller.registerScrollElement;
  const registerViewport = useCallback(
    (element: HTMLDivElement | null) => registerScrollElement(element),
    [registerScrollElement],
  );
  const footerRef = useRef<HTMLDivElement | null>(null);
  const setFooterHeightPx = controller.setFooterHeightPx;
  const scrollElement = controller.scrollElement;
  const restoredElementRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!scrollElement || restoredElementRef.current === scrollElement) return;
    restoredElementRef.current = scrollElement;
    const followMode = initialRestoreSnapshot?.latestTurn?.followMode;
    const distanceFromBottomPx = normalizeThreadRestoreDistanceFromBottomPx(
      initialRestoreSnapshot?.distanceFromBottomPx ?? 0,
      followMode,
    );
    if (distanceFromBottomPx > 0 || followMode === "user_hold") {
      controller.suppressAutoStickToBottom();
    } else {
      controller.setScrollMode("stickToBottom");
    }
    controller.scrollToDistanceFromBottomPx(distanceFromBottomPx, "auto");
    // A zero-distance native restore must not take ownership back from the reader.
    if (followMode === "user_hold") controller.suppressAutoStickToBottom();
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

    const syncFooterPadding = (entries?: readonly ResizeObserverEntry[]) => {
      const box = entries?.find((entry) => entry.target === footerElement)?.borderBoxSize;
      const measured = box?.[0]?.blockSize;
      const windowZoom =
        Number.parseFloat(
          getComputedStyle(footerElement).getPropertyValue("--codex-window-zoom"),
        ) || 1;
      const footerHeight = measured ?? footerElement.getBoundingClientRect().height / windowZoom;
      setFooterHeightPx(footerHeight);
    };

    syncFooterPadding();

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => syncFooterPadding();
      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
      };
    }

    const resizeObserver = new ResizeObserver(syncFooterPadding);
    resizeObserver.observe(footerElement);
    return () => {
      resizeObserver.disconnect();
    };
  }, [footer, setFooterHeightPx, scrollElement]);

  const motionStyle = contentX == null ? undefined : { x: contentX };

  return (
    <div
      data-thread-user-message-navigation-portal-target="true"
      className="relative h-full flex-1 [content-visibility:auto]"
    >
      <div
        ref={registerViewport}
        data-local-conversation-thread-body="true"
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        {...{
          [REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE]: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
        }}
        className={cn(THREAD_SCROLL_VIEWPORT_CLASS_NAME, scrollViewClassName)}
      >
        <motion.div style={motionStyle} className="flex min-h-full shrink-0 flex-col justify-start">
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
              aria-hidden="true"
              className="pointer-events-none sticky bottom-0 z-10 mt-auto w-full shrink-0 h-[calc(var(--thread-scroll-padding-bottom)-16px)]"
            />
          ) : null}
        </motion.div>
      </div>
      {footer ? (
        <motion.div
          ref={footerRef}
          data-thread-scroll-footer="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-4"
          style={motionStyle}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex h-full w-full justify-center pt-4">
            <div className="z-0 h-full w-full bg-gradient-to-t from-token-main-surface-primary via-token-main-surface-primary extension:from-token-bg-primary extension:via-token-bg-primary" />
          </div>
          <div
            {...{ [REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE]: "thread-footer" }}
            className="relative z-10 flex flex-col *:pointer-events-auto"
          >
            {footer}
          </div>
        </motion.div>
      ) : null}
    </div>
  );
});
