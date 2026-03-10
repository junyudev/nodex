import { useEffect } from "react";
import type { RefObject } from "react";

const SIDE_MENU_SELECTION_GUARD_ATTR = "data-side-menu-selection-guard";

interface ClosestCapableTarget {
  closest: (selector: string) => unknown;
}

function supportsClosest(
  value: EventTarget | null,
): value is EventTarget & ClosestCapableTarget {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { closest?: unknown }).closest === "function";
}

export function shouldArmSideMenuSelectionGuard(
  target: EventTarget | null,
  button: number,
): boolean {
  if (button !== 0) return false;
  if (!supportsClosest(target)) return false;
  if (target.closest(".bn-side-menu")) return false;
  return Boolean(target.closest(".ProseMirror"));
}

export function useSideMenuSelectionGuard(
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const armGuard = (event: MouseEvent) => {
      if (!shouldArmSideMenuSelectionGuard(event.target, event.button)) return;
      container.setAttribute(SIDE_MENU_SELECTION_GUARD_ATTR, "");
    };

    const clearGuard = () => {
      container.removeAttribute(SIDE_MENU_SELECTION_GUARD_ATTR);
    };

    container.addEventListener("mousedown", armGuard, true);
    window.addEventListener("mouseup", clearGuard, true);
    window.addEventListener("dragend", clearGuard, true);
    window.addEventListener("blur", clearGuard);

    return () => {
      container.removeEventListener("mousedown", armGuard, true);
      window.removeEventListener("mouseup", clearGuard, true);
      window.removeEventListener("dragend", clearGuard, true);
      window.removeEventListener("blur", clearGuard);
      clearGuard();
    };
  }, [containerRef]);
}
