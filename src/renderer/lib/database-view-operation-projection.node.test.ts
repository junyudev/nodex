import { describe, expect, test, vi } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
  parseDataSourceOptionId,
} from "../../shared/database-identities";
import type {
  DatabaseApplyOperationV2,
  DataSourcePageRowV2,
} from "../../shared/database-module-v2";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import { compileDatabaseViewOperationProjection as compile } from "./database-view-operation-projection";
import { DatabaseViewPresentationStore } from "./database-view-presentation";
import type { DatabaseViewMutationReceipt } from "./database-view-row-mutations";
import type { ProjectionRegistration } from "./projection-invalidation-registry";

const databaseId = parseDatabaseId("db");
const viewId = parseDatabaseViewId("view");
const dataSourceId = parseDataSourceId("source");
const propertyId = parseDataSourcePropertyId("p_SCORE001");
const timestamp = "2026-09-06T00:00:00Z";
const lifecycle = "active" as const;
const model = (): DatabaseViewRenderModel => ({
  accessContext: { kind: "library" },
  libraryId: "library",
  databaseId,
  databaseViewId: viewId,
  dataSourceId,
  databaseName: "Tasks",
  dataSourceName: "Tasks",
  viewName: "All",
  storeEpoch: "epoch",
  commitSeq: 4,
  authorization: null,
  readOnlyReason: null,
  columns: [],
  query: {
    database: {
      databaseId,
      libraryId: "library",
      name: "Tasks",
      lifecycle,
      defaultViewId: viewId,
      accessRevision: 1,
      metadataRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    dataSource: {
      dataSourceId,
      libraryId: "library",
      homeDatabaseId: databaseId,
      name: "Tasks",
      schemaKey: "nodex.pages",
      schemaRevision: 1,
      lifecycle,
      rankKey: "a",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    view: {
      viewId,
      databaseId,
      dataSourceId,
      name: "All",
      layout: "board",
      lifecycle,
      revision: 1,
      rankKey: "a",
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      config: upgradeDatabaseViewConfigV2({
        schemaKey: "nodex.database-view",
        schemaVersion: 2,
        filter: { kind: "group", operator: "and", children: [] },
        sort: [],
        group: null,
        display: { propertyIds: [propertyId], showTitle: true },
      }),
    },
    properties: [
      {
        propertyId,
        dataSourceId,
        name: "Score",
        ...testPropertySemantics("number"),
        valueType: "number",
        config: {},
        rankKey: "a",
        lifecycle,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    rows: ["a", "b", "c", "d"].map((pageId, index) => ({
      pageKey: null,
      membership: { membershipId: pageId, dataSourceId, revision: 1, createdAt: timestamp },
      page: {
        pageId,
        libraryId: "library",
        parent: { kind: "data_source", dataSourceId },
        lifecycle,
        parentRevision: 1,
        metadataRevision: 1,
        documentId: pageId,
        documentGeneration: 1,
        documentHeadSeq: 1,
        title: pageId,
        richTitle: plainTextToPortableRichText(pageId),
        preview: "",
        plainText: "",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      values: { [propertyId]: { propertyId, valueType: "number", value: index, revision: 1 } },
      taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
      position: { rankKey: String(index), revision: 1 },
      effectiveGroupKey: null,
      effectiveSubgroupKey: null,
    })),
  },
});
const valueEdit = (pageId = "a", value = 12): DatabaseApplyOperationV2 => ({
  kind: "edit_property_values",
  edits: [
    {
      pageId,
      dataSourceId,
      propertyId,
      edit: { kind: "replace", expectedValueRevision: 1, value: { kind: "number", value } },
    },
  ],
});
const move = (beforePageId?: string): DatabaseApplyOperationV2 => ({
  kind: "position_pages",
  viewId,
  pages: [
    { pageId: "c", expectedPositionRevision: 1 },
    { pageId: "a", expectedPositionRevision: 1 },
  ],
  ...(beforePageId ? { beforePageId } : {}),
});
const order = (value: DatabaseViewRenderModel) => value.query.rows.map((row) => row.page.pageId);
const withRow = (
  source: DatabaseViewRenderModel,
  pageId: string,
  update: (row: DataSourcePageRowV2) => DataSourcePageRowV2,
): DatabaseViewRenderModel => ({
  ...source,
  query: {
    ...source.query,
    rows: source.query.rows.map((row) => (row.page.pageId === pageId ? update(row) : row)),
  },
});

const receipt = (operationId: string, commitSeq = 5): DatabaseViewMutationReceipt => ({
  operationId,
  accessContext: { kind: "library" },
  libraryId: "library",
  storeEpoch: "epoch",
  duplicate: false,
  operationKinds: ["edit_property_values"],
  operationOutcomes: [],
  affectedDatabaseIds: [databaseId],
  affectedDataSourceIds: [dataSourceId],
  affectedPageIds: ["a"],
  affectedViewIds: [viewId],
  committedRevisions: {},
  commitSeq,
  committedAt: timestamp,
});

describe("Database View presentation owner", () => {
  test("retains pending Page revocation dependencies after they leave the canonical window", async () => {
    const canonical = {
      ...model(),
      authorization: {} as NonNullable<DatabaseViewRenderModel["authorization"]>,
    };
    const registrations: ProjectionRegistration[] = [];
    const owner = new DatabaseViewPresentationStore(canonical, () => ({
      register: (registration) => {
        registrations.push(registration);
        return () => undefined;
      },
    }));
    const detach = owner.attach();
    await expect(
      owner.submit(
        { model: canonical, operations: [valueEdit()], operationId: "uncertain-page" },
        async () => {
          throw new Error("Disconnected");
        },
      ),
    ).rejects.toThrow("Disconnected");
    owner.update({ ...canonical, query: { ...canonical.query, rows: [] } });
    expect(registrations[0]!.getDependencies().pageIds).toContain("a");
    owner.discard("uncertain-page");
    expect(registrations[0]!.getDependencies().pageIds).toEqual([]);
    detach();
  });

  test("retains independent Property previews on the same Page", async () => {
    const original = model();
    const secondPropertyId = parseDataSourcePropertyId("p_SCORE002");
    const canonical = {
      ...original,
      query: {
        ...original.query,
        properties: [
          ...original.query.properties,
          { ...original.query.properties[0]!, propertyId: secondPropertyId },
        ],
      },
    };
    const owner = new DatabaseViewPresentationStore(canonical);
    const detach = owner.attach();
    const first = valueEdit();
    const second: DatabaseApplyOperationV2 = {
      kind: "edit_property_values",
      edits: [
        {
          pageId: "a",
          dataSourceId,
          propertyId: secondPropertyId,
          edit: { kind: "replace", expectedValueRevision: 0, value: { kind: "number", value: 50 } },
        },
      ],
    };
    await owner.submit({ model: canonical, operations: [first], operationId: "score" }, async () =>
      receipt("score"),
    );
    await owner.submit(
      { model: canonical, operations: [second], operationId: "other-score" },
      async () => receipt("other-score", 6),
    );
    const projected = owner.project(canonical).model.query.rows[0]!;
    expect(projected.values[propertyId]!.value).toBe(12);
    expect(projected.values[secondPropertyId]!.value).toBe(50);
    expect(owner.getActivity().acknowledged).toBe(2);
    detach();
  });

  test("returns durable acknowledgement before repair, retaining intent through exact rendered handoff", async () => {
    const canonical = model();
    const owner = new DatabaseViewPresentationStore(canonical);
    const detach = owner.attach();
    let finishRepair!: () => void;
    owner.update(
      canonical,
      () =>
        new Promise<void>((resolve) => {
          finishRepair = resolve;
        }),
    );
    const operations = [valueEdit()];
    await expect(
      owner.submit({ model: canonical, operations, operationId: "first" }, async () =>
        receipt("first"),
      ),
    ).resolves.toMatchObject({ commitSeq: 5 });
    expect(owner.project(canonical).model.query.rows[0]?.values[propertyId]?.value).toBe(12);
    expect(owner.getActivity()).toEqual({ pending: 0, unknown: 0, acknowledged: 1 });
    const unrelated = { ...canonical, commitSeq: 5 };
    expect(owner.project(unrelated).renderToken).toBeNull();
    const materialized = { ...compile(canonical, operations).apply(canonical), commitSeq: 5 };
    owner.update(materialized);
    const token = owner.project(materialized).renderToken;
    expect(token).not.toBeNull();
    expect(owner.getActivity().acknowledged).toBe(1);
    owner.markRendered(token!);
    expect(owner.getActivity().acknowledged).toBe(0);
    finishRepair();
    detach();
  });

  test("keeps unknown intent and its original semantic proof during exact-identity retry", async () => {
    const canonical = model();
    const owner = new DatabaseViewPresentationStore(canonical);
    const detach = owner.attach();
    const request = { model: canonical, operations: [valueEdit()], operationId: "uncertain" };
    await expect(
      owner.submit(request, async () => {
        throw new Error("Connection interrupted");
      }),
    ).rejects.toThrow("Connection interrupted");
    expect(owner.getActivity().unknown).toBe(1);
    expect(owner.project(canonical).model.query.rows[0]?.values[propertyId]?.value).toBe(12);
    const matching = { ...compile(canonical, request.operations).apply(canonical), commitSeq: 5 };
    owner.update(matching);
    await owner.submit(
      request,
      async () => receipt("uncertain"),
      compile(canonical, [valueEdit("a", 99)]),
    );
    const projected = owner.project(matching);
    expect(projected.model.query.rows[0]?.values[propertyId]?.value).toBe(12);
    expect(projected.renderToken).not.toBeNull();
    owner.markRendered(projected.renderToken!);
    expect(owner.getActivity().unknown).toBe(0);
    detach();
  });

  test("pending-only edits require a new canonical read, not an unrelated high cursor", async () => {
    const canonical = { ...model(), commitSeq: 9 };
    const owner = new DatabaseViewPresentationStore(canonical);
    const detach = owner.attach();
    owner.update(canonical, undefined, canonical, 3);
    await owner.submit(
      { model: canonical, operations: [move()], operationId: "pending" },
      async () => receipt("pending", 8),
    );
    expect(owner.project(canonical).renderToken).toBeNull();
    owner.update(canonical, undefined, canonical, 4);
    expect(owner.project(canonical).renderToken).not.toBeNull();
    detach();
  });

  test("detachment retires presentation only and a retained history Adapter can still submit", async () => {
    const canonical = model();
    const owner = new DatabaseViewPresentationStore(canonical);
    const detach = owner.attach();
    const request = { model: canonical, operations: [valueEdit()], operationId: "detached" };
    await expect(
      owner.submit(request, async () => {
        throw new Error("Offline");
      }),
    ).rejects.toThrow("Offline");
    detach();
    expect(owner.getActivity()).toEqual({ pending: 0, unknown: 0, acknowledged: 0 });
    const transport = vi.fn(async () => receipt("detached"));
    await owner.submit(request, transport);
    expect(transport).toHaveBeenCalledWith(request);
    expect(owner.hasWork()).toBe(false);
  });
});

describe("bounded Database operation projection", () => {
  test("retires superseded addresses individually, using receipt revisions and opaque membership identity", () => {
    const canonical = withRow(model(), "a", (row) => ({
      ...row,
      membership: { ...row.membership, membershipId: "opaque-membership" },
    }));
    const plan = compile(canonical, [valueEdit("a"), valueEdit("b", 20)]);
    const later = withRow({ ...canonical, commitSeq: 90 }, "a", (row) => ({
      ...row,
      values: {
        ...row.values,
        [propertyId]: { propertyId, valueType: "number", value: 13, revision: 3 },
      },
    }));
    expect(plan.apply(later).query.rows[0]!.values[propertyId]!.value).toBe(12);
    plan.acknowledge!({
      committedRevisions: {
        [`value:${dataSourceId}:opaque-membership:${propertyId}`]: 2,
        [`value:${dataSourceId}:b:${propertyId}`]: 2,
      },
    });
    const partiallyApplied = plan.apply(later);
    expect(partiallyApplied.query.rows[0]!.values[propertyId]!.value).toBe(13);
    expect(partiallyApplied.query.rows[1]!.values[propertyId]!.value).toBe(20);
    expect(partiallyApplied).not.toBe(later);
    const settled = withRow(later, "b", (row) => ({
      ...row,
      values: {
        ...row.values,
        [propertyId]: { propertyId, valueType: "number", value: 20, revision: 2 },
      },
    }));
    expect(plan.apply(settled)).toBe(settled);
  });

  test("does not mistake a replacement membership or retyped property for materialization", () => {
    const canonical = model();
    const plan = compile(canonical, [valueEdit()]);
    const replaced = withRow(canonical, "a", (row) => ({
      ...row,
      membership: { ...row.membership, membershipId: "replacement" },
      values: {
        ...row.values,
        [propertyId]: { propertyId, valueType: "number", value: 12, revision: 20 },
      },
    }));
    plan.acknowledge!({ committedRevisions: { [`value:${dataSourceId}:a:${propertyId}`]: 2 } });
    expect(plan.apply(replaced)).not.toBe(replaced);
    expect(plan.apply(replaced).query).toBe(replaced.query);
    const retyped = {
      ...canonical,
      query: {
        ...canonical.query,
        properties: canonical.query.properties.map((property) => ({
          ...property,
          valueType: "text" as const,
        })),
      },
    };
    expect(plan.apply(retyped)).not.toBe(retyped);
    expect(plan.apply(retyped).query).toBe(retyped.query);
  });

  test("keeps newer positions while retaining the unsatisfied part of a move batch", () => {
    const canonical = model();
    const plan = compile(canonical, [move("d")]);
    plan.acknowledge!({
      committedRevisions: { [`position:${viewId}:c`]: 2, [`position:${viewId}:a`]: 2 },
    });
    const later = withRow(canonical, "c", (row) => ({
      ...row,
      position: { ...row.position!, revision: 3 },
    }));
    expect(order(plan.apply(later))).toEqual(["b", "c", "a", "d"]);
    const settled = withRow(later, "a", (row) => ({
      ...row,
      position: { ...row.position!, revision: 3 },
    }));
    expect(plan.apply(settled)).toBe(settled);
  });

  test("accepts exact committed rank revisions when another row changes the neighborhood", () => {
    const canonical = model();
    const plan = compile(canonical, [move("d")]);
    plan.acknowledge!({
      committedRevisions: { [`position:${viewId}:c`]: 2, [`position:${viewId}:a`]: 2 },
    });
    const materialized = withRow(
      withRow(canonical, "c", (row) => ({ ...row, position: { rankKey: "new-c", revision: 2 } })),
      "a",
      (row) => ({ ...row, position: { rankKey: "new-a", revision: 2 } }),
    );
    // Core applied c/a before d, then another writer put d first. Neither
    // moved row's rank changed again, so old adjacency must not be replayed.
    const later = {
      ...materialized,
      query: {
        ...materialized.query,
        rows: [
          materialized.query.rows[3]!,
          materialized.query.rows[1]!,
          materialized.query.rows[2]!,
          materialized.query.rows[0]!,
        ],
      },
    };
    expect(plan.apply(later)).toBe(later);
  });

  test("projects scalar edits without changing canonical revisions and recognizes exact materialization", () => {
    const canonical = model();
    const plan = compile(canonical, [valueEdit()]);
    expect(plan.predictable).toBe(true);
    const projected = plan.apply(canonical);
    expect(projected.query.rows[0]?.values[propertyId]).toMatchObject({ value: 12, revision: 1 });
    expect(canonical.query.rows[0]?.values[propertyId]?.value).toBe(0);
    expect(projected.query.rows[1]).toBe(canonical.query.rows[1]);
    expect(plan.apply(projected)).toBe(projected);
  });

  test("replays an ordered run before its visible anchor and preserves unrelated rows", () => {
    const canonical = model();
    const plan = compile(canonical, [move("b")]);
    expect(plan.predictable).toBe(true);
    const projected = plan.apply(canonical);
    expect(order(projected)).toEqual(["c", "a", "b", "d"]);
    expect(plan.apply(projected)).toBe(projected);
    expect(plan.conflictKeys).toContain(`view-order:${viewId}`);
  });

  test("uses authoritative before-values and before-runs for reverse edits", () => {
    const canonical = model();
    const plan = compile(canonical, [
      {
        kind: "reverse_data_edit",
        recipe: {
          propertyStates: [
            {
              address: { pageId: "c", dataSourceId, propertyId },
              propertyType: "number",
              beforeValue: { kind: "number", value: 19 },
              afterValue: { kind: "number", value: 2 },
            },
          ],
          positionStates: [
            {
              viewId,
              dataSourceId,
              direction: "asc",
              beforeRuns: [{ pageIds: ["c"], beforePageId: "a" }],
              afterRuns: [{ pageIds: ["c"], beforePageId: "d" }],
            },
          ],
        },
      },
    ]);
    expect(plan.predictable).toBe(true);
    const projected = plan.apply(canonical);
    expect(order(projected)).toEqual(["c", "a", "b", "d"]);
    expect(projected.query.rows[0]?.values[propertyId]?.value).toBe(19);
    expect(plan.apply(projected)).toBe(projected);
  });

  test("does not mistake missing rows, anchors, changed configuration, or epoch for materialization", () => {
    const canonical = model();
    const plan = compile(canonical, [move("b")]);
    const missing = {
      ...canonical,
      query: {
        ...canonical.query,
        rows: canonical.query.rows.filter((row) => row.page.pageId !== "b"),
      },
    };
    expect(plan.apply(missing)).not.toBe(missing);
    const otherEpoch = { ...canonical, storeEpoch: "other" };
    expect(plan.apply(otherEpoch)).not.toBe(otherEpoch);
    const reconfigured = model();
    const changed = {
      ...reconfigured,
      query: {
        ...reconfigured.query,
        view: {
          ...reconfigured.query.view,
          config: {
            ...reconfigured.query.view.config,
            presentation: { ...reconfigured.query.view.config.presentation, group: { propertyId } },
          },
        },
      },
    };
    expect(plan.apply(changed)).not.toBe(changed);
  });

  test("falls back atomically when a row, anchor, or tail completeness is unavailable", () => {
    const canonical = model();
    for (const operations of [
      [valueEdit("missing")],
      [move("missing")],
      [move()],
      [valueEdit(), move()],
    ]) {
      const plan = compile(canonical, operations);
      expect(plan.predictable).toBe(false);
      expect(plan.apply(canonical)).toBe(canonical);
    }
  });

  test("recognizes the final post-image of repeated replacements, including a whole-batch no-op", () => {
    const canonical = model();
    const noOp = compile(canonical, [valueEdit("a", 12), valueEdit("a", 0)]);
    expect(noOp.predictable).toBe(true);
    expect(noOp.apply(canonical)).toBe(canonical);
    const changed = compile(canonical, [valueEdit("a", 12), valueEdit("a", 19)]);
    const projected = changed.apply(canonical);
    expect(projected.query.rows[0]?.values[propertyId]?.value).toBe(19);
    expect(changed.apply(projected)).toBe(projected);
  });

  test("matches Core's set normalization when a replacement repeats multi-select options", () => {
    const canonical = model();
    const first = parseDataSourceOptionId({ propertyId, value: "o_FIRST001" });
    const second = parseDataSourceOptionId({ propertyId, value: "o_SECOND01" });
    const source: DatabaseViewRenderModel = {
      ...canonical,
      query: {
        ...canonical.query,
        properties: canonical.query.properties.map((property) => ({
          ...property,
          ...testPropertySemantics("multi_select"),
          valueType: "multi_select",
          config: {
            options: [
              { id: first, name: "First" },
              { id: second, name: "Second" },
            ],
          },
        })),
        rows: canonical.query.rows.map((row) => ({ ...row, values: {} })),
      },
    };
    const plan = compile(source, [
      {
        kind: "edit_property_values",
        edits: [
          {
            pageId: "a",
            dataSourceId,
            propertyId,
            edit: {
              kind: "replace",
              expectedValueRevision: 0,
              value: { kind: "multi_select", optionIds: [second, first, second] },
            },
          },
        ],
      },
    ]);
    expect(plan.predictable).toBe(true);
    const projected = plan.apply(source);
    expect(projected.query.rows[0]?.values[propertyId]?.value).toEqual([first, second]);
    expect(plan.apply(projected)).toBe(projected);
  });

  test.each(["asc", "desc"] as const)(
    "restores disjoint runs in %s display order without reconstructing ranks",
    (direction) => {
      const canonical = model();
      const source: DatabaseViewRenderModel = {
        ...canonical,
        query: {
          ...canonical.query,
          view: {
            ...canonical.query.view,
            config: {
              ...canonical.query.view.config,
              rules: {
                ...canonical.query.view.config.rules,
                sorts: [{ field: { kind: "manual" }, direction, nulls: "last" }],
              },
            },
          },
        },
      };
      const plan = compile(source, [
        {
          kind: "reverse_data_edit",
          recipe: {
            propertyStates: [],
            positionStates: [
              {
                viewId,
                dataSourceId,
                direction,
                beforeRuns: [
                  { pageIds: ["c"], beforePageId: "a" },
                  { pageIds: ["d"], beforePageId: "b" },
                ],
                afterRuns: [{ pageIds: ["c", "d"], beforePageId: null }],
              },
            ],
          },
        },
      ]);
      expect(plan.predictable).toBe(true);
      const projected = plan.apply(source);
      expect(order(projected)).toEqual(["c", "a", "d", "b"]);
      expect(plan.apply(projected)).toBe(projected);
      expect(projected.query.rows[0]?.position).toBe(source.query.rows[2]?.position);
    },
  );

  test("never proves a Library edit from the same View read through a different access context", () => {
    const canonical = model();
    const plan = compile(canonical, [valueEdit("a", 0)]);
    expect(plan.apply(canonical)).toBe(canonical);
    const projectRead: DatabaseViewRenderModel = {
      ...canonical,
      accessContext: { kind: "project", projectId: "other" },
    };
    expect(plan.apply(projectRead)).not.toBe(projectRead);
  });

  test("leaves query-changing property edits and nonmanual positions pending", () => {
    const canonical = model();
    const sorted = {
      ...canonical,
      query: {
        ...canonical.query,
        view: {
          ...canonical.query.view,
          config: {
            ...canonical.query.view.config,
            rules: {
              ...canonical.query.view.config.rules,
              sorts: [
                {
                  field: { kind: "property" as const, propertyId },
                  direction: "asc" as const,
                  nulls: "last" as const,
                },
              ],
            },
          },
        },
      },
    };
    expect(compile(sorted, [valueEdit()]).predictable).toBe(false);
    expect(compile(sorted, [move("b")]).predictable).toBe(false);
    const grouped = {
      ...canonical,
      query: {
        ...canonical.query,
        view: {
          ...canonical.query.view,
          config: {
            ...canonical.query.view.config,
            presentation: { ...canonical.query.view.config.presentation, group: { propertyId } },
          },
        },
      },
    };
    expect(compile(grouped, [valueEdit()]).predictable).toBe(false);
  });
});
