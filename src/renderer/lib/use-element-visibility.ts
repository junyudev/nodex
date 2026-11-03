import { useCallback, useEffect, useState, type RefCallback } from "react";

export interface ElementVisibility {
  readonly ref: RefCallback<HTMLElement>;
  /** Inside the prewarm margin. */
  readonly visible: boolean;
  /** Actually intersects the viewport, excluding the prewarm margin. */
  readonly intersecting: boolean;
  readonly intersectionRatio: number;
  readonly viewportCenterDistance: number;
  readonly documentOrder: number;
}

/**
 * Keeps heavyweight nested editors out of offscreen rows. A small root margin
 * prewarms a Card shortly before it scrolls into view.
 */
export const useElementVisibility = (rootMargin = "160px 0px"): ElementVisibility => {
  const canObserve = typeof globalThis.IntersectionObserver === "function";
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [visibility, setVisibility] = useState(() => ({
    visible: !canObserve,
    intersecting: !canObserve,
    intersectionRatio: canObserve ? 0 : 1,
    viewportCenterDistance: 0,
    documentOrder: 0,
  }));
  const ref = useCallback<RefCallback<HTMLElement>>((nextElement) => {
    setElement(nextElement);
    if (!nextElement) return;
    if (typeof globalThis.IntersectionObserver === "function") {
      setVisibility((current) => ({ ...current, visible: false }));
      return;
    }
    setVisibility({
      visible: true,
      intersecting: true,
      intersectionRatio: 1,
      viewportCenterDistance: 0,
      documentOrder: nextElement.offsetTop,
    });
  }, []);
  const [previousRootMargin, setPreviousRootMargin] = useState(rootMargin);
  if (previousRootMargin !== rootMargin) {
    setPreviousRootMargin(rootMargin);
    if (element && canObserve) setVisibility((current) => ({ ...current, visible: false }));
  }

  useEffect(() => {
    if (!element || typeof globalThis.IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const viewportHeight = globalThis.innerHeight;
        const viewportWidth = globalThis.innerWidth;
        const rect = entry.boundingClientRect;
        const intersectionWidth = Math.max(
          0,
          Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0),
        );
        const intersectionHeight = Math.max(
          0,
          Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
        );
        const area = Math.max(1, rect.width * rect.height);
        const ratio = Math.min(1, (intersectionWidth * intersectionHeight) / area);
        setVisibility({
          visible: entry.isIntersecting,
          intersecting: ratio > 0,
          intersectionRatio: ratio,
          viewportCenterDistance: Math.abs(rect.top + rect.height / 2 - viewportHeight / 2),
          documentOrder: element.offsetTop,
        });
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, rootMargin]);

  return { ref, ...visibility };
};
