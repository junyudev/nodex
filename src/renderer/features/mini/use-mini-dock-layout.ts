import { useEffect, type RefObject } from "react";
import type { MiniContentLayout, MiniRect } from "../../../shared/mini";
import { miniHost } from "./mini-host";

/**
 * Each block Mini draws carries `data-mini-content`; the dock, or the composer while it is open,
 * also carries `data-mini-base`.
 */
const CONTENT = "[data-mini-content]";
const BASE = "[data-mini-base]";

/** An element's box within the window; a card scrolled out of the list counts only as shown. */
const rectOf = (element: Element): MiniRect | null => {
  const box = element.getBoundingClientRect();
  const viewport = element.closest("[data-mini-card-scroll]")?.getBoundingClientRect();
  const left = Math.max(0, box.left, viewport?.left ?? 0);
  const top = Math.max(0, box.top, viewport?.top ?? 0);
  const right = Math.min(window.innerWidth, box.right, viewport?.right ?? window.innerWidth);
  const bottom = Math.min(window.innerHeight, box.bottom, viewport?.bottom ?? window.innerHeight);
  return right > left && bottom > top
    ? {
        x: Math.floor(left),
        y: Math.floor(top),
        width: Math.ceil(right) - Math.floor(left),
        height: Math.ceil(bottom) - Math.floor(top),
      }
    : null;
};

const union = (rects: readonly MiniRect[]): MiniRect | null => {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** Where Mini's drawn content sits in its window, or null when nothing is. */
export function measureMiniContent(frame: Element): MiniContentLayout | null {
  const content = union(
    [...frame.querySelectorAll(CONTENT)].flatMap((element) => {
      const rect = rectOf(element);
      return rect ? [rect] : [];
    }),
  );
  const baseElement = frame.querySelector(BASE);
  const base = baseElement ? rectOf(baseElement) : null;
  return content && base ? { content, base } : null;
}

/**
 * Tells Main where Mini's content sits while it is on screen, so the live previews docked beside
 * it line up with its dock and move with it; nothing while it is hidden.
 */
export function useMiniDockLayout(
  frame: RefObject<HTMLElement | null>,
  onScreen: boolean,
  dockWidth: number,
): void {
  useEffect(() => {
    const element = frame.current;
    if (!element || !onScreen) {
      miniHost.layout(null, dockWidth);
      return;
    }
    let request: number | null = null;
    let reported = "";
    const report = () => {
      request = null;
      const base = element.querySelector(BASE);
      const height = `${base?.getBoundingClientRect().height ?? 0}px`;
      if (element.style.getPropertyValue("--mini-base-height") !== height) {
        element.style.setProperty("--mini-base-height", height);
      }
      const layout = measureMiniContent(element);
      const serialized = JSON.stringify(layout);
      if (serialized === reported) return;
      reported = serialized;
      miniHost.layout(layout, dockWidth);
    };
    const schedule = () => {
      if (request === null) request = window.requestAnimationFrame(report);
    };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(element);
      for (const block of element.querySelectorAll(CONTENT)) resize.observe(block);
    };
    const mutation = new MutationObserver(() => {
      observe();
      schedule();
    });
    const geometry = new MutationObserver(schedule);
    observe();
    mutation.observe(element, { childList: true, subtree: true });
    geometry.observe(element, { attributeFilter: ["style"] });
    element.addEventListener("transitionend", schedule);
    element.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      if (request !== null) window.cancelAnimationFrame(request);
      resize.disconnect();
      mutation.disconnect();
      geometry.disconnect();
      element.removeEventListener("transitionend", schedule);
      element.removeEventListener("scroll", schedule, true);
      miniHost.layout(null, dockWidth);
    };
  }, [frame, onScreen, dockWidth]);
}
