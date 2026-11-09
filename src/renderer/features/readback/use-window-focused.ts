import { useSyncExternalStore } from "react";
import { getWindowFocusState, subscribeWindowFocusChanges } from "../../lib/api";

let focused = typeof document === "undefined" ? true : document.hasFocus();
const listeners = new Set<() => void>();
let release: (() => void) | null = null;

const publish = (next: boolean) => {
  if (next === focused) return;
  focused = next;
  for (const listener of [...listeners]) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!release) {
    release = subscribeWindowFocusChanges(publish);
    void getWindowFocusState().then(publish, () => undefined);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !release) return;
    release();
    release = null;
  };
}

/**
 * Whether this window is the focused application window. It follows the native window rather
 * than the document, so a focused Browser guest or webview still counts as this window.
 */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, () => focused);
}
