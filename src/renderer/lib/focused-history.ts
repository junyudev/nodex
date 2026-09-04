import type { SurfaceHistoryDirection, SurfaceHistorySnapshot } from "../../shared/surface-history";
import type { SurfaceHistoryControls } from "./surface-history/controls";

interface FocusedHistoryRegistration {
  readonly controls: SurfaceHistoryControls;
  readonly contentEditableRoot?: () => HTMLElement | null;
}
const registrations = new Map<HTMLElement, FocusedHistoryRegistration>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const notifyAfterFocus = () => queueMicrotask(notify);

/** The nearest mounted surface wins, except independent native editing targets. */
export function readFocusedHistory(): SurfaceHistorySnapshot | null {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) return null;
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    const registered = registrations.get(element);
    if (!registered) continue;
    const native = target.closest(
      'input, textarea, [contenteditable], [role="textbox"], [role="combobox"]',
    );
    const editing =
      native &&
      (native.matches('input, textarea, [role="textbox"], [role="combobox"]') ||
        native.getAttribute("contenteditable") !== "false");
    if (native?.getAttribute("contenteditable") === "false" && registered.contentEditableRoot)
      return null;
    if (editing && native !== registered.contentEditableRoot?.()) return null;
    return registered.controls.snapshot();
  }
  return null;
}

export function registerFocusedHistory(
  element: HTMLElement,
  registration: FocusedHistoryRegistration,
): () => void {
  registrations.set(element, registration);
  const unsubscribe = registration.controls.subscribe(notify);
  notify();
  return () => {
    unsubscribe();
    if (registrations.get(element) === registration) registrations.delete(element);
    notify();
  };
}

export function subscribeFocusedHistory(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("focusin", notify);
    document.addEventListener("focusout", notifyAfterFocus);
    window.addEventListener("focus", notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("focusin", notify);
    document.removeEventListener("focusout", notifyAfterFocus);
    window.removeEventListener("focus", notify);
  };
}

/** Route native menus through the same focused input owner as browser history input. */
export function dispatchFocusedHistory(direction: SurfaceHistoryDirection): void {
  const target = document.activeElement ?? document.body;
  const request = new InputEvent("beforeinput", {
    inputType: direction === "undo" ? "historyUndo" : "historyRedo",
    bubbles: true,
    cancelable: true,
  });
  if (!target.dispatchEvent(request)) return;
  // Standard inputs retain Chromium's native history. This fallback never runs
  // after an editor has claimed the intent, even when its own history is empty.
  document.execCommand(direction);
}
