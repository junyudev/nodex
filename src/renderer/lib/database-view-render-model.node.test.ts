import { describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  type DatabaseModuleReadSnapshotV2,
  type DatabaseViewQueryResultV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  buildDatabaseViewRenderModel,
  databaseViewConditionalColorForOption,
  withPublishedDatabaseViewDefinition,
} from "./database-view-render-model";

const timestamp = "2026-07-12T00:00:00.000Z";
const projectId = "project-alpha";
const libraryId = "library-alpha";
const databaseId = parseDatabaseId("database-alpha");
const dataSourceId = parseDataSourceId("source-alpha");
const viewId = parseDatabaseViewId("view-alpha");
const statusPropertyId = parseDataSourcePropertyId("status");
const tagsPropertyId = parseDataSourcePropertyId("tags");

const makeSnapshot = (
  input: {
    readonly primary?: boolean;
    readonly groupedByStatus?: boolean;
    readonly viewId?: string;
    readonly title?: string;
  } = {},
): DatabaseModuleReadSnapshotV2 => {
  const resolvedViewId = parseDatabaseViewId(input.viewId ?? viewId);
  const database = {
    databaseId,
    libraryId,
    name: "Tasks",
    lifecycle: "active" as const,
    defaultViewId: input.primary === false ? viewId : resolvedViewId,
    accessRevision: 1,
    metadataRevision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const dataSource = {
    dataSourceId,
    libraryId,
    homeDatabaseId: databaseId,
    name: "Pages",
    schemaKey: "nodex.pages",
    schemaRevision: 4,
    lifecycle: "active" as const,
    rankKey: "a",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const view = {
    viewId: resolvedViewId,
    databaseId,
    dataSourceId,
    name: input.primary === false ? "Focused work" : "Primary board",
    layout: "board" as const,
    config: upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view" as const,
      schemaVersion: 2 as const,
      filter: { kind: "group" as const, operator: "and" as const, children: [] },
      sort: [
        {
          field: { kind: "manual" as const },
          direction: "asc" as const,
          nulls: "last" as const,
        },
      ],
      group: input.groupedByStatus === false ? null : { propertyId: statusPropertyId },
      display: { propertyIds: [statusPropertyId, tagsPropertyId], showTitle: true },
    }),
    isDefault: input.primary !== false,
    revision: 3,
    rankKey: "a",
    lifecycle: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const properties = [
    {
      propertyId: statusPropertyId,
      dataSourceId,
      name: "Status",
      ...testPropertySemantics("select"),
      valueType: "select" as const,
      config: {},
      rankKey: "a",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: tagsPropertyId,
      dataSourceId,
      name: "Tags",
      ...testPropertySemantics("multi_select"),
      valueType: "multi_select" as const,
      config: {},
      rankKey: "b",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const title = input.title ?? "Canonical Page";
  const query: DatabaseViewQueryResultV2 = {
    database,
    dataSource,
    properties,
    view,
    rows: [
      {
        pageKey: null,
        membership: {
          membershipId: "membership-1",
          dataSourceId,
          revision: 1,
          createdAt: timestamp,
        },
        page: {
          pageId: "page-1",
          libraryId,
          parent: { kind: "data_source", dataSourceId },
          lifecycle: "active",
          parentRevision: 1,
          metadataRevision: 9,
          documentId: "document-1",
          documentGeneration: 1,
          documentHeadSeq: 5,
          title,
          richTitle: plainTextToPortableRichText(title),
          preview: "One line",
          plainText: "One line body",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        values: {
          [statusPropertyId]: {
            propertyId: statusPropertyId,
            valueType: "select",
            value: "build",
            revision: 2,
          },
          [tagsPropertyId]: {
            propertyId: tagsPropertyId,
            valueType: "multi_select",
            value: ["sync", "page-first"],
            revision: 1,
          },
        },
        taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
        position: { rankKey: "a", revision: 2 },
        effectiveGroupKey: input.groupedByStatus === false ? null : "build",
        effectiveSubgroupKey: null,
      },
    ],
  };
  return {
    projectId,
    libraryId,
    storeEpoch: "epoch-alpha",
    commitSeq: 7,
    authorization: null,
    value: { kind: "query", value: query },
  };
};

describe("Database View render model", () => {
  test("maps durable option colors onto conditional surface colors", () => {
    expect(databaseViewConditionalColorForOption("purple")).toBe("purple");
    expect(databaseViewConditionalColorForOption("teal")).toBe("green");
    expect(databaseViewConditionalColorForOption("default")).toBeNull();
    expect(databaseViewConditionalColorForOption("#56ABFD")).toBeNull();
  });

  test("projects the default single-Source View through the shared runtime", () => {
    const model = buildDatabaseViewRenderModel(makeSnapshot());
    expect(model.databaseViewId).toBe(viewId);
    expect(model.dataSourceId).toBe(dataSourceId);
    expect(model.readOnlyReason).toBe(null);
    expect(model.columns[2]?.rows[0]?.title).toBe("Canonical Page");
    expect(model.columns[2]?.rows[0]?.tags).toEqual(["sync", "page-first"]);
  });

  test("keeps a secondary View writable through its own canonical identity", () => {
    const model = buildDatabaseViewRenderModel(
      makeSnapshot({
        primary: false,
        viewId: "view-focused",
        title: "Only in focused view",
      }),
    );
    expect(model.databaseViewId).toBe("view-focused");
    expect(model.readOnlyReason).toBe(null);
    expect(model.columns[2]?.rows[0]?.title).toBe("Only in focused view");
  });

  test("preserves ordered Pages for a non-status grouped View", () => {
    const model = buildDatabaseViewRenderModel(
      makeSnapshot({
        primary: false,
        groupedByStatus: false,
      }),
    );
    expect(model.columns).toHaveLength(1);
    expect(model.columns[0]?.rows[0]?.pageId).toBe("page-1");
  });

  test("builds generic columns from stable select option identities", () => {
    const snapshot = makeSnapshot({ primary: false });
    if (snapshot.value.kind !== "query") throw new Error("Missing query fixture");
    const query = snapshot.value.value;
    const workflowPropertyId = parseDataSourcePropertyId("p_AAAAAAAA");
    const doingOptionId = "o_AAAAAAAA";
    const workflowProperty = {
      ...query.properties[0]!,
      propertyId: workflowPropertyId,
      name: "Workflow",
      config: { options: [{ id: doingOptionId, name: "Doing" }] },
    };
    const properties = [workflowProperty, ...query.properties.slice(1)];
    const model = buildDatabaseViewRenderModel({
      ...snapshot,
      value: {
        kind: "query",
        value: {
          ...query,
          properties,
          view: {
            ...query.view,
            config: {
              ...query.view.config,
              presentation: {
                ...query.view.config.presentation,
                group: { propertyId: workflowPropertyId },
              },
            },
          },
          rows: query.rows.map((row) => ({
            ...row,
            values: {
              ...row.values,
              [workflowPropertyId]: {
                propertyId: workflowPropertyId,
                valueType: "select" as const,
                value: doingOptionId,
                revision: 1,
              },
            },
            effectiveGroupKey: doingOptionId,
          })),
        },
      },
    });
    expect(model.readOnlyReason).toBe(null);
    expect(model.columns[0]?.id).toBe(doingOptionId);
    expect(model.columns[0]?.name).toBe("Doing");
    expect(model.columns[0]?.rows[0]?.pageId).toBe("page-1");
  });

  test("preserves a filtered default View in the shared runtime", () => {
    const snapshot = makeSnapshot();
    if (snapshot.value.kind !== "query") throw new Error("Missing query fixture");
    const query = snapshot.value.value;
    const filteredView = {
      ...query.view,
      config: {
        ...query.view.config,
        filter: {
          kind: "clause" as const,
          propertyId: statusPropertyId,
          operator: "equals" as const,
          value: "build",
        },
      },
    };
    const model = buildDatabaseViewRenderModel({
      ...snapshot,
      value: {
        kind: "query",
        value: { ...query, view: filteredView },
      },
    });
    expect(model.query.view.config.rules).toEqual(filteredView.config.rules);
  });

  test("hands published rules to durable metadata without replacing the visible projection", () => {
    const model = buildDatabaseViewRenderModel(makeSnapshot());
    const rules = { ...model.query.view.config.rules, sorts: [] };

    const published = withPublishedDatabaseViewDefinition(model, { rules });

    expect(published.query.view.config.rules).toBe(rules);
    expect(published.query.rows).toBe(model.query.rows);
    expect(published.columns).toBe(model.columns);
    expect(withPublishedDatabaseViewDefinition(published, { rules })).toBe(published);
  });

  test("reprojects conditional colors immediately while their receipt is materializing", () => {
    const model = buildDatabaseViewRenderModel(makeSnapshot());
    const conditionalColors = [
      {
        ruleId: "rule-build",
        propertyId: statusPropertyId,
        operator: "select_is" as const,
        value: "build",
        colorSource: "fixed" as const,
        color: "blue" as const,
      },
    ];

    const published = withPublishedDatabaseViewDefinition(model, { conditionalColors });

    expect(published.query.view.config.presentation.conditionalColors).toBe(conditionalColors);
    expect(published.query.rows).toBe(model.query.rows);
    expect(published.columns[2]?.rows[0]?.conditionalColor).toBe("blue");
    expect(withPublishedDatabaseViewDefinition(published, { conditionalColors })).toBe(published);
  });

  test("rejects resources from a different Library", () => {
    const snapshot = makeSnapshot();
    if (snapshot.value.kind !== "query") throw new Error("Missing query fixture");
    const mismatched: DatabaseModuleReadSnapshotV2 = {
      ...snapshot,
      value: {
        kind: "query",
        value: {
          ...snapshot.value.value,
          dataSource: {
            ...snapshot.value.value.dataSource,
            libraryId: "library-other",
          },
        },
      },
    };
    expect(() => buildDatabaseViewRenderModel(mismatched)).toThrow(
      "mismatched Library resource identity",
    );
  });
});
