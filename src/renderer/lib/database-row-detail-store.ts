import { useEffect, useMemo, useSyncExternalStore } from "react";
import { invokeRendererQuery as invoke } from "./renderer-command";
import type { DatabasePage } from "./types";

interface DatabaseRowDetailSnapshot {
  card: DatabasePage | null;
  loading: boolean;
  error: string | null;
}

type Listener = () => void;

interface SetDatabaseRowDetailOptions {
  acceptEqualRevision?: boolean;
}

const EMPTY_DETAIL: DatabaseRowDetailSnapshot = {
  card: null,
  loading: false,
  error: null,
};

const listenersByKey = new Map<string, Set<Listener>>();
const keyVersions = new Map<string, number>();
const detailEntries = new Map<string, DatabaseRowDetailSnapshot>();
interface InFlightRowDetail {
  readonly generation: number;
  readonly promise: Promise<DatabasePage | null>;
  readonly token: object;
}
const inFlightSingleRequests = new Map<string, InFlightRowDetail>();
const entryGenerations = new Map<string, number>();
let storeGeneration = 0;

function detailKey(projectId: string, pageId: string): string {
  return JSON.stringify([projectId, pageId]);
}

function keyBelongsToProject(key: string, projectId: string): boolean {
  try {
    const coordinate: unknown = JSON.parse(key);
    return Array.isArray(coordinate) && coordinate[0] === projectId;
  } catch {
    return false;
  }
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}

function bumpKeyVersion(key: string): void {
  keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
}

function advanceEntryGeneration(key: string): number {
  const generation = (entryGenerations.get(key) ?? 0) + 1;
  entryGenerations.set(key, generation);
  return generation;
}

function emitKeys(keys: Iterable<string>): void {
  const listeners = new Set<Listener>();
  for (const key of keys) {
    bumpKeyVersion(key);
    for (const listener of listenersByKey.get(key) ?? []) {
      listeners.add(listener);
    }
  }

  for (const listener of listeners) {
    listener();
  }
}

function subscribeKey(key: string, listener: Listener): () => void {
  const listeners = listenersByKey.get(key) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByKey.set(key, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByKey.delete(key);
      advanceEntryGeneration(key);
      detailEntries.delete(key);
    }
  };
}

function getKeyVersionSnapshot(key: string | null): number {
  if (!key) return 0;
  return keyVersions.get(key) ?? 0;
}

function isStale(card: DatabasePage | null, revision: number | undefined): boolean {
  if (!card) return true;
  if (revision === undefined) return false;
  return card.revision !== revision;
}

function shouldAcceptDatabaseRowDetail(
  existing: DatabasePage | null,
  incoming: DatabasePage,
  options: SetDatabaseRowDetailOptions = {},
): boolean {
  if (!existing) return true;
  if (typeof existing.revision !== "number" || typeof incoming.revision !== "number") {
    return existing !== incoming;
  }
  if (options.acceptEqualRevision && incoming.revision === existing.revision) {
    return existing !== incoming;
  }
  return incoming.revision > existing.revision;
}

function setDatabaseRowDetailEntry(
  projectId: string,
  card: DatabasePage,
  options: SetDatabaseRowDetailOptions = {},
): string | null {
  const key = detailKey(projectId, card.id);
  const existing = detailEntries.get(key) ?? EMPTY_DETAIL;
  const nextCard = shouldAcceptDatabaseRowDetail(existing.card, card, options)
    ? card
    : existing.card;
  const nextEntry: DatabaseRowDetailSnapshot = {
    card: nextCard,
    loading: false,
    error: null,
  };

  if (
    existing.card === nextEntry.card &&
    existing.loading === nextEntry.loading &&
    existing.error === nextEntry.error
  ) {
    return null;
  }

  detailEntries.set(key, nextEntry);
  return key;
}

export function setDatabaseRowDetail(
  projectId: string,
  card: DatabasePage,
  options: SetDatabaseRowDetailOptions = {},
): void {
  const changedKey = setDatabaseRowDetailEntry(projectId, card, options);
  if (!changedKey) return;
  emitKeys([changedKey]);
}

export function setDatabaseRowDetails(projectId: string, cards: readonly DatabasePage[]): void {
  if (cards.length === 0) return;
  const changedKeys = new Set<string>();
  for (const card of cards) {
    const changedKey = setDatabaseRowDetailEntry(projectId, card);
    if (changedKey) changedKeys.add(changedKey);
  }
  if (changedKeys.size > 0) emitKeys(changedKeys);
}

export function getDatabaseRowDetail(projectId: string, pageId: string): DatabasePage | null {
  return detailEntries.get(detailKey(projectId, pageId))?.card ?? null;
}

export function revokeDatabaseRowDetail(projectId: string, pageId: string): void {
  const key = detailKey(projectId, pageId);
  advanceEntryGeneration(key);
  detailEntries.set(key, {
    card: null,
    loading: false,
    error: "Page not found",
  });
  emitKeys([key]);
}

/** Clears a Project's row cache when a stream checkpoint proves events were missed. */
export function fenceDatabaseRowDetailsForProject(projectId: string): void {
  const affected = new Set<string>();
  for (const key of new Set([
    ...detailEntries.keys(),
    ...listenersByKey.keys(),
    ...inFlightSingleRequests.keys(),
  ])) {
    if (!keyBelongsToProject(key, projectId)) continue;
    advanceEntryGeneration(key);
    detailEntries.delete(key);
    affected.add(key);
  }
  emitKeys(affected);
}

export function resetDatabaseRowDetailStoreForTests(): void {
  storeGeneration += 1;
  const subscribedKeys = [...listenersByKey.keys()];
  detailEntries.clear();
  inFlightSingleRequests.clear();
  entryGenerations.clear();
  keyVersions.clear();
  emitKeys(subscribedKeys);
}

export async function fetchDatabaseRowDetail(
  projectId: string,
  pageId: string,
  status?: DatabasePage["status"],
): Promise<DatabasePage | null> {
  const key = detailKey(projectId, pageId);
  const generation = entryGenerations.get(key) ?? 0;
  const existing = inFlightSingleRequests.get(key);
  if (existing?.generation === generation) return existing.promise;

  const currentEntry = detailEntries.get(key);
  if (!currentEntry?.card) {
    detailEntries.set(key, {
      card: null,
      loading: true,
      error: null,
    });
    emitKeys([key]);
  } else if (currentEntry.error) {
    detailEntries.set(key, {
      card: currentEntry.card,
      loading: false,
      error: null,
    });
    emitKeys([key]);
  }

  const requestStoreGeneration = storeGeneration;
  const requestToken = {};
  const request = (async () => {
    try {
      const card = (await invoke(
        "database-row:get",
        projectId,
        pageId,
        status,
      )) as DatabasePage | null;
      if (
        requestStoreGeneration !== storeGeneration ||
        generation !== (entryGenerations.get(key) ?? 0)
      )
        return null;
      if (card) {
        setDatabaseRowDetail(projectId, card);
      } else {
        detailEntries.set(key, {
          card: null,
          loading: false,
          error: "Page not found",
        });
        emitKeys([key]);
      }
      return card;
    } catch (error) {
      if (
        requestStoreGeneration !== storeGeneration ||
        generation !== (entryGenerations.get(key) ?? 0)
      )
        return null;
      detailEntries.set(key, {
        card: detailEntries.get(key)?.card ?? null,
        loading: false,
        error: toErrorMessage(error),
      });
      emitKeys([key]);
      return null;
    } finally {
      if (inFlightSingleRequests.get(key)?.token === requestToken) {
        inFlightSingleRequests.delete(key);
      }
    }
  })();

  inFlightSingleRequests.set(key, {
    generation,
    promise: request,
    token: requestToken,
  });
  return request;
}

export function useDatabaseRowDetail(
  projectId: string,
  pageId: string | null | undefined,
  status?: DatabasePage["status"],
  revision?: number,
): DatabaseRowDetailSnapshot {
  const key = pageId ? detailKey(projectId, pageId) : null;
  const subscribe = useMemo(
    () => (listener: Listener) => (key ? subscribeKey(key, listener) : () => undefined),
    [key],
  );
  const getSnapshot = useMemo(() => () => getKeyVersionSnapshot(key), [key]);
  useSyncExternalStore(subscribe, getSnapshot);
  const snapshot = key ? (detailEntries.get(key) ?? EMPTY_DETAIL) : EMPTY_DETAIL;

  useEffect(() => {
    if (!pageId) return;
    if (snapshot.loading) return;
    if (snapshot.error) return;
    if (!isStale(snapshot.card, revision)) return;
    void fetchDatabaseRowDetail(projectId, pageId, status);
  }, [pageId, projectId, revision, snapshot.card, snapshot.error, snapshot.loading, status]);

  return snapshot;
}
