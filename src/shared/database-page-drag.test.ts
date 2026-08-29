import { describe, expect, test } from "vite-plus/test";

import {
  type DatabaseModuleReadSnapshotV2,
  type DatabaseViewQueryResultV2,
} from "./database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "./database-identities";
import {
  compileDatabasePageDrag,
  compileDatabasePagesDrag,
  DatabasePageDragError,
} from "./database-page-drag";
import { upgradeDatabaseViewConfigV2 } from "./database-view-presentation";
import { testPropertyManagement } from "./testing/database-property-record";

const timestamp = "2026-07-16T00:00:00.000Z";

const querySnapshot = (
  input: {
    readonly status?: string;
    readonly manual?: boolean;
    readonly emptySort?: boolean;
  } = {},
): DatabaseModuleReadSnapshotV2 => {
  const database = {
    databaseId: parseDatabaseId("database-1"),
    libraryId: "library-1",
    name: "Work",
    lifecycle: "active" as const,
    defaultViewId: parseDatabaseViewId("view-1"),
    accessRevision: 1,
    metadataRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const dataSource = {
    dataSourceId: parseDataSourceId("source-1"),
    libraryId: "library-1",
    homeDatabaseId: database.databaseId,
    name: "Pages",
    schemaKey: "nodex.pages",
    schemaRevision: 2,
    lifecycle: "active" as const,
    rankKey: "a",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const properties = [
    {
      propertyId: parseDataSourcePropertyId("status"),
      dataSourceId: dataSource.dataSourceId,
      name: "Status",
      schema: { kind: "select" as const },
      capabilities: {
        filterOperators: ["select_is", "select_is_not", "is_empty", "is_not_empty"] as const,
        sortable: true,
        groupable: true,
      },
      ...testPropertyManagement(),
      valueType: "select" as const,
      config: {},
      optionCount: 0,
      rankKey: "a",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: parseDataSourcePropertyId("priority"),
      dataSourceId: dataSource.dataSourceId,
      name: "Priority",
      schema: { kind: "select" as const },
      capabilities: {
        filterOperators: ["select_is", "select_is_not", "is_empty", "is_not_empty"] as const,
        sortable: true,
        groupable: true,
      },
      ...testPropertyManagement(),
      valueType: "select" as const,
      config: {},
      optionCount: 0,
      rankKey: "b",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const view = {
    viewId: parseDatabaseViewId("view-1"),
    databaseId: database.databaseId,
    dataSourceId: dataSource.dataSourceId,
    name: "Board",
    layout: "board" as const,
    config: upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view" as const,
      schemaVersion: 2 as const,
      filter: { kind: "group" as const, operator: "and" as const, children: [] },
      sort: input.emptySort
        ? []
        : input.manual === false
          ? [
              {
                field: { kind: "property" as const, propertyId: "priority" },
                direction: "asc" as const,
                nulls: "last" as const,
              },
            ]
          : [
              {
                field: { kind: "manual" as const },
                direction: "asc" as const,
                nulls: "last" as const,
              },
            ],
      group: { propertyId: "status" },
      display: { propertyIds: [], showTitle: true },
    }),
    isDefault: true,
    revision: 2,
    rankKey: "a",
    lifecycle: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const row = (
    pageId: string,
    status: string,
    priority: string,
    rankKey: string,
    revision: number,
  ): DatabaseViewQueryResultV2["rows"][number] => ({
    pageKey: null,
    page: {
      pageId,
      libraryId: "library-1",
      parent: { kind: "data_source", dataSourceId: dataSource.dataSourceId },
      lifecycle: "active",
      parentRevision: 1,
      metadataRevision: 1,
      documentId: `document:${pageId}`,
      documentGeneration: 1,
      documentHeadSeq: 1,
      title: pageId,
      richTitle: [],
      preview: "",
      plainText: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    membership: {
      membershipId: `membership:${pageId}`,
      dataSourceId: dataSource.dataSourceId,
      revision: 1,
      createdAt: timestamp,
    },
    values: {
      status: {
        propertyId: parseDataSourcePropertyId("status"),
        valueType: "select",
        value: status,
        revision,
      },
      priority: {
        propertyId: parseDataSourcePropertyId("priority"),
        valueType: "select",
        value: priority,
        revision: revision + 10,
      },
    },
    taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
    position: { rankKey, revision: revision + 20 },
    effectiveGroupKey: status,
    effectiveSubgroupKey: null,
  });
  const query: DatabaseViewQueryResultV2 = {
    database,
    dataSource,
    view,
    properties,
    rows: [
      row("page-a", input.status ?? "build", "p1-high", "a", 2),
      row("page-b", "build", "p1-high", "b", 3),
      row("page-target", "ship", "p2-medium", "c", 4),
    ],
  };
  return {
    projectId: "project-1",
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 8,
    authorization: null,
    value: { kind: "query", value: query },
  };
};

describe("Database Page drag compiler", () => {
  test("uses Page coordinates for a same-group manual position", () => {
    const compiled = compileDatabasePageDrag({
      move: {
        pageId: "page-b",
        fromStatus: "build",
        toStatus: "build",
        newOrder: 0,
      },
      snapshot: querySnapshot(),
    });

    expect(compiled).toMatchObject({
      databaseId: "database-1",
      dataSourceId: "source-1",
      viewId: "view-1",
    });
    expect(compiled.operations).toEqual([
      {
        kind: "position_page",
        viewId: "view-1",
        pageId: "page-b",
        expectedPositionRevision: 23,
        beforePageId: "page-a",
      },
    ]);
  });

  test("uses intrinsic Page order when the View has no explicit sort", () => {
    const compiled = compileDatabasePageDrag({
      move: {
        pageId: "page-b",
        fromStatus: "build",
        toStatus: "build",
        newOrder: 0,
      },
      snapshot: querySnapshot({ emptySort: true }),
    });

    expect(compiled.operations).toEqual([
      {
        kind: "position_page",
        viewId: "view-1",
        pageId: "page-b",
        expectedPositionRevision: 23,
        beforePageId: "page-a",
      },
    ]);
  });

  test("writes sorted Property values before their fractional tie-break", () => {
    const compiled = compileDatabasePageDrag({
      move: {
        pageId: "page-a",
        fromStatus: "build",
        toStatus: "ship",
        newOrder: 0,
        fieldPatch: { priority: "p2-medium" },
      },
      snapshot: querySnapshot({ manual: false }),
    });

    expect(compiled.operations.map((operation) => operation.kind)).toEqual([
      "edit_property_values",
      "position_page",
    ]);
    const values = compiled.operations[0];
    if (values?.kind !== "edit_property_values") throw new Error("Missing value run");
    expect(
      values.edits.map((value) => ({
        pageId: value.pageId,
        dataSourceId: value.dataSourceId,
        propertyId: value.propertyId,
      })),
    ).toEqual([
      {
        pageId: "page-a",
        dataSourceId: "source-1",
        propertyId: "status",
      },
      {
        pageId: "page-a",
        dataSourceId: "source-1",
        propertyId: "priority",
      },
    ]);
    expect(compiled.operations[1]).toMatchObject({
      kind: "position_page",
      pageId: "page-a",
      expectedPositionRevision: 22,
    });
  });

  test("keeps a multi-Page run ordered behind one external anchor", () => {
    const compiled = compileDatabasePagesDrag({
      move: {
        pageIds: ["page-b", "page-a"],
        fromStatus: "build",
        toStatus: "ship",
        newOrder: 0,
      },
      snapshot: querySnapshot(),
    });

    const position = compiled.operations.at(-1);
    if (position?.kind !== "position_pages") {
      throw new Error("Missing Page position run");
    }
    expect(position.pages.map((page) => page.pageId)).toEqual(["page-b", "page-a"]);
    expect(position.pages.map((page) => page.expectedPositionRevision)).toEqual([23, 22]);
    expect(position.beforePageId).toBe("page-target");
  });

  test("rejects a stale source status", () => {
    let code = "";
    try {
      compileDatabasePageDrag({
        move: {
          pageId: "page-a",
          fromStatus: "build",
          toStatus: "ship",
        },
        snapshot: querySnapshot({ status: "review" }),
      });
    } catch (error) {
      if (error instanceof DatabasePageDragError) code = error.code;
    }
    expect(code).toBe("source_status_conflict");
  });
});
