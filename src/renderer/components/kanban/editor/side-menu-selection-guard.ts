import type { FloatingUIOptions } from "@blocknote/react";
import { useEffect, useState } from "react";
import type { RefObject } from "react";

const SIDE_MENU_SELECTION_GUARD_OVERLAY_CLASS = "bn-side-menu-selection-guard-overlay";

const SIDE_MENU_SELECTION_GUARD_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  elementProps: {
    className: SIDE_MENU_SELECTION_GUARD_OVERLAY_CLASS,
    style: {
      pointerEvents: "none",
    },
  },
};

interface ClosestCapableTarget {
  closest: (selector: string) => unknown;
}

function supportsClosest(value: unknown): value is ClosestCapableTarget {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { closest?: unknown }).closest === "function";
}

function resolveClosestTarget(target: EventTarget | null): ClosestCapableTarget | null {
  if (supportsClosest(target)) return target;
  if (typeof target !== "object" || target === null) return null;

  const parentElement = (target as { parentElement?: unknown }).parentElement;
  return supportsClosest(parentElement) ? parentElement : null;
}

export function shouldArmSideMenuSelectionGuard(
  target: EventTarget | null,
  button: number,
): boolean {
  if (button !== 0) return false;
  const element = resolveClosestTarget(target);
  if (!element) return false;
  if (element.closest(".bn-side-menu")) return false;
  return Boolean(element.closest(".ProseMirror"));
}

export function getSideMenuSelectionGuardFloatingOptions(
  active: boolean,
): Partial<FloatingUIOptions> | undefined {
  return active ? SIDE_MENU_SELECTION_GUARD_FLOATING_OPTIONS : undefined;
}

export function useSideMenuSelectionGuard(
  containerRef: RefObject<HTMLElement | null>,
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const armGuard = (event: MouseEvent) => {
      if (!shouldArmSideMenuSelectionGuard(event.target, event.button)) return;
      setActive(true);
    };

    const clearGuard = () => {
      setActive(false);
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

  return active;
}
