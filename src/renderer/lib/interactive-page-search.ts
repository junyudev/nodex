import { getIntl } from "@/lib/i18n";
import type { WorkflowStatus } from "../../shared/workflow-status";
import { useMemo, useSyncExternalStore } from "react";
import { useFind } from "./find";
import type {
  PageSearchMetadataDocument,
  PageSearchMetadataSnapshot,
  PageSearchCoverage,
  PageSearchResult,
} from "../../shared/types";
import { subscribeLibraryChanges } from "./api";
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

export function usePageMetadataPreview(intent: PageSearchIntent) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return searchPageMetadataSync(intent);
}

export function useInteractivePageSearch(intent: PageSearchIntent): InteractivePageSearchResult {
  const projectId = intent.projectFilterIds?.[0];
  const request = {
    query: intent.query,
    kinds: ["page"] as const,
    place: projectId ? { kind: "project" as const, projectId } : { kind: "everywhere" as const },
    limit: intent.limit ?? 20,
    preferredProjectId: intent.preferredProjectId ?? undefined,
    excludePageIds: intent.excludePageIds,
    dataSourceIds: intent.dataSourceIds,
    recentPageIds: intent.recentPageIds,
  };
  const search = useFind(request, { enabled: intent.enabled, complete: intent.complete });
  const source = search.response?.coverage.find(({ source }) => source === "pages");
  const usePreview = !search.response || source?.state === "unavailable";
  const preview = usePageMetadataPreview({
    ...intent,
    enabled: intent.enabled !== false && usePreview,
  });
  const queryRevision = JSON.stringify(request);
  return useMemo(
    () => ({
      rows: usePreview
        ? preview
        : (search.response?.hits ?? []).flatMap((hit) => (hit.kind === "page" ? [hit.page] : [])),
      enrichment:
        intent.enabled === false
          ? "idle"
          : search.pending
            ? "loading"
            : search.failed || source?.state === "unavailable"
              ? "unavailable"
              : "settled",
      truncated: source?.truncated ?? false,
      coverage: source?.state === "indexing" ? "indexing" : undefined,
      queryRevision,
    }),
    [
      intent.enabled,
      preview,
      queryRevision,
      search.failed,
      search.pending,
      search.response,
      source,
      usePreview,
    ],
  );
}
