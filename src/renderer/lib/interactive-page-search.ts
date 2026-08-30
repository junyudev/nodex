import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  PageSearchFilters,
  PageSearchMetadataDocument,
  PageSearchMetadataSnapshot,
  PageSearchResult,
} from "../../shared/types";
import { searchPages, subscribeLibraryChanges } from "./api";
import { invokeRendererQuery as invoke } from "./renderer-command";

type WasmIndex = {
  free?(): void;
  replace(documents: unknown): void;
  applyDelta(upserts: unknown, removals: unknown): void;
  search(request: unknown): PageSearchResult[];
};

interface ProjectionState {
  readonly revision: number;
  readonly scopeKey: string;
  readonly status: "idle" | "loading" | "ready" | "unavailable";
  readonly libraryId: string | null;
  readonly storeEpoch: string | null;
  readonly commitSeq: number;
  readonly error: string | null;
}

export interface PageSearchIntent {
  readonly projectIds: readonly string[];
  readonly query: string;
  readonly filters?: PageSearchFilters;
  readonly preferredProjectId?: string | null;
  readonly recentPageIds?: readonly string[];
  readonly excludePageIds?: readonly string[];
  readonly dataSourceIds?: readonly string[];
  readonly limit?: number;
  readonly complete?: boolean;
}

export interface InteractivePageSearchResult {
  readonly rows: readonly PageSearchResult[];
  readonly enrichment: "idle" | "loading" | "settled" | "unavailable";
  readonly queryRevision: string;
}

const EMPTY_STATE: ProjectionState = {
  revision: 0,
  scopeKey: "",
  status: "idle",
  libraryId: null,
  storeEpoch: null,
  commitSeq: 0,
  error: null,
};

let state = EMPTY_STATE;
let index: WasmIndex | null = null;
let documents = new Map<string, PageSearchMetadataDocument>();
let configuredProjectIds: string[] = [];
let generation = 0;
let unsubscribeChanges: (() => void) | null = null;
let refreshInFlight = false;
let pendingFullRefresh = false;
const pendingPageIds = new Set<string>();
let nextScopeLeaseId = 1;
const scopeLeases = new Map<
  number,
  {
    readonly projectIds: readonly string[];
    readonly mode: "extend" | "replace";
  }
>();
const listeners = new Set<() => void>();

function emit(next: Omit<ProjectionState, "revision">): void {
  state = { ...next, revision: state.revision + 1 };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ProjectionState {
  return state;
}

function scopeKey(projectIds: readonly string[]): string {
  return [...new Set(projectIds)].sort().join("\n");
}

function projectionIsValid(snapshot: PageSearchMetadataSnapshot, expectedScope: string): boolean {
  const authorizedProjects = new Set(snapshot.authorization.projectIds);
  const pageIds = new Set(snapshot.documents.map((document) => document.pageId));
  return (
    snapshot.libraryId === snapshot.authorization.libraryId &&
    snapshot.storeEpoch === snapshot.authorization.storeEpoch &&
    snapshot.commitSeq === snapshot.authorization.coveredCommitSeq &&
    scopeKey(snapshot.authorization.projectIds) === expectedScope &&
    pageIds.size === snapshot.documents.length &&
    snapshot.documents.every(
      (document) =>
        document.authorizedProjectIds.length > 0 &&
        document.authorizedProjectIds.every((projectId) => authorizedProjects.has(projectId)),
    )
  );
}

async function loadWasm(): Promise<WasmIndex> {
  const wasm = await import("../generated/page-search-wasm/nodex_page_search_kernel.js");
  await wasm.default();
  return new wasm.PageSearchPreviewIndex([]) as WasmIndex;
}

async function refresh(pageIds?: readonly string[]): Promise<void> {
  const currentGeneration = generation;
  const expectedScope = scopeKey(configuredProjectIds);
  try {
    index ??= await loadWasm();
    const snapshot = await invoke(
      "pages:search-metadata",
      configuredProjectIds,
      pageIds ? [...pageIds] : undefined,
    );
    if (
      currentGeneration !== generation ||
      !projectionIsValid(snapshot, expectedScope) ||
      (state.storeEpoch === snapshot.storeEpoch && snapshot.commitSeq < state.commitSeq)
    ) {
      // A partial response can legitimately finish after a newer full response.
      // Reconcile the complete projection instead of silently leaving unrelated
      // Pages stale until another library event arrives.
      if (
        pageIds &&
        currentGeneration === generation &&
        state.storeEpoch === snapshot.storeEpoch &&
        snapshot.commitSeq < state.commitSeq
      ) {
        requestRefresh();
      }
      return;
    }
    if (pageIds) {
      const returned = new Set(snapshot.documents.map((document) => document.pageId));
      const removals = pageIds.filter((pageId) => !returned.has(pageId));
      for (const pageId of removals) documents.delete(pageId);
      for (const document of snapshot.documents) documents.set(document.pageId, document);
      index.applyDelta(snapshot.documents, removals);
    } else {
      documents = new Map(snapshot.documents.map((document) => [document.pageId, document]));
      index.replace(snapshot.documents);
    }
    emit({
      scopeKey: expectedScope,
      status: "ready",
      libraryId: snapshot.libraryId,
      storeEpoch: snapshot.storeEpoch,
      commitSeq: snapshot.commitSeq,
      error: null,
    });
  } catch (error) {
    if (currentGeneration !== generation) return;
    emit({
      ...state,
      scopeKey: expectedScope,
      status: index && documents.size > 0 ? "ready" : "unavailable",
      error: error instanceof Error ? error.message : "Page metadata is unavailable",
    });
  }
}

function requestRefresh(pageIds?: readonly string[]): void {
  if (pageIds === undefined) {
    pendingFullRefresh = true;
    pendingPageIds.clear();
  } else if (!pendingFullRefresh) {
    for (const pageId of pageIds) pendingPageIds.add(pageId);
  }
  if (refreshInFlight) return;
  refreshInFlight = true;
  void drainRefreshQueue();
}

async function drainRefreshQueue(): Promise<void> {
  try {
    while (pendingFullRefresh || pendingPageIds.size > 0) {
      const pageIds = pendingFullRefresh ? undefined : [...pendingPageIds];
      pendingFullRefresh = false;
      pendingPageIds.clear();
      await refresh(pageIds);
    }
  } finally {
    refreshInFlight = false;
    if (pendingFullRefresh || pendingPageIds.size > 0) requestRefresh();
  }
}

function activeProjectIds(): string[] {
  const leases = [...scopeLeases.values()];
  const replacement =
    leases.at(-1)?.mode === "replace"
      ? leases.at(-1)
      : leases.filter((lease) => lease.mode === "replace").at(-1);
  if (replacement) return [...new Set(replacement.projectIds)];
  return [...new Set(leases.flatMap((lease) => lease.projectIds))];
}

function applyProjectScope(nextIds: readonly string[]): void {
  const nextScope = scopeKey(nextIds);
  if (nextScope === state.scopeKey) return;
  configuredProjectIds = [...nextIds];
  generation += 1;
  pendingFullRefresh = false;
  pendingPageIds.clear();
  documents.clear();
  index?.free?.();
  index = null;
  if (nextIds.length === 0) {
    unsubscribeChanges?.();
    unsubscribeChanges = null;
    emit({
      scopeKey: "",
      status: "idle",
      libraryId: null,
      storeEpoch: null,
      commitSeq: 0,
      error: null,
    });
    return;
  }
  emit({
    scopeKey: nextScope,
    status: "loading",
    libraryId: null,
    storeEpoch: null,
    commitSeq: 0,
    error: null,
  });
  requestRefresh();
  unsubscribeChanges ??= subscribeLibraryChanges((event) => {
    if (state.storeEpoch !== null && event.storeEpoch !== state.storeEpoch) {
      generation += 1;
      documents.clear();
      index?.free?.();
      index = null;
      emit({
        ...state,
        status: "loading",
        libraryId: null,
        storeEpoch: null,
        commitSeq: 0,
        error: null,
      });
      requestRefresh();
      return;
    }
    // During the initial load the event is queued as a full reconciliation. It
    // must not cancel the in-flight snapshot by pretending its epoch changed.
    if (state.storeEpoch === null) {
      requestRefresh();
      return;
    }
    if (event.affectedPageIds.length > 0 && event.affectedDatabaseIds.length === 0) {
      requestRefresh(event.affectedPageIds);
      return;
    }
    requestRefresh();
  });
}

/** Prewarms the Core-stamped projection. No query is executed on this async path. */
export function configureInteractivePageSearch(
  projectIds: readonly string[],
  mode: "extend" | "replace" = "extend",
): () => void {
  const leaseId = nextScopeLeaseId++;
  scopeLeases.set(leaseId, { projectIds: [...new Set(projectIds)], mode });
  applyProjectScope(activeProjectIds());
  return () => {
    if (!scopeLeases.delete(leaseId)) return;
    applyProjectScope(activeProjectIds());
  };
}

export function searchPageMetadataSync(intent: PageSearchIntent): readonly PageSearchResult[] {
  if (
    !index ||
    state.status !== "ready" ||
    intent.projectIds.some((projectId) => !configuredProjectIds.includes(projectId))
  )
    return [];
  try {
    return index.search({
      projectIds: [...intent.projectIds],
      query: intent.query,
      filters: intent.filters,
      preferredProjectId: intent.preferredProjectId ?? undefined,
      recentPageIds: [...(intent.recentPageIds ?? [])],
      limit: intent.limit ?? 20,
      excludePageIds: [...(intent.excludePageIds ?? [])],
      dataSourceIds: [...(intent.dataSourceIds ?? [])],
    });
  } catch {
    return [];
  }
}

export function configuredPageSearchProjectIds(): readonly string[] {
  return configuredProjectIds;
}

function mergeResults(
  preview: readonly PageSearchResult[],
  complete: readonly PageSearchResult[],
  limit: number,
): readonly PageSearchResult[] {
  const completeById = new Map(complete.map((row) => [row.pageId, row]));
  const rows = preview.map((row) => completeById.get(row.pageId) ?? row);
  const seen = new Set(rows.map((row) => row.pageId));
  for (const row of complete) {
    if (!seen.has(row.pageId)) rows.push(row);
  }
  return rows.slice(0, limit);
}

function filterCompleteResults(
  rows: readonly PageSearchResult[],
  dataSourceIds: readonly string[] | undefined,
): readonly PageSearchResult[] {
  if (!dataSourceIds || dataSourceIds.length === 0) return rows;
  const requestedDataSourceIds = new Set(dataSourceIds);
  return rows.filter((row) => {
    const document = documents.get(row.pageId);
    return (
      document !== undefined &&
      document.dataSourceIds.some((dataSourceId) => requestedDataSourceIds.has(dataSourceId))
    );
  });
}

export function useInteractivePageSearch(intent: PageSearchIntent): InteractivePageSearchResult {
  const projection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const intendedScope = scopeKey(intent.projectIds);
  const normalizedProjectIds = useMemo(
    () => (intendedScope ? intendedScope.split("\n") : []),
    [intendedScope],
  );
  useEffect(() => configureInteractivePageSearch(normalizedProjectIds), [normalizedProjectIds]);
  const preview = searchPageMetadataSync({ ...intent, projectIds: normalizedProjectIds });
  const revision = JSON.stringify({
    query: intent.query,
    scope: scopeKey(normalizedProjectIds),
    filters: intent.filters ?? null,
    preferredProjectId: intent.preferredProjectId ?? null,
    recentPageIds: intent.recentPageIds ?? [],
    excludePageIds: [...(intent.excludePageIds ?? [])].sort(),
    dataSourceIds: [...(intent.dataSourceIds ?? [])].sort(),
    limit: intent.limit ?? 20,
    complete: intent.complete !== false,
    projection: [projection.storeEpoch, projection.commitSeq],
  });
  const complete = useCompletePageSearch(intent.complete !== false, revision, {
    ...intent,
    projectIds: normalizedProjectIds,
  });
  const excluded = new Set(intent.excludePageIds ?? []);
  const completeRows = filterCompleteResults(complete.rows, intent.dataSourceIds);
  const rows =
    complete.status === "settled"
      ? completeRows.filter((row) => !excluded.has(row.pageId)).slice(0, intent.limit ?? 20)
      : mergeResults(
          preview.filter((row) => !excluded.has(row.pageId)),
          completeRows.filter((row) => !excluded.has(row.pageId)),
          intent.limit ?? 20,
        );
  if (projection.status !== "ready" && complete.status !== "settled") {
    let enrichment: InteractivePageSearchResult["enrichment"] = "loading";
    if (
      complete.status === "unavailable" ||
      (complete.status === "idle" && projection.status === "unavailable")
    ) {
      enrichment = "unavailable";
    } else if (complete.status === "idle" && projection.status === "idle") {
      enrichment = "idle";
    }
    return { rows, enrichment, queryRevision: revision };
  }
  return {
    rows,
    enrichment: complete.status,
    queryRevision: revision,
  };
}

function useCompletePageSearch(
  enabled: boolean,
  revision: string,
  intent: PageSearchIntent,
): {
  readonly rows: readonly PageSearchResult[];
  readonly status: InteractivePageSearchResult["enrichment"];
} {
  const store = completeStoreFor(revision, enabled, intent);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

interface CompleteSnapshot {
  readonly rows: readonly PageSearchResult[];
  readonly status: InteractivePageSearchResult["enrichment"];
}
interface CompleteStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CompleteSnapshot;
  hasSubscribers(): boolean;
  dispose(): void;
}
interface CompleteRequest {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CompleteSnapshot;
  hasSubscribers(): boolean;
  dispose(): void;
  cancelEviction(): void;
}

const MAX_COMPLETE_STORES = 64;
const completeStores = new Map<string, CompleteStore>();
const completeRequests = new Map<string, CompleteRequest>();

function completeStoreFor(
  revision: string,
  enabled: boolean,
  intent: PageSearchIntent,
): CompleteStore {
  const existing = completeStores.get(revision);
  if (existing) return existing;
  // Store creation is render-safe. Registration and eviction happen when the
  // store receives a committed subscription, so abandoned renders cannot
  // mutate or dispose shared state.
  return createCompleteStore(revision, enabled, intent);
}

function registerCompleteStore(revision: string, store: CompleteStore): void {
  if (!completeStores.has(revision)) completeStores.set(revision, store);
  evictCompleteStores();
}

function evictCompleteStores(): void {
  if (completeStores.size <= MAX_COMPLETE_STORES) return;
  for (const [candidateRevision, candidate] of completeStores) {
    if (candidate.hasSubscribers()) continue;
    candidate.dispose();
    completeStores.delete(candidateRevision);
    if (completeStores.size <= MAX_COMPLETE_STORES) break;
  }
}

function createCompleteStore(
  revision: string,
  enabled: boolean,
  intent: PageSearchIntent,
): CompleteStore {
  const existingRequest = completeRequests.get(revision);
  let snapshot: CompleteSnapshot = existingRequest?.getSnapshot() ?? {
    rows: [],
    status: enabled ? "loading" : "idle",
  };
  let requestUnsubscribe: (() => void) | null = null;
  let storeEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  const subscribers = new Set<() => void>();
  const store: CompleteStore = {
    subscribe(listener) {
      subscribers.add(listener);
      if (subscribers.size === 1) {
        if (storeEvictionTimer) clearTimeout(storeEvictionTimer);
        storeEvictionTimer = null;
        registerCompleteStore(revision, store);
        const request = completeRequestFor(revision, enabled, intent);
        requestUnsubscribe = request.subscribe(() => {
          snapshot = request.getSnapshot();
          subscribers.forEach((subscriber) => subscriber());
        });
        snapshot = request.getSnapshot();
      }
      return () => {
        if (!subscribers.delete(listener) || subscribers.size > 0) return;
        requestUnsubscribe?.();
        requestUnsubscribe = null;
        storeEvictionTimer = setTimeout(() => {
          storeEvictionTimer = null;
          if (subscribers.size === 0 && completeStores.get(revision) === store) {
            completeStores.delete(revision);
            store.dispose();
            evictCompleteStores();
          }
        }, 0);
      };
    },
    getSnapshot: () => snapshot,
    hasSubscribers: () => subscribers.size > 0,
    dispose() {
      requestUnsubscribe?.();
      requestUnsubscribe = null;
      if (storeEvictionTimer) clearTimeout(storeEvictionTimer);
      storeEvictionTimer = null;
    },
  };
  return store;
}

function completeRequestFor(
  revision: string,
  enabled: boolean,
  intent: PageSearchIntent,
): CompleteRequest {
  const existing = completeRequests.get(revision);
  if (existing) {
    existing.cancelEviction();
    return existing;
  }
  const request = createCompleteRequest(revision, enabled, intent);
  completeRequests.set(revision, request);
  return request;
}

function createCompleteRequest(
  revision: string,
  enabled: boolean,
  intent: PageSearchIntent,
): CompleteRequest {
  let snapshot: CompleteSnapshot = { rows: [], status: enabled ? "loading" : "idle" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let evictionTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  const subscribers = new Set<() => void>();
  const notify = (): void => {
    subscribers.forEach((listener) => listener());
  };
  const start = (): void => {
    if (evictionTimer) clearTimeout(evictionTimer);
    evictionTimer = null;
    if (!enabled || timer || controller || snapshot.status !== "loading") return;
    timer = setTimeout(() => {
      timer = null;
      controller = new AbortController();
      const activeController = controller;
      // Core returns the complete candidate set. Data-source scoping is
      // applied against the same authorized metadata projection by the hook.
      void searchPages(
        {
          projectIds: [...intent.projectIds],
          query: intent.query,
          filters: intent.filters,
          preferredProjectId: intent.preferredProjectId ?? undefined,
          recentPageIds: [...(intent.recentPageIds ?? [])],
          limit: intent.limit,
        },
        activeController.signal,
      )
        .then((result) => {
          if (controller !== activeController || activeController.signal.aborted) return;
          if (
            (state.libraryId !== null && result.libraryId !== state.libraryId) ||
            (state.storeEpoch !== null && result.storeEpoch !== state.storeEpoch) ||
            result.commitSeq < state.commitSeq
          )
            return;
          snapshot = { rows: result.results, status: "settled" };
          notify();
        })
        .catch(() => {
          if (controller !== activeController || activeController.signal.aborted) return;
          snapshot = { rows: [], status: "unavailable" };
          notify();
        })
        .finally(() => {
          if (controller === activeController) controller = null;
        });
    }, 175);
  };
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  const scheduleEviction = (): void => {
    if (evictionTimer) clearTimeout(evictionTimer);
    evictionTimer = setTimeout(() => {
      evictionTimer = null;
      if (subscribers.size > 0 || completeRequests.get(revision) !== request) return;
      completeRequests.delete(revision);
      request.dispose();
    }, 0);
  };
  const request: CompleteRequest = {
    subscribe(listener) {
      subscribers.add(listener);
      if (subscribers.size === 1) start();
      return () => {
        if (!subscribers.delete(listener) || subscribers.size > 0) return;
        stop();
        scheduleEviction();
      };
    },
    getSnapshot: () => snapshot,
    hasSubscribers: () => subscribers.size > 0,
    dispose() {
      stop();
      if (evictionTimer) clearTimeout(evictionTimer);
      evictionTimer = null;
    },
    cancelEviction() {
      if (evictionTimer) clearTimeout(evictionTimer);
      evictionTimer = null;
    },
  };
  return request;
}

export const __testing = {
  installIndex(projectIds: readonly string[], testIndex: WasmIndex): void {
    configuredProjectIds = [...projectIds];
    index = testIndex;
    state = {
      revision: state.revision + 1,
      scopeKey: scopeKey(projectIds),
      status: "ready",
      libraryId: "library-1",
      storeEpoch: "test-epoch",
      commitSeq: 1,
      error: null,
    };
  },
  installUnavailable(projectIds: readonly string[]): void {
    configuredProjectIds = [...projectIds];
    index?.free?.();
    index = null;
    state = {
      revision: state.revision + 1,
      scopeKey: scopeKey(projectIds),
      status: "unavailable",
      libraryId: null,
      storeEpoch: null,
      commitSeq: 0,
      error: "Page metadata is unavailable",
    };
  },
  reset() {
    generation += 1;
    unsubscribeChanges?.();
    unsubscribeChanges = null;
    refreshInFlight = false;
    pendingFullRefresh = false;
    pendingPageIds.clear();
    scopeLeases.clear();
    nextScopeLeaseId = 1;
    state = EMPTY_STATE;
    index?.free?.();
    index = null;
    documents.clear();
    configuredProjectIds = [];
    completeStores.forEach((store) => store.dispose());
    completeRequests.forEach((request) => request.dispose());
    completeStores.clear();
    completeRequests.clear();
    listeners.clear();
  },
};
