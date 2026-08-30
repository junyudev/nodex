import { resolveRendererTransport } from "./renderer-transport";
import {
  defineRendererCommand,
  invokeRendererQuery,
  invokeRevisionedCommand,
} from "./renderer-command";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
} from "../../shared/ipc-api";

type PersistedAtomListener = (value: unknown) => void;
type PersistedAtomEventListener = (event: PersistedAtomEvent) => void;

const updatePersistedAtomCommand = defineRendererCommand({
  key: "persisted_atom.update",
  channel: "persisted-atom:update",
  authority: "main",
  owner: "PersistedAtomStore",
  protocol: { kind: "revision_fenced_local" },
});

export interface PersistedAtomTransport {
  readSnapshot(): Promise<PersistedAtomSnapshot>;
  mutate(mutation: PersistedAtomMutation): Promise<PersistedAtomEvent>;
  subscribe(listener: PersistedAtomEventListener): () => void;
}

const listenersByKey = new Map<string, Set<PersistedAtomListener>>();
const eventListeners = new Set<PersistedAtomEventListener>();

let snapshot: PersistedAtomSnapshot | null = null;
let syncPromise: Promise<PersistedAtomSnapshot> | null = null;
let electronUnsubscribe: (() => void) | null = null;
let memoryRevision = 0;

function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.api);
}

function emitAtomUpdate(key: string, value: unknown): void {
  const listeners = listenersByKey.get(key);
  if (!listeners) return;
  for (const listener of listeners) listener(value);
}

function publishEvent(event: PersistedAtomEvent): void {
  for (const listener of eventListeners) listener(event);
}

function applySnapshot(next: PersistedAtomSnapshot): PersistedAtomSnapshot {
  if (snapshot && next.revision < snapshot.revision) return snapshot;
  const previousValues = snapshot?.values ?? {};
  snapshot = {
    revision: next.revision,
    values: { ...next.values },
  };
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (Object.is(previousValues[key], value)) continue;
    emitAtomUpdate(key, value);
  }
  return snapshot;
}

function applyEvent(event: PersistedAtomEvent): void {
  if (snapshot && event.revision <= snapshot.revision) return;
  snapshot = {
    revision: event.revision,
    values: {
      ...(snapshot?.values ?? {}),
      [event.key]: event.value,
    },
  };
  emitAtomUpdate(event.key, event.value);
  publishEvent(event);
}

function ensureElectronSubscription(): void {
  if (!isElectronRuntime() || electronUnsubscribe) return;
  electronUnsubscribe = resolveRendererTransport().subscribePersistedAtomUpdates(applyEvent);
}

async function readOrderedSnapshot(): Promise<PersistedAtomSnapshot> {
  if (!isElectronRuntime()) {
    return snapshot ?? { revision: memoryRevision, values: {} };
  }
  ensureElectronSubscription();
  if (snapshot !== null) return snapshot;
  if (!syncPromise) {
    syncPromise = invokeRendererQuery("persisted-atom:sync-request")
      .then(applySnapshot)
      .finally(() => {
        syncPromise = null;
      });
  }
  return syncPromise;
}

async function mutateOrdered(mutation: PersistedAtomMutation): Promise<PersistedAtomEvent> {
  const key = mutation.key.trim();
  const mutationId = mutation.mutationId.trim();
  if (!key) throw new Error("Persisted atom mutation key must not be empty");
  if (!mutationId) throw new Error("Persisted atom mutation id must not be empty");
  const normalizedMutation = { ...mutation, key, mutationId };

  if (!isElectronRuntime()) {
    memoryRevision += 1;
    const event: PersistedAtomEvent = {
      ...normalizedMutation,
      revision: memoryRevision,
      originRendererId: "memory",
    };
    applyEvent(event);
    return event;
  }

  ensureElectronSubscription();
  const event = await invokeRevisionedCommand(updatePersistedAtomCommand, normalizedMutation);
  applyEvent(event);
  return event;
}

function subscribeOrdered(listener: PersistedAtomEventListener): () => void {
  ensureElectronSubscription();
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

const defaultTransport: PersistedAtomTransport = {
  readSnapshot: readOrderedSnapshot,
  mutate: mutateOrdered,
  subscribe: subscribeOrdered,
};

export function getPersistedAtomTransport(): PersistedAtomTransport {
  return defaultTransport;
}

export async function readAtom(key: string, fallback: unknown): Promise<unknown> {
  const current = await readOrderedSnapshot();
  return Object.prototype.hasOwnProperty.call(current.values, key) ? current.values[key] : fallback;
}

export async function writeAtom(key: string, value: unknown): Promise<void> {
  await mutateOrdered({
    key,
    value,
    mutationId: createMutationId(),
  });
}

export function subscribeAtom(key: string, listener: PersistedAtomListener): () => void {
  ensureElectronSubscription();
  const listeners = listenersByKey.get(key) ?? new Set<PersistedAtomListener>();
  listeners.add(listener);
  listenersByKey.set(key, listeners);

  return () => {
    const currentListeners = listenersByKey.get(key);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    if (currentListeners.size === 0) listenersByKey.delete(key);
  };
}

function createMutationId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `mutation:${Date.now()}:${Math.random()}`;
}

export function clearPersistedAtomStoreForTests(): void {
  listenersByKey.clear();
  eventListeners.clear();
  snapshot = null;
  syncPromise = null;
  memoryRevision = 0;
  electronUnsubscribe?.();
  electronUnsubscribe = null;
}
