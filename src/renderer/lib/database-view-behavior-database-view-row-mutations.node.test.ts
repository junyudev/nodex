import { describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type {
  DatabaseApplyResultV2,
  DatabaseViewQueryResultV2,
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
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
import {
  databaseViewSortDirectionLabels,
  hasCustomDatabaseViewSort,
  summarizeDatabaseViewFilter,
} from "./database-view-rule-summary";
import {
  createDefaultDatabaseTaskFilterGroup,
  decodeDatabaseTaskFilter,
  encodeDatabaseTaskFilter,
  resolveDatabaseTaskFilterCapabilities,
} from "./database-view-task-filter";
import {
  filterDbViewCards,
  getDefaultDbViewPrefs,
  hasActiveDbViewRules,
  normalizeLegacyDbViewPrefs,
  normalizeDbViewPrefs,
  sortDbViewCards,
  type DbViewCardRecord,
} from "./db-view-prefs";

describe("database view row mutations", () => {
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
        work: { unsatisfiedCount: 0, blockers: [], owner: null, assignee: null, autoStart: false },
        taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
        position: index === 2 ? null : { rankKey: String(index), revision: index + 1 },
        effectiveGroupKey: null,
        effectiveSubgroupKey: null,
      }),
    );
    return {
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      databaseViewId: view.viewId,
      databaseId: database.databaseId,
      dataSourceId,
      databaseName: database.name,
      dataSourceName: dataSource.name,
      viewName: view.name,
      storeEpoch: "epoch-1",
      commitSeq: 4,
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

    test("preserves the owner's identity and returns uncertain delivery without an independent retry", async () => {
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
      const submit = () =>
        commitDatabaseViewOperations({
          model: model(),
          operations,
          operationId: "owner-operation",
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
      await expect(submit()).rejects.toThrow("transport lost ACK");
      expect(requests).toHaveLength(1);
      const receipt = await submit();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
      expect(receipt?.operationId).toBe("owner-operation");
    });

    test("uses the Library apply contract without a synthetic Project", async () => {
      const authority: DatabaseViewRenderModel = {
        ...model(),
        routingContext: { kind: "library" },
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
                routingContext: { kind: "library" },
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
});

describe("database view rule summary", () => {
  const property = (propertyId: string, name: string): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId: parseDataSourceId("source:rules"),
    name,
    ...testPropertySemantics("select", 2),
    valueType: "select",
    config: { options: [{ id: "doing", name: "Doing" }] },
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });

  describe("database View rule summaries", () => {
    test("groups nested clauses by property and resolves option names", () => {
      expect(
        summarizeDatabaseViewFilter(
          {
            kind: "group",
            operator: "and",
            children: [
              { kind: "clause", propertyId: "p_status00", operator: "equals", value: "doing" },
              {
                kind: "group",
                operator: "or",
                children: [
                  { kind: "clause", propertyId: "p_priorit0", operator: "is_empty" },
                  { kind: "clause", propertyId: "p_priorit0", operator: "equals", value: "doing" },
                ],
              },
            ],
          },
          [property("p_status00", "Status"), property("p_priorit0", "Priority")],
        ),
      ).toEqual([
        { key: "p_status00", label: "Status", value: "is Doing" },
        { key: "p_priorit0", label: "Priority", value: "2 rules" },
      ]);
    });

    test("summarizes familiar task chips by their visible option labels", () => {
      const status = property("status", "Status");
      const taskStatus: DataSourcePropertyRecordV2 = {
        ...status,
        config: {
          options: [
            { id: "triage", name: "Incoming" },
            { id: "plan", name: "Queued" },
            { id: "doing", name: "Doing" },
            { id: "review", name: "Review" },
            { id: "done", name: "Done" },
          ],
        },
      };
      expect(
        summarizeDatabaseViewFilter(
          {
            kind: "group",
            operator: "and",
            children: [
              {
                kind: "group",
                operator: "or",
                children: [
                  { kind: "clause", propertyId: "status", operator: "equals", value: "triage" },
                  { kind: "clause", propertyId: "status", operator: "equals", value: "plan" },
                ],
              },
            ],
          },
          [taskStatus],
        ),
      ).toEqual([
        {
          key: "status",
          label: "Status",
          value: "Incoming, Queued",
        },
      ]);
    });

    test("resolves tag identities only through the bounded option registry", () => {
      const tags: DataSourcePropertyRecordV2 = {
        ...property("tags", "Tags"),
        ...testPropertySemantics("multi_select", 1),
        valueType: "multi_select",
        config: {},
      };
      const filter = {
        kind: "clause" as const,
        propertyId: "tags",
        operator: "contains" as const,
        value: "o_AAAAAAAA",
      };

      expect(
        summarizeDatabaseViewFilter(filter, [tags], {
          tags: [{ id: "o_AAAAAAAA", name: "Product" }],
        }),
      ).toEqual([
        {
          key: "tags",
          label: "Tags",
          value: "Any: Product",
        },
      ]);
      expect(summarizeDatabaseViewFilter(filter, [tags])).toEqual([
        {
          key: "tags",
          label: "Tags",
          value: "Any: Unknown option",
        },
      ]);
    });

    test("treats only canonical manual ordering as the default", () => {
      expect(
        hasCustomDatabaseViewSort([
          {
            field: { kind: "manual" },
            direction: "asc",
            nulls: "last",
          },
        ]),
      ).toBe(false);
      expect(
        hasCustomDatabaseViewSort([
          {
            field: { kind: "title" },
            direction: "asc",
            nulls: "last",
          },
        ]),
      ).toBe(true);
    });

    test("uses direction language that matches the selected Property semantics", () => {
      const numeric = {
        ...property("p_number00", "Estimate"),
        ...testPropertySemantics("number"),
        valueType: "number" as const,
      };
      expect(
        databaseViewSortDirectionLabels(
          {
            field: { kind: "property", propertyId: numeric.propertyId },
            direction: "asc",
            nulls: "last",
          },
          [numeric],
        ),
      ).toEqual(["Low to high", "High to low"]);
      expect(
        databaseViewSortDirectionLabels(
          { field: { kind: "created" }, direction: "desc", nulls: "last" },
          [],
        ),
      ).toEqual(["Earliest first", "Latest first"]);
    });
  });
});

describe("database view task filter", () => {
  const timestamp = "2026-08-12T00:00:00.000Z";
  const dataSourceId = parseDataSourceId("source:task-filter");
  const property = (
    propertyId: "status" | "priority" | "tags",
    valueType: "select" | "multi_select",
  ): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId,
    name: propertyId[0]!.toUpperCase() + propertyId.slice(1),
    ...testPropertySemantics(valueType, 2),
    valueType,
    config: {
      options: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    },
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const capabilities = resolveDatabaseTaskFilterCapabilities([
    property("status", "select"),
    property("priority", "select"),
    property("tags", "multi_select"),
  ]);

  describe("database task filter adapter", () => {
    test("projects an empty durable filter into the familiar all-selected task controls", () => {
      const decoded = decodeDatabaseTaskFilter(
        { kind: "group", operator: "and", children: [] },
        capabilities,
      );

      expect(decoded?.groups).toEqual([createDefaultDatabaseTaskFilterGroup(capabilities)]);
      expect(encodeDatabaseTaskFilter(decoded!, capabilities)).toEqual({
        kind: "group",
        operator: "and",
        children: [],
      });
    });

    test("round-trips multi-choice status, empty priority, and tag modes", () => {
      const encoded = encodeDatabaseTaskFilter(
        {
          groups: [
            {
              status: { selectedOptionIds: ["a"], includeEmpty: false },
              priority: { selectedOptionIds: ["b"], includeEmpty: true },
              tags: { selectedOptionIds: ["a", "b"], mode: "all" },
            },
          ],
        },
        capabilities,
      );

      expect(decodeDatabaseTaskFilter(encoded, capabilities)).toEqual({
        groups: [
          {
            status: { selectedOptionIds: ["a"], includeEmpty: false },
            priority: { selectedOptionIds: ["b"], includeEmpty: true },
            tags: { selectedOptionIds: ["a", "b"], mode: "all" },
          },
        ],
      });
    });

    test("declines filters that require the generic editor", () => {
      expect(
        decodeDatabaseTaskFilter(
          {
            kind: "clause",
            propertyId: "custom:text",
            operator: "contains",
            value: "agent",
          },
          capabilities,
        ),
      ).toBeNull();
    });

    test("keeps an all-deselected choice representable without falling back", () => {
      const encoded = encodeDatabaseTaskFilter(
        {
          groups: [
            {
              ...createDefaultDatabaseTaskFilterGroup(capabilities),
              status: { selectedOptionIds: [], includeEmpty: false },
            },
          ],
        },
        capabilities,
      );

      expect(decodeDatabaseTaskFilter(encoded, capabilities)?.groups[0]?.status).toEqual({
        selectedOptionIds: [],
        includeEmpty: false,
      });
    });
  });
});

describe("db view prefs", () => {
  function makeCard(overrides: Partial<DbViewCardRecord>): DbViewCardRecord {
    const title = overrides.title ?? "Card title";
    return {
      id: "card-1",
      status: "plan",
      archived: false,
      title,
      richTitle: overrides.richTitle ?? plainTextToPortableRichText(title),
      descriptionPreview: "",
      descriptionLength: 0,
      hasDescription: false,
      priority: "p2-medium",
      estimate: "m",
      tags: [],
      assignee: null,
      created: new Date("2026-02-10T00:00:00.000Z"),
      order: 0,
      columnId: "plan",
      columnName: "Plan",
      boardIndex: 0,
      ...overrides,
      pageKey: overrides.pageKey ?? null,
    };
  }

  describe("db view prefs", () => {
    test("normalizes persisted prefs per view and falls back invalid values", () => {
      const normalized = normalizeDbViewPrefs("list", {
        summaryExpanded: false,
        rules: {
          filter: {
            any: [
              {
                all: [{ field: "status", op: "in", values: ["plan"] }],
              },
            ],
          },
          sort: [
            { field: "assignee", direction: "asc" },
            { field: "invalid", direction: "desc" },
          ],
        },
        toggleListDisplay: {
          propertyOrder: ["status", "priority"],
          hiddenProperties: ["priority"],
          showEmptyEstimate: true,
        },
      });

      expect(normalized.summaryExpanded).toBe(false);
      expect(normalized.rules.sort[0]?.field).toBe("assignee");
      expect(JSON.stringify(normalized.display.propertyOrder)).toBe(JSON.stringify([]));
      expect(JSON.stringify(normalized.display.hiddenProperties)).toBe(JSON.stringify([]));
      expect(normalized.display.showEmptyEstimate).toBe(true);
    });

    test("upgrades legacy workflow filters once and returns canonical order", () => {
      const normalized = normalizeDbViewPrefs("list", {
        rules: {
          filter: {
            any: [
              {
                all: [
                  {
                    field: "status",
                    op: "in",
                    values: ["done", "draft", "in_review", "unknown", "done"],
                  },
                ],
              },
            ],
          },
        },
      });

      expect(normalized.rules.filter.any[0]?.all[0]).toEqual({
        field: "status",
        op: "in",
        values: ["triage", "review", "done"],
      });
      expect(normalizeDbViewPrefs("list", normalized)).toEqual(normalized);
    });

    test("upgrades retired P4 only at the legacy preference boundary", () => {
      const value = {
        rules: {
          filter: {
            any: [
              {
                all: [
                  {
                    field: "priority",
                    op: "in",
                    values: ["p4-later", "p3-low", "p4-later"],
                    includeEmpty: false,
                  },
                ],
              },
            ],
          },
        },
      };

      expect(normalizeLegacyDbViewPrefs("list", value).rules.filter).toEqual({
        any: [
          {
            all: [
              {
                field: "priority",
                op: "in",
                values: ["p3-low"],
                includeEmpty: false,
              },
            ],
          },
        ],
      });
      const currentBoundaryValue = {
        rules: {
          filter: {
            any: [
              {
                all: [
                  {
                    field: "priority",
                    op: "in",
                    values: ["p4-later"],
                    includeEmpty: false,
                  },
                ],
              },
            ],
          },
        },
      };
      expect(normalizeDbViewPrefs("list", currentBoundaryValue).rules.filter).toEqual({
        any: [
          {
            all: [
              {
                field: "priority",
                op: "in",
                values: [],
                includeEmpty: false,
              },
            ],
          },
        ],
      });
    });

    test("preserves omitted v1 empty-priority semantics across the P4 cutover", () => {
      const normalize = (values: string[]) =>
        normalizeLegacyDbViewPrefs("list", {
          rules: {
            filter: {
              any: [
                {
                  all: [{ field: "priority", op: "in", values }],
                },
              ],
            },
          },
        }).rules.filter.any[0]?.all[0];

      expect(normalize(["p0-critical", "p1-high", "p2-medium", "p3-low"])).toMatchObject({
        includeEmpty: false,
      });
      expect(
        normalize(["p0-critical", "p1-high", "p2-medium", "p3-low", "p4-later"]),
      ).toMatchObject({
        includeEmpty: true,
      });
    });

    test("migrates legacy toggle-list display prefs onto the generic display field", () => {
      const normalized = normalizeDbViewPrefs("toggle-list", {
        toggleListDisplay: {
          propertyOrder: ["status", "priority"],
          hiddenProperties: ["priority"],
          showEmptyEstimate: true,
        },
      });

      expect(JSON.stringify(normalized.display.propertyOrder)).toBe(
        JSON.stringify(["status", "priority", "estimate", "tags"]),
      );
      expect(JSON.stringify(normalized.display.hiddenProperties)).toBe(
        JSON.stringify(["priority"]),
      );
      expect(normalized.display.showEmptyEstimate).toBe(true);
    });

    test("uses board-specific display properties by default", () => {
      const prefs = getDefaultDbViewPrefs("board");

      expect(JSON.stringify(prefs.display.propertyOrder)).toBe(
        JSON.stringify(["priority", "estimate", "tags", "assignee"]),
      );
      expect(JSON.stringify(prefs.display.hiddenProperties)).toBe(JSON.stringify([]));
    });

    test("filterDbViewCards applies shared status and tag rules", () => {
      const prefs = getDefaultDbViewPrefs("board");
      prefs.rules.filter.any = [
        {
          all: [
            { field: "status", op: "in", values: ["doing"] },
            { field: "tags", op: "hasAny", values: ["ops"] },
          ],
        },
      ];

      const filtered = filterDbViewCards(
        [
          makeCard({ id: "a", columnId: "doing", tags: ["ops"] }),
          makeCard({ id: "b", columnId: "doing", tags: ["design"], boardIndex: 1 }),
          makeCard({ id: "c", columnId: "plan", tags: ["ops"], boardIndex: 2 }),
        ],
        prefs.rules,
      );

      expect(filtered.map((card) => card.id).join(",")).toBe("a");
    });

    test("filterDbViewCards respects explicit empty-priority selection", () => {
      const prefs = getDefaultDbViewPrefs("board");
      prefs.rules.filter.any = [
        {
          all: [
            { field: "status", op: "in", values: ["plan"] },
            { field: "priority", op: "in", values: [], includeEmpty: true },
          ],
        },
      ];

      const filtered = filterDbViewCards(
        [
          makeCard({ id: "a", priority: undefined }),
          makeCard({ id: "b", priority: "p1-high", boardIndex: 1 }),
        ],
        prefs.rules,
      );

      expect(filtered.map((card) => card.id).join(",")).toBe("a");
    });

    test("normalization preserves explicit empty-only priority filters", () => {
      const normalized = normalizeDbViewPrefs("board", {
        rules: {
          filter: {
            any: [
              {
                all: [
                  { field: "status", op: "in", values: ["plan"] },
                  { field: "priority", op: "in", values: [], includeEmpty: true },
                ],
              },
            ],
          },
          sort: [{ field: "board-order", direction: "asc" }],
        },
      });

      const priorityClause = normalized.rules.filter.any[0]?.all[1];
      expect(JSON.stringify(priorityClause)).toBe(
        JSON.stringify({
          field: "priority",
          op: "in",
          values: [],
          includeEmpty: true,
        }),
      );
    });

    test("normalization preserves explicit empty status filters", () => {
      const normalized = normalizeDbViewPrefs("board", {
        rules: {
          filter: {
            any: [
              {
                all: [{ field: "status", op: "in", values: [] }],
              },
            ],
          },
          sort: [{ field: "board-order", direction: "asc" }],
        },
      });

      expect(JSON.stringify(normalized.rules.filter.any[0]?.all[0])).toBe(
        JSON.stringify({
          field: "status",
          op: "in",
          values: [],
        }),
      );
    });

    test("sortDbViewCards supports list-specific assignee sorting", () => {
      const prefs = getDefaultDbViewPrefs("list");
      prefs.rules.sort = [{ field: "assignee", direction: "asc" }];

      const sorted = sortDbViewCards(
        [
          makeCard({ id: "c", assignee: { kind: "member", member_id: "zoe" }, boardIndex: 2 }),
          makeCard({ id: "a", assignee: { kind: "member", member_id: "anna" }, boardIndex: 0 }),
          makeCard({ id: "b", assignee: { kind: "member", member_id: "mika" }, boardIndex: 1 }),
        ],
        prefs.rules,
      );

      expect(sorted.map((card) => card.id).join(",")).toBe("a,b,c");
    });

    test("sortDbViewCards can place empty priorities first", () => {
      const prefs = getDefaultDbViewPrefs("board");
      prefs.rules.sort = [{ field: "priority", direction: "asc", emptyPlacement: "first" }];

      const sorted = sortDbViewCards(
        [
          makeCard({ id: "filled-low", priority: "p2-medium", boardIndex: 2 }),
          makeCard({ id: "empty", priority: undefined, boardIndex: 1 }),
          makeCard({ id: "filled-high", priority: "p1-high", boardIndex: 0 }),
        ],
        prefs.rules,
      );

      expect(sorted.map((card) => card.id).join(",")).toBe("empty,filled-high,filled-low");
    });

    test("sortDbViewCards keeps empty estimates first even on descending sorts", () => {
      const prefs = getDefaultDbViewPrefs("list");
      prefs.rules.sort = [{ field: "estimate", direction: "desc", emptyPlacement: "first" }];

      const sorted = sortDbViewCards(
        [
          makeCard({ id: "small", estimate: "s", boardIndex: 2 }),
          makeCard({ id: "empty", estimate: undefined, boardIndex: 1 }),
          makeCard({ id: "large", estimate: "xl", boardIndex: 0 }),
        ],
        prefs.rules,
      );

      expect(sorted.map((card) => card.id).join(",")).toBe("empty,large,small");
    });

    test("hasActiveDbViewRules respects per-view defaults", () => {
      const boardPrefs = getDefaultDbViewPrefs("board");
      const listPrefs = getDefaultDbViewPrefs("list");

      expect(hasActiveDbViewRules("board", boardPrefs.rules)).toBe(false);
      expect(hasActiveDbViewRules("list", listPrefs.rules)).toBe(false);

      boardPrefs.rules.sort = [{ field: "priority", direction: "asc" }];
      expect(hasActiveDbViewRules("board", boardPrefs.rules)).toBe(true);
    });
  });
});
