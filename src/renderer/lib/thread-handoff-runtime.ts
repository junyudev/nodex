import { createContext, useContext, useSyncExternalStore } from "react";
import type {
  CodexAppHandoffOperation,
  CodexThreadHandoffSnapshot,
  ThreadExecutionHandoffInput,
} from "../../shared/codex-thread-handoff";
import { subscribeCodexThreadHandoffsChanged } from "./api";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const moveThreadExecutionCommand = defineRendererCommand({
  key: "thread_execution.handoff",
  channel: "thread-execution:handoff",
  authority: "main",
  owner: "ThreadExecutionLocation",
  protocol: { kind: "pending_operation" },
});

export function moveThreadExecution(input: ThreadExecutionHandoffInput) {
  return invokePlainCommand(moveThreadExecutionCommand, input);
}

export interface ThreadHandoffScope {
  readonly operationId: string;
  readonly requestThreadId: string;
  readonly targetThreadId: string;
  readonly destinationHostId: string | null;
}

export interface ThreadHandoffTransport {
  readonly read: () => Promise<CodexThreadHandoffSnapshot>;
  readonly subscribe: (listener: (snapshot: CodexThreadHandoffSnapshot) => void) => () => void;
}

const EMPTY_SNAPSHOT: CodexThreadHandoffSnapshot = { revision: -1, operations: [] };

/** One observed Profile projection shared by every handoff row; Main owns operation progress. */
export function createThreadHandoffStore(transport: ThreadHandoffTransport) {
  let snapshot = EMPTY_SNAPSHOT;
  let generation = 0;
  let stopObserving: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: CodexThreadHandoffSnapshot) => {
    if (next.revision <= snapshot.revision) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      const observedGeneration = ++generation;
      // Observe before reading so a slow bootstrap response cannot erase newer progress.
      stopObserving = transport.subscribe((next) => {
        if (observedGeneration === generation) publish(next);
      });
      void transport.read().then(
        (next) => {
          if (observedGeneration === generation) publish(next);
        },
        () => {
          // The live observation remains available if the bootstrap query is interrupted.
        },
      );
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      generation += 1;
      stopObserving?.();
      stopObserving = null;
      snapshot = EMPTY_SNAPSHOT;
    };
  };

  return { getSnapshot: () => snapshot, subscribe };
}

export function selectThreadHandoffOperation(
  snapshot: CodexThreadHandoffSnapshot,
  scope: ThreadHandoffScope | null,
): CodexAppHandoffOperation | null {
  if (!scope) return null;
  const operation = snapshot.operations.find((entry) => entry.operationId === scope.operationId);
  if (!operation || operation.requestThreadId !== scope.requestThreadId) return null;
  if (operation.sourceThreadId !== scope.targetThreadId) return null;
  if (scope.destinationHostId !== null && operation.destinationHostId !== scope.destinationHostId)
    return null;
  return operation;
}

const handoffs = createThreadHandoffStore({
  read: () => invokeRendererQuery("codex:thread-handoffs:list"),
  subscribe: subscribeCodexThreadHandoffsChanged,
});
const ThreadHandoffStoreContext = createContext(handoffs);
export const ThreadHandoffStoreProvider = ThreadHandoffStoreContext.Provider;
const subscribeToNothing = () => () => undefined;

export function useThreadHandoffOperation(scope: ThreadHandoffScope | null) {
  const store = useContext(ThreadHandoffStoreContext);
  const snapshot = useSyncExternalStore(
    scope ? store.subscribe : subscribeToNothing,
    store.getSnapshot,
    () => EMPTY_SNAPSHOT,
  );
  return selectThreadHandoffOperation(snapshot, scope);
}

/** Attached chats also observe operations started in another window or before a restart. */
export function useThreadExecutionHandoff(threadId: string | null) {
  const store = useContext(ThreadHandoffStoreContext);
  const snapshot = useSyncExternalStore(
    threadId ? store.subscribe : subscribeToNothing,
    store.getSnapshot,
    () => EMPTY_SNAPSHOT,
  );
  return snapshot.operations
    .filter((operation) => operation.sourceThreadId === threadId)
    .reduce<CodexAppHandoffOperation | null>(
      (latest, operation) =>
        !latest || operation.createdAt > latest.createdAt ? operation : latest,
      null,
    );
}
