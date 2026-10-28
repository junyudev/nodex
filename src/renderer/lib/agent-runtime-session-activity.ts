import { useSyncExternalStore } from "react";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
  AgentRuntimeSessionActivitySnapshot,
} from "../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { resolveRendererTransport } from "./renderer-transport";

export interface AgentRuntimeActivitySource {
  readonly read: () => Promise<AgentRuntimeSessionActivitySnapshot>;
  readonly subscribe: (listener: (change: AgentRuntimeSessionActivityChange) => void) => () => void;
  readonly readConnection: () => Promise<AgentRuntimeConnectionState>;
  readonly subscribeConnection: (
    listener: (state: AgentRuntimeConnectionState) => void,
  ) => () => void;
}

export interface AgentRuntimeActivityStore {
  /** Activity for one Session, or null when it is idle or not Runtime-bound. */
  readonly read: (sessionId: string) => AgentRuntimeSessionActivity | null;
  /** All non-idle Sessions in the current bounded snapshot. */
  readonly readAll: () => ReadonlyMap<string, AgentRuntimeSessionActivity>;
  readonly readConnection: () => AgentRuntimeConnectionState;
  /** Notifies only when this Session's activity changes. */
  readonly subscribeSession: (sessionId: string, listener: () => void) => () => void;
  /** Notifies on any activity change; use for aggregates such as Project counts. */
  readonly subscribeAll: (listener: () => void) => () => void;
  readonly subscribeConnection: (listener: () => void) => () => void;
}

const RELEASE_DELAY_MS = 1_000;

/**
 * One renderer projection of Main's Session activity. It attaches on first use, applies
 * pushed changes in sequence order (buffering those that race the initial snapshot),
 * re-reads after `reset`, and detaches shortly after the last observer leaves.
 */
export function createAgentRuntimeActivityStore(
  source: AgentRuntimeActivitySource,
): AgentRuntimeActivityStore {
  let activities: ReadonlyMap<string, AgentRuntimeSessionActivity> = new Map();
  let connection: AgentRuntimeConnectionState = { status: "idle" };
  let appliedSequence = -1;
  let pending: AgentRuntimeSessionActivityChange[] | null = null;
  let readGeneration = 0;
  let releaseSource: (() => void) | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const sessionListeners = new Map<string, Set<() => void>>();
  const allListeners = new Set<() => void>();
  const connectionListeners = new Set<() => void>();

  const observerCount = () => {
    let count = allListeners.size + connectionListeners.size;
    for (const listeners of sessionListeners.values()) count += listeners.size;
    return count;
  };
  const notify = (changed: Iterable<string>) => {
    for (const sessionId of changed)
      for (const listener of [...(sessionListeners.get(sessionId) ?? [])]) listener();
    for (const listener of [...allListeners]) listener();
  };
  const replace = (next: ReadonlyMap<string, AgentRuntimeSessionActivity>) => {
    const changed = new Set<string>();
    for (const [sessionId, activity] of next)
      if (activities.get(sessionId) !== activity) changed.add(sessionId);
    for (const sessionId of activities.keys()) if (!next.has(sessionId)) changed.add(sessionId);
    activities = next;
    if (changed.size > 0) notify(changed);
  };
  const apply = (change: AgentRuntimeSessionActivityChange) => {
    if (change.sequence <= appliedSequence) return;
    appliedSequence = change.sequence;
    if (change.type === "reset") {
      void refresh();
      return;
    }
    const next = new Map(activities);
    if (change.type === "upsert") next.set(change.activity.sessionId, change.activity);
    else next.delete(change.sessionId);
    replace(next);
  };
  const refresh = async () => {
    const generation = ++readGeneration;
    pending = [];
    try {
      const snapshot = await source.read();
      if (generation !== readGeneration || !releaseSource) return;
      const buffered = pending;
      pending = null;
      appliedSequence = snapshot.sequence;
      replace(new Map(snapshot.items.map((activity) => [activity.sessionId, activity])));
      for (const change of buffered ?? []) apply(change);
    } catch {
      if (generation === readGeneration) pending = null;
    }
  };
  let connectionPushes = 0;
  const setConnection = (state: AgentRuntimeConnectionState) => {
    connection = state;
    for (const listener of [...connectionListeners]) listener();
  };
  const attach = () => {
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
    if (releaseSource) return;
    const stopActivity = source.subscribe((change) => {
      if (pending) pending.push(change);
      else apply(change);
    });
    const stopConnection = source.subscribeConnection((state) => {
      connectionPushes += 1;
      const recovered = state.status === "ready" && connection.status !== "ready";
      setConnection(state);
      // A replacement process has no memory of earlier pushes.
      if (recovered) void refresh();
    });
    releaseSource = () => {
      stopActivity();
      stopConnection();
    };
    void refresh();
    const pushesBeforeRead = connectionPushes;
    void source
      .readConnection()
      .then((state) => {
        // A pushed state is newer than a read that raced it.
        if (releaseSource && connectionPushes === pushesBeforeRead) setConnection(state);
      })
      .catch(() => {});
  };
  const detachLater = () => {
    if (observerCount() > 0 || releaseTimer) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (observerCount() > 0 || !releaseSource) return;
      releaseSource();
      releaseSource = null;
      readGeneration += 1;
      pending = null;
      appliedSequence = -1;
      activities = new Map();
    }, RELEASE_DELAY_MS);
  };
  const observe = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener);
    attach();
    return () => {
      listeners.delete(listener);
      detachLater();
    };
  };

  return {
    read: (sessionId) => activities.get(sessionId) ?? null,
    readAll: () => activities,
    readConnection: () => connection,
    subscribeSession: (sessionId, listener) => {
      const listeners = sessionListeners.get(sessionId) ?? new Set();
      sessionListeners.set(sessionId, listeners);
      const release = observe(listeners, listener);
      return () => {
        release();
        if (listeners.size === 0) sessionListeners.delete(sessionId);
      };
    },
    subscribeAll: (listener) => observe(allListeners, listener),
    subscribeConnection: (listener) => observe(connectionListeners, listener),
  };
}

const noSubscription = () => () => {};

export const agentRuntimeActivityStore = createAgentRuntimeActivityStore({
  read: () => agentRuntimeRuntime.activity(),
  subscribe: (listener) =>
    (resolveRendererTransport().subscribeAgentRuntimeActivityChanges ?? noSubscription)(listener),
  readConnection: () => agentRuntimeRuntime.connection(),
  subscribeConnection: (listener) =>
    (resolveRendererTransport().subscribeAgentRuntimeConnectionChanges ?? noSubscription)(listener),
});

const idle = () => null;

/** Live execution facts for a Session; null when idle, unbound or when no Session is given. */
export function useAgentRuntimeSessionActivity(
  sessionId: string | null | undefined,
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): AgentRuntimeSessionActivity | null {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribeSession(sessionId, listener) : () => {}),
    sessionId ? () => store.read(sessionId) : idle,
  );
}

/**
 * Only a Session's status, for surfaces outside its row: they re-render when it starts, waits,
 * or settles rather than on every activity update. Null while idle or not Runtime-bound.
 */
export function useAgentRuntimeSessionStatus(
  sessionId: string | null | undefined,
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): AgentRuntimeSessionActivity["status"] | null {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribeSession(sessionId, listener) : () => {}),
    () => (sessionId ? (store.read(sessionId)?.status ?? null) : null),
  );
}

/** Every non-idle Session; prefer the per-Session hook for leaf rows. */
export function useAgentRuntimeActivities(
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): ReadonlyMap<string, AgentRuntimeSessionActivity> {
  return useSyncExternalStore(store.subscribeAll, store.readAll);
}

export function useAgentRuntimeConnectionState(
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): AgentRuntimeConnectionState {
  return useSyncExternalStore(store.subscribeConnection, store.readConnection);
}
