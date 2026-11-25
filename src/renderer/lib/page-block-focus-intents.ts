import { useSyncExternalStore } from "react";

/** A Block to focus once its Page shows; `projectId` is null for a Library-routed Page. */
export interface PageBlockFocusIntent {
  readonly id: number;
  readonly projectId: string | null;
  readonly pageId: string;
  readonly blockId: string;
}

let nextIntentId = 1;
const intents = new Map<string, PageBlockFocusIntent>();
const listeners = new Map<string, Set<() => void>>();

const focusKey = (projectId: string | null, pageId: string): string =>
  `${projectId ?? ""}\0${pageId}`;

const emit = (key: string): void => {
  for (const listener of listeners.get(key) ?? []) listener();
};

export const requestPageBlockFocus = (input: {
  readonly projectId: string | null;
  readonly pageId: string;
  readonly blockId: string;
}): PageBlockFocusIntent => {
  const intent = { ...input, id: nextIntentId++ };
  const key = focusKey(input.projectId, input.pageId);
  intents.set(key, intent);
  emit(key);
  return intent;
};

export const consumePageBlockFocus = (intent: PageBlockFocusIntent): void => {
  const key = focusKey(intent.projectId, intent.pageId);
  if (intents.get(key)?.id !== intent.id) return;
  intents.delete(key);
  emit(key);
};

export const usePageBlockFocusIntent = (
  projectId: string | null,
  pageId: string,
): PageBlockFocusIntent | null => {
  const key = pageId ? focusKey(projectId, pageId) : null;
  return useSyncExternalStore(
    (listener) => {
      if (!key) return () => undefined;
      const current = listeners.get(key) ?? new Set();
      current.add(listener);
      listeners.set(key, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(key);
      };
    },
    () => (key ? (intents.get(key) ?? null) : null),
    () => null,
  );
};
