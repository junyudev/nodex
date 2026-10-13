import { useRef, useSyncExternalStore } from "react";

/** Subscribe to a selected snapshot while retaining equivalent publication values. */
export function useExternalSelector<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cacheRef = useRef<{ hasValue: boolean; value: T }>({
    hasValue: false,
    value: undefined as T,
  });
  return useSyncExternalStore(subscribe, () => {
    const nextValue = getSnapshot();
    if (cacheRef.current.hasValue && isEqual(cacheRef.current.value, nextValue))
      return cacheRef.current.value;
    cacheRef.current = { hasValue: true, value: nextValue };
    return nextValue;
  });
}
