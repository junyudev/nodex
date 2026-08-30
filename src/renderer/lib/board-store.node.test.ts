import { describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  boardContainsPageIds,
  buildCreateCardTransform,
  buildDeletePageTransform,
  buildMovePageTransform,
  buildPatchPageTransform,
  conflictKeysForCreate,
  conflictKeysForDelete,
  conflictKeysForMove,
  conflictKeysForPatch,
  createOptimisticCard,
} from "./board-optimistic-ops";
import type { BoardSummary, PageCreateInput, DatabasePageSummary } from "./types";
import { CoreApiError } from "./api";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { createBoardStoreRegistry, type BoardStoreDependencies } from "./board-store";
import type {
  DatabaseViewGroupsInput,
  DatabaseViewGroupsSnapshot,
  DatabaseViewWindowInput,
} from "../../shared/database-views";
import { toDatabasePageSummary } from "../../shared/page-summary";
import type { BoardChangeEvent } from "../../shared/ipc-api";
import type { ProjectionStreamMessage } from "../../shared/projection-stream";
import type { ResourceRevocationMessage } from "../../shared/resource-revocation-stream";
import { authorizedReadStampFixture } from "../../shared/testing/authorized-read-stamp-fixture";
import type { DatabaseViewWindowSnapshot } from "../../shared/database-views";
import {
  type DatabaseModuleReadResultV2,
  type DatabaseViewRecordV2,
  type DatabaseViewQueryResultV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import {
  ProjectionInvalidationRegistry,
  type ProjectionRegistration,
} from "./projection-invalidation-registry";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  groupScopeKeyForColumn,
  withPublishedDatabaseViewDefinition,
} from "./database-view-render-model";
import { createRendererCausalTrace } from "./renderer-causal-trace";

function createDatabaseViewSnapshot(
  viewId: string,
  title: string,
  isPrimary: boolean,
  commitSeq = 1,
): DatabaseModuleReadResultV2 {
  const projectId = "project-1";
  const libraryId = "library-1";
  const databaseId = parseDatabaseId("database-1");
  const dataSourceId = parseDataSourceId("source-1");
  const statusPropertyId = parseDataSourcePropertyId("status");
  const view: DatabaseViewRecordV2 = {
    viewId: parseDatabaseViewId(viewId),
    databaseId,
    dataSourceId,
    name: isPrimary ? "Primary" : "Focused",
    layout: "board" as const,
    config: upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view",
      schemaVersion: 2,
      filter: { kind: "group", operator: "and", children: [] },
      sort: [
        {
          field: { kind: "manual" },
          direction: "asc",
          nulls: "last",
        },
      ],
      group: { propertyId: statusPropertyId },
      display: { propertyIds: [statusPropertyId], showTitle: true },
    }),
    isDefault: isPrimary,
    revision: 1,
    rankKey: "a",
    lifecycle: "active",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const database = {
    databaseId,
    libraryId,
    name: "Tasks",
    lifecycle: "active" as const,
    defaultViewId: parseDatabaseViewId("view-primary"),
    accessRevision: 1,
    metadataRevision: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const dataSource = {
    dataSourceId,
    libraryId,
    homeDatabaseId: databaseId,
    name: "Pages",
    schemaKey: "nodex.pages",
    schemaRevision: 1,
    lifecycle: "active" as const,
    rankKey: "a",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const statusProperty = {
    propertyId: statusPropertyId,
    dataSourceId,
    name: "Status",
    ...testPropertySemantics("select"),
    valueType: "select" as const,
    config: {},
    rankKey: "a",
    lifecycle: "active" as const,
    revision: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const query: DatabaseViewQueryResultV2 = {
    database,
    dataSource,
    properties: [statusProperty],
    view,
    rows: [
      {
        pageKey: null,
        membership: {
          membershipId: "membership-1",
          dataSourceId,
          revision: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
        },
        page: {
          pageId: "card-1",
          libraryId,
          parent: { kind: "data_source" as const, dataSourceId },
          lifecycle: "active" as const,
          parentRevision: 1,
          metadataRevision: 1,
          documentId: "document-1",
          documentGeneration: 1,
          documentHeadSeq: 1,
          title,
          richTitle: plainTextToPortableRichText(title),
          preview: "",
          plainText: "",
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
        values: {
          [statusPropertyId]: {
            propertyId: statusPropertyId,
            valueType: "select" as const,
            value: "triage",
            revision: 1,
          },
        },
        taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
        position: { rankKey: "a", revision: 1 },
        effectiveGroupKey: "triage",
        effectiveSubgroupKey: null,
      },
    ],
  };
  return {
    ok: true,
    value: {
      projectId,
      libraryId,
      storeEpoch: "epoch-1",
      commitSeq,
      authorization: null,
      value: { kind: "query", value: query },
    },
  };
}

function createPageSummary(title = "Initial title"): DatabasePageSummary {
  return {
    id: "card-1",
    pageKey: null,
    status: "triage",
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    descriptionPreview: "Initial description",
    descriptionLength: "Initial description".length,
    hasDescription: true,
    priority: "p2-medium",
    estimate: "m",
    tags: [],
    revision: 1,
    created: new Date("2026-02-16T00:00:00.000Z"),
    order: 0,
  };
}

function createBoard(title = "Initial title"): BoardSummary {
  return {
    columns: [
      {
        id: "triage",
        name: "Ideas",
        cards: [createPageSummary(title)],
      },
      {
        id: "ship",
        name: "Ship",
        cards: [],
      },
    ],
  };
}

function createBoardSnapshot(
  board: BoardSummary = createBoard(),
  commitSeq = 1,
  viewId = "view-primary",
  primary = true,
  projectionRevision = 1,
): DatabaseViewWindowSnapshot {
  const card = board.columns.flatMap((column) => column.cards)[0] ?? createPageSummary();
  const queryResult = createDatabaseViewSnapshot(viewId, card.title, primary, commitSeq);
  if (!queryResult.ok || queryResult.value.value.kind !== "query") {
    throw new Error("Database View test fixture is invalid");
  }
  const query = {
    ...queryResult.value.value.value,
    rows: queryResult.value.value.value.rows.map((row) => ({
      ...row,
      page: {
        ...row.page,
        pageId: card.id,
        title: card.title,
        richTitle: card.richTitle,
        preview: card.descriptionPreview,
        plainText: card.descriptionPreview,
      },
    })),
  };
  return {
    projectId: "project-1",
    libraryId: "library-1",
    databaseId: "database-1",
    dataSourceId: "source-1",
    viewId,
    storeEpoch: "epoch-1",
    commitSeq,
    authorization: authorizedReadStampFixture({
      deliveryAddress: {
        kind: "project",
        library_id: "library-1",
        project_id: "project-1",
      },
      subject: { kind: "view", view_id: viewId },
      storeEpoch: "epoch-1",
      commitSeq,
      authorizationDependencies: [
        { kind: "page", page_id: card.id },
        { kind: "view", view_id: viewId },
      ],
    }),
    projection: {
      scopeKey: `scope:${viewId}`,
      schemaVersion: 1,
      revision: projectionRevision,
      coveredCommitSeq: commitSeq,
      effectHash:
        projectionRevision > 0 ? String(projectionRevision).padStart(64, "a").slice(-64) : null,
    },
    nextCursor: null,
    rows: [
      {
        page: card,
        groupKey: card.status,
        subgroupKey: null,
        rankKey: "a",
      },
    ],
    board,
    query,
    view: {
      id: viewId,
      databaseBlockId: "database-1",
      projectId: "project-1",
      name: query.view.name,
      layout: query.view.layout,
      config: query.view.config as never,
      isPrimary: primary,
      createdAt: query.view.createdAt,
      updatedAt: query.view.updatedAt,
    },
  };
}

function createTwoPageBoardSnapshot(
  pageIds: readonly [string, string] = ["card-1", "card-2"],
  commitSeq = 1,
): DatabaseViewWindowSnapshot {
  const cards = pageIds.map((pageId, index): DatabasePageSummary => ({
    ...createPageSummary(pageId === "card-1" ? "First" : "Second"),
    id: pageId,
    order: index,
  }));
  const snapshot = createBoardSnapshot(
    {
      columns: [
        { id: "triage", name: "Ideas", cards },
        { id: "ship", name: "Ship", cards: [] },
      ],
    },
    commitSeq,
    "view-primary",
    true,
    commitSeq,
  );
  const template = snapshot.query.rows[0];
  if (!template) throw new Error("Database View row fixture is missing");
  const queryRows = cards.map((card, index) => ({
    ...template,
    membership: {
      ...template.membership,
      membershipId: `membership-${card.id}`,
    },
    page: {
      ...template.page,
      pageId: card.id,
      documentId: `document-${card.id}`,
      title: card.title,
      richTitle: card.richTitle,
    },
    position: { rankKey: String.fromCharCode(97 + index), revision: 1 },
  }));
  return {
    ...snapshot,
    rows: cards.map((card, index) => ({
      page: card,
      groupKey: card.status,
      subgroupKey: null,
      rankKey: String.fromCharCode(97 + index),
    })),
    query: { ...snapshot.query, rows: queryRows },
  };
}

function createGroupsSnapshot(
  overrides: Partial<DatabaseViewGroupsSnapshot> = {},
): DatabaseViewGroupsSnapshot {
  const snapshot = {
    projectId: "project-1",
    libraryId: "library-1",
    databaseId: "database-1",
    dataSourceId: "source-1",
    viewId: "view-primary",
    storeEpoch: "epoch-1",
    commitSeq: 1,
    projection: {
      scopeKey: "scope:view-primary",
      schemaVersion: 1,
      revision: 1,
      coveredCommitSeq: 1,
      effectHash: "1".padStart(64, "a"),
    },
    grouped: false,
    subgrouped: false,
    totalRows: 1,
    totalGroups: 0,
    groupLimit: 200,
    truncated: false,
    groups: [],
    ...overrides,
  };
  return {
    ...snapshot,
    authorization:
      overrides.authorization ??
      authorizedReadStampFixture({
        deliveryAddress: {
          kind: "project",
          library_id: snapshot.libraryId,
          project_id: snapshot.projectId,
        },
        subject: { kind: "view", view_id: snapshot.viewId },
        storeEpoch: snapshot.storeEpoch,
        commitSeq: snapshot.commitSeq,
      }),
  };
}

/**
 * Test registry with an ungrouped groups read by default, which keeps the
 * store on the single flat window path most tests exercise.
 */
function createTestRegistry(dependencies: Partial<BoardStoreDependencies> = {}) {
  return createBoardStoreRegistry({
    getProjectionInvalidationRegistry: () => null,
    readViewGroups: async (_projectId, input) => {
      const viewId = input.databaseViewId ?? "view-primary";
      const revision = input.minimumCommitCursor?.commitSeq ?? input.minimumCommitSeq ?? 1;
      return createGroupsSnapshot({
        viewId,
        storeEpoch: input.minimumCommitCursor?.storeEpoch ?? "epoch-1",
        commitSeq: revision,
        projection: {
          scopeKey: `scope:${viewId}`,
          schemaVersion: 1,
          revision,
          coveredCommitSeq: revision,
          effectHash: String(revision).padStart(64, "a").slice(-64),
        },
      });
    },
    ...dependencies,
  });
}

function createProjectionHarness() {
  const projectionListeners = new Set<(message: ProjectionStreamMessage) => void>();
  const revocationListeners = new Set<(message: ResourceRevocationMessage) => void>();
  let latestMessage: ProjectionStreamMessage | ResourceRevocationMessage | null = null;
  const registry = new ProjectionInvalidationRegistry({
    subscribeProjection: (scope, listener) => {
      projectionListeners.add(listener);
      if (latestMessage) {
        listener({
          version: 2,
          kind: "checkpoint",
          scope,
          stream: latestMessage.stream,
        });
      }
      return () => projectionListeners.delete(listener);
    },
    subscribeRevocations: (_scope, listener) => {
      revocationListeners.add(listener);
      return () => revocationListeners.delete(listener);
    },
  });
  const registrations: ProjectionRegistration[] = [];
  const register = registry.register.bind(registry);
  registry.register = (registration) => {
    registrations.push(registration);
    return register(registration);
  };
  return {
    getRegistry: () => registry,
    registrations,
    publish: (message: ProjectionStreamMessage | ResourceRevocationMessage) => {
      latestMessage = message;
      if (message.version === 1) {
        for (const listener of revocationListeners) listener(message);
        return;
      }
      for (const listener of projectionListeners) listener(message);
    },
  };
}

function pageChanged(
  commitSeq: number,
  pageId = "card-1",
  viewId = "view-primary",
): ProjectionStreamMessage {
  return {
    version: 2,
    kind: "effect",
    scope: {
      kind: "project",
      libraryId: "library-1",
      projectId: "project-1",
    },
    stream: { storeEpoch: "epoch-1", commitSeq },
    delivery: {
      storeEpoch: "epoch-1",
      commitSeq,
      manifestHash: String(commitSeq).padStart(64, "b").slice(-64),
      operationId: `operation-${commitSeq}`,
      committedAt: "2026-08-06T00:00:00.000Z",
      impact: {
        kind: "resources",
        page_ids: [pageId],
        database_ids: ["database-1"],
        data_source_ids: ["source-1"],
        view_ids: ["view-focused", "view-primary"],
        document_heads: [
          {
            page_id: pageId,
            document_id: "document-1",
            generation: 1,
            head_seq: commitSeq,
          },
        ],
      },
      effect: {
        scope: {
          schema_version: 1,
          canonical_key: `scope:${viewId}`,
          scope: {
            kind: "database_view",
            project_id: "project-1",
            database_id: "database-1",
            data_source_id: "source-1",
            view_id: viewId,
          },
        },
        baseRevision: Math.max(0, commitSeq - 1),
        resultRevision: commitSeq,
        coveredCommitSeq: commitSeq,
        patch: null,
        requiresReadAtLeast: true,
        effectHash: String(commitSeq).padStart(64, "a").slice(-64),
      },
    },
  };
}

function pageRemoved(commitSeq: number, pageId: string): ProjectionStreamMessage {
  const message = pageChanged(commitSeq, pageId);
  if (message.kind !== "effect") throw new Error("Projection fixture is invalid");
  return {
    ...message,
    delivery: {
      ...message.delivery,
      effect: {
        ...message.delivery.effect,
        patch: {
          kind: "database_row_remove",
          projectId: "project-1",
          databaseId: "database-1",
          dataSourceId: "source-1",
          viewId: "view-primary",
          pageId,
          totalRows: 0,
          groupKey: "triage",
          subgroupKey: null,
          groupTotal: 0,
        },
      },
    },
  };
}

function pageRevoked(commitSeq: number, pageId: string): ResourceRevocationMessage {
  return {
    version: 1,
    kind: "revocation",
    scope: {
      kind: "project",
      libraryId: "library-1",
      projectId: "project-1",
    },
    stream: { storeEpoch: "epoch-1", commitSeq },
    delivery: {
      storeEpoch: "epoch-1",
      commitSeq,
      manifestHash: String(commitSeq).padStart(64, "b").slice(-64),
      operationId: `operation-${commitSeq}`,
      committedAt: "2026-08-06T00:00:00.000Z",
      revocation: {
        authorization_scope: {
          kind: "project",
          library_id: "library-1",
          project_id: "project-1",
        },
        resource_kind: "page",
        resource_id: pageId,
        reason: "ownership_moved",
      },
    },
  };
}

function pageUpserted(
  commitSeq: number,
  page: DatabasePageSummary,
  rankKey = "b",
): ProjectionStreamMessage {
  const message = pageChanged(commitSeq, page.id);
  if (message.kind !== "effect") throw new Error("Projection fixture is invalid");
  return {
    ...message,
    delivery: {
      ...message.delivery,
      effect: {
        ...message.delivery.effect,
        patch: {
          kind: "database_row_upsert",
          projectId: "project-1",
          databaseId: "database-1",
          dataSourceId: "source-1",
          viewId: "view-primary",
          row: page,
          sourceRow: {
            page_id: page.id,
            lifecycle: "active",
            title: page.title,
            rich_title: page.richTitle,
            description_preview: page.descriptionPreview,
            description_length: page.descriptionPreview.length,
            has_description: page.descriptionPreview.length > 0,
            database_values: { status: page.status },
            intrinsic_properties: {},
            database_value_revisions: { status: 1 },
            task_parent_page_id: null,
            task_sibling_rank: null,
            task_parent_value_revision: 1,
            metadata_revision: page.revision ?? 1,
            parent_revision: 1,
            document_id: `document:${page.id}`,
            document_generation: 1,
            document_head_seq: 1,
            membership_id: `membership:${page.id}`,
            membership_revision: 1,
            membership_created_at: "2026-08-06T00:00:00.000Z",
            created_at: "2026-08-06T00:00:00.000Z",
            updated_at: "2026-08-06T00:00:00.000Z",
            effective_group_key: page.status,
            effective_subgroup_key: null,
            rank_key: rankKey,
            position_revision: 1,
          },
          effectiveGroupKey: page.status,
          effectiveSubgroupKey: null,
          rankKey,
          totalRows: 2,
          groupTotal: 2,
        },
      },
    },
  };
}

function cloneBoard(board: BoardSummary): BoardSummary {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({ ...card })),
    })),
  };
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

function waitForProjectionRepair(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 350);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("board store", () => {
  test("re-reads group and row windows with the current personal presentation", async () => {
    const windowInputs: DatabaseViewWindowInput[] = [];
    const groupInputs: DatabaseViewGroupsInput[] = [];
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, input) => {
        windowInputs.push(input);
        return createBoardSnapshot(
          createBoard(),
          windowInputs.length,
          "view-focused",
          false,
          windowInputs.length,
        );
      },
      readViewGroups: async (_projectId, input) => {
        groupInputs.push(input);
        return createGroupsSnapshot({
          viewId: "view-focused",
          commitSeq: groupInputs.length,
          projection: {
            scopeKey: "scope:view-focused",
            schemaVersion: 1,
            revision: groupInputs.length,
            coveredCommitSeq: groupInputs.length,
            effectHash: String(groupInputs.length).padStart(64, "a").slice(-64),
          },
        });
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1", "view-focused");
    await store.fetchBoard();

    store.setPresentationOverride({ group: null });
    await store.fetchBoard();

    expect(groupInputs.at(-1)?.preferencesOverride?.presentationOverride).toEqual({
      group: null,
    });
    expect(windowInputs.at(-1)?.preferencesOverride?.presentationOverride).toEqual({
      group: null,
    });
  });

  test("keeps the last readable projection until a presentation refresh replaces it", async () => {
    const replacement = createDeferred<DatabaseViewWindowSnapshot>();
    let readGeneration = 0;
    const registry = createTestRegistry({
      readViewGroups: async () => {
        readGeneration += 1;
        return createGroupsSnapshot({
          viewId: "view-focused",
          commitSeq: readGeneration,
          projection: {
            scopeKey: "scope:view-focused",
            schemaVersion: 1,
            revision: readGeneration,
            coveredCommitSeq: readGeneration,
            effectHash: String(readGeneration).padStart(64, "a").slice(-64),
          },
        });
      },
      readViewWindow: async () =>
        readGeneration === 1
          ? createBoardSnapshot(createBoard("Visible before refresh"), 1, "view-focused", false, 1)
          : await replacement.promise,
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1", "view-focused");
    await store.fetchBoard();

    store.setPresentationOverride({ group: null });
    const refresh = store.fetchBoard();
    await waitForMicrotasks();

    expect(store.getSnapshot().loading).toBe(false);
    expect(store.getSnapshot().error).toBe(null);
    expect(
      store
        .getSnapshot()
        .databaseView?.columns.flatMap((column) => column.rows)
        .map((row) => row.title),
    ).toContain("Visible before refresh");

    replacement.resolve(
      createBoardSnapshot(createBoard("Atomically replaced"), 2, "view-focused", false, 2),
    );
    await refresh;

    expect(store.getSnapshot().loading).toBe(false);
    expect(store.getSnapshot().error).toBe(null);
    expect(
      store
        .getSnapshot()
        .databaseView?.columns.flatMap((column) => column.rows)
        .map((row) => row.title),
    ).toContain("Atomically replaced");
  });

  test("ignores a released projection fence from the previous presentation", async () => {
    const projection = createProjectionHarness();
    const replacement = createDeferred<DatabaseViewWindowSnapshot>();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return readCount === 1
          ? createBoardSnapshot(createBoard("Visible during handoff"), 1, "view-focused", false, 1)
          : replacement.promise;
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1", "view-focused");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();
    const releasedRegistration = projection.registrations.at(-1);
    if (!releasedRegistration) throw new Error("Board projection was not registered");

    store.setPresentationOverride({ group: null });
    releasedRegistration.fence?.({
      version: 2,
      kind: "checkpoint",
      scope: {
        kind: "project",
        libraryId: "library-1",
        projectId: "project-1",
      },
      stream: { storeEpoch: "epoch-1", commitSeq: 2 },
    });

    expect(store.getSnapshot().loading).toBe(false);
    expect(
      store
        .getSnapshot()
        .databaseView?.columns.flatMap((column) => column.rows)
        .map((row) => row.title),
    ).toContain("Visible during handoff");
    replacement.resolve(
      createBoardSnapshot(createBoard("Replacement"), 2, "view-focused", false, 2),
    );
    await waitForMicrotasks();
    unsubscribe();
  });

  test("keeps the last readable projection when a presentation refresh fails", async () => {
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount > 1) throw new Error("refresh unavailable");
        return createBoardSnapshot(createBoard("Still visible"), 1, "view-focused", false, 1);
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1", "view-focused");
    await store.fetchBoard();

    store.setPresentationOverride({ group: null });
    await store.fetchBoard();

    expect(store.getSnapshot().loading).toBe(false);
    expect(store.getSnapshot().error).toBe("refresh unavailable");
    expect(
      store
        .getSnapshot()
        .databaseView?.columns.flatMap((column) => column.rows)
        .map((row) => row.title),
    ).toContain("Still visible");
  });

  test("isolates durable View stores and never reads primary Board data for a secondary View", async () => {
    const calls: string[] = [];
    const registry = createTestRegistry({
      readViewWindow: async (projectId, input) => {
        const viewId = input.databaseViewId ?? "view-primary";
        calls.push(`database:view-window:get:${projectId}:${viewId}`);
        return createBoardSnapshot(
          createBoard(
            viewId === "view-focused" ? "Focused query row" : "Full primary Card summary",
          ),
          1,
          viewId,
          viewId === "view-primary",
        );
      },
      subscribeBoardChanges: () => () => {},
    });
    const primary = registry.getStore("project-1", "view-primary");
    const focused = registry.getStore("project-1", "view-focused");

    await Promise.all([primary.fetchBoard(), focused.fetchBoard()]);

    expect(primary === focused).toBe(false);
    expect(primary.getSnapshot().databaseView?.databaseViewId).toBe("view-primary");
    expect(primary.getSnapshot().pageIndex.get("card-1")?.title).toBe("Full primary Card summary");
    expect(focused.getSnapshot().databaseView?.databaseViewId).toBe("view-focused");
    expect(focused.getSnapshot().databaseView?.columns[0]?.rows[0]?.title).toBe(
      "Focused query row",
    );
    expect(focused.getSnapshot().board).not.toBe(null);
    expect(calls.filter((call) => call.startsWith("database:view-window:get")).length).toBe(2);
    const callsBeforeFreshEnsure = calls.length;
    await focused.ensureFreshBoard();
    expect(calls.length).toBe(callsBeforeFreshEnsure);
    expect(focused.getSnapshot().loading).toBe(false);
  });

  test("repairs each independent Board scope consumer from one effect", async () => {
    const projection = createProjectionHarness();
    let fetchCount = 0;
    const makeRegistry = () =>
      createTestRegistry({
        readViewWindow: async () => {
          fetchCount += 1;
          const revision = fetchCount <= 2 ? 1 : 8;
          return createBoardSnapshot(createBoard(), revision, "view-primary", true, revision);
        },
        subscribeBoardChanges: () => () => {},
        getProjectionInvalidationRegistry: projection.getRegistry,
      });
    const firstStore = makeRegistry().getStore("project-1");
    const secondStore = makeRegistry().getStore("project-1");
    const unsubscribeFirst = firstStore.subscribe(() => {});
    const unsubscribeSecond = secondStore.subscribe(() => {});
    await waitForMicrotasks();
    expect(fetchCount).toBe(2);

    projection.publish(pageChanged(8));
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(fetchCount).toBe(4);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("refreshes a durable Database View from a matching Page Document event", async () => {
    const projection = createProjectionHarness();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return createBoardSnapshot(
          createBoard(readCount === 1 ? "Before Document edit" : "After Document edit"),
          readCount === 1 ? 1 : 9,
          "view-focused",
          false,
          readCount === 1 ? 1 : 9,
        );
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1", "view-focused");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();
    expect(store.getSnapshot().databaseView?.columns[0]?.rows[0]?.title).toBe(
      "Before Document edit",
    );

    projection.publish(pageChanged(9, "card-filtered-out-before-title-change", "view-focused"));
    await waitForMicrotasks();

    expect(readCount).toBe(2);
    expect(store.getSnapshot().databaseView?.columns[0]?.rows[0]?.title).toBe(
      "After Document edit",
    );
    unsubscribe();
  });

  test("keeps receiving Page Document effects after an initial checkpoint repair", async () => {
    const projection = createProjectionHarness();
    const readFloors: number[] = [];
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, input) => {
        const floor = input.minimumCommitCursor?.commitSeq ?? input.minimumCommitSeq ?? 1;
        readFloors.push(floor);
        return createBoardSnapshot(
          createBoard(`Revision ${floor}`),
          floor,
          "view-focused",
          false,
          floor,
        );
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1", "view-focused");

    projection.publish(pageChanged(2, "card-1", "view-focused"));
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(readFloors).toContain(2);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Revision 2");

    projection.publish(pageChanged(3, "card-1", "view-focused"));
    await waitForProjectionRepair();

    expect(readFloors).toContain(3);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Revision 3");
    unsubscribe();
  });

  test("runs one trailing read when a Page invalidation arrives during a fetch", async () => {
    const firstRead = createDeferred<DatabaseViewWindowSnapshot>();
    const projection = createProjectionHarness();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return await firstRead.promise;
        return createBoardSnapshot(createBoard("Latest head"), 10, "view-focused", false, 10);
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1", "view-focused");
    const unsubscribe = store.subscribe(() => {});

    projection.publish(pageChanged(10, "card-1", "view-focused"));
    firstRead.resolve(
      createBoardSnapshot(createBoard("Stale in-flight head"), 1, "view-focused", false),
    );
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(readCount).toBe(2);
    expect(store.getSnapshot().databaseView?.columns[0]?.rows[0]?.title).toBe("Latest head");
    unsubscribe();
  });

  test("registers a single board-change subscription for multiple listeners", async () => {
    const board = createBoard();
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;

    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(board),
      subscribeBoardChanges: () => {
        subscribeCalls += 1;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    });

    const store = registry.getStore("default");
    const unsubscribeFirst = store.subscribe(() => {});
    const unsubscribeSecond = store.subscribe(() => {});
    await waitForMicrotasks();

    expect(subscribeCalls).toBe(1);

    unsubscribeFirst();
    expect(unsubscribeCalls).toBe(0);

    unsubscribeSecond();
    expect(unsubscribeCalls).toBe(1);
  });

  test("dedupes in-flight board fetches", async () => {
    const board = createBoard();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let groupsReads = 0;
    let windowReads = 0;

    const registry = createTestRegistry({
      readViewGroups: async () => {
        groupsReads += 1;
        await released;
        return createGroupsSnapshot();
      },
      readViewWindow: async () => {
        windowReads += 1;
        return createBoardSnapshot(board);
      },
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    const firstFetch = store.fetchBoard();
    const secondFetch = store.fetchBoard();

    expect(groupsReads).toBe(1);

    release();
    await Promise.all([firstFetch, secondFetch]);
    expect(groupsReads).toBe(1);
    expect(windowReads).toBe(1);
  });

  test("refreshBoard fetches again after an in-flight fetch settles", async () => {
    const initialBoard = createBoard("Initial");
    const refreshedBoard = createBoard("Refreshed");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let windowReads = 0;

    const registry = createTestRegistry({
      readViewWindow: async () => {
        windowReads += 1;
        if (windowReads === 1) {
          await released;
          return createBoardSnapshot(initialBoard);
        }
        return createBoardSnapshot(refreshedBoard, 2);
      },
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    const firstFetch = store.fetchBoard();
    const refreshPromise = store.refreshBoard();

    release();
    await Promise.all([firstFetch, refreshPromise]);

    expect(windowReads).toBe(2);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Refreshed");
  });

  test("fetchBoard reads the bounded window and keeps full descriptions out of snapshots", async () => {
    const board = createBoard();
    let windowReads = 0;

    const registry = createTestRegistry({
      readViewWindow: async () => {
        windowReads += 1;
        return createBoardSnapshot(board);
      },
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    const indexedPage = store.getSnapshot().pageIndex.get("card-1");
    expect(windowReads).toBe(1);
    expect(Object.hasOwn(indexedPage ?? {}, "description")).toBe(false);
    expect(indexedPage?.descriptionPreview).toBe("Initial description");
  });

  test("bounds group-window read concurrency for high-cardinality Views", async () => {
    const release = createDeferred<void>();
    const groups = Array.from({ length: 24 }, (_, index) => ({
      groupKey: `group-${index}`,
      subgroupKey: null,
      totalRows: 1,
    }));
    let windowReads = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    const registry = createTestRegistry({
      readViewGroups: async () =>
        createGroupsSnapshot({
          grouped: true,
          totalRows: groups.length,
          totalGroups: groups.length,
          groups,
        }),
      readViewWindow: async () => {
        windowReads += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await release.promise;
        activeReads -= 1;
        return createBoardSnapshot();
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    const fetching = store.fetchBoard();
    await waitForMicrotasks();

    expect(windowReads).toBe(8);
    expect(maxActiveReads).toBe(8);

    release.resolve(undefined);
    await fetching;

    expect(windowReads).toBe(24);
    expect(maxActiveReads).toBe(8);
  });

  test("retries instead of composing groups and windows from different projection revisions", async () => {
    let groupReads = 0;
    let windowReads = 0;
    const authority = (revision: number) => ({
      scopeKey: "scope:view-primary",
      schemaVersion: 1,
      revision,
      coveredCommitSeq: revision,
      effectHash: String(revision).padStart(64, "a").slice(-64),
    });
    const registry = createTestRegistry({
      readViewGroups: async () => {
        groupReads += 1;
        const revision = groupReads === 1 ? 1 : 2;
        return createGroupsSnapshot({
          commitSeq: revision,
          projection: authority(revision),
        });
      },
      readViewWindow: async () => {
        windowReads += 1;
        return createBoardSnapshot(createBoard("Consistent head"), 2, "view-primary", true, 2);
      },
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("project-1");
    await store.fetchBoard();

    expect(groupReads).toBe(2);
    expect(windowReads).toBe(2);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Consistent head");
  });

  test("appends a real continuation window without duplicating loaded rows", async () => {
    const first = {
      ...createBoardSnapshot(createBoard("First")),
      nextCursor: "cursor-1",
    };
    const secondCard = {
      ...createPageSummary("Second"),
      id: "card-2",
      order: 1,
    };
    const second = createBoardSnapshot({
      columns: [
        { id: "triage", name: "Ideas", cards: [secondCard] },
        { id: "ship", name: "Ship", cards: [] },
      ],
    });
    const requests: unknown[] = [];
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, request) => {
        requests.push(request);
        return requests.length === 1 ? first : second;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1");

    await store.fetchBoard();
    expect(store.getSnapshot().hasMore).toBe(true);
    await store.loadMore();

    expect(requests).toEqual([
      { first: 50 },
      {
        after: "cursor-1",
        first: 50,
        minimumCommitCursor: { storeEpoch: "epoch-1", commitSeq: 1 },
      },
    ]);
    expect([...store.getSnapshot().pageIndex.keys()]).toEqual(["card-1", "card-2"]);
    expect(store.getSnapshot().hasMore).toBe(false);
  });

  test("a rejected continuation converges silently from the first window", async () => {
    const first = {
      ...createBoardSnapshot(createBoard("First")),
      nextCursor: "cursor-1",
    };
    const recovered = createBoardSnapshot(createBoard("Recovered"), 2);
    const requests: unknown[] = [];
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, request) => {
        requests.push(request);
        if (requests.length === 2) {
          throw new CoreApiError({
            code: "stale_store_epoch",
            message: "Collection cursor belongs to another Store epoch",
            retryable: false,
            recovery: { kind: "none" },
          });
        }
        return requests.length === 1 ? first : recovered;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1");

    await store.fetchBoard();
    expect(store.getSnapshot().hasMore).toBe(true);
    await store.loadMore();

    expect(requests).toEqual([
      { first: 50 },
      {
        after: "cursor-1",
        first: 50,
        minimumCommitCursor: { storeEpoch: "epoch-1", commitSeq: 1 },
      },
      {
        first: 50,
        minimumCommitCursor: { storeEpoch: "epoch-1", commitSeq: 1 },
      },
    ]);
    expect(store.getSnapshot().error).toBe(null);
    expect(store.getSnapshot().loadingMore).toBe(false);
    expect(store.getSnapshot().hasMore).toBe(false);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Recovered");
  });

  test("grouped boards page each column independently with scoped continuations", async () => {
    const triageCards = [0, 1].map((index) => ({
      ...createPageSummary(`Triage ${index}`),
      id: `triage-${index}`,
      order: index,
    }));
    const shipCard = {
      ...createPageSummary("Ship 0"),
      id: "ship-0",
      status: "ship" as const,
      order: 0,
    };
    const windowFor = (
      cards: readonly DatabasePageSummary[],
      columnId: string,
      nextCursor: string | null,
    ): DatabaseViewWindowSnapshot => ({
      ...createBoardSnapshot({
        columns: [
          { id: "triage", name: "Ideas", cards: columnId === "triage" ? [...cards] : [] },
          { id: "ship", name: "Ship", cards: columnId === "ship" ? [...cards] : [] },
        ],
      }),
      nextCursor,
      rows: cards.map((card, index) => ({
        page: card,
        groupKey: columnId,
        subgroupKey: null,
        rankKey: String(index),
      })),
    });
    const requests: Array<{ groupScope?: unknown; after?: string; first?: number }> = [];
    const registry = createTestRegistry({
      readViewGroups: async () =>
        createGroupsSnapshot({
          grouped: true,
          totalRows: 4,
          groups: [
            { groupKey: "ship", subgroupKey: null, totalRows: 1 },
            { groupKey: "triage", subgroupKey: null, totalRows: 3 },
          ],
        }),
      readViewWindow: async (_projectId, request) => {
        requests.push(request);
        const key = request.groupScope?.groupKey ?? "unassigned";
        if (key === "ship") return windowFor([shipCard], "ship", null);
        if (request.after === "triage-cursor") {
          return windowFor(
            [{ ...createPageSummary("Triage 2"), id: "triage-2", order: 2 }],
            "triage",
            null,
          );
        }
        return windowFor(triageCards, "triage", "triage-cursor");
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1");

    await store.fetchBoard();

    expect(store.getSnapshot().totalRows).toBe(4);
    const triageScopeKey = groupScopeKeyForColumn("triage");
    const shipScopeKey = groupScopeKeyForColumn("ship");
    const triagePagination = store.getSnapshot().groupPagination.get(triageScopeKey);
    expect(triagePagination).toMatchObject({
      loadedRows: 2,
      totalRows: 3,
      hasMore: true,
      loadingMore: false,
    });
    expect(store.getSnapshot().groupPagination.get(shipScopeKey)).toMatchObject({
      loadedRows: 1,
      totalRows: 1,
      hasMore: false,
    });

    await store.loadMoreGroup(triageScopeKey);

    expect(requests.filter((request) => request.after).length).toBe(1);
    expect(requests.find((request) => request.after)).toMatchObject({
      after: "triage-cursor",
      groupScope: { kind: "path", groupKey: "triage", subgroupKey: null },
    });
    expect([...store.getSnapshot().pageIndex.keys()].sort()).toEqual([
      "ship-0",
      "triage-0",
      "triage-1",
      "triage-2",
    ]);
    expect(store.getSnapshot().groupPagination.get(triageScopeKey)?.hasMore).toBe(false);
  });

  test("a refresh re-reads the loaded span instead of resetting to one window", async () => {
    const cards = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...createPageSummary(`Card ${index}`),
        id: `card-${index}`,
        order: index,
      }));
    const windowOf = (
      loaded: DatabasePageSummary[],
      nextCursor: string | null,
      commitSeq = 1,
    ): DatabaseViewWindowSnapshot => ({
      ...createBoardSnapshot(
        {
          columns: [
            { id: "triage", name: "Ideas", cards: loaded },
            { id: "ship", name: "Ship", cards: [] },
          ],
        },
        commitSeq,
      ),
      nextCursor,
      rows: loaded.map((card, index) => ({
        page: card,
        groupKey: "triage",
        subgroupKey: null,
        rankKey: String(index).padStart(4, "0"),
      })),
    });
    const requests: Array<{ after?: string; first?: number }> = [];
    const all = cards(80);
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, request) => {
        requests.push(request);
        if (request.after === "cursor-50") {
          return windowOf(all.slice(50, 80), null);
        }
        const first = request.first ?? 50;
        return windowOf(
          all.slice(0, Math.min(first, all.length)),
          first < 80 ? "cursor-50" : null,
          requests.length,
        );
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1");

    await store.fetchBoard();
    await store.loadMore();
    expect(store.getSnapshot().pageIndex.size).toBe(80);

    await store.refreshBoard();

    expect(requests.at(-1)).toMatchObject({ first: 80 });
    expect(store.getSnapshot().pageIndex.size).toBe(80);
  });

  test("a transport failure keeps the board and reports an inline group error", async () => {
    const first = {
      ...createBoardSnapshot(createBoard("First")),
      nextCursor: "cursor-1",
    };
    let windowReads = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        windowReads += 1;
        if (windowReads === 2) {
          throw new Error("Core is unavailable");
        }
        return first;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("project-1");

    await store.fetchBoard();
    await store.loadMore();

    expect(windowReads).toBe(2);
    expect(store.getSnapshot().error).toBe(null);
    expect(store.getSnapshot().board).not.toBe(null);
    const pagination = store.getSnapshot().groupPagination.get("all");
    expect(pagination?.error).toBe("Core is unavailable");
    // The continuation is retained so the user can retry the same group.
    expect(pagination?.hasMore).toBe(true);
  });

  test("first subscribe with a fresh base board does not refetch", async () => {
    const board = createBoard();
    let invokeCalls = 0;
    let currentTime = 1_000;

    const registry = createTestRegistry({
      readViewWindow: async () => {
        invokeCalls += 1;
        return createBoardSnapshot(board);
      },
      subscribeBoardChanges: () => () => {},
      now: () => currentTime,
    });

    const store = registry.getStore("default");
    await store.fetchBoard();
    expect(invokeCalls).toBe(1);

    currentTime = 2_000;
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    expect(invokeCalls).toBe(1);
    unsubscribe();
  });

  test("stale subscribe refreshes in the background without clearing the current board", async () => {
    const boards = [createBoard("Initial"), createBoard("Refreshed")];
    let invokeCalls = 0;
    let currentTime = 1_000;

    const registry = createTestRegistry({
      readViewWindow: async () => {
        const board = boards[invokeCalls] ?? boards[boards.length - 1]!;
        invokeCalls += 1;
        return createBoardSnapshot(board, invokeCalls);
      },
      subscribeBoardChanges: () => () => {},
      now: () => currentTime,
    });

    const store = registry.getStore("default");
    await store.fetchBoard();
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Initial");

    currentTime = 32_000;
    const unsubscribe = store.subscribe(() => {});
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Initial");

    await waitForMicrotasks();
    expect(invokeCalls).toBe(2);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Refreshed");
    unsubscribe();
  });

  test("force ensureFreshBoard refreshes even when the board is fresh", async () => {
    const boards = [createBoard("Initial"), createBoard("Forced")];
    let invokeCalls = 0;

    const registry = createTestRegistry({
      readViewWindow: async () => {
        const board = boards[invokeCalls] ?? boards[boards.length - 1]!;
        invokeCalls += 1;
        return createBoardSnapshot(board, invokeCalls);
      },
      subscribeBoardChanges: () => () => {},
      now: () => 1_000,
    });

    const store = registry.getStore("default");
    await store.fetchBoard();
    await store.ensureFreshBoard({ force: true });

    expect(invokeCalls).toBe(2);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Forced");
  });

  test("summary patch events update the board without a broad refetch", async () => {
    const callbacks: { onBoardChange?: (event: BoardChangeEvent) => void } = {};
    let boardFetchCount = 0;

    const registry = createTestRegistry({
      readViewWindow: async () => {
        boardFetchCount += 1;
        return createBoardSnapshot();
      },
      subscribeBoardChanges: (_projectId, callback) => {
        callbacks.onBoardChange = callback;
        return () => {};
      },
    });

    const store = registry.getStore("default");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    callbacks.onBoardChange?.({
      projectId: "default",
      changeType: "update",
      columnId: "triage",
      status: "triage",
      pageId: "card-1",
      summary: createPageSummary("Patched from event"),
      storeEpoch: "epoch-1",
      commitSeq: 2,
    });
    await waitForMicrotasks();

    expect(boardFetchCount).toBe(1);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Patched from event");
    unsubscribe();
  });

  test("applies local optimistic overlays to board and card index", async () => {
    const board = createBoard();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(board),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    await waitForMicrotasks();
    notifications = 0;

    store.applyLocalPatch("triage", "card-1", {
      title: "Updated title",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.board?.columns[0]?.cards[0]?.title).toBe("Updated title");
    expect(snapshot.pageIndex.get("card-1")?.title).toBe("Updated title");
    expect(notifications).toBe(1);

    unsubscribe();
  });

  test("merges full remote card updates as summaries without storing the body", async () => {
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyRemoteCard({
      id: "card-1",
      pageKey: null,
      status: "triage",
      archived: false,
      title: "Remote title",
      richTitle: plainTextToPortableRichText("Remote title"),
      description: "Remote full body that should only become preview metadata",
      tags: [],
      revision: 2,
      created: new Date("2026-02-16T00:00:00.000Z"),
      order: 0,
    });

    const indexedPage = store.getSnapshot().pageIndex.get("card-1");
    const summary = toDatabasePageSummary({
      id: "card-1",
      pageKey: null,
      status: "triage",
      archived: false,
      title: "Remote title",
      richTitle: plainTextToPortableRichText("Remote title"),
      description: "Remote full body that should only become preview metadata",
      tags: [],
      revision: 2,
      created: new Date("2026-02-16T00:00:00.000Z"),
      order: 0,
    });

    expect(indexedPage?.title).toBe("Remote title");
    expect(indexedPage?.descriptionPreview).toBe(summary.descriptionPreview);
    expect(indexedPage?.descriptionLength).toBe(summary.descriptionLength);
    expect(Object.hasOwn(indexedPage ?? {}, "description")).toBe(false);
  });

  test("merges remote card summary acknowledgements without a full body", async () => {
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyRemoteCardSummary({
      id: "card-1",
      pageKey: null,
      status: "triage",
      archived: false,
      title: "Ack title",
      richTitle: plainTextToPortableRichText("Ack title"),
      tags: [],
      revision: 2,
      created: new Date("2026-02-16T00:00:00.000Z"),
      order: 0,
      descriptionPreview: "Ack preview",
      descriptionLength: 128,
      hasDescription: true,
    });

    const indexedPage = store.getSnapshot().pageIndex.get("card-1");
    expect(indexedPage?.title).toBe("Ack title");
    expect(indexedPage?.descriptionPreview).toBe("Ack preview");
    expect(indexedPage?.descriptionLength).toBe(128);
    expect(Object.hasOwn(indexedPage ?? {}, "description")).toBe(false);
  });

  test("does not notify subscribers for a repeated canonical summary", async () => {
    const board = createBoard();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(board),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const before = store.getSnapshot();
    const card = before.board?.columns[0]?.cards[0];
    if (!card) throw new Error("Canonical card fixture is missing");
    store.applyRemoteCardSummary({ ...card });

    expect(store.getSnapshot()).toBe(before);
    expect(notifications).toBe(0);
    unsubscribe();
  });

  test("rejects a stale direct projection delta after a newer row read", async () => {
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyRemoteCardSummary(
      {
        ...createPageSummary("Newer title"),
        revision: 2,
      },
      { storeEpoch: "epoch-1", commitSeq: 8 },
    );
    store.applyRemoteCardSummary(
      {
        ...createPageSummary("Delayed older title"),
        revision: 1,
      },
      { storeEpoch: "epoch-1", commitSeq: 7 },
    );

    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Newer title");
  });

  test("shows a newly promoted Page in the loaded Board before projection refresh", async () => {
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyRemoteCardSummary(
      {
        ...createPageSummary("Promoted title"),
        id: "page-promoted",
        order: 1,
      },
      { storeEpoch: "epoch-1", commitSeq: 2 },
    );

    const snapshot = store.getSnapshot();
    expect(snapshot.pageIndex.get("page-promoted")?.title).toBe("Promoted title");
    expect(
      snapshot.board?.columns
        .find((column) => column.id === "triage")
        ?.cards.map((card) => card.id),
    ).toEqual(["card-1", "page-promoted"]);
  });

  test("applies a promoted Page effect before a delayed canonical repair", async () => {
    const projection = createProjectionHarness();
    const delayedRepair = createDeferred<DatabaseViewWindowSnapshot>();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return createBoardSnapshot();
        return await delayedRepair.promise;
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const release = store.subscribe(() => {});
    await waitForMicrotasks();
    const promoted = {
      ...createPageSummary("Promoted immediately"),
      id: "page-promoted",
      order: 1,
    };

    projection.publish(pageUpserted(2, promoted));

    expect(store.getSnapshot().pageIndex.get("page-promoted")?.title).toBe("Promoted immediately");
    expect(
      store
        .getSnapshot()
        .databaseView?.columns.flatMap((column) => column.rows)
        .some((row) => row.pageId === "page-promoted"),
    ).toBe(true);
    await waitForProjectionRepair();
    expect(readCount).toBe(2);
    delayedRepair.resolve(
      createBoardSnapshot(
        {
          columns: createBoard().columns.map((column) =>
            column.id === "triage" ? { ...column, cards: [...column.cards, promoted] } : column,
          ),
        },
        2,
        "view-primary",
        true,
        2,
      ),
    );
    await waitForMicrotasks();
    release();
  });

  test("does not replace a Property-sorted window with fractional order before repair", async () => {
    const projection = createProjectionHarness();
    const repair = createDeferred<DatabaseViewWindowSnapshot>();
    const initial = createTwoPageBoardSnapshot(["card-2", "card-1"]);
    const rankByPageId = new Map([
      ["card-1", "a"],
      ["card-2", "z"],
    ]);
    const propertySorted = {
      ...initial,
      rows: initial.rows.map((row) => ({
        ...row,
        rankKey: rankByPageId.get(row.page.id) ?? row.rankKey,
      })),
      query: {
        ...initial.query,
        rows: initial.query.rows.map((row) => {
          if (!row.position) {
            throw new Error("Expected the sorted Board fixture to have positions");
          }
          return {
            ...row,
            position: {
              ...row.position,
              rankKey: rankByPageId.get(row.page.pageId) ?? row.position.rankKey,
            },
          };
        }),
      },
    } satisfies DatabaseViewWindowSnapshot;
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return readCount === 1 ? propertySorted : await repair.promise;
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    store.setRulesOverride({
      sorts: [
        {
          field: { kind: "property", propertyId: "priority" },
          direction: "asc",
          nulls: "last",
        },
      ],
    });
    const release = store.subscribe(() => {});
    await waitForMicrotasks();

    const updated = {
      ...propertySorted.rows[0]!.page,
      title: "Updated without manual reorder",
      richTitle: plainTextToPortableRichText("Updated without manual reorder"),
    };
    projection.publish(pageUpserted(2, updated, "z"));
    await waitForMicrotasks();

    expect(store.getSnapshot().databaseView?.query.rows.map((row) => row.page.pageId)).toEqual([
      "card-2",
      "card-1",
    ]);
    expect(store.getSnapshot().databaseView?.query.rows[0]?.page.title).toBe(
      "Updated without manual reorder",
    );

    repair.resolve({
      ...propertySorted,
      commitSeq: 2,
      projection: {
        ...propertySorted.projection,
        revision: 2,
        coveredCommitSeq: 2,
        effectHash: "2".padStart(64, "a"),
      },
    });
    await waitForProjectionRepair();
    release();
  });

  test("local draft overlays do not bump card revision", async () => {
    const board = createBoard();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(board),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyLocalPatch("triage", "card-1", {
      title: "Updated title",
    });

    expect(store.getSnapshot().pageIndex.get("card-1")?.revision).toBe(1);
  });

  test("remote optimistic updates bump card revision", async () => {
    const board = createBoard();
    const deferred = createDeferred<{ ok: true }>();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(board)),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    const pendingMutation = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "Updated title" }),
      apply: buildPatchPageTransform(
        "triage",
        "card-1",
        { title: "Updated title" },
        { bumpRevision: true },
      ),
      runRemote: async () => deferred.promise,
    });

    expect(store.getSnapshot().pageIndex.get("card-1")?.revision).toBe(2);

    deferred.resolve({ ok: true });
    await pendingMutation;
  });

  test("keeps a generic Database View reorder projected through receipt refresh", async () => {
    const initial = createTwoPageBoardSnapshot();
    const canonical = createTwoPageBoardSnapshot(["card-2", "card-1"], 2);
    const remote = createDeferred<{
      readonly storeEpoch: string;
      readonly commitSeq: number;
    }>();
    const refreshed = createDeferred<DatabaseViewWindowSnapshot>();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return readCount === 1 ? initial : await refreshed.promise;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();
    const reorder = (model: NonNullable<ReturnType<typeof store.getSnapshot>["databaseView"]>) => {
      const rows = [...model.query.rows].sort((left, right) =>
        left.page.pageId === "card-2" ? -1 : right.page.pageId === "card-2" ? 1 : 0,
      );
      if (rows.every((row, index) => row === model.query.rows[index])) return model;
      return { ...model, query: { ...model.query, rows } };
    };

    const mutation = store.runOptimisticDatabaseViewMutation({
      kind: "database:position-many",
      conflictKeys: ["card:card-2:position"],
      apply: reorder,
      remoteLane: "database-view:placement",
      runRemote: async (canonicalModel) => {
        expect(canonicalModel.query.rows.map((row) => row.page.pageId)).toEqual([
          "card-1",
          "card-2",
        ]);
        return await remote.promise;
      },
      getCommitCursor: (receipt) => receipt,
    });
    const visibleOrder = () =>
      store.getSnapshot().databaseView?.query.rows.map((row) => row.page.pageId);
    expect(visibleOrder()).toEqual(["card-2", "card-1"]);

    remote.resolve({ storeEpoch: "epoch-1", commitSeq: 2 });
    await waitForMicrotasks();
    expect(readCount).toBe(2);
    expect(visibleOrder()).toEqual(["card-2", "card-1"]);

    refreshed.resolve(canonical);
    expect((await mutation).ok).toBe(true);
    expect(visibleOrder()).toEqual(["card-2", "card-1"]);
  });

  test("keeps published rules visible while personal state hands off to canonical authority", async () => {
    const initial = createTwoPageBoardSnapshot();
    const rules = { ...initial.query.view.config.rules, sorts: [] };
    const canonicalBase = createTwoPageBoardSnapshot(["card-1", "card-2"], 2);
    const canonical: DatabaseViewWindowSnapshot = {
      ...canonicalBase,
      query: {
        ...canonicalBase.query,
        view: {
          ...canonicalBase.query.view,
          config: { ...canonicalBase.query.view.config, rules },
        },
      },
      view: {
        ...canonicalBase.view,
        config: { ...canonicalBase.view.config, rules } as never,
      },
    };
    const remote = createDeferred<{
      readonly storeEpoch: string;
      readonly commitSeq: number;
    }>();
    const refreshed = createDeferred<DatabaseViewWindowSnapshot>();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return readCount === 1 ? initial : await refreshed.promise;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    store.setRulesOverride({ sorts: rules.sorts });
    await store.fetchBoard();

    const mutation = store.runOptimisticDatabaseViewMutation({
      kind: "database:view:rules:publish",
      conflictKeys: ["database-view:definition:rules"],
      apply: (model) => withPublishedDatabaseViewDefinition(model, { rules }),
      runRemote: async () => await remote.promise,
      getCommitCursor: (receipt) => receipt,
    });
    const visibleRules = () => store.getSnapshot().databaseView?.query.view.config.rules;
    expect(visibleRules()).toEqual(rules);

    // Core may publish the personal-preference clear before the canonical View
    // refresh arrives. The receipt-fenced definition patch owns this gap.
    store.setRulesOverride(null);
    expect(visibleRules()).toEqual(rules);

    remote.resolve({ storeEpoch: "epoch-1", commitSeq: 2 });
    await waitForMicrotasks();
    expect(readCount).toBe(2);
    expect(visibleRules()).toEqual(rules);

    refreshed.resolve(canonical);
    expect((await mutation).ok).toBe(true);
    expect(visibleRules()).toEqual(rules);
  });

  test("ignores no-op local overlays", async () => {
    const board = createBoard();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(board),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();
    const before = store.getSnapshot();

    const changed = store.applyLocalPatch("triage", "card-1", {
      title: "Initial title",
    });
    const after = store.getSnapshot();

    expect(changed).toBe(false);
    expect(after.board).toBe(before.board);
    expect(after.pageIndex).toBe(before.pageIndex);
  });

  test("LWW: out-of-order update acknowledgements keep latest local value", async () => {
    let serverBoard = createBoard();
    const deferredA = createDeferred<{ ok: true }>();
    const deferredB = createDeferred<{ ok: true }>();
    const deferredC = createDeferred<{ ok: true }>();

    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(serverBoard)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutationA = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "A" }),
      apply: buildPatchPageTransform("triage", "card-1", { title: "A" }),
      runRemote: async () => {
        const result = await deferredA.promise;
        serverBoard = buildPatchPageTransform("triage", "card-1", { title: "A" })(serverBoard);
        return result;
      },
    });
    const mutationB = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "B" }),
      apply: buildPatchPageTransform("triage", "card-1", { title: "B" }),
      runRemote: async () => {
        const result = await deferredB.promise;
        serverBoard = buildPatchPageTransform("triage", "card-1", { title: "B" })(serverBoard);
        return result;
      },
    });
    const mutationC = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "C" }),
      apply: buildPatchPageTransform("triage", "card-1", { title: "C" }),
      runRemote: async () => {
        const result = await deferredC.promise;
        serverBoard = buildPatchPageTransform("triage", "card-1", { title: "C" })(serverBoard);
        return result;
      },
    });

    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("C");

    deferredA.resolve({ ok: true });
    await mutationA;
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("C");

    deferredB.resolve({ ok: true });
    await mutationB;
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("C");

    deferredC.resolve({ ok: true });
    await mutationC;
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("C");
  });

  test("create -> edit -> move remains stable across acknowledgements", async () => {
    const createInput: PageCreateInput = {
      title: "Created",
      id: "018f0f85-6d56-7625-bdea-000000000000",
    };
    let serverBoard = createBoard();

    const createRemoteDeferred = createDeferred<{ id: string }>();
    const updateRemoteDeferred = createDeferred<{ ok: true }>();
    const moveRemoteDeferred = createDeferred<{ ok: true }>();

    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(serverBoard)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const optimisticCard = createOptimisticCard(createInput);

    const createMutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", optimisticCard.id),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => {
        const result = await createRemoteDeferred.promise;
        serverBoard = buildCreateCardTransform("triage", optimisticCard, "bottom")(serverBoard);
        return result;
      },
    });
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe(
      "Created",
    );

    const updateMutation = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("018f0f85-6d56-7625-bdea-000000000000", {
        title: "Created edited",
      }),
      apply: buildPatchPageTransform("triage", "018f0f85-6d56-7625-bdea-000000000000", {
        title: "Created edited",
      }),
      runRemote: async () => {
        const result = await updateRemoteDeferred.promise;
        serverBoard = buildPatchPageTransform("triage", "018f0f85-6d56-7625-bdea-000000000000", {
          title: "Created edited",
        })(serverBoard);
        return result;
      },
    });
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe(
      "Created edited",
    );

    const moveMutation = store.runOptimisticMutation({
      kind: "page:move",
      conflictKeys: conflictKeysForMove({
        pageId: "018f0f85-6d56-7625-bdea-000000000000",
        fromStatus: "triage",
        toStatus: "ship",
      }),
      apply: buildMovePageTransform({
        pageId: "018f0f85-6d56-7625-bdea-000000000000",
        fromStatus: "triage",
        toStatus: "ship",
      }),
      runRemote: async () => {
        const result = await moveRemoteDeferred.promise;
        serverBoard = buildMovePageTransform({
          pageId: "018f0f85-6d56-7625-bdea-000000000000",
          fromStatus: "triage",
          toStatus: "ship",
        })(serverBoard);
        return result;
      },
    });

    expect(
      store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId,
    ).toBe("ship");

    createRemoteDeferred.resolve({ id: "018f0f85-6d56-7625-bdea-000000000000" });
    await createMutation;
    expect(
      store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId,
    ).toBe("ship");
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe(
      "Created edited",
    );

    updateRemoteDeferred.resolve({ ok: true });
    await updateMutation;
    expect(
      store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId,
    ).toBe("ship");
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe(
      "Created edited",
    );

    moveRemoteDeferred.resolve({ ok: true });
    await moveMutation;
    expect(
      store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId,
    ).toBe("ship");
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe(
      "Created edited",
    );
  });

  test("converges a pending create when its canonical projection arrives first", async () => {
    const projection = createProjectionHarness();
    const remote = createDeferred<{ id: string }>();
    const pageId = "018f0f85-6d56-7625-bdea-000000000002";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Optimistic title",
    });
    const canonicalCard: DatabasePageSummary = {
      ...optimisticCard,
      title: "Canonical title",
      richTitle: plainTextToPortableRichText("Canonical title"),
      revision: 1,
      order: 1,
    };
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(),
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    const mutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => remote.promise,
      refreshOnSuccess: false,
    });
    expect(
      store
        .getSnapshot()
        .board?.columns.flatMap((column) => column.cards)
        .filter((card) => card.id === pageId),
    ).toHaveLength(1);

    projection.publish(pageUpserted(2, canonicalCard));
    await waitForMicrotasks();

    const pendingOccurrences =
      store
        .getSnapshot()
        .board?.columns.flatMap((column) => column.cards)
        .filter((card) => card.id === pageId) ?? [];
    expect(pendingOccurrences).toEqual([canonicalCard]);
    expect(store.getSnapshot().pendingMutationCount).toBe(1);

    store.applyLocalPatch("triage", pageId, {
      title: "Edited while create is pending",
    });
    const editedOccurrences =
      store
        .getSnapshot()
        .board?.columns.flatMap((column) => column.cards)
        .filter((card) => card.id === pageId) ?? [];
    expect(editedOccurrences).toHaveLength(1);
    expect(editedOccurrences[0]?.title).toBe("Edited while create is pending");

    remote.resolve({ id: pageId });
    await mutation;

    const settledOccurrences =
      store
        .getSnapshot()
        .board?.columns.flatMap((column) => column.cards)
        .filter((card) => card.id === pageId) ?? [];
    expect(settledOccurrences).toHaveLength(1);
    expect(settledOccurrences[0]?.title).toBe("Edited while create is pending");
    expect(store.getSnapshot().pendingMutationCount).toBe(0);
    unsubscribe();
  });

  test("keeps a top create in place while its receipt and projection repair interleave", async () => {
    const projection = createProjectionHarness();
    const remote = createDeferred<{
      cursor: { storeEpoch: string; commitSeq: number };
    }>();
    const canonicalRepair = createDeferred<DatabaseViewWindowSnapshot>();
    const initialBoard = createBoard();
    const pageId = "019fe620-0000-7000-8000-000000000000";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Optimistic title",
    });
    const canonicalCard: DatabasePageSummary = {
      ...optimisticCard,
      title: "Canonical title",
      richTitle: plainTextToPortableRichText("Canonical title"),
      revision: 1,
      order: 0,
    };
    const existingCard = initialBoard.columns[0]?.cards[0];
    if (!existingCard) throw new Error("Existing card fixture is missing");
    const canonicalBoard: BoardSummary = {
      ...initialBoard,
      columns: initialBoard.columns.map((column) =>
        column.id === "triage"
          ? {
              ...column,
              cards: [canonicalCard, { ...existingCard, order: 1 }],
            }
          : column,
      ),
    };
    const repairedSnapshot = {
      ...createBoardSnapshot(canonicalBoard, 2, "view-primary", true, 2),
      rows: [
        { page: canonicalCard, groupKey: "triage", subgroupKey: null, rankKey: "0" },
        {
          page: { ...existingCard, order: 1 },
          groupKey: "triage",
          subgroupKey: null,
          rankKey: "a",
        },
      ],
    } satisfies DatabaseViewWindowSnapshot;
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return createBoardSnapshot(initialBoard);
        return await canonicalRepair.promise;
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const visibleRuns: string[][] = [];
    const unsubscribe = store.subscribe(() => {
      const ids =
        store
          .getSnapshot()
          .board?.columns.find((column) => column.id === "triage")
          ?.cards.map((card) => card.id) ?? [];
      if (ids.includes(pageId)) visibleRuns.push(ids);
    });
    await waitForMicrotasks();

    const mutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "top"),
      runRemote: async () => await remote.promise,
      getCommitCursor: (result) => result.cursor,
    });
    projection.publish(pageUpserted(2, canonicalCard, "0"));
    await waitForMicrotasks();
    remote.resolve({ cursor: { storeEpoch: "epoch-1", commitSeq: 2 } });
    await waitForMicrotasks();
    canonicalRepair.resolve(repairedSnapshot);
    await mutation;

    expect(visibleRuns.length).toBeGreaterThan(0);
    expect(visibleRuns.every((ids) => ids[0] === pageId)).toBe(true);
    expect(store.getSnapshot().pageIndex.get(pageId)?.title).toBe("Canonical title");
    expect(store.getSnapshot().pendingMutationCount).toBe(0);
    unsubscribe();
  });

  test("retains a covered create while the Page remains outside the loaded window", async () => {
    const pageId = "019fe620-0000-7000-8000-000000000001";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Outside loaded window",
    });
    let canonicalBoard = createBoard();
    let commitSeq = 1;
    const registry = createTestRegistry({
      readViewWindow: async () =>
        createBoardSnapshot(cloneBoard(canonicalBoard), commitSeq, "view-primary", true, commitSeq),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => ({
        cursor: { storeEpoch: "epoch-1", commitSeq: 2 },
      }),
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (board) => boardContainsPageIds(board, [pageId]),
    });
    commitSeq = 2;
    await mutation;

    expect(store.getSnapshot().pageIndex.get(pageId)?.title).toBe("Outside loaded window");
    expect(store.getSnapshot().pendingMutationCount).toBe(0);

    const canonicalCard = { ...optimisticCard, order: 1, revision: 1 };
    canonicalBoard = buildCreateCardTransform(
      "triage",
      canonicalCard,
      "bottom",
    )(cloneBoard(canonicalBoard));
    await store.refreshBoardAtLeast(2);
    const renderToken = store.getSnapshot().materializationRenderToken;
    expect(renderToken).not.toBeNull();
    store.markRendered(renderToken ?? 0);
    store.applyRemoteCardSummary({ ...canonicalCard, archived: true });

    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(false);
  });

  test("does not treat a repair-bound projection patch as window materialization", async () => {
    const projection = createProjectionHarness();
    const repair = createDeferred<DatabaseViewWindowSnapshot>();
    const remote = createDeferred<{
      cursor: { storeEpoch: string; commitSeq: number };
    }>();
    const pageId = "019fe620-0000-7000-8000-000000000003";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Pinned beyond first window",
    });
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return createBoardSnapshot();
        return await repair.promise;
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    const mutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => await remote.promise,
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (board) => boardContainsPageIds(board, [pageId]),
    });
    remote.resolve({ cursor: { storeEpoch: "epoch-1", commitSeq: 2 } });
    await waitForMicrotasks();
    projection.publish(pageUpserted(2, { ...optimisticCard, revision: 1 }));
    await waitForMicrotasks();

    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(true);
    repair.resolve(createBoardSnapshot(createBoard(), 2, "view-primary", true, 2));
    await mutation;

    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(true);
    unsubscribe();
  });

  test("does not inject an exact tail upsert beyond a bounded loaded window", async () => {
    const projection = createProjectionHarness();
    const repair = createDeferred<DatabaseViewWindowSnapshot>();
    const initial = { ...createBoardSnapshot(), nextCursor: "cursor-1" };
    const tailCard = {
      ...createPageSummary("Remote tail create"),
      id: "019fe620-0000-7000-8000-000000000005",
      order: 1,
    };
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return initial;
        return await repair.promise;
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    projection.publish(pageUpserted(2, tailCard, "z"));
    await waitForMicrotasks();

    expect(store.getSnapshot().pageIndex.has(tailCard.id)).toBe(false);
    repair.resolve({
      ...createBoardSnapshot(createBoard(), 2, "view-primary", true, 2),
      nextCursor: "cursor-2",
    });
    await waitForMicrotasks();
    expect(store.getSnapshot().pageIndex.has(tailCard.id)).toBe(false);
    unsubscribe();
  });

  test("retains a covered move when the Page falls outside the loaded window", async () => {
    const initialBoard = createBoard();
    const moveInput = {
      pageId: "card-1",
      fromStatus: "triage" as const,
      toStatus: "ship" as const,
      newOrder: 0,
    };
    const fallbackCard = initialBoard.columns[0]?.cards[0];
    if (!fallbackCard) throw new Error("Move fallback fixture is missing");
    let canonicalBoard: BoardSummary = {
      columns: initialBoard.columns.map((column) => ({ ...column, cards: [] })),
    };
    let commitSeq = 1;
    const registry = createTestRegistry({
      readViewWindow: async () =>
        createBoardSnapshot(cloneBoard(canonicalBoard), commitSeq, "view-primary", true, commitSeq),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    canonicalBoard = cloneBoard(initialBoard);
    await store.fetchBoard();
    canonicalBoard = {
      columns: initialBoard.columns.map((column) => ({ ...column, cards: [] })),
    };

    const mutation = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: conflictKeysForMove(moveInput),
      apply: buildMovePageTransform(moveInput, [fallbackCard]),
      runRemote: async () => ({
        cursor: { storeEpoch: "epoch-1", commitSeq: 2 },
      }),
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (board) => boardContainsPageIds(board, [moveInput.pageId]),
    });
    commitSeq = 2;
    await mutation;

    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");

    canonicalBoard = buildMovePageTransform(moveInput)(cloneBoard(initialBoard));
    await store.refreshBoardAtLeast(2);
    const renderToken = store.getSnapshot().materializationRenderToken;
    expect(renderToken).not.toBeNull();
    store.markRendered(renderToken ?? 0);
    const canonicalCard = canonicalBoard.columns[1]?.cards[0];
    if (!canonicalCard) throw new Error("Canonical moved Page fixture is missing");
    store.applyRemoteCardSummary({ ...canonicalCard, archived: true });

    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(false);
  });

  test("fences old optimistic receipts when a canonical read opens a new Store epoch", async () => {
    const pageId = "019fe620-0000-7000-8000-000000000002";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Old epoch create",
    });
    let storeEpoch = "epoch-1";
    let canonicalBoard = createBoard("Epoch one");
    const registry = createTestRegistry({
      readViewWindow: async () => ({
        ...createBoardSnapshot(cloneBoard(canonicalBoard), 1),
        storeEpoch,
      }),
      readViewGroups: async () => createGroupsSnapshot({ storeEpoch }),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    await store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => ({
        cursor: { storeEpoch: "epoch-1", commitSeq: 2 },
      }),
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (board) => boardContainsPageIds(board, [pageId]),
      refreshOnSuccess: false,
    });
    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(true);

    storeEpoch = "epoch-2";
    canonicalBoard = createBoard("Epoch two");
    await store.refreshBoard();

    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(false);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Epoch two");
  });

  test("uses the receipt epoch to accept a lower-sequence replacement Store", async () => {
    const pageId = "019fe620-0000-7000-8000-000000000004";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Old Store Page",
    });
    let storeEpoch = "epoch:old";
    let commitSeq = 100;
    let canonicalBoard = createBoard("Old Store");
    const windowInputs: DatabaseViewWindowInput[] = [];
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, input) => {
        windowInputs.push(input);
        return {
          ...createBoardSnapshot(
            cloneBoard(canonicalBoard),
            commitSeq,
            "view-primary",
            true,
            commitSeq,
          ),
          storeEpoch,
        };
      },
      readViewGroups: async () =>
        createGroupsSnapshot({
          storeEpoch,
          commitSeq,
          projection: {
            scopeKey: "scope:view-primary",
            schemaVersion: 1,
            revision: commitSeq,
            coveredCommitSeq: commitSeq,
            effectHash: String(commitSeq).padStart(64, "a").slice(-64),
          },
        }),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const outcome = await store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => {
        storeEpoch = "epoch:new";
        commitSeq = 1;
        canonicalBoard = createBoard("New Store");
        return { cursor: { storeEpoch: "epoch:old", commitSeq: 101 } };
      },
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (board) => boardContainsPageIds(board, [pageId]),
    });

    expect(
      windowInputs.some(
        (input) =>
          input.minimumCommitCursor?.storeEpoch === "epoch:old" &&
          input.minimumCommitCursor.commitSeq === 101,
      ),
    ).toBe(true);
    expect(outcome.superseded).toBe(true);
    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(false);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("New Store");
  });

  test("fences an old receipt when the first canonical read opens another epoch", async () => {
    const pageId = "019fe620-0000-7000-8000-000000000005";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Unloaded old Store Page",
    });
    const replacement = {
      ...createBoardSnapshot(createBoard("Replacement Store"), 1),
      storeEpoch: "epoch:new",
    };
    const registry = createTestRegistry({
      readViewWindow: async () => replacement,
      readViewGroups: async () =>
        createGroupsSnapshot({
          storeEpoch: "epoch:new",
          commitSeq: 1,
        }),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");

    const outcome = await store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => ({
        cursor: { storeEpoch: "epoch:old", commitSeq: 101 },
      }),
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (board) => boardContainsPageIds(board, [pageId]),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.superseded).toBe(true);
    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(false);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Replacement Store");
  });

  test("keeps an acknowledged move visible until canonical base converges", async () => {
    const initialBoard = createBoard();
    const moveInput = {
      pageId: "card-1",
      fromStatus: "triage" as const,
      toStatus: "ship" as const,
      newOrder: 0,
    };
    const canonicalBoard = buildMovePageTransform(moveInput)(cloneBoard(initialBoard));
    const remote = createDeferred<{ ok: true }>();
    const canonicalRefresh = createDeferred<DatabaseViewWindowSnapshot>();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) {
          return createBoardSnapshot(cloneBoard(initialBoard));
        }
        return canonicalRefresh.promise;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const observedColumns: string[] = [];
    const recordColumn = () => {
      const columnId = store.getSnapshot().pageIndex.get("card-1")?.columnId;
      if (columnId) observedColumns.push(columnId);
    };
    const unsubscribe = store.subscribe(recordColumn);
    const mutation = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: conflictKeysForMove(moveInput),
      apply: buildMovePageTransform(moveInput),
      runRemote: async () => remote.promise,
    });
    recordColumn();

    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");
    remote.resolve({ ok: true });
    await waitForMicrotasks();

    expect(readCount).toBe(2);
    expect(store.getSnapshot().pendingMutationCount).toBe(0);
    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");

    store.applyRemoteCardSummary({
      ...createPageSummary("Unrelated canonical update"),
      id: "card-2",
      order: 1,
    });
    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");

    canonicalRefresh.resolve(createBoardSnapshot(canonicalBoard));
    await mutation;

    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");
    expect(new Set(observedColumns)).toEqual(new Set(["ship"]));
    const renderToken = store.getSnapshot().materializationRenderToken;
    expect(renderToken).not.toBeNull();
    store.markRendered((renderToken ?? 0) + 1);
    expect(store.getSnapshot().materializationRenderToken).toBe(renderToken);
    store.markRendered(renderToken ?? 0);
    expect(store.getSnapshot().materializationRenderToken).toBeNull();

    const movedCard = canonicalBoard.columns[1]?.cards[0];
    if (!movedCard) throw new Error("Canonical moved Page fixture is missing");
    store.applyRemoteCardSummary({
      ...movedCard,
      status: "triage",
      order: 0,
    });
    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("triage");
    unsubscribe();
  });

  test("serializes placement commands through the preceding receipt refresh", async () => {
    const firstRemote = createDeferred<{
      cursor: { storeEpoch: string; commitSeq: number };
    }>();
    const firstRefresh = createDeferred<DatabaseViewWindowSnapshot>();
    let readCount = 0;
    let secondRemoteStarted = false;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return createBoardSnapshot();
        return await firstRefresh.promise;
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const first = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: ["card:card-1:position"],
      apply: (board) => board,
      remoteLane: "database:position",
      runRemote: async () => await firstRemote.promise,
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: () => true,
    });
    const second = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: ["card:card-2:position"],
      apply: (board) => board,
      remoteLane: "database:position",
      runRemote: async () => {
        secondRemoteStarted = true;
        return { ok: true } as const;
      },
      refreshOnSuccess: false,
    });

    expect(secondRemoteStarted).toBe(false);
    firstRemote.resolve({
      cursor: { storeEpoch: "epoch-1", commitSeq: 2 },
    });
    await waitForMicrotasks();
    expect(readCount).toBe(2);
    expect(secondRemoteStarted).toBe(false);

    firstRefresh.resolve(createBoardSnapshot(createBoard(), 2, "view-primary", true, 2));
    await first;
    await second;

    expect(secondRemoteStarted).toBe(true);
  });

  test("does not execute a queued placement after Store authority is replaced", async () => {
    const firstRemote = createDeferred<{ ok: true }>();
    let storeEpoch = "epoch-1";
    let secondRemoteStarted = false;
    const registry = createTestRegistry({
      readViewWindow: async () => ({
        ...createBoardSnapshot(),
        storeEpoch,
      }),
      readViewGroups: async () => createGroupsSnapshot({ storeEpoch }),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const first = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: ["card:card-1:position"],
      apply: (board) => board,
      remoteLane: "database:position",
      runRemote: async () => await firstRemote.promise,
      refreshOnSuccess: false,
    });
    const second = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: ["card:card-2:position"],
      apply: (board) => board,
      remoteLane: "database:position",
      runRemote: async () => {
        secondRemoteStarted = true;
        return { ok: true } as const;
      },
      refreshOnSuccess: false,
    });

    storeEpoch = "epoch-2";
    await store.refreshBoard();
    firstRemote.resolve({ ok: true });

    const firstOutcome = await first;
    const secondOutcome = await second;
    expect(firstOutcome.superseded).toBe(true);
    expect(secondOutcome.ok).toBe(false);
    expect(secondOutcome.superseded).toBe(true);
    expect(secondRemoteStarted).toBe(false);
  });

  test("fails a placement lane closed when receipt refresh cannot converge", async () => {
    const firstRemote = createDeferred<{
      cursor: { storeEpoch: string; commitSeq: number };
    }>();
    let readCount = 0;
    let secondRemoteStarted = false;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 2) throw new Error("canonical refresh unavailable");
        return createBoardSnapshot();
      },
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const first = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: ["card:card-1:position"],
      apply: (board) => board,
      remoteLane: "database:position",
      runRemote: async () => await firstRemote.promise,
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: () => true,
    });
    const second = store.runOptimisticMutation({
      kind: "database:position",
      conflictKeys: ["card:card-2:position"],
      apply: (board) => board,
      remoteLane: "database:position",
      runRemote: async () => {
        secondRemoteStarted = true;
        return { ok: true } as const;
      },
      refreshOnSuccess: false,
    });

    firstRemote.resolve({
      cursor: { storeEpoch: "epoch-1", commitSeq: 2 },
    });
    const firstOutcome = await first;
    const secondOutcome = await second;

    expect(firstOutcome.ok).toBe(true);
    expect(secondOutcome.ok).toBe(false);
    expect(secondRemoteStarted).toBe(false);
    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(true);
  });

  test("collects a pending move after its canonical projection arrives first", async () => {
    const initialBoard = createBoard();
    const moveInput = {
      pageId: "card-1",
      fromStatus: "triage" as const,
      toStatus: "ship" as const,
      newOrder: 0,
    };
    const canonicalBoard = buildMovePageTransform(moveInput)(cloneBoard(initialBoard));
    const canonicalCard = canonicalBoard.columns[1]?.cards[0];
    if (!canonicalCard) throw new Error("Canonical moved Page fixture is missing");
    const remote = createDeferred<{ ok: true }>();
    const causalTrace = createRendererCausalTrace({ enabled: true, capacity: 16, now: () => 1 });
    const registry = createTestRegistry({
      causalTrace,
      readViewWindow: async () => createBoardSnapshot(cloneBoard(initialBoard)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutation = store.runOptimisticMutation({
      kind: "database:position",
      operationIdentity: "board-move-operation",
      conflictKeys: conflictKeysForMove(moveInput),
      apply: buildMovePageTransform(moveInput),
      runRemote: async () => remote.promise,
      refreshOnSuccess: false,
    });
    store.applyRemoteCardSummary(canonicalCard);

    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");
    expect(store.getSnapshot().pendingMutationCount).toBe(1);

    remote.resolve({ ok: true });
    await mutation;

    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("ship");
    expect(store.getSnapshot().pendingMutationCount).toBe(0);
    const renderToken = store.getSnapshot().materializationRenderToken;
    expect(renderToken).not.toBeNull();
    store.markRendered(renderToken ?? 0);
    expect(store.getSnapshot().materializationRenderToken).toBeNull();
    store.applyRemoteCardSummary({
      ...canonicalCard,
      status: "triage",
      order: 0,
    });
    expect(store.getSnapshot().pageIndex.get("card-1")?.columnId).toBe("triage");
    expect(causalTrace.snapshot().events.map(({ kind }) => kind)).toEqual([
      "local_intent",
      "submitted",
      "acknowledged",
      "materialized",
      "rendered",
      "settled",
    ]);
    expect(causalTrace.reduce()).toMatchObject({ legal: true });
  });

  test("fences rendered settlement across superseding A/B intents", async () => {
    const initialBoard = createBoard();
    const initialCard = initialBoard.columns[0]?.cards[0];
    if (!initialCard) throw new Error("Initial Page fixture is missing");
    const canonicalA = {
      ...initialCard,
      title: "A",
      richTitle: plainTextToPortableRichText("A"),
      revision: (initialCard.revision ?? 0) + 1,
    };
    const canonicalB = {
      ...canonicalA,
      title: "B",
      richTitle: plainTextToPortableRichText("B"),
      revision: canonicalA.revision + 1,
    };
    const remoteA = createDeferred<{ ok: true }>();
    const remoteB = createDeferred<{ ok: true }>();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(initialBoard)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutationA = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "A" }),
      apply: buildPatchPageTransform("triage", "card-1", { title: "A" }),
      runRemote: async () => await remoteA.promise,
      refreshOnSuccess: false,
    });
    store.applyRemoteCardSummary(canonicalA);
    remoteA.resolve({ ok: true });
    await mutationA;
    const tokenA = store.getSnapshot().materializationRenderToken;
    expect(tokenA).not.toBeNull();

    const mutationB = store.runOptimisticMutation({
      kind: "page:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "B" }),
      apply: buildPatchPageTransform("triage", "card-1", { title: "B" }),
      runRemote: async () => await remoteB.promise,
      refreshOnSuccess: false,
    });
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("B");
    expect(store.getSnapshot().materializationRenderToken).toBeNull();
    store.markRendered(tokenA ?? 0);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("B");

    store.applyRemoteCardSummary(canonicalB);
    remoteB.resolve({ ok: true });
    await mutationB;
    const tokenB = store.getSnapshot().materializationRenderToken;
    expect(tokenB).not.toBeNull();
    expect(tokenB).not.toBe(tokenA);
    store.markRendered(tokenA ?? 0);
    expect(store.getSnapshot().materializationRenderToken).toBe(tokenB);
    store.markRendered(tokenB ?? 0);
    expect(store.getSnapshot().materializationRenderToken).toBeNull();
  });

  test("requires a render for an acknowledged no-op and fences it on Store replacement", async () => {
    let storeEpoch = "epoch-1";
    let canonicalBoard = createBoard("Epoch one");
    const registry = createTestRegistry({
      readViewWindow: async () => ({
        ...createBoardSnapshot(cloneBoard(canonicalBoard)),
        storeEpoch,
      }),
      readViewGroups: async () => createGroupsSnapshot({ storeEpoch }),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    await store.runOptimisticMutation({
      kind: "database:no-op",
      conflictKeys: ["database:no-op"],
      apply: (board) => board,
      runRemote: async () => ({ ok: true }) as const,
      refreshOnSuccess: false,
    });
    const oldRenderToken = store.getSnapshot().materializationRenderToken;
    expect(oldRenderToken).not.toBeNull();

    storeEpoch = "epoch-2";
    canonicalBoard = createBoard("Epoch two");
    await store.refreshBoard();

    expect(store.getSnapshot().materializationRenderToken).toBeNull();
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Epoch two");
    store.markRendered(oldRenderToken ?? 0);
    expect(store.getSnapshot().materializationRenderToken).toBeNull();
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Epoch two");
  });

  test("failed delete rolls back automatically", async () => {
    const board = createBoard();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(board)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutation = store.runOptimisticMutation({
      kind: "page:delete",
      conflictKeys: conflictKeysForDelete("card-1"),
      apply: buildDeletePageTransform("triage", "card-1"),
      runRemote: async () => {
        throw new Error("delete failed");
      },
    });

    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(false);
    const result = await mutation;
    expect(result.ok).toBe(false);
    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(true);
  });

  test("patches local board events and uses the event cursor for ambiguous refreshes", async () => {
    const board = createBoard();
    const callbacks: { onBoardChange?: (event: BoardChangeEvent) => void } = {};
    let boardFetchCount = 0;

    const registry = createTestRegistry({
      readViewWindow: async (_projectId, input) => {
        boardFetchCount += 1;
        const revision = input.minimumCommitCursor?.commitSeq ?? input.minimumCommitSeq ?? 1;
        return createBoardSnapshot(board, revision, "view-primary", true, revision);
      },
      subscribeBoardChanges: (_projectId, callback) => {
        callbacks.onBoardChange = callback;
        return () => {};
      },
    });

    const store = registry.getStore("default");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    expect(boardFetchCount).toBe(1);

    const deleteEvent: BoardChangeEvent = {
      projectId: "default",
      changeType: "delete",
      columnId: "triage",
      status: "triage",
      pageId: "card-1",
      storeEpoch: "epoch-1",
      commitSeq: 2,
    };

    callbacks.onBoardChange?.(deleteEvent);
    await waitForMicrotasks();
    expect(boardFetchCount).toBe(1);
    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(false);

    const ambiguousEvent: BoardChangeEvent = {
      projectId: "default",
      changeType: "move",
      columnId: "triage",
      status: "triage",
      storeEpoch: "epoch-1",
      commitSeq: 3,
    };

    callbacks.onBoardChange?.(ambiguousEvent);
    await waitForMicrotasks();
    expect(boardFetchCount).toBe(2);

    callbacks.onBoardChange?.(ambiguousEvent);
    await waitForMicrotasks();
    expect(boardFetchCount).toBe(3);

    unsubscribe();
  });

  test("does not let a late older Board read overwrite a cursor-fenced patch", async () => {
    const board = createBoard();
    const lateRead = createDeferred<DatabaseViewWindowSnapshot>();
    const callbacks: { onBoardChange?: (event: BoardChangeEvent) => void } = {};
    const projection = createProjectionHarness();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return createBoardSnapshot(cloneBoard(board), 1);
        return await lateRead.promise;
      },
      subscribeBoardChanges: (_projectId, callback) => {
        callbacks.onBoardChange = callback;
        return () => {};
      },
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    const refresh = store.refreshBoard();
    await waitForMicrotasks();
    projection.publish(pageRemoved(2, "card-1"));
    lateRead.resolve(createBoardSnapshot(cloneBoard(board), 1));
    await refresh;
    await waitForMicrotasks();

    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(false);
    unsubscribe();
  });

  test("evicts a revoked Page immediately and fences a pre-revocation Board read", async () => {
    const staleRead = createDeferred<DatabaseViewWindowSnapshot>();
    const projection = createProjectionHarness();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        if (readCount === 1) return createBoardSnapshot(createBoard(), 1);
        if (readCount === 2) return await staleRead.promise;
        return createBoardSnapshot(
          {
            ...createBoard(),
            columns: createBoard().columns.map((column) => ({
              ...column,
              cards: column.cards.filter((card) => card.id !== "card-1"),
            })),
          },
          2,
          "view-primary",
          true,
          2,
        );
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();
    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(true);

    const refresh = store.refreshBoard();
    await waitForMicrotasks();
    projection.publish(pageRevoked(2, "card-1"));
    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(false);

    staleRead.resolve(createBoardSnapshot(createBoard(), 1));
    await refresh;
    await waitForMicrotasks();

    expect(readCount).toBe(3);
    expect(store.getSnapshot().pageIndex.has("card-1")).toBe(false);
    unsubscribe();
  });

  test("removes a revoked Page create overlay before it reaches canonical base", async () => {
    const projection = createProjectionHarness();
    const remote = createDeferred<{ ok: true }>();
    const pageId = "019fe620-0000-7000-8000-000000000099";
    const optimisticCard = createOptimisticCard({
      id: pageId,
      status: "triage",
      title: "Pending but revoked",
    });
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(),
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    const mutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", pageId),
      apply: buildCreateCardTransform("triage", optimisticCard, "top"),
      runRemote: async () => await remote.promise,
      refreshOnSuccess: false,
    });
    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(true);
    expect(store.getSnapshot().pendingMutationCount).toBe(1);

    projection.publish(pageRevoked(2, pageId));
    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(false);
    expect(store.getSnapshot().pendingMutationCount).toBe(0);

    remote.resolve({ ok: true });
    await mutation;
    expect(store.getSnapshot().pageIndex.has(pageId)).toBe(false);
    unsubscribe();
  });

  test("keeps an authorized Board warm across unsubscribe/resubscribe", async () => {
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return createBoardSnapshot();
      },
      subscribeBoardChanges: () => () => {},
    });

    const first = registry.getStore("default");
    const unsubscribe = first.subscribe(() => {});
    await waitForMicrotasks();
    expect(readCount).toBe(1);
    expect(first.getSnapshot().board).not.toBe(null);
    unsubscribe();

    const second = registry.getStore("default");
    expect(second).toBe(first);
    expect(second.getSnapshot().board).not.toBe(null);
    const unsubscribeAgain = second.subscribe(() => {});
    await waitForMicrotasks();
    expect(readCount).toBe(1);
    expect(second.getSnapshot().loading).toBe(false);
    unsubscribeAgain();
  });

  test("invalidates an inactive retained Board only after a matching effect", async () => {
    const projection = createProjectionHarness();
    let readCount = 0;
    const registry = createTestRegistry({
      readViewWindow: async () => {
        readCount += 1;
        return createBoardSnapshot(
          createBoard(readCount === 1 ? "Warm" : "Repaired"),
          readCount,
          "view-focused",
          false,
          readCount,
        );
      },
      subscribeBoardChanges: () => () => {},
      getProjectionInvalidationRegistry: projection.getRegistry,
    });
    const store = registry.getStore("project-1", "view-focused");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();
    unsubscribe();
    expect(store.getSnapshot().board).not.toBe(null);

    projection.publish(pageChanged(2, "card-1", "view-focused"));
    await waitForMicrotasks();

    expect(readCount).toBe(1);
    expect(store.getSnapshot().board).toBe(null);
    const unsubscribeAgain = store.subscribe(() => {});
    await waitForMicrotasks();
    expect(readCount).toBe(2);
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Repaired");
    unsubscribeAgain();
  });

  test("evicts the least-recent inactive Board after the retained capacity", async () => {
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, input) =>
        createBoardSnapshot(
          createBoard(input.databaseViewId ?? "primary"),
          1,
          input.databaseViewId ?? "view-primary",
        ),
      subscribeBoardChanges: () => () => {},
    });
    let firstStore: ReturnType<typeof registry.getStore> | null = null;
    let lastStore: ReturnType<typeof registry.getStore> | null = null;
    for (let index = 0; index < 33; index += 1) {
      const store = registry.getStore("project-1", `view-${index}`);
      firstStore ??= store;
      lastStore = store;
      const unsubscribe = store.subscribe(() => {});
      await waitForMicrotasks();
      unsubscribe();
    }

    expect(firstStore?.getSnapshot().board).toBe(null);
    expect(lastStore?.getSnapshot().board).not.toBe(null);
    expect(registry.getStore("project-1", "view-0")).not.toBe(firstStore);
  });

  test("fences an evicted inactive Board read before its late response arrives", async () => {
    const firstRead = createDeferred<DatabaseViewWindowSnapshot>();
    const registry = createTestRegistry({
      readViewWindow: async (_projectId, input) =>
        input.databaseViewId === "view-0"
          ? await firstRead.promise
          : createBoardSnapshot(
              createBoard(input.databaseViewId ?? "primary"),
              1,
              input.databaseViewId ?? "view-primary",
            ),
      subscribeBoardChanges: () => () => {},
    });
    const firstStore = registry.getStore("project-1", "view-0");
    const unsubscribeFirst = firstStore.subscribe(() => {});
    await waitForMicrotasks();
    unsubscribeFirst();

    for (let index = 1; index < 33; index += 1) {
      const store = registry.getStore("project-1", `view-${index}`);
      const unsubscribe = store.subscribe(() => {});
      await waitForMicrotasks();
      unsubscribe();
    }

    expect(firstStore.getSnapshot().board).toBe(null);
    firstRead.resolve(createBoardSnapshot(createBoard("Late"), 1, "view-0"));
    await waitForMicrotasks();
    expect(firstStore.getSnapshot().board).toBe(null);
    expect(registry.getStore("project-1", "view-0")).not.toBe(firstStore);
  });

  test("queues local overlay before first fetch and applies after board load", async () => {
    const deferredBoard = createDeferred<DatabaseViewWindowSnapshot>();
    const registry = createTestRegistry({
      readViewWindow: async () => deferredBoard.promise,
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    const queued = store.applyLocalPatch("triage", "card-1", { title: "Queued title" });
    expect(queued).toBe(true);
    expect(store.getSnapshot().board).toBe(null);

    deferredBoard.resolve(createBoardSnapshot());
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Queued title");
    unsubscribe();
  });

  test("auto-collects local overlay after server converges", async () => {
    let serverBoard = createBoard();
    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(serverBoard)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyLocalPatch("triage", "card-1", { title: "Local title" });
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Local title");

    serverBoard = buildPatchPageTransform("triage", "card-1", { title: "Local title" })(
      serverBoard,
    );
    await store.refreshBoard();
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Local title");

    // If local overlay was not collected, this server update would be masked.
    serverBoard = buildPatchPageTransform("triage", "card-1", { title: "Server next" })(
      serverBoard,
    );
    await store.refreshBoard();
    expect(store.getSnapshot().pageIndex.get("card-1")?.title).toBe("Server next");
  });

  test("does not auto-collect local overlay that depends on pending create", async () => {
    let serverBoard = createBoard();
    const createRemoteDeferred = createDeferred<{ id: string }>();
    const createInput: PageCreateInput = {
      title: "Created",
      id: "018f0f85-6d56-7625-bdea-000000000001",
    };
    const optimisticCard = createOptimisticCard(createInput);

    const registry = createTestRegistry({
      readViewWindow: async () => createBoardSnapshot(cloneBoard(serverBoard)),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const createMutation = store.runOptimisticMutation({
      kind: "page:create",
      conflictKeys: conflictKeysForCreate("triage", optimisticCard.id),
      apply: buildCreateCardTransform("triage", optimisticCard, "bottom"),
      runRemote: async () => {
        const result = await createRemoteDeferred.promise;
        serverBoard = buildCreateCardTransform("triage", optimisticCard, "bottom")(serverBoard);
        return result;
      },
    });

    store.applyLocalPatch("triage", "018f0f85-6d56-7625-bdea-000000000001", {
      title: "Edited while pending",
    });
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000001")?.title).toBe(
      "Edited while pending",
    );

    // Re-fetch while create is still pending: patch must not be dropped.
    await store.refreshBoard();
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000001")?.title).toBe(
      "Edited while pending",
    );

    createRemoteDeferred.resolve({ id: "018f0f85-6d56-7625-bdea-000000000001" });
    await createMutation;
    expect(store.getSnapshot().pageIndex.get("018f0f85-6d56-7625-bdea-000000000001")?.title).toBe(
      "Edited while pending",
    );
  });
});
