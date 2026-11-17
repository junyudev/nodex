import { getIntl } from "@/lib/i18n";
import type { WorkflowStatus } from "../../shared/workflow-status";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  PageSearchFilters,
  PageSearchMetadataDocument,
  PageSearchMetadataSnapshot,
  PageSearchCoverage,
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
  readonly projectFilterIds?: readonly string[];
  readonly enabled?: boolean;
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
  readonly truncated: boolean;
  readonly coverage?: PageSearchCoverage;
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

let generation = 0;
let unsubscribeChanges: (() => void) | null = null;
let refreshInFlight = false;
let pendingFullRefresh = false;
const pendingPageIds = new Set<string>();
let nextScopeLeaseId = 1;
const scopeLeases = new Set<number>();
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

function projectionIsValid(snapshot: PageSearchMetadataSnapshot): boolean {
  const pageIds = new Set(snapshot.documents.map((document) => document.pageId));
  return (
    snapshot.libraryId.length > 0 &&
    snapshot.storeEpoch.length > 0 &&
    Number.isSafeInteger(snapshot.commitSeq) &&
    snapshot.commitSeq >= 0 &&
    pageIds.size === snapshot.documents.length
  );
}

async function loadWasm(): Promise<WasmIndex> {
  const { searchKernel } = await import("@nodex/search-kernel");
  const kernel = new searchKernel.PageSearchPreviewIndex([]);
  return {
    free: () => kernel.free(),
    replace: (rows) =>
      kernel.replace((rows as PageSearchMetadataDocument[]).map(kernelMetadataDocument)),
    applyDelta: (rows, removals) =>
      kernel.applyDelta(
        (rows as PageSearchMetadataDocument[]).map(kernelMetadataDocument),
        removals,
      ),
    search: (request) =>
      (
        kernel.search(request) as Array<
          Omit<PageSearchResult, "status"> & { status: WorkflowStatus | null }
        >
      ).map((row) => ({
        ...row,
        status: documents.get(row.pageId)?.status ?? null,
      })),
  };
}

// The ranking kernel filters by stage identity; labels remain Core-authored metadata.
function kernelMetadataDocument(document: PageSearchMetadataDocument) {
  return { ...document, status: document.status?.optionId ?? null };
}

async function refresh(pageIds?: readonly string[]): Promise<void> {
  const currentGeneration = generation;
  const expectedScope = "library";
  try {
    index ??= await loadWasm();
    const snapshot = await invoke(
      "pages:search-metadata",
      undefined,
      pageIds ? [...pageIds] : undefined,
    );
    if (
      currentGeneration !== generation ||
      !projectionIsValid(snapshot) ||
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
      error:
        error instanceof Error
          ? error.message
          : getIntl().formatMessage({
              id: "lib.interactivePageSearch.metadataUnavailable",
              defaultMessage: "Page metadata is unavailable",
            }),
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

function applyProjectionLease(): void {
  const nextScope = scopeLeases.size > 0 ? "library" : "";
  if (nextScope === state.scopeKey) return;
  generation += 1;
  pendingFullRefresh = false;
  pendingPageIds.clear();
  documents.clear();
  index?.free?.();
  index = null;
  if (!nextScope) {
    unsubscribeChanges?.();
    unsubscribeChanges = null;
    emit({ ...EMPTY_STATE, scopeKey: "" });
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
export function configureInteractivePageSearch(): () => void {
  const leaseId = nextScopeLeaseId++;
  scopeLeases.add(leaseId);
  applyProjectionLease();
  return () => {
    if (!scopeLeases.delete(leaseId)) return;
    applyProjectionLease();
  };
}

export function searchPageMetadataSync(intent: PageSearchIntent): readonly PageSearchResult[] {
  if (!index || state.status !== "ready" || intent.enabled === false) return [];
  try {
    return index.search({
      projectFilterIds: intent.projectFilterIds ? [...intent.projectFilterIds] : undefined,
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

/** Titles from the same commit-fenced projection used by interactive Page search. */
export function useDataSourcePageTitles(dataSourceId: string | undefined) {
  const projection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (!dataSourceId || projection.status !== "ready") return [];
    return [...documents.values()].flatMap((document) =>
      document.dataSourceIds.includes(dataSourceId)
        ? [{ pageId: document.pageId, title: document.title }]
        : [],
    );
  }, [dataSourceId, projection]);
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
  const enabled = intent.enabled !== false;
  useEffect(() => (enabled ? configureInteractivePageSearch() : undefined), [enabled]);
  const preview = searchPageMetadataSync(intent);
  const revision = JSON.stringify({
    query: intent.query,
    projectFilter: intent.projectFilterIds ? scopeKey(intent.projectFilterIds) : null,
    filters: intent.filters ?? null,
    preferredProjectId: intent.preferredProjectId ?? null,
    recentPageIds: intent.recentPageIds ?? [],
    excludePageIds: [...(intent.excludePageIds ?? [])].sort(),
    dataSourceIds: [...(intent.dataSourceIds ?? [])].sort(),
    limit: intent.limit ?? 20,
    complete: enabled && intent.complete !== false,
    projection: [projection.storeEpoch, projection.commitSeq],
  });
  const complete = useCompletePageSearch(enabled && intent.complete !== false, revision, intent);
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
    return { rows, enrichment, truncated: false, queryRevision: revision };
  }
  return {
    rows,
    enrichment: complete.status,
    truncated: complete.status === "settled" && complete.truncated === true,
    coverage: complete.coverage,
    queryRevision: revision,
  };
}

function useCompletePageSearch(
  enabled: boolean,
  revision: string,
  intent: PageSearchIntent,
): CompleteSnapshot {
  const store = completeStoreFor(revision, enabled, intent);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

interface CompleteSnapshot {
  readonly coverage?: PageSearchCoverage;
  readonly truncated?: boolean;
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
    const indexing = snapshot.coverage === "indexing";
    if (!enabled || timer || controller || (snapshot.status !== "loading" && !indexing)) return;
    timer = setTimeout(
      () => {
        timer = null;
        controller = new AbortController();
        const activeController = controller;
        // The hook applies data-source scoping against the authorized metadata projection.
        void searchPages(
          {
            projectFilterIds: intent.projectFilterIds ? [...intent.projectFilterIds] : undefined,
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
            snapshot = {
              rows: result.results,
              status: "settled",
              truncated: result.truncated,
              coverage: result.coverage,
            };
            notify();
          })
          .catch(() => {
            if (controller !== activeController || activeController.signal.aborted) return;
            snapshot = { rows: [], status: "unavailable" };
            notify();
          })
          .finally(() => {
            if (controller !== activeController) return;
            controller = null;
            // Index slices don't advance the content commit. Refresh the active
            // query while its observed body coverage is incomplete.
            if (subscribers.size > 0 && snapshot.coverage === "indexing") start();
          });
      },
      indexing ? 2_000 : 175,
    );
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
  installIndex(testIndex: WasmIndex): void {
    index = testIndex;
    state = {
      revision: state.revision + 1,
      scopeKey: "library",
      status: "ready",
      libraryId: "library-1",
      storeEpoch: "test-epoch",
      commitSeq: 1,
      error: null,
    };
  },
  installUnavailable(): void {
    index?.free?.();
    index = null;
    state = {
      revision: state.revision + 1,
      scopeKey: "library",
      status: "unavailable",
      libraryId: null,
      storeEpoch: null,
      commitSeq: 0,
      error: getIntl().formatMessage({
        id: "lib.interactivePageSearch.metadataUnavailable",
        defaultMessage: "Page metadata is unavailable",
      }),
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
    completeStores.forEach((store) => store.dispose());
    completeRequests.forEach((request) => request.dispose());
    completeStores.clear();
    completeRequests.clear();
    listeners.clear();
  },
};
