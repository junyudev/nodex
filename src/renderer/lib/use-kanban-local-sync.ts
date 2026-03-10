import type { CardInput } from "./types";

export interface KanbanLocalPatchMutation {
  type: "patch";
  sourceInstanceId: symbol;
  columnId: string;
  cardId: string;
  updates: Partial<CardInput>;
}

export interface KanbanLocalRefreshMutation {
  type: "refresh";
  sourceInstanceId: symbol;
}

export type KanbanLocalMutation = KanbanLocalPatchMutation | KanbanLocalRefreshMutation;

type KanbanLocalMutationListener = (mutation: KanbanLocalMutation) => void;

const listenersByProjectId = new Map<string, Set<KanbanLocalMutationListener>>();

export function publishKanbanLocalMutation(
  projectId: string,
  mutation: KanbanLocalMutation,
): void {
  if (!projectId) return;

  const listeners = listenersByProjectId.get(projectId);
  if (!listeners || listeners.size === 0) return;

  for (const listener of listeners) {
    listener(mutation);
  }
}

export function subscribeKanbanLocalMutation(
  projectId: string,
  listener: KanbanLocalMutationListener,
): () => void {
  if (!projectId) return () => {};

  const listeners = listenersByProjectId.get(projectId) ?? new Set<KanbanLocalMutationListener>();
  listeners.add(listener);
  listenersByProjectId.set(projectId, listeners);

  return () => {
    const current = listenersByProjectId.get(projectId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByProjectId.delete(projectId);
    }
  };
}

export function resetKanbanLocalMutationListenersForTest(): void {
  listenersByProjectId.clear();
}
