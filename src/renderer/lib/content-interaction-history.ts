import type { OwnedDocumentDescriptor } from "../../shared/block-documents";
import { contentAccessContextKey } from "../../shared/content-access-context";
import { createInteractionHistory, type InteractionHistory } from "./surface-history/owner";
import type { SurfaceHistorySnapshot } from "../../shared/surface-history";
import type { SurfaceHistoryControls } from "./surface-history/controls";

export type ContentInteractionHistoryScope = Pick<
  OwnedDocumentDescriptor,
  "libraryId" | "accessContext" | "storeEpoch"
>;

export const contentInteractionHistoryScopeKey = (scope: ContentInteractionHistoryScope): string =>
  [scope.libraryId, contentAccessContextKey(scope.accessContext), scope.storeEpoch].join("\0");

interface RealmLease {
  readonly history: InteractionHistory;
  readonly scope: ContentInteractionHistoryScope;
  readonly unsubscribe: () => void;
  references: number;
}
const realms = new Map<string, RealmLease>();
export interface ContentHistoryObservation {
  readonly scope: ContentInteractionHistoryScope;
  readonly controls: SurfaceHistoryControls;
  readonly snapshot: SurfaceHistorySnapshot;
}
const observers = new Set<() => void>();
let observations: readonly ContentHistoryObservation[] = [];
export interface ContentProjectionActivity {
  readonly pending: number;
  readonly unknown: number;
  readonly acknowledged: number;
}
export interface ContentProjectionActivitySource {
  readonly id: string;
  readonly label: string;
  getActivity(): ContentProjectionActivity;
  subscribe(listener: () => void): () => void;
}
export interface ContentProjectionObservation {
  readonly scope: ContentInteractionHistoryScope;
  readonly id: string;
  readonly label: string;
  readonly activity: ContentProjectionActivity;
}
const projectionSources = new Map<
  string,
  {
    readonly source: ContentProjectionActivitySource;
    readonly scope: ContentInteractionHistoryScope;
    readonly unsubscribe: () => void;
    references: number;
  }
>();
let projectionObservations: readonly ContentProjectionObservation[] = [];
const publish = () => {
  observations = [...realms.values()].map(({ history, scope }) => ({
    scope,
    controls: history,
    snapshot: history.snapshot(),
  }));
  projectionObservations = [...projectionSources.values()].map(({ source, scope }) => ({
    scope,
    id: source.id,
    label: source.label,
    activity: source.getActivity(),
  }));
  observers.forEach((listener) => listener());
};

/** Borrow projection-owner observations; this registry cannot settle or mutate a journal. */
export function registerContentProjectionActivity(
  scope: ContentInteractionHistoryScope,
  source: ContentProjectionActivitySource,
): () => void {
  const key = `${contentInteractionHistoryScopeKey(scope)}\0${source.id}`;
  let entry = projectionSources.get(key);
  if (!entry) {
    entry = { source, scope, references: 0, unsubscribe: source.subscribe(publish) };
    projectionSources.set(key, entry);
  }
  const retained = entry;
  retained.references += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained.references -= 1;
    if (retained.references !== 0) return;
    projectionSources.delete(key);
    retained.unsubscribe();
    publish();
  };
}
export const readContentProjectionActivities = () => projectionObservations;

/** Observation never acquires a lease or prolongs a content timeline's lifetime. */
export const readContentInteractionHistories = () => observations;
export function subscribeContentInteractionHistories(listener: () => void): () => void {
  observers.add(listener);
  return () => observers.delete(listener);
}

/** Runtime participants, not DOM mounts, retain each window-local content timeline. */
export function acquireContentInteractionHistory(scope: ContentInteractionHistoryScope): {
  readonly history: InteractionHistory;
  release(): void;
} {
  const key = contentInteractionHistoryScopeKey(scope);
  let realm = realms.get(key);
  if (!realm) {
    const history = createInteractionHistory({
      scopeKey: key,
      limits: { maxEntries: 500, maxBytes: 64 * 1024 * 1024, maxPending: 101 },
      onError: (error) => console.error("Content history failed", error),
    });
    realm = {
      history,
      scope,
      unsubscribe: history.subscribe(publish),
      references: 0,
    };
    realms.set(key, realm);
    publish();
  }
  const retained = realm;
  retained.references += 1;
  let released = false;
  return {
    history: retained.history,
    release() {
      if (released) return;
      released = true;
      retained.references -= 1;
      if (retained.references !== 0) return;
      realms.delete(key);
      retained.unsubscribe();
      retained.history.close();
      publish();
    },
  };
}

/** Settle admitted local work before the window flushes its durable Documents. */
export async function flushContentInteractionHistories(): Promise<void> {
  await Promise.all([...realms.values()].map((realm) => realm.history.whenIdle()));
}
