import { useSyncExternalStore } from "react";

/** A Block to focus in the exact Page surface opened by a navigation gesture. */
export interface PageBlockFocusIntent {
  readonly id: number;
  readonly editorSurfaceId: string;
  readonly pageId: string;
  readonly blockId: string;
}

let nextIntentId = 1;
const intents = new Map<string, PageBlockFocusIntent>();
const listeners = new Map<string, Set<() => void>>();

const focusKey = (editorSurfaceId: string, pageId: string): string =>
  `${editorSurfaceId}\0${pageId}`;

const emit = (key: string): void => {
  for (const listener of listeners.get(key) ?? []) listener();
};

export const requestPageBlockFocus = (input: {
  readonly editorSurfaceId: string;
  readonly pageId: string;
  readonly blockId: string;
}): PageBlockFocusIntent => {
  const intent = { ...input, id: nextIntentId++ };
  const key = focusKey(input.editorSurfaceId, input.pageId);
  intents.set(key, intent);
  emit(key);
  return intent;
};

export const consumePageBlockFocus = (intent: PageBlockFocusIntent): void => {
  const key = focusKey(intent.editorSurfaceId, intent.pageId);
  if (intents.get(key)?.id !== intent.id) return;
  intents.delete(key);
  emit(key);
};

export const usePageBlockFocusIntent = (
  editorSurfaceId: string,
  pageId: string,
): PageBlockFocusIntent | null => {
  const key = pageId ? focusKey(editorSurfaceId, pageId) : null;
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
