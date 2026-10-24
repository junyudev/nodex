import { useSyncExternalStore } from "react";

export type DocumentTheme = "dark" | "light";

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

export function readDocumentTheme(): DocumentTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (
    listeners.size === 1 &&
    typeof document !== "undefined" &&
    typeof MutationObserver !== "undefined"
  ) {
    observer = new MutationObserver(() => {
      listeners.forEach((currentListener) => currentListener());
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
  };
}

/**
 * Reads the effective theme from the DOM presentation boundary without requiring
 * app state. Use it for independently mountable previews and portals.
 */
export function useDocumentTheme(): DocumentTheme {
  return useSyncExternalStore(subscribe, readDocumentTheme, () => "light");
}
