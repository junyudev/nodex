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
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { motion, type MotionValue } from "motion/react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "../../../lib/utils";
import {
  readResizeObserverBorderBoxSize,
  subscribeToElementResize,
} from "../../../lib/resize-observer-motion-values";
import {
  REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE,
  REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
} from "../../../../shared/remote-hosted-pip";
import {
  buildPendingLatestTurnSubmitPlacement,
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

export interface ThreadScrollToBottomOptions {
  durationMs?: number;
  followContentGrowth?: boolean;
  onStop?: () => void;
}

export interface LocalConversationThreadScrollControllerValue {
  isScrolledFromBottom: boolean;
  nativeFindTurnKey: string | null;
  scrollElement: HTMLDivElement | null;
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
  prepareLatestTurnSubmitPlacement: (options?: {
    readonly placeLatestTurn?: boolean;
  }) => PendingLatestTurnSubmitPlacement | null;
  registerResponseSpacerState: (state: ThreadResponseSpacerState | null) => void;
  responseSpacerState: ThreadResponseSpacerState | null;
  scrollToBottom: (options?: ThreadScrollToBottomOptions) => void;
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
  scrollToDistanceFromBottomPx: (
    distanceFromBottomPx: number,
    behavior?: ScrollBehavior,
    source?: "system" | "user",
  ) => void;
  setFooterResizeViewportPreserveDisabled: (disabled: boolean) => void;
  setFooterHeightPx: (height: number) => void;
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
  onViewportWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  onViewportKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

const THREAD_SCROLL_VIEWPORT_CLASS_NAME =
  "thread-scroll-container relative h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none] [scroll-padding-bottom:var(--thread-scroll-padding-bottom,0px)] electron:[scrollbar-gutter:stable_both-edges] pt-(--thread-content-top-inset) [container-name:thread-content] [container-type:inline-size] [&:has([data-thread-scroll-footer='true']:focus-within)]:[scroll-padding-bottom:0px] flex flex-col outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const THREAD_SCROLL_CONTENT_WRAPPER_CLASS_NAME =
  "mx-auto w-full max-w-(--thread-content-max-width) px-toolbar";

const LocalConversationThreadScrollControllerContext =
  createContext<LocalConversationThreadScrollControllerContextValue | null>(null);

export function isThreadScrollNearBottom({
  scrollDistanceFromBottomPx,
}: ThreadScrollPositionSnapshot): boolean {
  return scrollDistanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX;
}

type ThreadScrollGeometry = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/**
 * The viewport scrolls from the top like any document, and bottom distance is derived from it.
 * Growth or decay below the reader therefore never needs a native write, so the browser's
 * animated wheel and momentum scrolling keep their full travel.
 */
export function getThreadScrollDistanceFromBottomPx(element: ThreadScrollGeometry): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

export function resolveNativeScrollTopForDistanceFromBottomPx(
  element: ThreadScrollGeometry,
  distanceFromBottomPx: number,
): number {
  return Math.max(
    0,
    element.scrollHeight - element.clientHeight - Math.max(0, distanceFromBottomPx),
  );
}

export function resolveThreadScrollKeyDirection(
  event: KeyboardEvent,
  viewport: HTMLElement,
): "away" | "toward" | null {
  if (event.defaultPrevented || event.repeat) return null;
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
  const userScrollIntentRef = useRef<{
    direction: "away" | "toward";
    lastAtMs: number;
  } | null>(null);
  const programmaticFindSettleTimeoutRef = useRef<number | null>(null);
  const scrollListenersRef = useRef(new Set<ThreadScrollListener>());
  const userScrollListenersRef = useRef(new Set<ThreadUserScrollListener>());
  const footerResizeViewportPreserveDisabledRef = useRef(false);
  const footerHeightRef = useRef<{
    readonly element: HTMLDivElement;
    readonly height: number;
  } | null>(null);
  const scrollToBottomAnimationFrameRef = useRef<number | null>(null);
  const scrollToBottomAnimationDurationExplicitRef = useRef(false);
  const scrollToBottomAnimationOnStopRef = useRef<(() => void) | undefined>(undefined);
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
      roundedScrollRequestRef.current = null;
      setScrollElement(element);
    },
    [cancelNativeFindScroll],
  );

  const cancelScrollToBottomAnimation = useCallback(() => {
    if (scrollToBottomAnimationFrameRef.current !== null)
      window.cancelAnimationFrame(scrollToBottomAnimationFrameRef.current);
    scrollToBottomAnimationFrameRef.current = null;
    scrollToBottomAnimationDurationExplicitRef.current = false;
    const onStop = scrollToBottomAnimationOnStopRef.current;
    scrollToBottomAnimationOnStopRef.current = undefined;
    onStop?.();
  }, []);

  const recordScrollDistance = useCallback((scrollDistanceFromBottomPx: number) => {
    if (roundedScrollRequestRef.current?.actual !== scrollDistanceFromBottomPx)
      roundedScrollRequestRef.current = null;
    lastScrollDistanceFromBottomPxRef.current = scrollDistanceFromBottomPx;
    for (const listener of scrollListenersRef.current) listener(scrollDistanceFromBottomPx);
    setIsScrolledFromBottom(!isThreadScrollNearBottom({ scrollDistanceFromBottomPx }));
  }, []);

  const recordUserScrollDistance = useCallback((distance: number, previous: number) => {
    scrollModeRef.current =
      distance < previous && isThreadScrollNearBottom({ scrollDistanceFromBottomPx: distance })
        ? "stickToBottom"
        : "user";
    for (const listener of userScrollListenersRef.current) listener(distance, previous);
  }, []);

  const writeNativeScrollDistance = useCallback(
    (element: HTMLDivElement, distanceFromBottomPx: number, behavior: ScrollBehavior) => {
      const nextDistanceFromBottomPx = Math.max(0, distanceFromBottomPx);
      if (nextDistanceFromBottomPx !== getThreadScrollDistanceFromBottomPx(element))
        userScrollIntentRef.current = null;
      const top = resolveNativeScrollTopForDistanceFromBottomPx(element, nextDistanceFromBottomPx);
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
      else userScrollIntentRef.current = null;
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
    cancelScrollToBottomAnimation();
    setScrollMode("user");
    responseSpacerStateRef.current?.holdViewport?.();
  }, [cancelScrollToBottomAnimation, setScrollMode]);

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
    listener(lastScrollDistanceFromBottomPxRef.current);
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
    (
      distanceFromBottomPx: number,
      behavior: ScrollBehavior = "auto",
      source: "system" | "user" = "system",
    ) => {
      const element = scrollElementRef.current;
      if (element === null) return;
      const previous = lastScrollDistanceFromBottomPxRef.current;
      cancelNativeFindScroll();
      if (distanceFromBottomPx > THREAD_NEAR_BOTTOM_THRESHOLD_PX) cancelScrollToBottomAnimation();
      if (distanceFromBottomPx === 0 && scrollModeRef.current !== "programmaticFind")
        setScrollMode("stickToBottom");
      writeNativeScrollDistance(element, distanceFromBottomPx, behavior);
      const distance = lastScrollDistanceFromBottomPxRef.current;
      if (source === "user" && distance !== previous) recordUserScrollDistance(distance, previous);
    },
    [
      cancelNativeFindScroll,
      cancelScrollToBottomAnimation,
      recordUserScrollDistance,
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
      cancelScrollToBottomAnimation();
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
    [cancelNativeFindScroll, cancelScrollToBottomAnimation, setScrollMode],
  );

  const setFooterResizeViewportPreserveDisabled = useCallback((disabled: boolean) => {
    footerResizeViewportPreserveDisabledRef.current = disabled;
  }, []);

  const setFooterHeightPx = useCallback(
    (height: number) => {
      const element = scrollElementRef.current;
      if (!element) return;
      const previous =
        footerHeightRef.current?.element === element ? footerHeightRef.current.height : null;
      if (previous === height) return;
      const distanceBeforePx = getThreadScrollDistanceFromBottomPx(element);
      element.style.setProperty("--thread-scroll-padding-bottom", `${height + 16}px`);
      footerHeightRef.current = { element, height };
      if (
        footerResizeViewportPreserveDisabledRef.current ||
        scrollToBottomAnimationFrameRef.current !== null
      )
        return;
      if (isThreadScrollNearBottom({ scrollDistanceFromBottomPx: distanceBeforePx })) {
        writeNativeScrollDistance(element, 0, "instant");
        return;
      }
      recordScrollDistance(getThreadScrollDistanceFromBottomPx(element));
    },
    [recordScrollDistance, writeNativeScrollDistance],
  );

  const scrollToBottom = useCallback(
    (options?: ThreadScrollToBottomOptions) => {
      const element = scrollElementRef.current;
      if (!element) return;
      cancelNativeFindScroll();
      scrollModeRef.current = options?.followContentGrowth === false ? "user" : "stickToBottom";
      const initialDistanceFromBottomPx = getThreadScrollDistanceFromBottomPx(element);
      if (reducedMotion || initialDistanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
        writeNativeScrollDistance(element, 0, "instant");
        cancelScrollToBottomAnimation();
        options?.onStop?.();
        return;
      }
      cancelScrollToBottomAnimation();
      userScrollIntentRef.current = null;
      roundedScrollRequestRef.current = null;
      scrollToBottomAnimationOnStopRef.current = options?.onStop;
      scrollToBottomAnimationDurationExplicitRef.current = options?.durationMs !== undefined;
      const startedAtMs = performance.now();
      const step = (nowMs: number) => {
        const current = scrollElementRef.current;
        if (!current) {
          cancelScrollToBottomAnimation();
          return;
        }
        const progress = Math.min(
          1,
          (nowMs - startedAtMs) / (options?.durationMs ?? SCROLL_TO_BOTTOM_ANIMATION_DURATION_MS),
        );
        const top = resolveNativeScrollTopForDistanceFromBottomPx(
          current,
          initialDistanceFromBottomPx * (1 - progress) ** 3,
        );
        if (current.scrollTop !== top) current.scrollTop = top;
        if (
          progress < 1 &&
          (options?.durationMs !== undefined ||
            !isThreadScrollNearBottom({
              scrollDistanceFromBottomPx: getThreadScrollDistanceFromBottomPx(current),
            }))
        ) {
          scrollToBottomAnimationFrameRef.current = window.requestAnimationFrame(step);
          return;
        }
        writeNativeScrollDistance(current, 0, "instant");
        cancelScrollToBottomAnimation();
      };
      scrollToBottomAnimationFrameRef.current = window.requestAnimationFrame(step);
    },
    [
      cancelNativeFindScroll,
      cancelScrollToBottomAnimation,
      reducedMotion,
      writeNativeScrollDistance,
    ],
  );

  const jumpToBottom = useCallback(() => {
    setScrollMode("stickToBottom");
    scrollToDistanceFromBottomPx(0, "auto");
  }, [scrollToDistanceFromBottomPx, setScrollMode]);

  const suppressAutoStickToBottom = useCallback(() => {
    setScrollMode("user");
  }, [setScrollMode]);

  const registerUserScrollIntent = useCallback(
    (direction: "away" | "toward") => {
      const element = scrollElementRef.current;
      if (!element) return;
      cancelNativeFindScroll();
      cancelScrollToBottomAnimation();
      roundedScrollRequestRef.current = null;
      const canMove =
        direction === "away"
          ? element.scrollTop > 0
          : getThreadScrollDistanceFromBottomPx(element) > 0;
      userScrollIntentRef.current = canMove ? { direction, lastAtMs: performance.now() } : null;
    },
    [cancelNativeFindScroll, cancelScrollToBottomAnimation],
  );
  const onViewportWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        !event.nativeEvent.composedPath().includes(event.currentTarget) ||
        event.ctrlKey ||
        event.shiftKey ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      )
        return;
      registerUserScrollIntent(event.deltaY < 0 ? "away" : "toward");
    },
    [registerUserScrollIntent],
  );
  const onViewportKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!event.nativeEvent.composedPath().includes(event.currentTarget)) return;
      const direction = resolveThreadScrollKeyDirection(event.nativeEvent, event.currentTarget);
      if (direction) registerUserScrollIntent(direction);
    },
    [registerUserScrollIntent],
  );

  useLayoutEffect(() => {
    if (!scrollElement || typeof ResizeObserver === "undefined") return;
    // Keep native movement that has not reached its scroll event ahead of content measurement.
    let observedScrollTop = scrollElement.scrollTop;
    const followContentGrowth = () => {
      const scrolledSinceObservation = Math.abs(observedScrollTop - scrollElement.scrollTop) > 1;
      observedScrollTop = scrollElement.scrollTop;
      if (
        scrollModeRef.current !== "stickToBottom" ||
        lastScrollDistanceFromBottomPxRef.current !== 0 ||
        getThreadScrollDistanceFromBottomPx(scrollElement) <= 0 ||
        scrolledSinceObservation ||
        userScrollIntentRef.current?.direction === "away"
      )
        return;
      compensateScrollToDistanceFromBottomPx(0);
      observedScrollTop = scrollElement.scrollTop;
    };
    const contentResizeObserver = new ResizeObserver(followContentGrowth);
    contentResizeObserver.observe(scrollElement);
    if (scrollElement.firstElementChild)
      contentResizeObserver.observe(scrollElement.firstElementChild);

    return () => contentResizeObserver.disconnect();
  }, [compensateScrollToDistanceFromBottomPx, scrollElement]);

  useEffect(() => {
    if (!scrollElement) return;
    const abort = new AbortController();
    const listenerOptions = { passive: true, signal: abort.signal };
    let scrollbarPointerStart: { scrollHeight: number; scrollTop: number } | null = null;
    let touch: Touch | null = null;

    const syncFromScrollPosition = () => {
      const distance = getThreadScrollDistanceFromBottomPx(scrollElement);
      if (
        isThreadScrollNearBottom({ scrollDistanceFromBottomPx: distance }) &&
        !scrollToBottomAnimationDurationExplicitRef.current
      )
        cancelScrollToBottomAnimation();
      recordScrollDistance(distance);
    };
    const handleScroll = () => {
      const previous = lastScrollDistanceFromBottomPxRef.current;
      const pointerStart = scrollbarPointerStart;
      if (pointerStart) {
        scrollbarPointerStart = null;
        const distance = getThreadScrollDistanceFromBottomPx(scrollElement);
        if (
          scrollElement.scrollHeight === pointerStart.scrollHeight &&
          scrollElement.scrollTop !== pointerStart.scrollTop &&
          distance !== previous
        )
          userScrollIntentRef.current = {
            direction: distance > previous ? "away" : "toward",
            lastAtMs: performance.now(),
          };
      }
      const intent = userScrollIntentRef.current;
      if (!intent) {
        syncFromScrollPosition();
        return;
      }
      const now = performance.now();
      if (now - intent.lastAtMs > USER_SCROLL_GRACE_WINDOW_MS) {
        userScrollIntentRef.current = null;
        syncFromScrollPosition();
        return;
      }
      syncFromScrollPosition();
      const distance = getThreadScrollDistanceFromBottomPx(scrollElement);
      const direction = distance > previous ? "away" : distance < previous ? "toward" : null;
      if (direction !== intent.direction) return;
      intent.lastAtMs = now;
      recordUserScrollDistance(distance, previous);
      if (isThreadScrollNearBottom({ scrollDistanceFromBottomPx: distance }))
        userScrollIntentRef.current = null;
    };
    const handlePointerDown = (event: PointerEvent) => {
      userScrollIntentRef.current = null;
      scrollbarPointerStart = null;
      if (event.pointerType !== "mouse" || event.target !== scrollElement) return;
      cancelNativeFindScroll();
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
      if (Math.abs(deltaY) > Math.abs(deltaX))
        registerUserScrollIntent(deltaY > 0 ? "away" : "toward");
    };
    const handleTouchEnd = () => {
      touch = null;
    };

    scrollElement.addEventListener("pointerdown", handlePointerDown, listenerOptions);
    scrollElement.addEventListener("pointerup", handlePointerEnd, listenerOptions);
    scrollElement.addEventListener("pointercancel", handlePointerEnd, listenerOptions);
    scrollElement.addEventListener("touchstart", handleTouchStart, listenerOptions);
    scrollElement.addEventListener("touchmove", handleTouchMove, listenerOptions);
    scrollElement.addEventListener("touchend", handleTouchEnd, listenerOptions);
    scrollElement.addEventListener("touchcancel", handleTouchEnd, listenerOptions);
    scrollElement.addEventListener("scroll", handleScroll, listenerOptions);
    return () => {
      abort.abort();
    };
  }, [
    cancelNativeFindScroll,
    cancelScrollToBottomAnimation,
    recordScrollDistance,
    recordUserScrollDistance,
    registerUserScrollIntent,
    scrollElement,
  ]);

  useEffect(
    () => () => {
      cancelNativeFindScroll();
      if (programmaticFindSettleTimeoutRef.current !== null) {
        window.clearTimeout(programmaticFindSettleTimeoutRef.current);
      }
      cancelScrollToBottomAnimation();
    },
    [cancelNativeFindScroll, cancelScrollToBottomAnimation],
  );

  const controller = useMemo<LocalConversationThreadScrollControllerContextValue>(
    () => ({
      addScrollListener,
      addUserScrollListener,
      compensateScrollToDistanceFromBottomPx,
      getUnroundedScrollDistanceFromBottomPx,
      holdViewport,
      shouldFollowContentGrowth,
      clearPendingLatestTurnSubmitPlacement,
      consumePendingLatestTurnSubmitPlacement,
      hasPendingLatestTurnSubmitPlacement,
      getLastScrollDistanceFromBottomPx,
      getScrollDistanceFromBottomPx,
      getScrollElement,
      getScrollMode,
      isScrolledFromBottom,
      nativeFindTurnKey,
      onViewportWheel,
      onViewportKeyDown,
      jumpToBottom,
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
      clearPendingLatestTurnSubmitPlacement,
      consumePendingLatestTurnSubmitPlacement,
      hasPendingLatestTurnSubmitPlacement,
      getLastScrollDistanceFromBottomPx,
      getScrollDistanceFromBottomPx,
      getScrollElement,
      getScrollMode,
      isScrolledFromBottom,
      nativeFindTurnKey,
      onViewportWheel,
      onViewportKeyDown,
      jumpToBottom,
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
  const setFooterHeightPx = controller.setFooterHeightPx;
  const scrollElement = controller.scrollElement;
  const restoredElementRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!scrollElement || restoredElementRef.current === scrollElement) return;
    restoredElementRef.current = scrollElement;
    const distanceFromBottomPx = normalizeThreadRestoreDistanceFromBottomPx(
      initialRestoreSnapshot?.distanceFromBottomPx ?? 0,
    );
    controller.scrollToDistanceFromBottomPx(distanceFromBottomPx, "auto");
    controller.setScrollMode(distanceFromBottomPx === 0 ? "stickToBottom" : "user");
  }, [controller, initialRestoreSnapshot, scrollElement]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: controller.scrollToBottom,
    }),
    [controller.scrollToBottom],
  );

  const registerFooter = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      return subscribeToElementResize(element, (entry) => {
        setFooterHeightPx(readResizeObserverBorderBoxSize(entry).height);
      });
    },
    [setFooterHeightPx],
  );

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
        onWheel={controller.onViewportWheel}
        onKeyDown={controller.onViewportKeyDown}
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
          ref={registerFooter}
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
