import { afterEach, describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import type { DataSourcePageRowV2 } from "../../shared/database-module-v2";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  WorkbenchCaptureViewResultSchema,
  type WorkbenchCaptureViewRequest,
} from "../../shared/nodex-app-tools/workbench-view-content";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  materializeInitialWorkbenchScene,
  makeWorkbenchSceneKey,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import {
  boardWorkbenchOccurrenceKey,
  captureWorkbenchViewContent,
  createWorkbenchViewSnapshot,
  registerWorkbenchViewContent,
  workbenchViewOccurrence,
} from "./workbench-view-content";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
const timestamp = "2026-09-08T00:00:00Z";
const dataSourceId = parseDataSourceId("source-a");
const propertyId = parseDataSourcePropertyId("status");
const row: DataSourcePageRowV2 = {
  page: {
    pageId: "page-a",
    libraryId: "library-a",
    parent: { kind: "data_source", dataSourceId },
    lifecycle: "active",
    parentRevision: 2,
    metadataRevision: 3,
    documentId: "document-a",
    documentGeneration: 4,
    documentHeadSeq: 5,
    title: "Page A",
    richTitle: plainTextToPortableRichText("Page A"),
    preview: "",
    plainText: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  pageKey: "P-1",
  membership: { membershipId: "member-a", dataSourceId, revision: 6, createdAt: timestamp },
  values: { [propertyId]: { propertyId, valueType: "select", value: "build", revision: 7 } },
  position: { rankKey: "rank-a", revision: 8 },
  effectiveGroupKey: "build",
  effectiveSubgroupKey: null,
  taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
};
const config = upgradeDatabaseViewConfigV2({
  schemaKey: "nodex.database-view",
  schemaVersion: 2,
  filter: { kind: "group", operator: "and", children: [] },
  sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
  group: null,
  display: { propertyIds: [], showTitle: true },
});

function fixture() {
  const sceneOwner = { kind: "project" as const, projectId: "project-a" };
  const scene = materializeInitialWorkbenchScene(sceneOwner);
  if (scene.primary?.kind !== "db_view") throw new Error("Expected default View");
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location: sceneOwner,
    scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
  });
  owner.initialize();
  const presentation = { owner, sceneOwner, surface: scene.primary };
  disposers.push(owner.registerResolvedDatabaseView(sceneOwner, scene.primary, "view-a"));
  const binding = {
    presentation,
    preferencesRevision: 9,
    preferencesPending: false,
    loading: false,
  };
  const model = {
    libraryId: "library-a",
    accessContext: { kind: "project" as const, projectId: "project-a" },
    databaseId: parseDatabaseId("database-a"),
    dataSourceId,
    databaseViewId: parseDatabaseViewId("view-a"),
    storeEpoch: "epoch-a",
    commitSeq: 10,
    query: { view: { revision: 11 }, dataSource: { schemaRevision: 12 } },
  };
  const first = workbenchViewOccurrence({
    row,
    displayKey: "occurrence-first",
    occurrenceKey: "occurrence-first",
    groupPath: ["build"],
    ancestorPageIds: ["parent-a"],
    mounted: true,
    inViewport: false,
    selected: false,
  });
  const second = workbenchViewOccurrence({
    row,
    displayKey: "occurrence-second",
    occurrenceKey: "occurrence-second",
    groupPath: ["ship"],
    ancestorPageIds: ["parent-b"],
    mounted: true,
    inViewport: true,
    selected: true,
  });
  const request = (
    patch: Partial<WorkbenchCaptureViewRequest> = {},
  ): WorkbenchCaptureViewRequest => ({
    kind: "capture_view",
    sceneOwner,
    tabId: scene.primary!.id,
    expectedPresentationRevision: owner.read().presentationRevision,
    purpose: "display",
    range: "loaded",
    offset: 0,
    limit: 200,
    ...patch,
  });
  const snapshot = (input = request()) =>
    createWorkbenchViewSnapshot({
      request: input,
      binding,
      model,
      effective: { layout: "list", rules: config.rules, presentation: config.presentation },
      search: { current: "", deferred: "" },
      pending: { optimistic: false, loading: false, options: false },
      selection: {
        allMatching: true,
        selectedOccurrenceKeys: [],
        excludedOccurrenceKeys: [first.displayKey],
        anchorOccurrenceKey: second.displayKey,
        activeOccurrenceKey: second.displayKey,
      },
      collapsedOccurrenceKeys: ["collapsed-parent"],
      occurrences: [first, second],
      totalOccurrenceCount: 100,
      allRowsLoaded: false,
      viewportKnown: true,
    });
  return { owner, presentation, request, snapshot, binding, model };
}

describe("Workbench View display observation", () => {
  test("preserves duplicate occurrences and exact field conditions with bounded range coverage", () => {
    const f = fixture();
    const full = f.snapshot();
    expect(WorkbenchCaptureViewResultSchema.safeParse(full).success).toBe(true);
    expect(full.occurrences.map((entry) => [entry.pageId, entry.ancestorPageIds])).toEqual([
      ["page-a", ["parent-a"]],
      ["page-a", ["parent-b"]],
    ]);
    expect(full.occurrences[0]?.condition).toEqual({
      metadataRevision: 3,
      parentRevision: 2,
      documentId: "document-a",
      documentGeneration: 4,
      documentHeadSeq: 5,
      membershipId: "member-a",
      membershipRevision: 6,
      databaseValueRevisions: { status: 7 },
      positionRevision: 8,
      rankKey: "rank-a",
    });
    const viewport = f.snapshot(f.request({ range: "viewport", limit: 1 }));
    expect(viewport.occurrences.map((entry) => entry.displayKey)).toEqual(["occurrence-second"]);
    expect(viewport.coverage).toMatchObject({
      rangeCount: 1,
      loadedOccurrenceCount: 2,
      mountedOccurrenceCount: 2,
      viewportOccurrenceCount: 1,
      totalOccurrenceCount: 100,
      allRowsLoaded: false,
      hasMoreInRange: false,
    });
    expect(f.snapshot(f.request({ limit: 1 })).coverage.hasMoreInRange).toBe(true);
    const selected = f.snapshot(f.request({ range: "selected" }));
    expect(selected.selection).toMatchObject({
      allMatching: true,
      excludedOccurrenceKeys: ["occurrence-first"],
    });
    expect(selected.occurrences.map((entry) => entry.displayKey)).toEqual(["occurrence-second"]);
    expect(boardWorkbenchOccurrenceKey("page-a", "build", null)).not.toBe(
      boardWorkbenchOccurrenceKey("page-a", "ship", null),
    );
  });

  test("reads one exact Window capability and revokes stale descriptor, resolution, lifecycle and generation", () => {
    const first = fixture();
    const other = fixture();
    const releaseFirst = registerWorkbenchViewContent(first.presentation, first.snapshot);
    const releaseReplacement = registerWorkbenchViewContent(first.presentation, first.snapshot);
    releaseFirst();
    expect(captureWorkbenchViewContent(first.owner, first.request(), () => true).status).toBe(
      "ready",
    );
    expect(captureWorkbenchViewContent(other.owner, other.request(), () => true)).toEqual({
      status: "surface_unavailable",
    });
    expect(captureWorkbenchViewContent(first.owner, first.request(), () => false)).toEqual({
      status: "cancelled",
    });
    const oldRequest = first.request();
    const releaseResolution = first.owner.registerResolvedDatabaseView(
      first.presentation.sceneOwner,
      first.presentation.surface,
      "view-b",
    );
    expect(captureWorkbenchViewContent(first.owner, oldRequest, () => true)).toEqual({
      status: "stale_presentation",
    });
    expect(captureWorkbenchViewContent(first.owner, first.request(), () => true)).toEqual({
      status: "surface_unavailable",
    });
    releaseResolution();
    releaseReplacement();
    expect(captureWorkbenchViewContent(first.owner, first.request(), () => true)).toEqual({
      status: "surface_unavailable",
    });
  });

  test("reports pending display honestly and declines effective queries until search and journals settle", () => {
    const f = fixture();
    const snapshot = {
      ...f.snapshot(),
      search: { current: "new", deferred: "old", pending: true },
      pending: { preferences: true, optimistic: true, loading: false, options: false },
    };
    disposers.push(registerWorkbenchViewContent(f.presentation, () => snapshot));
    expect(captureWorkbenchViewContent(f.owner, f.request(), () => true)).toMatchObject({
      status: "ready",
      search: { current: "new", deferred: "old", pending: true },
      pending: { preferences: true, optimistic: true },
    });
    expect(
      captureWorkbenchViewContent(f.owner, f.request({ purpose: "effective_query" }), () => true),
    ).toEqual({ status: "pending_presentation" });
    disposers.push(registerWorkbenchViewContent(f.presentation, f.snapshot));
    expect(
      captureWorkbenchViewContent(f.owner, f.request({ purpose: "effective_query" }), () => true)
        .status,
    ).toBe("ready");
  });
});
