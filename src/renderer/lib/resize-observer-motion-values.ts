import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import { useMotionValue, useMotionValueEvent, type MotionValue } from "motion/react";
import { normalizeElementSize, readResizeObserverBorderBoxSize } from "./resize-observer-size";

export { normalizeElementSize, readResizeObserverBorderBoxSize } from "./resize-observer-size";

type ResizeSubscription = (entry: ResizeObserverEntry) => void;

const resizeSubscriptions = new WeakMap<Element, Set<ResizeSubscription>>();
const lastResizeEntries = new WeakMap<Element, ResizeObserverEntry>();
let sharedResizeObserver: ResizeObserver | null = null;
let sharedResizeObserverConstructor: typeof ResizeObserver | null = null;

function getSharedResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (sharedResizeObserver !== null && sharedResizeObserverConstructor === ResizeObserver) {
    return sharedResizeObserver;
  }

  sharedResizeObserver?.disconnect();
  sharedResizeObserverConstructor = ResizeObserver;
  sharedResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      lastResizeEntries.set(entry.target, entry);
      for (const subscription of Array.from(resizeSubscriptions.get(entry.target) ?? [])) {
        subscription(entry);
      }
    }
  });
  return sharedResizeObserver;
}

export function subscribeToElementResize(
  element: Element,
  subscription: ResizeSubscription,
): () => void {
  const observer = getSharedResizeObserver();
  if (!observer) {
    const notify = () => {
      subscription({
        target: element,
        contentRect: element.getBoundingClientRect(),
      } as ResizeObserverEntry);
    };
    window.addEventListener("resize", notify);
    return () => window.removeEventListener("resize", notify);
  }

  const existingSubscriptions = resizeSubscriptions.get(element);
  if (existingSubscriptions) {
    existingSubscriptions.add(subscription);
    const lastEntry = lastResizeEntries.get(element);
    if (lastEntry) subscription(lastEntry);
  } else {
    resizeSubscriptions.set(element, new Set([subscription]));
    observer.observe(element);
  }

  return () => {
    const subscriptions = resizeSubscriptions.get(element);
    if (!subscriptions) return;
    subscriptions.delete(subscription);
    if (subscriptions.size > 0) return;
    resizeSubscriptions.delete(element);
    lastResizeEntries.delete(element);
    observer.unobserve(element);
  };
}

export interface ElementSizeMotionValues {
  height: MotionValue<number>;
  ref: RefCallback<HTMLElement>;
  width: MotionValue<number>;
}

export function useSyncedMotionValue<T>(value: T): MotionValue<T> {
  const motionValue = useMotionValue(value);
  useLayoutEffect(() => {
    if (Object.is(motionValue.get(), value)) return;
    motionValue.set(value);
  }, [motionValue, value]);
  return motionValue;
}

export function useMotionValueState<T>(motionValue: MotionValue<T>): T {
  const [state, setState] = useState<T>(() => motionValue.get() as T);
  const stateRef = useRef<T>(state);

  const commit = useCallback((nextState: T) => {
    if (Object.is(stateRef.current, nextState)) return;
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  useMotionValueEvent(motionValue, "change", commit);
  useLayoutEffect(() => {
    commit(motionValue.get());
  }, [commit, motionValue]);
  return state;
}

export function useElementSizeMotionValues({
  initialHeight = 0,
  initialWidth = 0,
  readFallbackSize,
}: {
  initialHeight?: number;
  initialWidth?: number;
  readFallbackSize?: () => { height: number; width: number };
} = {}): ElementSizeMotionValues {
  const width = useMotionValue(normalizeElementSize(initialWidth));
  const height = useMotionValue(normalizeElementSize(initialHeight));
  const elementRef = useRef<HTMLElement | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const applySize = useCallback(
    (nextWidth: number, nextHeight: number) => {
      const normalizedWidth = normalizeElementSize(nextWidth);
      const normalizedHeight = normalizeElementSize(nextHeight);
      if (width.get() !== normalizedWidth) width.set(normalizedWidth);
      if (height.get() !== normalizedHeight) height.set(normalizedHeight);
    },
    [height, width],
  );

  const measureElement = useCallback(
    (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const fallbackSize = readFallbackSize?.();
      applySize(
        rect.width > 0 ? rect.width : (fallbackSize?.width ?? rect.width),
        rect.height > 0 ? rect.height : (fallbackSize?.height ?? rect.height),
      );
    },
    [applySize, readFallbackSize],
  );

  const ref = useCallback<RefCallback<HTMLElement>>(
    (element) => {
      if (elementRef.current === element) return;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      elementRef.current = element;
      if (!element) return;

      measureElement(element);
      unsubscribeRef.current = subscribeToElementResize(element, (entry) => {
        const size = readResizeObserverBorderBoxSize(entry);
        if (size.width > 0 && size.height > 0) {
          applySize(size.width, size.height);
          return;
        }
        measureElement(element);
      });
    },
    [applySize, measureElement],
  );

  useEffect(() => {
    if (!readFallbackSize) return undefined;
    const measureFallback = () => {
      const size = readFallbackSize();
      applySize(size.width, size.height);
    };
    window.addEventListener("resize", measureFallback);
    return () => window.removeEventListener("resize", measureFallback);
  }, [applySize, readFallbackSize]);

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      elementRef.current = null;
    },
    [],
  );

  return { height, ref, width };
}
