import { useSyncExternalStore } from "react";

/**
 * A Prompt's folded children are presentation, like a Toggle's: kept per Block on this device,
 * never in the Document. Prompts open by default and fold after a send.
 */
const STORAGE_PREFIX = "nfm-prompt-collapsed-";
const listeners = new Map<string, Set<() => void>>();

function storageKey(blockId: string) {
  return `${STORAGE_PREFIX}${blockId}`;
}

export function readNfmPromptCollapsed(blockId: string): boolean {
  try {
    return localStorage.getItem(storageKey(blockId)) === "true";
  } catch {
    return false;
  }
}

export function writeNfmPromptCollapsed(blockId: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(storageKey(blockId), "true");
    else localStorage.removeItem(storageKey(blockId));
  } catch {
    // localStorage may be unavailable; the fold then lasts for this view only.
  }
  for (const listener of listeners.get(blockId) ?? []) listener();
}

export function useNfmPromptCollapsed(blockId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const blockListeners = listeners.get(blockId) ?? new Set<() => void>();
      blockListeners.add(listener);
      listeners.set(blockId, blockListeners);
      return () => {
        blockListeners.delete(listener);
        if (blockListeners.size === 0) listeners.delete(blockId);
      };
    },
    () => readNfmPromptCollapsed(blockId),
  );
}
