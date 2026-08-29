import { describe, expect, test } from "vite-plus/test";
import type {
  DatabaseViewConfigV2,
  DatabaseViewPresentationConfig,
  DatabaseViewRules,
} from "./database-kernel";
import {
  DatabaseMutationContractError,
  parseDatabaseViewConfigV6,
  parseDatabaseViewPresentationOverride,
} from "./database-kernel";
import {
  compactDatabaseViewPresentationOverride,
  databaseViewFractionalOrderDirection,
  databaseViewGesturePresentationOverride,
  databaseViewPrimaryManualOrderDirection,
  resolveEffectiveDatabaseView,
  upgradeDatabaseViewConfigV2,
  type DatabaseViewCapabilities,
} from "./database-view-presentation";

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
