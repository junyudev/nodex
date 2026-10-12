import type { RefObject } from "react";
import { useLayoutEffect } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "audio[controls]",
  "video[controls]",
  "iframe",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");
const LINK_SELECTOR = "a[href], area[href]";

interface PriorFocusableState {
  readonly ariaHidden: string | null;
  readonly inert: boolean;
  readonly inertAttribute: string | null;
}

function listFocusableDescendants(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function isFocusableVisibleWithin(element: HTMLElement, root: HTMLElement): boolean {
  const bounds = element.getBoundingClientRect();
  const viewport = root.getBoundingClientRect();
  if (element.matches(LINK_SELECTOR))
    return (
      Math.min(bounds.right, viewport.right) > Math.max(bounds.left, viewport.left) &&
      Math.min(bounds.bottom, viewport.bottom) > Math.max(bounds.top, viewport.top)
    );
  return (
    bounds.top >= viewport.top &&
    bounds.right <= viewport.right &&
    bounds.bottom <= viewport.bottom &&
    bounds.left >= viewport.left
  );
}

export function useClippedFocusSafety(
  clippedContainerRef: RefObject<HTMLElement | null>,
  clipped: boolean,
): void {
  useLayoutEffect(() => {
    const clippedContainer = clippedContainerRef.current;
    if (!clippedContainer || !clipped) return;

    const priorStates = new Map<HTMLElement, PriorFocusableState>();
    const restore = (element: HTMLElement, release = true) => {
      const prior = priorStates.get(element);
      if (!prior) return;

      if (prior.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", prior.ariaHidden);
      element.inert = prior.inert;
      if (prior.inertAttribute === null) element.removeAttribute("inert");
      else element.setAttribute("inert", prior.inertAttribute);
      if (release) priorStates.delete(element);
    };
    const setClipped = (element: HTMLElement, isClipped: boolean) => {
      if (!priorStates.has(element)) {
        priorStates.set(element, {
          ariaHidden: element.getAttribute("aria-hidden"),
          inert: Boolean(element.inert),
          inertAttribute: element.getAttribute("inert"),
        });
      }
      if (!isClipped) {
        restore(element, false);
        return;
      }
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    };

    const intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const target = entry.target as HTMLElement;
                if (!priorStates.has(target)) continue;
                const visible =
                  entry.isIntersecting &&
                  (target.matches(LINK_SELECTOR)
                    ? entry.intersectionRatio > 0
                    : entry.intersectionRatio >= 1);
                setClipped(target, !visible);
              }
            },
            {
              root: clippedContainer,
              threshold: [Number.EPSILON, 1],
            },
          );
    const reconcileDescendants = () => {
      for (const element of [...priorStates.keys()]) {
        if (clippedContainer.contains(element)) continue;
        intersectionObserver?.unobserve(element);
        restore(element);
      }
      for (const element of listFocusableDescendants(clippedContainer)) {
        if (priorStates.has(element) || element.hasAttribute("inert")) continue;
        const visible =
          intersectionObserver === null && isFocusableVisibleWithin(element, clippedContainer);
        setClipped(element, !visible);
        intersectionObserver?.observe(element);
      }
    };
    reconcileDescendants();
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(reconcileDescendants);
    mutationObserver?.observe(clippedContainer, { childList: true, subtree: true });

    return () => {
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
      for (const element of [...priorStates.keys()]) restore(element);
    };
  }, [clipped, clippedContainerRef]);
}
