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
let pendingInput: {
  readonly element: HTMLElement;
  readonly controls: SurfaceHistoryControls;
  readonly release: () => void;
} | null = null;

export function historyKeyDirection(event: KeyboardEvent): SurfaceHistoryDirection | null {
  if (event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey)) return null;
  if (event.key.toLowerCase() === "z") return event.shiftKey ? "redo" : "undo";
  if (event.key.toLowerCase() === "y" && !event.shiftKey) return "redo";
  return null;
}

const isUnclaimedFocus = (document: Document): boolean => {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
};

/**
 * Structural preparation temporarily blurs the editor. Keep only history input
 * on its initiating surface until completion; an explicit user interaction wins.
 * A subsequent request replaces this lease, so an older completion cannot end it.
 */
export function retainPendingHistoryInput(
  element: HTMLElement,
  controls: SurfaceHistoryControls,
  request: (direction: SurfaceHistoryDirection) => void,
): { readonly release: () => void; readonly isCurrent: () => boolean } {
  pendingInput?.release();
  const document = element.ownerDocument;
  const window = document.defaultView;
  const release = () => {
    if (pendingInput !== lease) return;
    pendingInput = null;
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("beforeinput", onBeforeInput, true);
    document.removeEventListener("pointerdown", release, true);
    document.removeEventListener("focusin", release, true);
    window?.removeEventListener("blur", release);
    unsubscribe();
    notify();
  };
  const available = () => {
    if (element.isConnected && isUnclaimedFocus(document)) return true;
    if (!element.isConnected) release();
    return false;
  };
  const route = (event: Event, direction: SurfaceHistoryDirection) => {
    if (event.defaultPrevented || !available()) return;
    event.preventDefault();
    event.stopPropagation();
    request(direction);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const direction = historyKeyDirection(event);
    if (direction) return route(event, direction);
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
    release();
  };
  const onBeforeInput = (event: InputEvent) => {
    if (event.isComposing) return release();
    if (event.inputType === "historyUndo") return route(event, "undo");
    if (event.inputType === "historyRedo") return route(event, "redo");
    release();
  };
  const lease = { element, controls, release };
  const unsubscribe = controls.subscribe(notify);
  pendingInput = lease;
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("pointerdown", release, true);
  document.addEventListener("focusin", release, true);
  window?.addEventListener("blur", release);
  notify();
  return { release, isCurrent: () => pendingInput === lease && element.isConnected };
}

/** The nearest mounted surface wins, except independent native editing targets. */
export function readFocusedHistory(): SurfaceHistorySnapshot | null {
  if (pendingInput?.element.isConnected && isUnclaimedFocus(document))
    return pendingInput.controls.snapshot();
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
