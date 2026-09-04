import { useEffect, type RefObject } from "react";
import { registerFocusedHistory } from "../focused-history";
import type { SurfaceHistoryControls } from "./controls";

export function useSurfaceHistoryFocus(
  element: RefObject<HTMLElement | null>,
  controls: SurfaceHistoryControls,
  contentEditableRoot?: () => HTMLElement | null,
): void {
  useEffect(() => {
    const root = contentEditableRoot ? contentEditableRoot() : element.current;
    if (!root) return;
    return registerFocusedHistory(root, { controls, contentEditableRoot });
  }, [element, controls, contentEditableRoot]);
}
