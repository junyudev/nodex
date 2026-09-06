import { describe, expect, test } from "vite-plus/test";
import {
  withEffectiveDatabaseView,
  type DatabaseViewRenderModel,
} from "./database-view-render-model";
import {
  applyOptimisticDatabaseViewBoardDrop,
  compileDatabaseViewBoardDropProjection,
  buildDatabaseViewBoardDropOperations,
  databaseViewSupportsSortedSlotInference,
  resolveDatabaseViewDropPropertyValues,
  resolveDatabaseViewSortedDropValues,
} from "./database-view-drag-operations";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import { testPropertySemantics } from "../../shared/testing/database-property-record";

const timestamp = "2026-08-11T00:00:00.000Z";
const databaseId = parseDatabaseId("database-1");
const dataSourceId = parseDataSourceId("source-1");
const viewId = parseDatabaseViewId("view-1");
const statusId = parseDataSourcePropertyId("p_STATUS01");
const priorityId = parseDataSourcePropertyId("p_PRIOR001");
const unavailablePropertyId = parseDataSourcePropertyId("p_MISSING1");

const row = (pageId: string, status: string, priority: string, rankKey: string) => ({
  pageKey: null,
  membership: {
    membershipId: `membership-${pageId}`,
    dataSourceId,
    revision: 1,
    createdAt: timestamp,
  },
  page: {
    pageId,
    libraryId: "library-1",
    parent: { kind: "data_source" as const, dataSourceId },
    lifecycle: "active" as const,
    parentRevision: 1,
    metadataRevision: 1,
    documentId: `document-${pageId}`,
    documentGeneration: 1,
    documentHeadSeq: 1,
    title: pageId,
    richTitle: plainTextToPortableRichText(pageId),
    preview: "",
    plainText: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  values: {
    [statusId]: { propertyId: statusId, valueType: "select" as const, value: status, revision: 2 },
    [priorityId]: {
      propertyId: priorityId,
      valueType: "select" as const,
      value: priority,
      revision: 3,
    },
  },
  taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
  position: { rankKey, revision: 4 },
  effectiveGroupKey: status,
  effectiveSubgroupKey: priority,
});

const model: DatabaseViewRenderModel = {
  accessContext: { kind: "project", projectId: "project-1" },
  libraryId: "library-1",
  databaseViewId: viewId,
  databaseId,
  dataSourceId,
  databaseName: "Tasks",
  dataSourceName: "Tasks",
  viewName: "Work",
  storeEpoch: "epoch-1",
  commitSeq: 1,
  authorization: null,
  readOnlyReason: null,
  columns: [],
  query: {
    database: {
      databaseId,
      libraryId: "library-1",
      name: "Tasks",
      lifecycle: "active",
      defaultViewId: viewId,
      accessRevision: 1,
      metadataRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    dataSource: {
      dataSourceId,
      libraryId: "library-1",
      homeDatabaseId: databaseId,
      name: "Tasks",
      schemaKey: "nodex.pages",
      schemaRevision: 1,
      lifecycle: "active",
      rankKey: "a",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    view: {
      viewId,
      databaseId,
      dataSourceId,
      name: "Work",
      layout: "board",
      config: {
        schemaKey: "nodex.database-view",
        schemaVersion: 6,
        rules: {
          propertyFilters: [],
          advancedFilter: null,
          sorts: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
        },
        presentation: {
          conditionalColors: [],
          group: { propertyId: statusId },
          subgroup: { propertyId: priorityId },
          groupDirection: "asc",
          completion: { range: "all", orderByRecency: false },
          hierarchy: { showSubPages: true, nestedSubPages: false },
          display: { fields: [], propertyOrder: [], showEmptyGroups: true },
        },
      },
      isDefault: true,
      revision: 1,
      rankKey: "a",
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    properties: [
      {
        propertyId: statusId,
        dataSourceId,
        name: "Status",
        ...testPropertySemantics("select", 1),
        valueType: "select",
        config: {
          options: [
            { id: "o_DOING001", name: "Doing" },
            { id: "o_DONE0001", name: "Done" },
          ],
        },
        rankKey: "a",
        lifecycle: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        propertyId: priorityId,
        dataSourceId,
        name: "Priority",
        ...testPropertySemantics("select", 1),
        valueType: "select",
        config: {
          options: [
            { id: "o_HIGH0001", name: "High" },
            { id: "o_LOW00001", name: "Low" },
          ],
        },
        rankKey: "b",
        lifecycle: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    rows: [
      row("page-1", "o_DOING001", "o_HIGH0001", "a"),
      row("page-2", "o_DONE0001", "o_LOW00001", "b"),
      row("page-3", "o_DONE0001", "o_LOW00001", "c"),
    ],
  },
};

const prioritySortedModel = (): DatabaseViewRenderModel => ({
  ...model,
  query: {
    ...model.query,
    view: {
      ...model.query.view,
      config: {
        ...model.query.view.config,
        rules: {
          ...model.query.view.config.rules,
          sorts: [
            {
              field: { kind: "property", propertyId: priorityId },
              direction: "desc",
              nulls: "last",
            },
          ],
        },
        presentation: { ...model.query.view.config.presentation, subgroup: null },
      },
    },
    rows: model.query.rows.map((candidate) => ({
      ...candidate,
      effectiveSubgroupKey: null,
    })),
  },
});

describe("buildDatabaseViewBoardDropOperations", () => {
  test("compiles against the surface presentation while its Store snapshot still has durable rules", () => {
    const priorityProjectedModel: DatabaseViewRenderModel = {
      ...model,
      query: {
        ...model.query,
        rows: model.query.rows.map((candidate) => ({
          ...candidate,
          effectiveGroupKey: candidate.values[priorityId]?.value as string,
          effectiveSubgroupKey: null,
        })),
      },
    };
    const effectiveModel = withEffectiveDatabaseView(priorityProjectedModel, {
      layout: "board",
      rules: {
        ...model.query.view.config.rules,
        sorts: [
          {
            field: { kind: "property", propertyId: priorityId },
            direction: "asc",
            nulls: "last",
          },
        ],
      },
      presentation: {
        ...model.query.view.config.presentation,
        group: { propertyId: priorityId },
        subgroup: null,
      },
    });

    expect(
      buildDatabaseViewBoardDropOperations({
        model: effectiveModel,
        pageIds: ["page-1"],
        target: {
          groupKey: "o_LOW00001",
          subgroupKey: null,
          beforePageId: "page-3",
        },
      }),
    ).toEqual([
      {
        kind: "edit_property_values",
        edits: [
          {
            pageId: "page-1",
            dataSourceId,
            propertyId: priorityId,
            edit: {
              kind: "replace",
              expectedValueRevision: 3,
              value: { kind: "select", optionId: "o_LOW00001" },
            },
          },
        ],
      },
      {
        kind: "position_pages",
        viewId,
        pages: [{ pageId: "page-1", expectedPositionRevision: 4 }],
        beforePageId: "page-3",
      },
    ]);
  });

  test("moves group, subgroup, and global manual rank in one operation list", () => {
    expect(
      buildDatabaseViewBoardDropOperations({
        model,
        pageIds: ["page-1"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: "o_LOW00001",
          beforePageId: "page-3",
        },
      }),
    ).toEqual([
      {
        kind: "edit_property_values",
        edits: [
          {
            pageId: "page-1",
            dataSourceId,
            propertyId: statusId,
            edit: {
              kind: "replace",
              expectedValueRevision: 2,
              value: { kind: "select", optionId: "o_DONE0001" },
            },
          },
          {
            pageId: "page-1",
            dataSourceId,
            propertyId: priorityId,
            edit: {
              kind: "replace",
              expectedValueRevision: 3,
              value: { kind: "select", optionId: "o_LOW00001" },
            },
          },
        ],
      },
      {
        kind: "position_pages",
        viewId,
        pages: [{ pageId: "page-1", expectedPositionRevision: 4 }],
        beforePageId: "page-3",
      },
    ]);
  });

  test("rejects a self anchor without emitting a partial property write", () => {
    expect(
      buildDatabaseViewBoardDropOperations({
        model,
        pageIds: ["page-1", "page-2"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: "o_LOW00001",
          beforePageId: "page-2",
        },
      }),
    ).toEqual([]);
  });

  test("reorders inside one Board cell without rewriting grouping values", () => {
    expect(
      buildDatabaseViewBoardDropOperations({
        model,
        pageIds: ["page-2"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: "o_LOW00001",
          beforePageId: "page-3",
        },
      }),
    ).toEqual([
      {
        kind: "position_pages",
        viewId,
        pages: [{ pageId: "page-2", expectedPositionRevision: 4 }],
        beforePageId: "page-3",
      },
    ]);
  });

  test("keeps fractional manual positioning when the View has no sort rule", () => {
    const unsortedModel: DatabaseViewRenderModel = {
      ...model,
      query: {
        ...model.query,
        view: {
          ...model.query.view,
          config: {
            ...model.query.view.config,
            rules: { ...model.query.view.config.rules, sorts: [] },
          },
        },
      },
    };
    expect(
      buildDatabaseViewBoardDropOperations({
        model: unsortedModel,
        pageIds: ["page-2"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: "o_LOW00001",
          beforePageId: "page-3",
        },
      }),
    ).toEqual([
      {
        kind: "position_pages",
        viewId,
        pages: [{ pageId: "page-2", expectedPositionRevision: 4 }],
        beforePageId: "page-3",
      },
    ]);
  });

  test("infers the sorted Property value shared by the insertion neighbors", () => {
    const sortedModel = prioritySortedModel();
    const target = {
      groupKey: "o_DONE0001",
      subgroupKey: null,
      beforePageId: "page-3",
    } as const;

    expect(
      resolveDatabaseViewSortedDropValues({
        model: sortedModel,
        pageIds: ["page-1"],
        target,
      }),
    ).toEqual([{ propertyId: priorityId, value: "o_LOW00001" }]);
    expect(databaseViewSupportsSortedSlotInference(sortedModel)).toBe(true);
    expect(
      buildDatabaseViewBoardDropOperations({
        model: sortedModel,
        pageIds: ["page-1"],
        target,
      }),
    ).toEqual([
      {
        kind: "edit_property_values",
        edits: [
          {
            pageId: "page-1",
            dataSourceId,
            propertyId: statusId,
            edit: {
              kind: "replace",
              expectedValueRevision: 2,
              value: { kind: "select", optionId: "o_DONE0001" },
            },
          },
          {
            pageId: "page-1",
            dataSourceId,
            propertyId: priorityId,
            edit: {
              kind: "replace",
              expectedValueRevision: 3,
              value: { kind: "select", optionId: "o_LOW00001" },
            },
          },
        ],
      },
      {
        kind: "position_pages",
        viewId,
        pages: [{ pageId: "page-1", expectedPositionRevision: 4 }],
        beforePageId: "page-3",
      },
    ]);
  });

  test("preserves the mouse-up Property intent while recompiling against newer authority", () => {
    const sortedModel = prioritySortedModel();
    const target = {
      groupKey: "o_DONE0001",
      subgroupKey: null,
      beforePageId: "page-3",
    } as const;
    const propertyValues = resolveDatabaseViewDropPropertyValues({
      model: sortedModel,
      pageIds: ["page-1"],
      target,
    });
    const rebasedModel = {
      ...sortedModel,
      query: {
        ...sortedModel.query,
        rows: sortedModel.query.rows.map((row) =>
          row.page.pageId === "page-3"
            ? {
                ...row,
                values: {
                  ...row.values,
                  [priorityId]: {
                    ...row.values[priorityId]!,
                    value: "o_HIGH0001",
                  },
                },
              }
            : row,
        ),
      },
    } satisfies DatabaseViewRenderModel;

    expect(
      resolveDatabaseViewDropPropertyValues({
        model: rebasedModel,
        pageIds: ["page-1"],
        target,
      }),
    ).toEqual([{ propertyId: statusId, value: "o_DONE0001" }]);
    expect(
      buildDatabaseViewBoardDropOperations({
        model: rebasedModel,
        pageIds: ["page-1"],
        target,
        propertyValues,
      })[0],
    ).toEqual({
      kind: "edit_property_values",
      edits: [
        {
          pageId: "page-1",
          dataSourceId,
          propertyId: statusId,
          edit: {
            kind: "replace",
            expectedValueRevision: 2,
            value: { kind: "select", optionId: "o_DONE0001" },
          },
        },
        {
          pageId: "page-1",
          dataSourceId,
          propertyId: priorityId,
          edit: {
            kind: "replace",
            expectedValueRevision: 3,
            value: { kind: "select", optionId: "o_LOW00001" },
          },
        },
      ],
    });
  });

  test("reorders equal Property values by their fractional tie-break", () => {
    const sortedModel = prioritySortedModel();

    expect(
      buildDatabaseViewBoardDropOperations({
        model: sortedModel,
        pageIds: ["page-3"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: null,
          beforePageId: "page-2",
        },
      }),
    ).toEqual([
      {
        kind: "position_pages",
        viewId,
        pages: [{ pageId: "page-3", expectedPositionRevision: 4 }],
        beforePageId: "page-2",
      },
    ]);
  });

  test("moves across groups when one Property owns grouping and ordering", () => {
    const sortedModel = prioritySortedModel();
    const groupedModel: DatabaseViewRenderModel = {
      ...sortedModel,
      query: {
        ...sortedModel.query,
        view: {
          ...sortedModel.query.view,
          config: {
            ...sortedModel.query.view.config,
            presentation: {
              ...sortedModel.query.view.config.presentation,
              group: { propertyId: priorityId },
            },
          },
        },
        rows: sortedModel.query.rows.map((candidate) => ({
          ...candidate,
          effectiveGroupKey: candidate.values[priorityId]?.value as string,
        })),
      },
    };
    const target = {
      groupKey: "o_LOW00001",
      subgroupKey: null,
      beforePageId: "page-2",
    } as const;
    const propertyValues = resolveDatabaseViewDropPropertyValues({
      model: groupedModel,
      pageIds: ["page-1"],
      target,
    });

    expect(propertyValues).toEqual([
      {
        propertyId: priorityId,
        value: "o_LOW00001",
      },
    ]);
    const optimistic = applyOptimisticDatabaseViewBoardDrop(groupedModel, {
      pageIds: ["page-1"],
      fallbackRows: [groupedModel.query.rows[0]!],
      target,
      propertyValues,
    });
    expect(optimistic.query.rows.find((row) => row.page.pageId === "page-1")).toMatchObject({
      effectiveGroupKey: "o_LOW00001",
      values: { [priorityId]: { value: "o_LOW00001" } },
    });
    expect(
      buildDatabaseViewBoardDropOperations({
        model: groupedModel,
        pageIds: ["page-1"],
        target,
      }).map((operation) => operation.kind),
    ).toEqual(["edit_property_values", "position_pages"]);
  });

  test("keeps the optimistic sorted drop until canonical order converges", () => {
    const sortedModel = prioritySortedModel();
    const projection = {
      pageIds: ["page-3"],
      fallbackRows: [sortedModel.query.rows[2]!],
      target: {
        groupKey: "o_DONE0001",
        subgroupKey: null,
        beforePageId: "page-2",
      },
      propertyValues: [],
    } as const;

    const optimistic = applyOptimisticDatabaseViewBoardDrop(sortedModel, projection);
    expect(optimistic.query.rows.map((row) => row.page.pageId)).toEqual([
      "page-1",
      "page-3",
      "page-2",
    ]);
    expect(optimistic.columns.flatMap((column) => column.rows).map((row) => row.pageId)).toEqual([
      "page-1",
      "page-3",
      "page-2",
    ]);
    expect(applyOptimisticDatabaseViewBoardDrop(optimistic, projection)).toBe(optimistic);

    const repairingAuthority = {
      ...sortedModel,
      query: {
        ...sortedModel.query,
        rows: sortedModel.query.rows.filter((row) => row.page.pageId !== "page-3"),
      },
    };
    expect(
      applyOptimisticDatabaseViewBoardDrop(repairingAuthority, projection).query.rows.map(
        (row) => row.page.pageId,
      ),
    ).toEqual(["page-1", "page-3", "page-2"]);
  });

  test("requires authoritative target completeness for an unanchored tail preview", () => {
    const canonical = prioritySortedModel();
    const projection = {
      pageIds: ["page-3"],
      fallbackRows: [canonical.query.rows[2]!],
      target: { groupKey: "o_DONE0001", subgroupKey: null },
      propertyValues: [],
    } as const;
    expect(compileDatabaseViewBoardDropProjection(canonical, projection).predictable).toBe(false);
    expect(
      compileDatabaseViewBoardDropProjection(canonical, projection, { targetComplete: false })
        .predictable,
    ).toBe(false);
    expect(
      compileDatabaseViewBoardDropProjection(canonical, projection, { targetComplete: true })
        .predictable,
    ).toBe(true);
  });

  test("does not mistake an unavailable drop anchor for canonical tail materialization", () => {
    const canonical = prioritySortedModel();
    const projection = {
      pageIds: ["page-3"],
      fallbackRows: [canonical.query.rows[2]!],
      target: { groupKey: "o_DONE0001", subgroupKey: null, beforePageId: "page-2" },
      propertyValues: [],
    } as const;
    const plan = compileDatabaseViewBoardDropProjection(canonical, projection);
    expect(plan.predictable).toBe(true);
    const missing = {
      ...canonical,
      query: {
        ...canonical.query,
        rows: canonical.query.rows.filter((row) => row.page.pageId !== "page-2"),
      },
    };
    expect(plan.apply(missing)).not.toBe(missing);
    expect(compileDatabaseViewBoardDropProjection(missing, projection).predictable).toBe(false);
    const materialized = applyOptimisticDatabaseViewBoardDrop(canonical, projection);
    expect(plan.apply(materialized)).toBe(materialized);
  });

  test("never replays a drop into a replaced Data Source or Membership", () => {
    const canonical = prioritySortedModel();
    const plan = compileDatabaseViewBoardDropProjection(canonical, {
      pageIds: ["page-3"],
      fallbackRows: [canonical.query.rows[2]!],
      target: { groupKey: "o_DONE0001", subgroupKey: null, beforePageId: "page-2" },
      propertyValues: [{ propertyId: statusId, value: "o_DONE0001" }],
    });
    const replacedSource = { ...canonical, dataSourceId: parseDataSourceId("replacement-source") };
    const replacedMembership = {
      ...canonical,
      query: {
        ...canonical.query,
        rows: canonical.query.rows.map((row) =>
          row.page.pageId !== "page-3"
            ? row
            : {
                ...row,
                membership: { ...row.membership, membershipId: "replacement-membership" },
              },
        ),
      },
    };
    for (const replaced of [replacedSource, replacedMembership]) {
      const projected = plan.apply(replaced);
      expect(projected).not.toBe(replaced);
      expect(projected.query).toBe(replaced.query);
    }
  });

  test("yields a later Page value without dropping other values or Pages in the same drop", () => {
    const canonical = prioritySortedModel();
    const projection = {
      pageIds: ["page-1", "page-3"],
      fallbackRows: [canonical.query.rows[0]!, canonical.query.rows[2]!],
      target: { groupKey: "o_DONE0001", subgroupKey: null, beforePageId: "page-2" },
      propertyValues: [
        { propertyId: statusId, value: "o_DONE0001" },
        { propertyId: priorityId, value: "o_HIGH0001" },
      ],
    } as const;
    const plan = compileDatabaseViewBoardDropProjection(canonical, projection);
    plan.acknowledge?.({
      committedRevisions: {
        [`value:${dataSourceId}:membership-page-1:${priorityId}`]: 4,
        [`value:${dataSourceId}:membership-page-1:${statusId}`]: 3,
      },
    });
    const remote = {
      ...canonical,
      query: {
        ...canonical.query,
        rows: canonical.query.rows.map((row) =>
          row.page.pageId !== "page-1"
            ? row
            : {
                ...row,
                values: {
                  ...row.values,
                  [priorityId]: { ...row.values[priorityId]!, value: "o_LOW00001", revision: 5 },
                },
              },
        ),
      },
    };
    const projected = plan.apply(remote);
    const byId = new Map(projected.query.rows.map((row) => [row.page.pageId, row]));
    expect(byId.get("page-1")?.values[priorityId]?.value).toBe("o_LOW00001");
    expect(byId.get("page-1")?.values[statusId]?.value).toBe("o_DONE0001");
    expect(byId.get("page-3")?.values[priorityId]?.value).toBe("o_HIGH0001");
    expect(projected.query.rows.map((row) => row.page.pageId)).toEqual([
      "page-1",
      "page-3",
      "page-2",
    ]);
    expect(plan.apply(projected)).toBe(projected);
  });

  test("does not promise an exact slot after a derived secondary sort", () => {
    expect(
      databaseViewSupportsSortedSlotInference({
        ...model,
        query: {
          ...model.query,
          view: {
            ...model.query.view,
            config: {
              ...model.query.view.config,
              rules: {
                ...model.query.view.config.rules,
                sorts: [
                  {
                    field: { kind: "property", propertyId: priorityId },
                    direction: "asc",
                    nulls: "last",
                  },
                  { field: { kind: "title" }, direction: "asc", nulls: "last" },
                ],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  test("does not infer a writable slot without active Property semantics", () => {
    expect(
      databaseViewSupportsSortedSlotInference({
        ...model,
        query: {
          ...model.query,
          view: {
            ...model.query.view,
            config: {
              ...model.query.view.config,
              rules: {
                ...model.query.view.config.rules,
                sorts: [
                  {
                    field: { kind: "property", propertyId: unavailablePropertyId },
                    direction: "asc",
                    nulls: "last",
                  },
                ],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  test("describes structural and sorted Property changes from one drop proposal", () => {
    const sortedModel = prioritySortedModel();

    expect(
      resolveDatabaseViewDropPropertyValues({
        model: sortedModel,
        pageIds: ["page-1"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: null,
          beforePageId: "page-3",
        },
      }),
    ).toEqual([
      { propertyId: statusId, value: "o_DONE0001" },
      { propertyId: priorityId, value: "o_LOW00001" },
    ]);
    expect(
      resolveDatabaseViewDropPropertyValues({
        model,
        pageIds: ["page-2"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: "o_LOW00001",
          beforePageId: "page-3",
        },
      }),
    ).toEqual([]);
    expect(
      resolveDatabaseViewDropPropertyValues({
        model: sortedModel,
        pageIds: ["page-2"],
        target: {
          groupKey: "o_DONE0001",
          subgroupKey: null,
          beforePageId: "page-3",
        },
      }),
    ).toEqual([]);
  });

  test("does not advertise an exact slot for intrinsic sorting", () => {
    expect(
      databaseViewSupportsSortedSlotInference({
        ...model,
        query: {
          ...model.query,
          view: {
            ...model.query.view,
            config: {
              ...model.query.view.config,
              rules: {
                ...model.query.view.config.rules,
                sorts: [{ field: { kind: "title" }, direction: "asc", nulls: "last" }],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});
