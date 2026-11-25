import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { createUuidV7FromTimestamp, isUuidV7 } from "./uuid-v7";
import {
  BUILT_IN_DATA_SOURCE_PROPERTY_IDS,
  canonicalizeTagName,
  createCustomOptionId,
  createCustomPropertyId,
  createInitialDatabaseIdentities,
  isBuiltInDataSourceOptionId,
  isBuiltInDataSourcePropertyId,
  isReservedDataSourcePropertyId,
  parseDatabaseId,
  parseDataSourceOptionId,
  parseDataSourcePropertyId,
  type DataSourceOptionRef,
  type DataSourcePropertyRef,
  parseDatabaseViewId,
  parseDataSourceId,
} from "./database-identities";
import type { DatabaseModuleReadSnapshotV2, DatabaseViewQueryResultV2 } from "./database-module-v2";
import {
  compileDatabasePageDrag,
  compileDatabasePagesDrag,
  DatabasePageDragError,
} from "./database-page-drag";
import {
  upgradeDatabaseViewConfigV2,
  compactDatabaseViewPresentationOverride,
  databaseViewFractionalOrderDirection,
  databaseViewGesturePresentationOverride,
  databaseViewPrimaryManualOrderDirection,
  resolveEffectiveDatabaseView,
  type DatabaseViewCapabilities,
} from "./database-view-presentation";
import { testPropertyManagement } from "./testing/database-property-record";
import {
  type DatabaseViewConfigV2,
  type DatabaseViewPresentationConfig,
  type DatabaseViewRules,
  DatabaseMutationContractError,
  parseDatabaseViewConfigV6,
  parseDatabaseViewPresentationOverride,
} from "./database-kernel";

describe("database identities", () => {
  const deterministicBytes = (length: number): Uint8Array => {
    expect(length).toBe(6);
    return Uint8Array.from([0, 1, 2, 253, 254, 255]);
  };

  describe("database identities", () => {
    test("allocates independent UUID-v7 identities for an initial Database", () => {
      const identities = createInitialDatabaseIdentities();

      expect(isUuidV7(identities.databaseId)).toBe(true);
      expect(isUuidV7(identities.dataSourceId)).toBe(true);
      expect(isUuidV7(identities.viewId)).toBe(true);
      expect(new Set(Object.values(identities))).toHaveLength(3);
    });

    test("validates injected UUID values and rejects coupled allocation", () => {
      const values = [
        createUuidV7FromTimestamp(1_762_400_000_000, 0),
        createUuidV7FromTimestamp(1_762_400_000_000, 1),
        createUuidV7FromTimestamp(1_762_400_000_000, 2),
      ];
      const identities = createInitialDatabaseIdentities(() => values.shift()!);

      expect(identities).toEqual({
        databaseId: createUuidV7FromTimestamp(1_762_400_000_000, 0),
        dataSourceId: createUuidV7FromTimestamp(1_762_400_000_000, 1),
        viewId: createUuidV7FromTimestamp(1_762_400_000_000, 2),
      });

      const duplicate = createUuidV7FromTimestamp(1_762_400_000_001, 0);
      expect(() => createInitialDatabaseIdentities(() => duplicate)).toThrow(
        "independently allocated",
      );
      expect(() => createInitialDatabaseIdentities(() => "not-a-uuid")).toThrow(
        "canonical lowercase UUID-v7",
      );
    });

    test("keeps existing global identities opaque while validating their transport form", () => {
      expect(parseDatabaseId("database:legacy:primary")).toBe("database:legacy:primary");
      expect(() => parseDatabaseId(" database:legacy:primary ")).toThrow(
        "canonical non-empty identity",
      );
      expect(() => parseDatabaseId("database:\nlegacy")).toThrow("canonical non-empty identity");
    });

    test("generates eight base64url characters from exactly six bytes", () => {
      expect(createCustomPropertyId(deterministicBytes)).toBe("p_AAEC_f7_");
      expect(createCustomOptionId(deterministicBytes)).toBe("o_AAEC_f7_");
      expect(createCustomPropertyId()).toMatch(/^p_[A-Za-z0-9_-]{8}$/u);
      expect(createCustomOptionId()).toMatch(/^o_[A-Za-z0-9_-]{8}$/u);

      expect(() => createCustomPropertyId(() => new Uint8Array(5))).toThrow("exactly 6 bytes");
      expect(() =>
        createCustomOptionId((() => [0, 1, 2, 3, 4, 5]) as unknown as (
          length: number,
        ) => Uint8Array),
      ).toThrow("must return Uint8Array");
    });

    test("accepts only reserved or compact Property identities", () => {
      expect(BUILT_IN_DATA_SOURCE_PROPERTY_IDS).toEqual([
        "status",
        "priority",
        "estimate",
        "tags",
        "due_date",
        "scheduled_start",
        "scheduled_end",
        "assignee",
        "owner",
        "task_parent",
        "blocked_by",
      ]);
      for (const propertyId of BUILT_IN_DATA_SOURCE_PROPERTY_IDS) {
        expect(parseDataSourcePropertyId(propertyId)).toBe(propertyId);
        expect(isBuiltInDataSourcePropertyId(propertyId)).toBe(true);
        expect(isReservedDataSourcePropertyId(propertyId)).toBe(true);
      }
      expect(parseDataSourcePropertyId("p_0123abcd")).toBe("p_0123abcd");
      for (const invalid of [
        "p_0123abc",
        "p_0123abcde",
        "o_0123abcd",
        "database:project:primary:property:status",
        "550e8400-e29b-41d4-a716-446655440000",
        " status",
      ]) {
        expect(() => parseDataSourcePropertyId(invalid)).toThrow();
      }
    });

    test("validates built-in option identities against their owning Property", () => {
      expect(isBuiltInDataSourceOptionId("status", "done")).toBe(true);
      expect(isBuiltInDataSourceOptionId("priority", "p0-critical")).toBe(true);
      expect(isBuiltInDataSourceOptionId("estimate", "xs")).toBe(true);
      expect(isBuiltInDataSourceOptionId("priority", "done")).toBe(false);
      for (const priority of ["p0-critical", "p1-high", "p2-medium", "p3-low"]) {
        expect(parseDataSourceOptionId({ propertyId: "priority", value: priority })).toBe(priority);
      }
      expect(() =>
        parseDataSourceOptionId({
          propertyId: "priority",
          value: "p4-later",
        }),
      ).toThrow("not valid");
      expect(isBuiltInDataSourceOptionId("tags", "done")).toBe(false);
      expect(isBuiltInDataSourceOptionId("toString", "call")).toBe(false);

      expect(parseDataSourceOptionId({ propertyId: "status", value: "done" })).toBe("done");
      expect(
        parseDataSourceOptionId({
          propertyId: "tags",
          value: "o_0123abcd",
        }),
      ).toBe("o_0123abcd");
      expect(
        parseDataSourceOptionId({
          propertyId: "p_abcdefgh",
          value: "o_0123abcd",
        }),
      ).toBe("o_0123abcd");

      expect(() => parseDataSourceOptionId({ propertyId: "priority", value: "done" })).toThrow(
        "not valid",
      );
      expect(() => parseDataSourceOptionId({ propertyId: "status", value: "ship" })).toThrow(
        "not valid",
      );
      expect(() => parseDataSourceOptionId({ propertyId: "tags", value: "bug" })).toThrow(
        "not valid",
      );
      expect(() =>
        parseDataSourceOptionId({
          propertyId: "priority",
          value: "o_0123abcd",
        }),
      ).toThrow("not valid");
      expect(() =>
        parseDataSourceOptionId({
          propertyId: "due_date",
          value: "o_0123abcd",
        }),
      ).toThrow("not valid");
    });

    test("canonicalizes tag names before applying caller-owned bounds", () => {
      expect(canonicalizeTagName("  Cafe\u0301  ")).toBe("Café");
      expect(canonicalizeTagName("\u0085ui\u0085")).toBe("ui");
      expect(canonicalizeTagName("\uFEFFui\uFEFF")).toBe("\uFEFFui\uFEFF");
      expect(canonicalizeTagName("  release candidate  ", { maxLength: 17 })).toBe(
        "release candidate",
      );
      expect(() => canonicalizeTagName("   ")).toThrow("must not be empty");
      expect(() => canonicalizeTagName("release", { maxLength: 6 })).toThrow("at most 6");
      expect(() => canonicalizeTagName("release", { maxLength: 0 })).toThrow(
        "positive safe integer",
      );
    });

    test("brands owner-qualified Property and option references", () => {
      const identities = createInitialDatabaseIdentities();
      const propertyRef: DataSourcePropertyRef = {
        dataSourceId: identities.dataSourceId,
        propertyId: parseDataSourcePropertyId("tags"),
      };
      const optionRef: DataSourceOptionRef = {
        ...propertyRef,
        optionId: parseDataSourceOptionId({
          propertyId: propertyRef.propertyId,
          value: "o_0123abcd",
        }),
      };

      expect(optionRef).toEqual({
        dataSourceId: identities.dataSourceId,
        propertyId: "tags",
        optionId: "o_0123abcd",
      });
      expectTypeOf(optionRef).toMatchTypeOf<DataSourceOptionRef>();
    });
  });
});

describe("database page drag", () => {
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
      work: { unsatisfiedCount: 0, blockers: [], owner: null, assignee: null, autoStart: false },
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
        row("page-a", input.status ?? "doing", "p1-high", "a", 2),
        row("page-b", "doing", "p1-high", "b", 3),
        row("page-target", "done", "p2-medium", "c", 4),
      ],
    };
    return {
      projectId: "project-1",
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: 8,
      value: { kind: "query", value: query },
    };
  };

  describe("Database Page drag compiler", () => {
    test("uses Page coordinates for a same-group manual position", () => {
      const compiled = compileDatabasePageDrag({
        move: {
          pageId: "page-b",
          fromStatus: "doing",
          toStatus: "doing",
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
          fromStatus: "doing",
          toStatus: "doing",
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
          fromStatus: "doing",
          toStatus: "done",
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
          fromStatus: "doing",
          toStatus: "done",
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
            fromStatus: "doing",
            toStatus: "done",
          },
          snapshot: querySnapshot({ status: "review" }),
        });
      } catch (error) {
        if (error instanceof DatabasePageDragError) code = error.code;
      }
      expect(code).toBe("source_status_conflict");
    });
  });
});

describe("database view presentation", () => {
  const capabilities: DatabaseViewCapabilities = {
    properties: [
      { propertyId: "status", sortable: true, groupable: true, finite: true },
      { propertyId: "priority", sortable: true, groupable: true, finite: true },
      { propertyId: "estimate", sortable: true, groupable: false, finite: false },
      { propertyId: "notes", sortable: false, groupable: false, finite: false },
    ],
    taskStatusPropertyId: "status",
  };

  const presentation: DatabaseViewPresentationConfig = {
    conditionalColors: [],
    group: { propertyId: "status" },
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: false },
    display: {
      fields: [
        { kind: "property", propertyId: "priority" },
        { kind: "intrinsic", field: "updated_at" },
      ],
      propertyOrder: ["priority"],
      showEmptyGroups: false,
      showDescription: true,
    },
  };

  const rules: DatabaseViewRules = {
    propertyFilters: [],
    advancedFilter: null,
    sorts: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
  };

  describe("Database View presentation", () => {
    test("freezes a gesture without creating a second layout identity", () => {
      const effective = resolveEffectiveDatabaseView(
        "board",
        presentation,
        { group: { propertyId: "priority" }, display: { showDescription: false } },
        capabilities,
      );

      expect(databaseViewGesturePresentationOverride(effective)).toEqual({
        group: { propertyId: "priority" },
        subgroup: null,
        groupDirection: "asc",
        completion: { range: "all", orderByRecency: false },
        hierarchy: { showSubPages: true, nestedSubPages: false },
        display: effective.presentation.display,
      });
    });

    test("keeps the durable layout authoritative over personal presentation", () => {
      const effective = resolveEffectiveDatabaseView(
        "board",
        presentation,
        { display: { fields: [{ kind: "property", propertyId: "estimate" }] } },
        capabilities,
      );

      expect(effective.layout).toBe("board");
      expect(effective.presentation.display.fields).toEqual([
        { kind: "property", propertyId: "estimate" },
      ]);
      expect(() => parseDatabaseViewPresentationOverride({ layout: "list" })).toThrow(
        DatabaseMutationContractError,
      );
    });

    test("resolves primary manual order independently from fractional tie-breaking", () => {
      const propertySort = [
        {
          field: { kind: "property" as const, propertyId: "priority" },
          direction: "desc" as const,
          nulls: "last" as const,
        },
      ];
      expect(databaseViewPrimaryManualOrderDirection([])).toBe("asc");
      expect(databaseViewPrimaryManualOrderDirection(rules.sorts)).toBe("asc");
      expect(databaseViewPrimaryManualOrderDirection(propertySort)).toBeNull();
      expect(databaseViewFractionalOrderDirection(propertySort)).toBe("asc");
      expect(
        databaseViewFractionalOrderDirection([
          propertySort[0]!,
          { field: { kind: "manual" }, direction: "desc", nulls: "last" },
        ]),
      ).toBe("desc");
    });

    test("parses only the canonical v6 rules and presentation shape", () => {
      expect(
        parseDatabaseViewConfigV6({
          schemaKey: "nodex.database-view",
          schemaVersion: 6,
          rules,
          presentation,
        }),
      ).toEqual({
        schemaKey: "nodex.database-view",
        schemaVersion: 6,
        rules,
        presentation,
      });
      expect(() =>
        parseDatabaseViewConfigV6({
          schemaKey: "nodex.database-view",
          schemaVersion: 6,
          rules,
          presentation: {
            ...presentation,
            display: {
              ...presentation.display,
              fields: [{ kind: "intrinsic", field: "page_id" }],
            },
          },
        }),
      ).toThrow(DatabaseMutationContractError);
      expect(() =>
        parseDatabaseViewConfigV6({
          schemaKey: "nodex.database-view",
          schemaVersion: 6,
          rules: {
            propertyFilters: [
              {
                filterId: "filter-tags",
                clause: {
                  kind: "clause",
                  propertyId: "tags",
                  operator: "multi_select_contains",
                  value: "legacy-scalar",
                },
              },
            ],
            advancedFilter: null,
            sorts: [],
          },
          presentation,
        }),
      ).toThrow("non-empty identity list");
      expect(() =>
        parseDatabaseViewConfigV6({
          schemaKey: "nodex.database-view",
          schemaVersion: 6,
          rules: {
            propertyFilters: [],
            advancedFilter: {
              kind: "group",
              operator: "and",
              children: [
                {
                  kind: "clause",
                  propertyId: "due",
                  operator: "date_relative_to",
                  value: { direction: "past", count: 0, unit: "week" },
                },
              ],
            },
            sorts: [],
          },
          presentation,
        }),
      ).toThrow("count must be an integer");
    });

    test("upgrades v2 to one canonical display", () => {
      const config: DatabaseViewConfigV2 = {
        schemaKey: "nodex.database-view",
        schemaVersion: 2,
        filter: { kind: "group", operator: "and", children: [] },
        sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
        group: { propertyId: "status" },
        display: { propertyIds: ["priority", "estimate"], showTitle: false },
      };

      expect(upgradeDatabaseViewConfigV2(config).presentation.display).toEqual({
        fields: [
          { kind: "property", propertyId: "priority" },
          { kind: "property", propertyId: "estimate" },
        ],
        propertyOrder: ["priority", "estimate"],
        showEmptyGroups: false,
        showDescription: true,
      });
    });

    test("normalizes stale properties and capability-dependent controls", () => {
      const effective = resolveEffectiveDatabaseView(
        "list",
        presentation,
        {
          group: { propertyId: "priority" },
          subgroup: { propertyId: "priority" },
          completion: { range: "past_week", orderByRecency: true },
          display: {
            fields: [
              { kind: "property", propertyId: "missing" },
              { kind: "property", propertyId: "estimate" },
              { kind: "property", propertyId: "estimate" },
            ],
            propertyOrder: ["missing", "estimate", "priority", "estimate"],
            showEmptyGroups: true,
          },
        },
        capabilities,
        rules,
        {
          sorts: [
            { field: { kind: "property", propertyId: "notes" }, direction: "asc", nulls: "last" },
            {
              field: { kind: "property", propertyId: "priority" },
              direction: "desc",
              nulls: "last",
            },
          ],
        },
      );

      expect(effective).toMatchObject({
        layout: "list",
        rules: {
          sorts: [
            {
              field: { kind: "property", propertyId: "priority" },
              direction: "desc",
              nulls: "last",
            },
          ],
        },
        presentation: {
          group: { propertyId: "priority" },
          subgroup: null,
          display: {
            fields: [{ kind: "property", propertyId: "estimate" }],
            propertyOrder: ["estimate", "priority", "status", "notes"],
            showEmptyGroups: true,
          },
        },
      });
    });

    test("keeps a complete View-owned order for shown and hidden Properties", () => {
      const durable = resolveEffectiveDatabaseView("board", presentation, undefined, capabilities);
      const desired = resolveEffectiveDatabaseView(
        "board",
        presentation,
        { display: { propertyOrder: ["notes", "estimate", "priority", "status"] } },
        capabilities,
      );

      expect(desired.presentation.display.propertyOrder).toEqual([
        "notes",
        "estimate",
        "priority",
        "status",
      ]);
      expect(compactDatabaseViewPresentationOverride(durable, desired)).toEqual({
        display: { propertyOrder: ["notes", "estimate", "priority", "status"] },
      });
    });

    test("compacts and round-trips a personal presentation delta", () => {
      const durable = resolveEffectiveDatabaseView("board", presentation, undefined, capabilities);
      const desired = resolveEffectiveDatabaseView(
        "board",
        presentation,
        {
          group: { propertyId: "priority" },
          groupDirection: "desc",
          completion: { range: "past_month" },
          display: { fields: [{ kind: "property", propertyId: "estimate" }] },
        },
        capabilities,
      );
      const compact = compactDatabaseViewPresentationOverride(durable, desired);

      expect(compact).toEqual({
        group: { propertyId: "priority" },
        groupDirection: "desc",
        completion: { range: "past_month" },
        display: {
          fields: [{ kind: "property", propertyId: "estimate" }],
          propertyOrder: ["priority", "estimate", "status", "notes"],
        },
      });
      expect(
        resolveEffectiveDatabaseView("board", presentation, compact ?? undefined, capabilities),
      ).toEqual(desired);
      expect(compactDatabaseViewPresentationOverride(durable, durable)).toBeNull();
    });
  });
});
