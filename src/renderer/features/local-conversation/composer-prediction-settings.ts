import { runConversationOperation } from "./local-conversation-operations";

const storageKey = "nodex-composer-predictions-enabled-v1";
const listeners = new Set<() => void>();

/** Local preference permits predictions; explicit Main availability still gates all inference. */
export function readComposerPredictionsEnabled(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(storageKey) !== "false";
  } catch {
    return true;
  }
}

export function writeComposerPredictionsEnabled(enabled: boolean): void {
  const previous = readComposerPredictionsEnabled();
  try {
    localStorage.setItem(storageKey, String(enabled));
  } catch {
    return;
  }
  if (previous === enabled) return;
  // Inference can outlive every Composer and can be cached on multiple hosts.
  void runConversationOperation("codex:composer-prediction:clear").catch(() => {});
  for (const listener of listeners) listener();
}

export function subscribeComposerPredictionsEnabled(listener: () => void): () => void {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) listener();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}
