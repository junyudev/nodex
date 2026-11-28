import type { PointerEvent as ReactPointerEvent } from "react";
import { miniHost } from "./mini-host";

/** How far the pointer travels while held before a press on Mini becomes a move. */
const DRAG_THRESHOLD_PX = 4;
/** Where holding the pointer selects or edits instead of moving Mini. */
const KEEPS_PRESS =
  "textarea, input, select, [contenteditable='true'], [role='menu'], [role='listbox']";

/**
 * Mini moves when held anywhere it draws and dragged, as a picture-in-picture window does: a
 * press that stays put is still a click, one that travels moves Mini and its click is dropped.
 * Main follows the pointer and snaps only if Option is held on release.
 */
export function startMiniDrag(event: ReactPointerEvent<HTMLElement>, drawn: string): void {
  if (event.button !== 0 || !event.isPrimary) return;
  const target = event.target;
  // Captured by what was pressed, so the pointer still reads as over Mini and is not let through.
  const surface = target instanceof Element ? target.closest(drawn) : null;
  if (!surface || (target as Element).closest(KEEPS_PRESS)) return;
  const { pointerId, screenX, screenY } = event;
  let moving = false;
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId || moving) return;
    if (Math.hypot(next.screenX - screenX, next.screenY - screenY) < DRAG_THRESHOLD_PX) return;
    moving = true;
    surface.setPointerCapture(pointerId);
    miniHost.drag({ phase: "start", x: screenX, y: screenY });
  };
  const release = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    if (!moving) return;
    miniHost.drag({ phase: "end", snap: next.type === "pointerup" && next.altKey });
    // The release that ends a move is not a click on whatever it ends over.
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}
