export interface CodeBlockViewStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CodeBlockViewStateStore {
  getWrapped(blockId: string): boolean;
  setWrapped(blockId: string, wrapped: boolean): void;
  getMermaidPreviewMode(blockId: string): MermaidCodePreviewMode;
  setMermaidPreviewMode(blockId: string, mode: MermaidCodePreviewMode): void;
  subscribe(blockId: string, listener: () => void): () => void;
}

export type MermaidCodePreviewMode = "code" | "preview" | "split";

export function codeWrapStateStorageKey(blockId: string): string {
  return `code-wrap-${blockId}`;
}

export function mermaidPreviewModeStorageKey(blockId: string): string {
  return `code-mermaid-preview-${blockId}`;
}

function isMermaidCodePreviewMode(value: string | null): value is MermaidCodePreviewMode {
  return value === "code" || value === "preview" || value === "split";
}

function getBrowserStorage(): CodeBlockViewStateStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createCodeBlockViewStateStore(
  storage: CodeBlockViewStateStorage | null = getBrowserStorage(),
): CodeBlockViewStateStore {
  const wrappedByBlockId = new Map<string, boolean>();
  const mermaidModeByBlockId = new Map<string, MermaidCodePreviewMode>();
  const listenersByBlockId = new Map<string, Set<() => void>>();

  const getWrapped = (blockId: string): boolean => {
    const cached = wrappedByBlockId.get(blockId);
    if (cached !== undefined) return cached;

    let wrapped = false;
    try {
      wrapped = storage?.getItem(codeWrapStateStorageKey(blockId)) === "true";
    } catch {
      wrapped = false;
    }
    wrappedByBlockId.set(blockId, wrapped);
    return wrapped;
  };

  const setWrapped = (blockId: string, wrapped: boolean): void => {
    if (getWrapped(blockId) === wrapped) return;
    wrappedByBlockId.set(blockId, wrapped);
    try {
      storage?.setItem(codeWrapStateStorageKey(blockId), wrapped ? "true" : "false");
    } catch {
      // Keep the renderer session responsive even when persistence is unavailable.
    }
    for (const listener of listenersByBlockId.get(blockId) ?? []) listener();
  };

  const getMermaidPreviewMode = (blockId: string): MermaidCodePreviewMode => {
    const cached = mermaidModeByBlockId.get(blockId);
    if (cached) return cached;

    let mode: MermaidCodePreviewMode = "split";
    try {
      const stored = storage?.getItem(mermaidPreviewModeStorageKey(blockId)) ?? null;
      if (isMermaidCodePreviewMode(stored)) mode = stored;
    } catch {
      mode = "split";
    }
    mermaidModeByBlockId.set(blockId, mode);
    return mode;
  };

  const setMermaidPreviewMode = (blockId: string, mode: MermaidCodePreviewMode): void => {
    if (getMermaidPreviewMode(blockId) === mode) return;
    mermaidModeByBlockId.set(blockId, mode);
    try {
      storage?.setItem(mermaidPreviewModeStorageKey(blockId), mode);
    } catch {
      // Keep the renderer session responsive even when persistence is unavailable.
    }
    for (const listener of listenersByBlockId.get(blockId) ?? []) listener();
  };

  const subscribe = (blockId: string, listener: () => void): (() => void) => {
    const listeners = listenersByBlockId.get(blockId) ?? new Set<() => void>();
    listeners.add(listener);
    listenersByBlockId.set(blockId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByBlockId.delete(blockId);
    };
  };

  return { getWrapped, setWrapped, getMermaidPreviewMode, setMermaidPreviewMode, subscribe };
}

export const codeBlockViewState = createCodeBlockViewStateStore();
