import type { RefObject } from "react";
import { useLayoutEffect, useState } from "react";

interface UseContentOverflowResult {
  readonly collapsedHeightPx: number | null;
  readonly isOverflowing: boolean;
}

const LINE_HEIGHT_FALLBACK_MULTIPLIER = 1.5;

function readLineHeightPx(element: HTMLElement): number {
  const ownerWindow = element.ownerDocument.defaultView ?? window;
  const style = ownerWindow.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;

  const fontSize = Number.parseFloat(style.fontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) {
    return fontSize * LINE_HEIGHT_FALLBACK_MULTIPLIER;
  }

  return 13 * LINE_HEIGHT_FALLBACK_MULTIPLIER;
}

export function useContentOverflow(
  contentRef: RefObject<HTMLElement | null>,
  collapsedLineCount: number,
): UseContentOverflowResult {
  const [measurement, setMeasurement] = useState<UseContentOverflowResult>({
    collapsedHeightPx: null,
    isOverflowing: false,
  });

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const ownerWindow = element.ownerDocument.defaultView ?? window;
    let animationFrame: number | null = null;

    const measure = () => {
      animationFrame = null;
      const collapsedHeightPx = Math.ceil(readLineHeightPx(element) * collapsedLineCount);
      const isOverflowing = Math.ceil(element.scrollHeight) > collapsedHeightPx + 1;
      setMeasurement((current) =>
        current.collapsedHeightPx === collapsedHeightPx && current.isOverflowing === isOverflowing
          ? current
          : { collapsedHeightPx, isOverflowing },
      );
    };
    const scheduleMeasurement = () => {
      if (animationFrame !== null) return;
      animationFrame = ownerWindow.requestAnimationFrame(measure);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasurement);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleMeasurement);

    resizeObserver?.observe(element);
    mutationObserver?.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    measure();

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (animationFrame !== null) ownerWindow.cancelAnimationFrame(animationFrame);
    };
  }, [collapsedLineCount, contentRef]);

  return measurement;
}
