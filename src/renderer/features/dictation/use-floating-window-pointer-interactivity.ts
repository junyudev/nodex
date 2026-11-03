import { useEffect, useRef, type RefObject } from "react";

const isVisibleElement = (element: Element): boolean => {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const pointHitsElement = (
  point: { readonly x: number; readonly y: number },
  element: Element,
): boolean => {
  const rect = element.getBoundingClientRect();
  const inside =
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  if (!inside) return false;
  return document
    .elementsFromPoint(point.x, point.y)
    .some((candidate) => candidate === element || element.contains(candidate));
};

const resolveInitialHover = (interactiveRegion: Element | null): boolean | null => {
  if (interactiveRegion && isVisibleElement(interactiveRegion)) {
    if (interactiveRegion.matches(":hover")) return true;
  }
  return document.documentElement.matches(":hover") ? false : null;
};

/** Mirrors the native helper's hit-test handoff without making the whole transparent window click-blocking. */
export function useFloatingWindowPointerInteractivity(options: {
  readonly activationNonce: number;
  readonly interactiveRegionRef: RefObject<HTMLElement | null>;
  readonly onInteractiveChange: (interactive: boolean) => void;
}): void {
  const { activationNonce, interactiveRegionRef, onInteractiveChange } = options;
  const activationRef = useRef(activationNonce);
  const resetRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let published: boolean | null = null;
    let currentPoint: { readonly x: number; readonly y: number } | null = null;
    let lastPoint: { readonly x: number; readonly y: number } | null = null;
    let sampleFrame: number | null = null;

    const publish = (interactive: boolean): void => {
      if (published === interactive) return;
      published = interactive;
      onInteractiveChange(interactive);
    };
    const resolvePoint = (point: { readonly x: number; readonly y: number }): boolean => {
      const region = interactiveRegionRef.current;
      return region ? pointHitsElement(point, region) : true;
    };
    const sample = (): void => {
      sampleFrame = null;
      if (!currentPoint) return;
      lastPoint = currentPoint;
      publish(resolvePoint(currentPoint));
    };
    const scheduleSample = (): void => {
      if (sampleFrame !== null) return;
      sampleFrame = requestAnimationFrame(sample);
    };
    const onMouseMove = (event: MouseEvent): void => {
      currentPoint = { x: event.clientX, y: event.clientY };
      lastPoint = currentPoint;
      scheduleSample();
    };
    const resample = (): void => {
      if (!lastPoint) return;
      currentPoint = lastPoint;
      scheduleSample();
    };
    const onMouseLeave = (): void => publish(false);
    const publishInitial = (): void => {
      const hovered = resolveInitialHover(interactiveRegionRef.current);
      if (hovered === true) publish(true);
    };
    const observer = new MutationObserver(resample);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("resize", resample);
    window.addEventListener("scroll", resample, true);
    window.addEventListener("mouseleave", onMouseLeave);
    observer.observe(document.body, {
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    publishInitial();
    let initialFrame = requestAnimationFrame(publishInitial);
    resetRef.current = () => {
      onInteractiveChange(true);
      published = null;
      currentPoint = null;
      lastPoint = null;
      if (sampleFrame !== null) cancelAnimationFrame(sampleFrame);
      sampleFrame = null;
      cancelAnimationFrame(initialFrame);
      publishInitial();
      initialFrame = requestAnimationFrame(publishInitial);
    };

    return () => {
      resetRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", resample);
      window.removeEventListener("scroll", resample, true);
      window.removeEventListener("mouseleave", onMouseLeave);
      observer.disconnect();
      cancelAnimationFrame(initialFrame);
      if (sampleFrame !== null) cancelAnimationFrame(sampleFrame);
      onInteractiveChange(true);
    };
  }, [interactiveRegionRef, onInteractiveChange]);

  useEffect(() => {
    if (activationRef.current === activationNonce) return;
    activationRef.current = activationNonce;
    resetRef.current?.();
  }, [activationNonce]);
}
