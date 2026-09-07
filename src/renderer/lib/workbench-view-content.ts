import { contentAccessContextKey } from "../../shared/content-access-context";
import type { DataSourcePageRowV2 } from "../../shared/database-module-v2";
import { databaseViewGesturePreferencesOverride } from "../../shared/database-view-presentation";
import type { EffectiveDatabaseView } from "../../shared/database-kernel";
import type {
  WorkbenchCaptureViewRequest,
  WorkbenchCaptureViewResult,
  WorkbenchViewOccurrence,
  WorkbenchViewSnapshot,
} from "../../shared/nodex-app-tools/workbench-view-content";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import {
  databaseViewPresentationIdentity,
  type WorkbenchDatabaseViewPresentationRegistration,
} from "./workbench-database-view-presentation";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

export interface WorkbenchViewContentBinding {
  readonly presentation: WorkbenchDatabaseViewPresentationRegistration;
  readonly preferencesRevision: number | null;
  readonly preferencesPending: boolean;
  readonly loading: boolean;
}

type ViewReader = (request: WorkbenchCaptureViewRequest) => WorkbenchViewSnapshot | null;
interface Registration {
  readonly identity: string;
  readonly read: ViewReader;
}
// Capabilities only: the committed React body and its existing data owners retain all display state.
const readers = new WeakMap<WorkbenchWindowOwner, Map<string, Registration>>();
const readerKey = (input: Pick<WorkbenchCaptureViewRequest, "sceneOwner" | "tabId">) =>
  `${makeWorkbenchSceneKey(input.sceneOwner)}\0${input.tabId}`;

export function registerWorkbenchViewContent(
  registration: WorkbenchDatabaseViewPresentationRegistration,
  read: ViewReader,
): () => void {
  const { owner, sceneOwner, surface } = registration;
  const registry = readers.get(owner) ?? new Map<string, Registration>();
  readers.set(owner, registry);
  const key = readerKey({ sceneOwner, tabId: surface.id });
  const entry = { identity: databaseViewPresentationIdentity(surface), read };
  registry.set(key, entry);
  return () => {
    if (registry.get(key) === entry) registry.delete(key);
  };
}

/** Read only the exact committed body in this Window; a resolved default never selects another tab. */
export function captureWorkbenchViewContent(
  owner: WorkbenchWindowOwner,
  input: WorkbenchCaptureViewRequest,
  isCurrent: () => boolean,
): WorkbenchCaptureViewResult {
  if (!isCurrent()) return { status: "cancelled" };
  const state = owner.read();
  if (state.presentationRevision !== input.expectedPresentationRevision)
    return { status: "stale_presentation" };
  const tab = readWorkbenchAgentContext(state, input.sceneOwner)?.tabs.find(
    (candidate) => candidate.tabId === input.tabId,
  );
  const surface = tab?.surface;
  if (!tab?.visible || surface?.kind !== "db_view") return { status: "surface_unavailable" };
  const entry = readers.get(owner)?.get(readerKey(input));
  if (!entry || entry.identity !== databaseViewPresentationIdentity(surface))
    return { status: "surface_unavailable" };
  const snapshot = entry.read(input);
  if (!isCurrent()) return { status: "cancelled" };
  if (owner.read().presentationRevision !== input.expectedPresentationRevision)
    return { status: "stale_presentation" };
  if (
    !snapshot ||
    readers.get(owner)?.get(readerKey(input)) !== entry ||
    owner.resolveDatabaseView(input.sceneOwner, surface) !== snapshot.databaseViewId ||
    contentAccessContextKey(snapshot.accessContext) !==
      contentAccessContextKey(surface.config.accessContext)
  )
    return { status: "surface_unavailable" };
  if (
    input.purpose === "effective_query" &&
    (snapshot.search.pending || Object.values(snapshot.pending).some(Boolean))
  )
    return { status: "pending_presentation" };
  return snapshot;
}

export function workbenchViewOccurrence(input: {
  readonly row: DataSourcePageRowV2;
  readonly displayKey: string;
  readonly occurrenceKey: string | null;
  readonly groupPath: readonly (string | null)[];
  readonly ancestorPageIds: readonly string[];
  readonly mounted: boolean;
  readonly inViewport: boolean;
  readonly selected: boolean;
}): WorkbenchViewOccurrence {
  const { row } = input;
  return {
    displayKey: input.displayKey,
    occurrenceKey: input.occurrenceKey,
    pageId: row.page.pageId,
    groupPath: [...input.groupPath],
    ancestorPageIds: [...input.ancestorPageIds],
    mounted: input.mounted,
    inViewport: input.inViewport,
    selected: input.selected,
    condition: {
      metadataRevision: row.page.metadataRevision,
      parentRevision: row.page.parentRevision,
      documentId: row.page.documentId,
      documentGeneration: row.page.documentGeneration,
      documentHeadSeq: row.page.documentHeadSeq,
      membershipId: row.membership.membershipId,
      membershipRevision: row.membership.revision,
      databaseValueRevisions: Object.fromEntries(
        Object.values(row.values).map((value) => [value.propertyId, value.revision]),
      ),
      positionRevision: row.position?.revision ?? null,
      rankKey: row.position?.rankKey ?? null,
    },
  };
}

export function createWorkbenchViewSnapshot(input: {
  readonly request: WorkbenchCaptureViewRequest;
  readonly binding: WorkbenchViewContentBinding;
  readonly model: Pick<
    DatabaseViewRenderModel,
    | "libraryId"
    | "accessContext"
    | "databaseId"
    | "dataSourceId"
    | "databaseViewId"
    | "storeEpoch"
    | "commitSeq"
  > & {
    readonly query: {
      readonly view: Pick<DatabaseViewRenderModel["query"]["view"], "revision">;
      readonly dataSource: Pick<DatabaseViewRenderModel["query"]["dataSource"], "schemaRevision">;
    };
  };
  readonly effective: EffectiveDatabaseView;
  readonly search: { readonly current: string; readonly deferred: string };
  readonly pending: Pick<WorkbenchViewSnapshot["pending"], "optimistic" | "loading" | "options">;
  readonly selection: WorkbenchViewSnapshot["selection"];
  readonly collapsedOccurrenceKeys: readonly string[];
  readonly occurrences: readonly WorkbenchViewOccurrence[];
  readonly totalOccurrenceCount: number | null;
  readonly allRowsLoaded: boolean;
  readonly viewportKnown: boolean;
}): WorkbenchViewSnapshot {
  const { request, model, occurrences, binding } = input;
  const range = occurrences.filter((row) =>
    request.range === "viewport"
      ? row.inViewport
      : request.range === "selected"
        ? row.selected
        : true,
  );
  const selected = range.slice(request.offset, request.offset + request.limit);
  return {
    status: "ready",
    capturedAt: new Date().toISOString(),
    layout: input.effective.layout,
    libraryId: model.libraryId,
    accessContext: model.accessContext,
    databaseId: model.databaseId,
    dataSourceId: model.dataSourceId,
    databaseViewId: model.databaseViewId,
    storeEpoch: model.storeEpoch,
    commitSeq: model.commitSeq,
    viewRevision: model.query.view.revision,
    schemaRevision: model.query.dataSource.schemaRevision,
    preferencesRevision: binding.preferencesRevision,
    preferencesOverride: databaseViewGesturePreferencesOverride(input.effective),
    search: { ...input.search, pending: input.search.current !== input.search.deferred },
    pending: {
      ...input.pending,
      preferences: binding.preferencesPending,
      loading: binding.loading || input.pending.loading,
    },
    selection: input.selection,
    collapsedOccurrenceKeys: [...input.collapsedOccurrenceKeys],
    coverage: {
      range: request.range,
      offset: request.offset,
      returnedCount: selected.length,
      rangeCount: range.length,
      loadedOccurrenceCount: occurrences.length,
      mountedOccurrenceCount: occurrences.filter((row) => row.mounted).length,
      viewportOccurrenceCount: occurrences.filter((row) => row.inViewport).length,
      totalOccurrenceCount: input.totalOccurrenceCount,
      allRowsLoaded: input.allRowsLoaded,
      viewportKnown: input.viewportKnown,
      hasMoreInRange: request.offset + selected.length < range.length,
    },
    occurrences: selected,
  };
}

export const boardWorkbenchOccurrenceKey = (
  pageId: string,
  groupKey: string | null,
  subgroupKey: string | null,
): string => JSON.stringify([pageId, groupKey, subgroupKey]);

/** Intersect the known card's box with every clipping ancestor; DOM content is never extracted. */
export function workbenchElementInViewport(element: HTMLElement | null | undefined): boolean {
  if (!element?.isConnected || element.getClientRects().length === 0) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let right = Math.min(view.innerWidth, rect.right);
  let top = Math.max(0, rect.top);
  let bottom = Math.min(view.innerHeight, rect.bottom);
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    )
      return false;
    if (node === element) continue;
    const bounds = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return right > left && bottom > top;
}
