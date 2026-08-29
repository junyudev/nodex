import { describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  type DatabaseApplyResultV2,
  type DatabaseViewQueryResultV2,
  type DataSourcePageRowV2,
  type DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import {
  buildDatabaseViewMoveOperations,
  buildDatabaseViewMovePageRunOperations,
  buildDatabaseViewPropertyValueOperations,
  commitDatabaseViewOperations,
} from "./database-view-row-mutations";

const timestamp = "2026-07-12T00:00:00.000Z";
const libraryId = "library-1";
const databaseId = parseDatabaseId("database-1");
const dataSourceId = parseDataSourceId("source-1");
const viewId = parseDatabaseViewId("view-1");
const scorePropertyId = parseDataSourcePropertyId("p_AAAAAAAA");
const tagsPropertyId = parseDataSourcePropertyId("tags");

const model = (): DatabaseViewRenderModel => {
  const properties: readonly DataSourcePropertyRecordV2[] = [
    {
      propertyId: scorePropertyId,
      dataSourceId,
      name: "Score",
      ...testPropertySemantics("number"),
      valueType: "number",
      config: {},
      rankKey: "a",
      lifecycle: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: tagsPropertyId,
      dataSourceId,
      name: "Tags",
      ...testPropertySemantics("multi_select", 2),
      valueType: "multi_select",
      config: {
        options: [
          { id: "o_AAAAAAAA", name: "One" },
          { id: "o_BBBBBBBB", name: "Two" },
        ],
      },
      rankKey: "b",
      lifecycle: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const view = {
    viewId,
    databaseId,
    dataSourceId,
    name: "All",
    layout: "list" as const,
    config: upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view" as const,
      schemaVersion: 2 as const,
      filter: { kind: "group" as const, operator: "and" as const, children: [] },
      sort: [
        { field: { kind: "manual" as const }, direction: "asc" as const, nulls: "last" as const },
      ],
      group: null,
      display: { propertyIds: [scorePropertyId, tagsPropertyId], showTitle: true },
    }),
    isDefault: false,
    revision: 1,
    rankKey: "a",
    lifecycle: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const database = {
    databaseId,
    libraryId,
    name: "Tasks",
    lifecycle: "active" as const,
    defaultViewId: parseDatabaseViewId("view-default"),
    accessRevision: 1,
    metadataRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const dataSource = {
    dataSourceId,
    libraryId,
    homeDatabaseId: database.databaseId,
    name: "Pages",
    schemaKey: "nodex.pages",
    schemaRevision: 2,
    lifecycle: "active" as const,
    rankKey: "a",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const rows: DatabaseViewQueryResultV2["rows"] = ["page-a", "page-b", "page-c"].map(
    (pageId, index): DataSourcePageRowV2 => ({
      pageKey: null,
      membership: {
        membershipId: `membership-${pageId}`,
        dataSourceId,
        revision: 1,
        createdAt: timestamp,
      },
      page: {
        pageId,
        libraryId,
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
      values:
        index === 0
          ? {
              [scorePropertyId]: {
                propertyId: scorePropertyId,
                valueType: "number" as const,
                value: 1,
                revision: 3,
              },
              [tagsPropertyId]: {
                propertyId: tagsPropertyId,
                valueType: "multi_select" as const,
                value: ["o_AAAAAAAA"],
                revision: 2,
              },
            }
          : {},
      taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
      position: index === 2 ? null : { rankKey: String(index), revision: index + 1 },
      effectiveGroupKey: null,
      effectiveSubgroupKey: null,
    }),
  );
  return {
    libraryId: "library-1",
    accessContext: { kind: "project", projectId: "project-1" },
    databaseViewId: view.viewId,
    databaseId: database.databaseId,
    dataSourceId,
    databaseName: database.name,
    dataSourceName: dataSource.name,
    viewName: view.name,
    storeEpoch: "epoch-1",
    commitSeq: 4,
    authorization: null,
    query: { database, dataSource, view, properties, rows },
    columns: [
      {
        id: "all",
        groupKey: null,
        scopeKey: "all",
        name: "All",
        rows: rows.map((row) => ({
          pageId: row.page.pageId,
          pageKey: row.pageKey,
          groupKey: null,
          subgroupKey: null,
          title: row.page.title,
          preview: "",
          plainText: "",
          tags: [],
          taskParentValueRevision: 1,
          documentGeneration: row.page.documentGeneration,
          documentHeadSeq: row.page.documentHeadSeq,
          metadataRevision: 1,
          createdAt: new Date(timestamp),
        })),
      },
    ],
    readOnlyReason: null,
  };
};

describe("selected Database View Page mutations", () => {
  test("uses scalar CAS and set-like multi-select intent from one query snapshot", () => {
    const authority = model();
    const scalar = buildDatabaseViewPropertyValueOperations({
      model: authority,
      pageId: "page-a",
      propertyId: scorePropertyId,
      value: 2,
    });
    const setLike = buildDatabaseViewPropertyValueOperations({
      model: authority,
      pageId: "page-a",
      propertyId: tagsPropertyId,
      value: ["o_BBBBBBBB"],
    });
    expect(scalar[0]).toMatchObject({
      kind: "edit_property_values",
      edits: [
        {
          pageId: "page-a",
          dataSourceId,
          edit: { kind: "replace", expectedValueRevision: 3 },
        },
      ],
    });
    expect(setLike[0]).toEqual({
      kind: "edit_property_values",
      edits: [
        {
          pageId: "page-a",
          dataSourceId,
          propertyId: tagsPropertyId,
          edit: {
            kind: "patch_set",
            delta: {
              kind: "multi_select",
              addOptionIds: ["o_BBBBBBBB"],
              removeOptionIds: ["o_AAAAAAAA"],
            },
          },
        },
      ],
    });
  });

  test("initializes an unfiltered group's complete manual order atomically", () => {
    const operations = buildDatabaseViewMoveOperations({
      model: model(),
      pageId: "page-a",
      direction: "down",
      groupComplete: true,
    });
    expect(operations[0]).toEqual({
      kind: "position_pages",
      viewId: "view-1",
      pages: [
        { pageId: "page-b", expectedPositionRevision: 2 },
        { pageId: "page-a", expectedPositionRevision: 1 },
        { pageId: "page-c", expectedPositionRevision: 0 },
      ],
    });
  });

  test("moves Pages against implicit manual order when sort rules are empty", () => {
    const baseModel = model();
    const unsortedModel: DatabaseViewRenderModel = {
      ...baseModel,
      query: {
        ...baseModel.query,
        view: {
          ...baseModel.query.view,
          config: {
            ...baseModel.query.view.config,
            rules: { ...baseModel.query.view.config.rules, sorts: [] },
          },
        },
      },
    };
    expect(
      buildDatabaseViewMoveOperations({
        model: unsortedModel,
        pageId: "page-a",
        direction: "down",
        groupComplete: true,
      })[0],
    ).toMatchObject({
      kind: "position_pages",
      pages: [{ pageId: "page-b" }, { pageId: "page-a" }, { pageId: "page-c" }],
    });
  });

  test("moves a Page to either manual-order boundary", () => {
    expect(
      buildDatabaseViewMoveOperations({
        model: model(),
        pageId: "page-c",
        direction: "top",
        groupComplete: true,
      })[0],
    ).toMatchObject({
      kind: "position_pages",
      pages: [{ pageId: "page-c" }, { pageId: "page-a" }, { pageId: "page-b" }],
    });
    expect(
      buildDatabaseViewMoveOperations({
        model: model(),
        pageId: "page-a",
        direction: "bottom",
        groupComplete: true,
      })[0],
    ).toMatchObject({
      kind: "position_pages",
      pages: [{ pageId: "page-b" }, { pageId: "page-c" }, { pageId: "page-a" }],
    });
  });

  test("moves a multi-selection atomically in visible order", () => {
    expect(
      buildDatabaseViewMovePageRunOperations({
        model: model(),
        pageIds: ["page-c", "page-a"],
        direction: "bottom",
        groupComplete: true,
      })[0],
    ).toMatchObject({
      kind: "position_pages",
      pages: [{ pageId: "page-b" }, { pageId: "page-a" }, { pageId: "page-c" }],
    });
  });

  test("retains the exact request identity across one transport retry", async () => {
    const requests: string[] = [];
    let calls = 0;
    const operations = buildDatabaseViewPropertyValueOperations({
      model: model(),
      pageId: "page-a",
      propertyId: scorePropertyId,
      value: 2,
    });
    const result = {
      ok: true,
      localCommit: noOpLocalCommit("epoch-1"),
      value: {
        operationId: "operation-1",
        projectId: "project-1",
        libraryId,
        storeEpoch: "epoch-1",
        duplicate: false,
        operationKinds: ["edit_property_values"],
        operationOutcomes: [],
        affectedDatabaseIds: [databaseId],
        affectedDataSourceIds: [dataSourceId],
        affectedPageIds: ["page-a"],
        affectedViewIds: [],
        committedRevisions: {},
        commitSeq: 5,
        committedAt: timestamp,
      },
    } satisfies DatabaseApplyResultV2;
    const receipt = await commitDatabaseViewOperations({
      model: model(),
      operations,
      dependencies: {
        applyProject: async (_projectId, request) => {
          requests.push(JSON.stringify(request));
          calls += 1;
          if (calls === 1) throw new Error("transport lost ACK");
          return {
            ...result,
            value: { ...result.value, operationId: request.operationId },
          };
        },
        applyLibrary: async () => {
          throw new Error("Unexpected Library authority");
        },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(receipt?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("uses the Library apply contract without a synthetic Project", async () => {
    const authority: DatabaseViewRenderModel = {
      ...model(),
      accessContext: { kind: "library" },
    };
    const operations = buildDatabaseViewPropertyValueOperations({
      model: authority,
      pageId: "page-a",
      propertyId: scorePropertyId,
      value: 2,
    });
    const libraryRequests: unknown[] = [];

    await commitDatabaseViewOperations({
      model: authority,
      operations,
      operationId: "operation:library",
      dependencies: {
        applyProject: async () => {
          throw new Error("Unexpected Project authority");
        },
        applyLibrary: async (request) => {
          libraryRequests.push(request);
          return {
            ok: true,
            localCommit: noOpLocalCommit("epoch-1"),
            value: {
              operationId: request.operationId,
              accessContext: { kind: "library" },
              libraryId,
              storeEpoch: "epoch-1",
              duplicate: false,
              operationKinds: ["edit_property_values"],
              operationOutcomes: [],
              affectedDatabaseIds: [databaseId],
              affectedDataSourceIds: [dataSourceId],
              affectedPageIds: ["page-a"],
              affectedViewIds: [],
              committedRevisions: {},
              commitSeq: 5,
              committedAt: timestamp,
            },
          };
        },
      },
    });

    expect(libraryRequests).toEqual([
      {
        operationId: "operation:library",
        storeEpoch: "epoch-1",
        operations,
      },
    ]);
  });
});
