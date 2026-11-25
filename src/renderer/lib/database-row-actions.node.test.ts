import { beforeEach, describe, expect, test, vi, it } from "vite-plus/test";
import {
  databaseBoardColumnLayoutScope,
  getDatabaseBoardColumnLayout,
  normalizeDatabaseBoardColumnLayoutPrefs,
  readDatabaseBoardColumnLayoutPrefs,
  updateDatabaseBoardColumnLayoutPrefs,
} from "./database-board-column-layout";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DatabaseModuleReadSnapshotV2,
  DatabaseViewRecordV2,
  DataSourceDescriptorV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import {
  testPropertySemantics,
  testPropertyManagement,
} from "../../shared/testing/database-property-record";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  commitDatabasePageDrag,
  DatabasePageDragMutationError,
  type DatabasePageDragRuntimeDependencies,
} from "./database-page-drag-runtime";
import {
  type DatabasePageKeyRuntimeDependencies,
  DatabasePageKeyRuntimeError,
  previewDatabasePageKeyPrefix,
  readDatabasePageKeyNamespace,
  renameDatabasePageKeyPrefix,
} from "./database-page-key-runtime";
import type {
  BlockTransferPresentationPlanResult,
  BlockTransferReceipt,
} from "../../shared/block-transfer";
import type { HistoryCommandObservation } from "./surface-history/owner";
import type { DatabasePromotionReadEvidence } from "./database-promotion-read-evidence";
import { DatabasePromotionPresentationStore } from "./database-promotion-presentation";
import { localStructuralTransactionPresentation } from "./local-structural-transaction-presentation";
import { emptyDatabaseViewConfig } from "./database-view-authoring";
import {
  changeDatabaseViewLayoutOperation,
  databaseViewConfigWithoutProperty,
  deleteDataSourcePropertyOperations,
  duplicateDatabaseViewOperation,
  moveDataSourcePropertyOperation,
  moveDatabaseViewOperation,
  reorderDatabaseViewOperation,
} from "./database-settings-operations";

describe("database Board column layout", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  test("scopes arbitrary group paths by View and grouping Property", () => {
    const scope = databaseBoardColumnLayoutScope({
      viewId: "view-1",
      groupPropertyId: "priority",
    });
    const updated = updateDatabaseBoardColumnLayoutPrefs(scope, {}, 'key:"p1-high"', {
      collapsed: true,
      width: 360,
    });
    expect(getDatabaseBoardColumnLayout(updated, 'key:"p1-high"')).toEqual({
      collapsed: true,
      width: 360,
    });
    expect(readDatabaseBoardColumnLayoutPrefs(scope)).toEqual(updated);
    expect(
      readDatabaseBoardColumnLayoutPrefs(
        databaseBoardColumnLayoutScope({
          viewId: "view-1",
          groupPropertyId: "status",
        }),
      ),
    ).toEqual({});
  });

  test("normalizes malformed persisted paths without assuming workflow statuses", () => {
    expect(
      normalizeDatabaseBoardColumnLayoutPrefs({
        'key:"custom-option"': { collapsed: true, width: 9_999 },
        empty: null,
      }),
    ).toEqual({
      'key:"custom-option"': { collapsed: true, width: 416 },
    });
  });
});

describe("database page drag runtime", () => {
  const timestamp = "2026-07-16T00:00:00.000Z";

  const snapshot = (): DatabaseModuleReadSnapshotV2 => ({
    projectId: "project-1",
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 1,
    value: {
      kind: "query",
      value: {
        database: {
          databaseId: parseDatabaseId("database-1"),
          libraryId: "library-1",
          name: "Work",
          lifecycle: "active",
          defaultViewId: parseDatabaseViewId("view-1"),
          metadataRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        dataSource: {
          dataSourceId: parseDataSourceId("source-1"),
          libraryId: "library-1",
          homeDatabaseId: parseDatabaseId("database-1"),
          name: "Pages",
          schemaKey: "nodex.pages",
          schemaRevision: 1,
          lifecycle: "active",
          rankKey: "a",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        view: {
          viewId: parseDatabaseViewId("view-1"),
          databaseId: parseDatabaseId("database-1"),
          dataSourceId: parseDataSourceId("source-1"),
          name: "Board",
          layout: "board",
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
            group: { propertyId: "status" },
            display: { propertyIds: [], showTitle: true },
          }),
          isDefault: true,
          revision: 1,
          rankKey: "a",
          lifecycle: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        properties: [
          {
            propertyId: parseDataSourcePropertyId("status"),
            dataSourceId: parseDataSourceId("source-1"),
            name: "Status",
            ...testPropertySemantics("select"),
            valueType: "select",
            config: {},
            rankKey: "a",
            lifecycle: "active",
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        rows: [
          {
            pageKey: null,
            page: {
              pageId: "page-1",
              libraryId: "library-1",
              parent: { kind: "data_source", dataSourceId: parseDataSourceId("source-1") },
              lifecycle: "active",
              parentRevision: 1,
              metadataRevision: 1,
              documentId: "document:page-1",
              documentGeneration: 1,
              documentHeadSeq: 1,
              title: "Page",
              richTitle: [],
              preview: "",
              plainText: "",
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            membership: {
              membershipId: "membership-1",
              dataSourceId: parseDataSourceId("source-1"),
              revision: 1,
              createdAt: timestamp,
            },
            values: {
              status: {
                propertyId: parseDataSourcePropertyId("status"),
                valueType: "select",
                value: "triage",
                revision: 2,
              },
            },
            work: {
              unsatisfiedCount: 0,
              blockers: [],
              owner: null,
              assignee: null,
              autoStart: false,
            },
            taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
            position: { rankKey: "a", revision: 3 },
            effectiveGroupKey: "triage",
            effectiveSubgroupKey: null,
          },
        ],
      },
    },
  });

  const committed = (
    request: DatabaseApplyV2,
  ): Extract<DatabaseApplyResultV2, { readonly ok: true }> => ({
    ok: true,
    localCommit: noOpLocalCommit(request.storeEpoch),
    value: {
      operationId: request.operationId,
      projectId: request.projectId,
      libraryId: "library-1",
      storeEpoch: request.storeEpoch,
      duplicate: true,
      operationKinds: request.operations.map((operation) => operation.kind),
      operationOutcomes: [],
      affectedDatabaseIds: [parseDatabaseId("database-1")],
      affectedDataSourceIds: [parseDataSourceId("source-1")],
      affectedPageIds: ["page-1"],
      affectedViewIds: [parseDatabaseViewId("view-1")],
      committedRevisions: {},
      commitSeq: 2,
      committedAt: timestamp,
    },
  });

  describe("Database Page drag runtime", () => {
    test("retains the exact Page apply request across a lost response retry", async () => {
      const requests: DatabaseApplyV2[] = [];
      const dependencies: DatabasePageDragRuntimeDependencies = {
        apply: async (_projectId, request) => {
          requests.push(request);
          if (requests.length === 1) throw new Error("response lost");
          return committed(request);
        },
      };

      const receipt = await commitDatabasePageDrag({
        projectId: "project-1",
        operationId: "drag-1",
        snapshot: snapshot(),
        move: {
          pageId: "page-1",
          fromStatus: "triage",
          toStatus: "done",
        },
        dependencies,
      });
      expect(receipt).toEqual(committed(requests[1] as DatabaseApplyV2).value);
      expect(receipt.commitSeq).toBe(2);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
      expect(requests[0]?.actor).toEqual({ kind: "renderer_page_drag" });
      expect(requests[0]?.operations.map((operation) => operation.kind)).toEqual([
        "edit_property_values",
        "position_page",
      ]);
    });

    test("surfaces a typed revision conflict without issuing an unbounded refresh", async () => {
      let applies = 0;
      const dependencies: DatabasePageDragRuntimeDependencies = {
        apply: async () => {
          applies += 1;
          return {
            ok: false,
            error: {
              code: "revision_conflict",
              message: "Page changed",
              retryable: false,
            },
          };
        },
      };

      await expect(
        commitDatabasePageDrag({
          projectId: "project-1",
          operationId: "drag-stale",
          snapshot: snapshot(),
          move: {
            pageId: "page-1",
            fromStatus: "triage",
            toStatus: "done",
          },
          dependencies,
        }),
      ).rejects.toBeInstanceOf(DatabasePageDragMutationError);
      expect(applies).toBe(1);
    });
  });
});

describe("database page key runtime", () => {
  const dependencies = (
    applyProject?: DatabasePageKeyRuntimeDependencies["applyProject"],
  ): DatabasePageKeyRuntimeDependencies => ({
    readProject: async (projectId, request) => ({
      ok: true,
      value: {
        projectId,
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 7,
        value:
          request.read.mode === "page_key_namespace"
            ? {
                kind: "page_key_namespace",
                value: {
                  databaseId: parseDatabaseId("database:test"),
                  currentPrefix: "LAB",
                  nextNumber: 14,
                  assignedPageCount: 13,
                  revision: 3,
                  retiredPrefixes: [{ prefix: "OLD", lastNumber: 9 }],
                },
              }
            : {
                kind: "page_key_prefix_preview",
                value: {
                  prefix: "LAB",
                  availability: "current",
                  alternativePrefix: null,
                  nextNumber: 14,
                  exampleKeys: ["LAB-14", "LAB-15"],
                },
              },
      },
    }),
    readLibrary: async (request) => {
      if (request.read.mode !== "page_key_prefix_preview") {
        throw new Error("Expected a Page-key prefix preview");
      }
      return {
        ok: true,
        value: {
          routingContext: { kind: "library" },
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          commitSeq: 7,
          value: {
            kind: "page_key_prefix_preview",
            value: {
              prefix: request.read.requestedPrefix ?? "LAB",
              availability: "available",
              alternativePrefix: null,
              nextNumber: 1,
              exampleKeys: ["LAB-1", "LAB-2"],
            },
          },
        },
      };
    },
    applyProject:
      applyProject ??
      (async () => ({
        ok: false,
        error: {
          code: "revision_conflict",
          message: "Namespace changed",
          retryable: false,
        },
      })),
  });

  describe("Database Page-key runtime", () => {
    test("uses Library preview for create and Project-scoped Database reads for edit", async () => {
      const runtime = dependencies();
      const preview = await previewDatabasePageKeyPrefix(
        {
          nameHint: "Lab",
        },
        runtime,
      );
      const authority = await readDatabasePageKeyNamespace(
        {
          projectId: "project:test",
          databaseId: "database:test",
        },
        runtime,
      );

      expect(preview.exampleKeys).toEqual(["LAB-1", "LAB-2"]);
      expect(authority).toMatchObject({
        storeEpoch: "epoch:test",
        namespace: { currentPrefix: "LAB", revision: 3 },
      });
    });

    test("sends a Database CAS command and preserves typed failure", async () => {
      let requestKind: string | undefined;
      const runtime = dependencies(async (_projectId, request) => {
        requestKind = request.operations[0]?.kind;
        return {
          ok: false,
          error: {
            code: "revision_conflict",
            message: "Namespace changed",
            retryable: false,
          },
        };
      });

      await expect(
        renameDatabasePageKeyPrefix(
          {
            projectId: "project:test",
            databaseId: "database:test",
            storeEpoch: "epoch:test",
            expectedRevision: 3,
            prefix: "RND",
            operationId: "operation:test",
          },
          runtime,
        ),
      ).rejects.toMatchObject({
        name: "DatabasePageKeyRuntimeError",
        code: "revision_conflict",
      } satisfies Partial<DatabasePageKeyRuntimeError>);
      expect(requestKind).toBe("rename_page_key_prefix");
    });
  });
});

describe("database promotion presentation", () => {
  const receipt: BlockTransferReceipt = {
    operationId: "move",
    projectId: "project",
    storeEpoch: "epoch",
    mode: "move",
    duplicate: false,
    sourceRootBlockIds: ["source"],
    resultRootBlockIds: ["page"],
    copiedBlockIds: {},
    transformationEvidence: [],
    finalLocations: {},
    finalLocationRevisions: {},
    documentCommits: [],
    affectedDatabaseBlockIds: [],
    commitSeq: 20,
    committedAt: "2026-09-12T00:00:00Z",
    undoToken: null,
    history: null,
  };
  const read = (pageIds: readonly string[], commitSeq = 20): DatabasePromotionReadEvidence => ({
    identity: "identity",
    windowKey: "window",
    storeEpoch: "epoch",
    scopeKey: "scope",
    commitSeq,
    pageIds,
  });
  const fixture = () => {
    const owner = new DatabasePromotionPresentationStore("identity");
    const detach = owner.attach();
    const refresh = vi.fn();
    const accept = (operationId = "move") => {
      let listener: ((state: HistoryCommandObservation<BlockTransferReceipt>) => void) | undefined;
      owner.accept({
        operationId,
        storeEpoch: "epoch",
        rootBlockIds: ["source"],
        previews: [{ rootBlockId: "source", title: "Source" }],
        mode: "move",
        placement: {
          kind: "direct",
          viewId: "view",
          groupKey: "todo",
          preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
        },
        refresh,
        observe: (next) => {
          listener = next;
          next({ status: "preparing" });
          return () => {
            listener = undefined;
          };
        },
      });
      return (state: HistoryCommandObservation<BlockTransferReceipt>) => listener?.(state);
    };
    return { owner, detach, accept, refresh };
  };
  const ack = { status: "committed", receipt, entryId: 1 } as const;

  describe("Database promotion presentation", () => {
    test("shows final-looking prediction before planning and an older receipt cannot resurrect it", async () => {
      const owner = new DatabasePromotionPresentationStore("identity");
      const detach = owner.attach();
      let notify: ((state: HistoryCommandObservation<BlockTransferReceipt>) => void) | undefined;
      let resolvePlan:
        | ((value: {
            readonly ok: true;
            readonly value: {
              readonly operationId: string;
              readonly mode: "move";
              readonly roots: readonly [
                {
                  readonly sourceBlockId: string;
                  readonly resultPageId: string;
                  readonly transformationKind: "wrap";
                },
              ];
            };
          }) => void)
        | undefined;
      const plan = new Promise<BlockTransferPresentationPlanResult>((resolve) => {
        resolvePlan = resolve;
      });
      owner.accept({
        operationId: "promotion",
        storeEpoch: "epoch",
        rootBlockIds: ["source"],
        previews: [{ rootBlockId: "source", title: "Source" }],
        mode: "move",
        placement: {
          kind: "direct",
          viewId: "view",
          groupKey: "todo",
          preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
        },
        plan,
        refresh: vi.fn(),
        observe: (listener) => {
          notify = listener;
          listener({ status: "preparing" });
          return () => {
            notify = undefined;
          };
        },
      });

      const currentRevision = owner.getSnapshot();
      expect(owner.project(currentRevision - 1, null, new Set())).toEqual({
        model: { evidence: null, pageIds: new Set(), slots: [] },
        renderToken: null,
      });

      expect(owner.project(owner.getSnapshot(), null, new Set()).model.slots).toEqual([
        expect.objectContaining({
          kind: "predicted_promotion",
          operationId: "promotion",
          previews: [{ rootBlockId: "source", title: "Source" }],
        }),
      ]);

      resolvePlan?.({
        ok: true,
        value: {
          operationId: "promotion",
          mode: "move",
          roots: [
            {
              sourceBlockId: "source",
              resultPageId: "wrapped-page",
              transformationKind: "wrap",
            },
          ],
        },
      });
      await plan;
      await Promise.resolve();
      expect(owner.project(owner.getSnapshot(), null, new Set()).model.slots[0]?.previews).toEqual([
        { rootBlockId: "source", title: "Source", resultPageId: "wrapped-page" },
      ]);

      localStructuralTransactionPresentation.beginDatabasePageMove({
        operationId: "move-away",
        storeEpoch: "epoch",
        dataSourceId: "source",
        pageIds: ["wrapped-page"],
      });
      expect(owner.project(owner.getSnapshot(), null, new Set()).model.slots).toHaveLength(0);

      notify?.({
        status: "committed",
        entryId: 1,
        receipt: {
          ...receipt,
          operationId: "promotion",
          resultRootBlockIds: ["wrapped-page"],
        },
      });
      expect(owner.project(owner.getSnapshot(), null, new Set()).model.slots).toHaveLength(0);

      localStructuralTransactionPresentation.reject("move-away");
      localStructuralTransactionPresentation.reject("promotion");
      detach();
    });

    test("ACK hands off through the current bounded read and the current rendered token", async () => {
      const { owner, accept, refresh } = fixture();
      const notify = accept();
      notify(ack);
      expect(owner.project(owner.getSnapshot(), null, new Set(["page"])).renderToken).toBeNull();
      expect(owner.project(owner.getSnapshot(), read([], 19), new Set()).renderToken).toBeNull();
      expect(
        owner.project(owner.getSnapshot(), { ...read([]), identity: "other-panel" }, new Set())
          .renderToken,
      ).toBeNull();
      const changedWindow = { ...read(["page"]), windowKey: "other-window" };
      const gap = owner.project(owner.getSnapshot(), changedWindow, new Set(), new Set(["page"]));
      expect(gap.renderToken).toBeNull();
      expect(gap.model.slots).toHaveLength(1);
      const candidate = owner.project(
        owner.getSnapshot(),
        changedWindow,
        new Set(["page"]),
        new Set(["page"]),
      );
      expect(candidate.model.slots).toHaveLength(0);
      expect(owner.getActivity().acknowledged).toBe(1);
      owner.project(owner.getSnapshot(), null, new Set());
      owner.markRendered(candidate.renderToken!);
      expect(owner.getActivity().acknowledged).toBe(1);
      owner.markRendered(
        owner.project(owner.getSnapshot(), changedWindow, new Set(["page"]), new Set(["page"]))
          .renderToken!,
      );
      expect(owner.getActivity().acknowledged).toBe(0);
      await Promise.resolve();
      expect(refresh).toHaveBeenCalledExactlyOnceWith({ storeEpoch: "epoch", commitSeq: 20 });
    });

    test("a planned Page claim stays owned while the receipt confirms it", async () => {
      const owner = new DatabasePromotionPresentationStore("identity");
      const detach = owner.attach();
      let notify: ((state: HistoryCommandObservation<BlockTransferReceipt>) => void) | undefined;
      const plan = Promise.resolve<BlockTransferPresentationPlanResult>({
        ok: true,
        value: {
          operationId: "planned",
          mode: "move",
          roots: [
            {
              sourceBlockId: "source",
              resultPageId: "page",
              transformationKind: "wrap",
            },
          ],
        },
      });
      owner.accept({
        operationId: "planned",
        storeEpoch: "epoch",
        rootBlockIds: ["source"],
        previews: [{ rootBlockId: "source", title: "Source" }],
        mode: "move",
        placement: {
          kind: "direct",
          viewId: "view",
          groupKey: "todo",
          preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
        },
        plan,
        refresh: vi.fn(),
        observe: (listener) => {
          notify = listener;
          listener({ status: "preparing" });
          return () => {
            notify = undefined;
          };
        },
      });
      await plan;
      await Promise.resolve();
      expect(owner.project(owner.getSnapshot(), null, new Set()).model.slots).toHaveLength(1);

      notify?.({
        status: "committed",
        entryId: 1,
        receipt: { ...receipt, operationId: "planned" },
      });

      expect(owner.getActivity().acknowledged).toBe(1);
      expect(owner.project(owner.getSnapshot(), read([], 19), new Set()).model.slots).toHaveLength(
        1,
      );
      localStructuralTransactionPresentation.reject("planned");
      detach();
    });

    test("a reshaped bounded window can prove canonical absence without dropping prediction early", () => {
      const { owner, accept } = fixture();
      accept()(ack);
      const reshaped = { ...read([]), windowKey: "through:next-window" };

      const staleVisible = owner.project(
        owner.getSnapshot(),
        reshaped,
        new Set(["page"]),
        new Set(),
      );
      expect(staleVisible.renderToken).toBeNull();
      expect(staleVisible.model.pageIds.has("page")).toBe(true);
      expect(staleVisible.model.slots).toHaveLength(0);

      const candidate = owner.project(owner.getSnapshot(), reshaped, new Set(), new Set());
      expect(candidate.model.slots).toHaveLength(0);
      expect(candidate.renderToken).not.toBeNull();
      owner.markRendered(candidate.renderToken!);
      expect(owner.getActivity().acknowledged).toBe(0);
    });

    test("canonical-first recovery keeps one operation and never submits another command", () => {
      const { owner, accept } = fixture();
      const notify = accept();
      notify({ status: "recovering", reason: "Reply lost" });
      expect(
        owner.project(owner.getSnapshot(), read(["page"]), new Set(["page"])).renderToken,
      ).toBeNull();
      expect(owner.getActivity().unknown).toBe(1);
      notify(ack);
      const candidate = owner.project(owner.getSnapshot(), read(["page"]), new Set(["page"]));
      expect(candidate.model.slots).toHaveLength(0);
      expect(owner.getActivity().acknowledged).toBe(1);
      owner.markRendered(candidate.renderToken!);
      expect(owner.getActivity().acknowledged).toBe(0);
    });

    test("a visible overlay cannot use another model's membership proof", () => {
      const { owner, accept } = fixture();
      accept()(ack);
      const candidate = owner.project(
        owner.getSnapshot(),
        read(["page"]),
        new Set(),
        new Set(["page"]),
      );
      expect(candidate.renderToken).toBeNull();
      expect(candidate.model.slots).toHaveLength(1);
    });

    test("consecutive batches in one group do not supersede each other; detachment drops presentation only", () => {
      const { owner, accept, detach, refresh } = fixture();
      const first = accept("first");
      const second = accept("second");
      expect(
        owner
          .project(owner.getSnapshot(), null, new Set())
          .model.slots.map((slot) => slot.operationId),
      ).toEqual(["first", "second"]);
      first({ status: "rejected", reason: "Conflict" });
      expect(
        owner
          .project(owner.getSnapshot(), null, new Set())
          .model.slots.map((slot) => slot.operationId),
      ).toEqual(["second"]);
      detach();
      second(ack);
      expect(owner.project(owner.getSnapshot(), read([]), new Set()).model.slots).toHaveLength(0);
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});

describe("database settings operations", () => {
  const sourceId = parseDataSourceId("source");
  const databaseId = parseDatabaseId("database");
  const propertyId = parseDataSourcePropertyId("p_AAAAAAAA");

  const property: DataSourcePropertyRecordV2 = {
    propertyId,
    dataSourceId: sourceId,
    name: "Priority",
    schema: { kind: "select" },
    capabilities: {
      filterOperators: ["select_is", "select_is_not", "is_empty", "is_not_empty"],
      sortable: true,
      groupable: true,
    },
    ...testPropertyManagement(),
    valueType: "select",
    config: {},
    optionCount: 0,
    rankKey: "a",
    lifecycle: "active",
    revision: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const view = (id: string, rankKey: string): DatabaseViewRecordV2 => ({
    viewId: parseDatabaseViewId(id),
    databaseId,
    dataSourceId: sourceId,
    name: id,
    layout: "board",
    config: {
      ...emptyDatabaseViewConfig(),
      rules: {
        propertyFilters: [],
        advancedFilter: {
          kind: "group",
          operator: "and",
          children: [{ kind: "clause", propertyId, operator: "select_is", value: "high" }],
        },
        sorts: [{ field: { kind: "property", propertyId }, direction: "asc", nulls: "last" }],
      },
      presentation: {
        ...emptyDatabaseViewConfig().presentation,
        group: { propertyId },
        subgroup: { propertyId },
        display: {
          fields: [{ kind: "property", propertyId }],
          propertyOrder: [propertyId],
          showEmptyGroups: false,
        },
        conditionalColors: [
          {
            ruleId: "rule-1",
            propertyId,
            operator: "equals",
            value: "high",
            colorSource: "fixed",
            color: "red",
          },
        ],
      },
    },
    isDefault: id === "a",
    revision: 2,
    rankKey,
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  const source: DataSourceDescriptorV2 = {
    dataSource: {
      dataSourceId: sourceId,
      libraryId: "library",
      homeDatabaseId: databaseId,
      name: "Tasks",
      schemaKey: "tasks",
      schemaRevision: 8,
      lifecycle: "active",
      rankKey: "a",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    properties: [property],
  };

  describe("database settings operations", () => {
    it("uses explicit durable intents for View duplication and layout conversion", () => {
      const current = view("a", "a");
      const newViewId = parseDatabaseViewId("b");

      expect(duplicateDatabaseViewOperation({ view: current, viewId: newViewId })).toEqual({
        kind: "duplicate_view",
        databaseId,
        sourceViewId: current.viewId,
        expectedRevision: current.revision,
        newViewId,
      });
      expect(changeDatabaseViewLayoutOperation(current, "list")).toEqual({
        kind: "change_view_layout",
        databaseId,
        viewId: current.viewId,
        expectedRevision: current.revision,
        layout: "list",
      });
    });

    it("removes all supported references to a deleted Property", () => {
      const next = databaseViewConfigWithoutProperty(view("a", "a").config, propertyId);

      expect(next.rules.advancedFilter).toEqual({ kind: "group", operator: "and", children: [] });
      expect(next.rules.sorts).toEqual([]);
      expect(next.presentation.group).toBeNull();
      expect(next.presentation.subgroup).toBeNull();
      expect(next.presentation.display.fields).toEqual([]);
      expect(next.presentation.display.propertyOrder).toEqual([]);
      expect(next.presentation.conditionalColors).toEqual([]);
    });

    it("repairs every affected View before one soft delete", () => {
      const operations = deleteDataSourcePropertyOperations({
        source,
        views: [view("a", "a"), view("b", "b")],
        property,
      });

      expect(operations.map((operation) => operation.kind)).toEqual([
        "put_view",
        "put_view",
        "delete_property",
      ]);
    });

    it("reorders a real View identity without changing its layout", () => {
      const views = [view("a", "a"), view("b", "b"), view("c", "c")];
      const operation = moveDatabaseViewOperation(views, views[1]!, "down");

      expect(operation).toMatchObject({
        kind: "move_view",
        viewId: "b",
        placement: { kind: "end" },
      });
    });

    it("persists an arbitrary tab drop with one placement operation", () => {
      const views = [view("a", "a"), view("b", "b"), view("c", "c")];

      expect(reorderDatabaseViewOperation(views, "c", ["a", "c", "b"])).toMatchObject({
        kind: "move_view",
        viewId: "c",
        placement: { kind: "before", viewId: "b" },
      });
      expect(reorderDatabaseViewOperation(views, "a", ["b", "c", "a"])).toMatchObject({
        kind: "move_view",
        viewId: "a",
        placement: { kind: "end" },
      });
    });

    it("expresses move-to-end explicitly for Properties", () => {
      const second = { ...property, propertyId: parseDataSourcePropertyId("p_BBBBBBBB") };
      const operation = moveDataSourcePropertyOperation(
        { ...source, properties: [property, second] },
        property,
        "down",
      );

      expect(operation).toMatchObject({
        kind: "move_property",
        propertyId,
        placement: { kind: "end" },
      });
    });
  });
});
