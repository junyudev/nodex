import { describe, expect, test } from "vite-plus/test";
import {
  canonicalizeDatabaseMutationIntent,
  evaluateDatabaseViewConditionalColor,
  evaluateDatabaseViewFilter,
  normalizeDatabasePropertyValue,
  parseDatabaseMutationRequest,
  parseDatabasePropertyConfig,
  parseDatabaseViewConfig,
  parseDatabaseViewConfigV2,
  parseDatabaseViewConfigV6,
  type DatabaseMutationRequest,
  type DatabaseViewConfig,
} from "./database-kernel";

const viewConfig = (): DatabaseViewConfig => ({
  schemaKey: "nodex.database-view",
  schemaVersion: 1,
  filter: { kind: "group", operator: "and", children: [] },
  sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
  group: null,
  display: { propertyIds: [], showTitle: true },
});

const viewConfigV6 = () => ({
  schemaKey: "nodex.database-view" as const,
  schemaVersion: 6 as const,
  rules: { propertyFilters: [], advancedFilter: null, sorts: [] },
  presentation: {
    group: null,
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: false },
    display: {
      fields: [],
      propertyOrder: [],
      showEmptyGroups: false,
      showDescription: true,
    },
    conditionalColors: [],
  },
});

const request = (): DatabaseMutationRequest => ({
  operationId: "operation-1",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  clientSessionId: "session-1",
  actor: { kind: "test" },
  operations: [
    {
      kind: "create_database",
      databaseBlockId: "database-1",
      name: "Tasks",
      isPrimary: false,
      initialView: {
        viewId: "view-1",
        name: "Table",
        layout: "list",
        config: viewConfig(),
      },
    },
  ],
});

const fails = (operation: () => void): boolean => {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
};

describe("general Database mutation contract", () => {
  test("normalizes omitted empty rules and accepts incomplete rule-authoring drafts", () => {
    expect(
      parseDatabaseViewConfigV6({
        ...viewConfigV6(),
        rules: {},
      }).rules,
    ).toEqual({ propertyFilters: [], advancedFilter: null, sorts: [] });

    const draft = {
      kind: "clause",
      propertyId: "tags",
      operator: "multi_select_contains",
      value: [],
    };
    expect(
      parseDatabaseViewConfigV6({
        ...viewConfigV6(),
        rules: {
          propertyFilters: [{ filterId: "filter-draft", clause: draft }],
          advancedFilter: { kind: "group", operator: "and", children: [draft] },
          sorts: [],
        },
      }).rules.propertyFilters[0]?.clause,
    ).toEqual(draft);
  });

  test("accepts the full sort budget and rejects duplicate fields", () => {
    const sorts = Array.from({ length: 128 }, (_, index) => ({
      field: {
        kind: "property" as const,
        propertyId: `p_${index.toString(36).padStart(8, "0")}`,
      },
      direction: "asc" as const,
      nulls: "last" as const,
    }));
    expect(
      parseDatabaseViewConfigV6({
        ...viewConfigV6(),
        rules: { ...viewConfigV6().rules, sorts },
      }).rules.sorts,
    ).toHaveLength(128);
    expect(() =>
      parseDatabaseViewConfigV6({
        ...viewConfigV6(),
        rules: { ...viewConfigV6().rules, sorts: [sorts[0], sorts[0]] },
      }),
    ).toThrow("contains duplicate fields");
  });

  test("normalizes conditional color compatibility fields and rejects incomplete typed values", () => {
    const parsed = parseDatabaseViewConfigV6({
      ...viewConfigV6(),
      presentation: {
        ...viewConfigV6().presentation,
        conditionalColors: [
          {
            ruleId: "rule-compatible",
            propertyId: "status",
            operator: "is_not_empty",
            color: "green",
          },
        ],
      },
    });
    expect(parsed.presentation.conditionalColors[0]?.colorSource).toBe("fixed");

    expect(() =>
      parseDatabaseViewConfigV6({
        ...viewConfigV6(),
        presentation: {
          ...viewConfigV6().presentation,
          conditionalColors: [
            {
              ruleId: "rule-incomplete",
              propertyId: "status",
              operator: "select_is",
              colorSource: "property_option",
              color: "green",
            },
          ],
        },
      }),
    ).toThrow("invalid value arity");
  });

  test("resolves the first matching conditional color with typed empty and membership semantics", () => {
    const values = new Map<string, unknown>([
      ["status", "build"],
      ["tags", ["urgent", "frontend"]],
      ["estimate", 0],
      ["done", false],
      ["notes", ""],
    ]);
    const evaluate = (rules: Parameters<typeof evaluateDatabaseViewConditionalColor>[0]) =>
      evaluateDatabaseViewConditionalColor(rules, (propertyId) => values.get(propertyId) as never);

    expect(
      evaluate([
        {
          ruleId: "rule-1",
          propertyId: "status",
          operator: "equals",
          value: "build",
          colorSource: "fixed",
          color: "orange",
        },
        {
          ruleId: "rule-2",
          propertyId: "tags",
          operator: "contains",
          value: "urgent",
          colorSource: "fixed",
          color: "red",
        },
      ]),
    ).toBe("orange");
    expect(
      evaluate([
        {
          ruleId: "rule-3",
          propertyId: "notes",
          operator: "is_empty",
          colorSource: "fixed",
          color: "gray",
        },
      ]),
    ).toBe("gray");
    expect(
      evaluate([
        {
          ruleId: "rule-4",
          propertyId: "estimate",
          operator: "is_not_empty",
          colorSource: "fixed",
          color: "blue",
        },
        {
          ruleId: "rule-5",
          propertyId: "done",
          operator: "is_empty",
          colorSource: "fixed",
          color: "pink",
        },
      ]),
    ).toBe("blue");
    expect(
      evaluate([
        {
          ruleId: "rule-6",
          propertyId: "tags",
          operator: "not_contains",
          value: "urgent",
          colorSource: "fixed",
          color: "purple",
        },
      ]),
    ).toBeNull();

    expect(
      evaluateDatabaseViewConditionalColor(
        [
          {
            ruleId: "rule-option-color",
            propertyId: "tags",
            operator: "multi_select_contains",
            value: ["urgent"],
            colorSource: "property_option",
            color: "gray",
          },
        ],
        (propertyId) => values.get(propertyId) as never,
        (propertyId, optionId) => (propertyId === "tags" && optionId === "urgent" ? "red" : null),
      ),
    ).toBe("red");
    expect(
      evaluateDatabaseViewConditionalColor(
        [
          {
            ruleId: "rule-first-option-fallback",
            propertyId: "tags",
            operator: "multi_select_contains",
            value: ["urgent"],
            colorSource: "property_option",
            color: "gray",
          },
        ],
        (propertyId) => values.get(propertyId) as never,
        (_propertyId, optionId) => (optionId === "frontend" ? "blue" : null),
      ),
    ).toBeNull();
  });

  test("validates compact local Property identities in View config v2", () => {
    expect(
      parseDatabaseViewConfigV2({
        ...viewConfig(),
        schemaVersion: 2,
        filter: {
          kind: "clause",
          propertyId: "status",
          operator: "equals",
          value: "ship",
        },
        sort: [
          {
            field: { kind: "property", propertyId: "p_0123abcd" },
            direction: "asc",
            nulls: "last",
          },
        ],
        group: { propertyId: "status" },
        display: {
          propertyIds: ["status", "p_0123abcd"],
          showTitle: true,
        },
      }),
    ).toMatchObject({
      schemaKey: "nodex.database-view",
      schemaVersion: 2,
      group: { propertyId: "status" },
    });

    expect(() =>
      parseDatabaseViewConfigV2({
        ...viewConfig(),
        schemaVersion: 2,
        group: { propertyId: "database:legacy:property:status" },
      }),
    ).toThrow("propertyId must be a reserved built-in ID");
  });

  test("uses logical anchors and excludes transport attribution from retry identity", () => {
    const parsed = parseDatabaseMutationRequest(request());
    expect(parsed.operations[0]?.kind).toBe("create_database");
    const retry = {
      ...request(),
      clientSessionId: "session-2",
      actor: { kind: "cli", user: "same-human" },
    };
    expect(canonicalizeDatabaseMutationIntent(retry)).toBe(
      canonicalizeDatabaseMutationIntent(request()),
    );

    const untrustedRank = {
      ...request(),
      operations: [{ ...request().operations[0], rankKey: "client-owned" }],
    };
    expect(fails(() => parseDatabaseMutationRequest(untrustedRank))).toBe(true);
  });

  test("accepts one connected Board intent and rejects duplicate, reversed, or unrelated writes", () => {
    const value = {
      kind: "set_value" as const,
      pageId: "card-1",
      databaseBlockId: "database-1",
      propertyId: "status-property",
      expectedValueRevision: 1,
      value: "ship",
    };
    const position = {
      kind: "position_page" as const,
      viewId: "view-1",
      pageId: "card-1",
      expectedPositionRevision: 2,
      beforePageId: "card-2",
    };
    const boardDrag = parseDatabaseMutationRequest({
      ...request(),
      operations: [value, position],
    });
    expect(boardDrag.operations.length).toBe(2);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: [value, { ...value, value: "plan" }],
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: [position, value],
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: [
            value,
            {
              kind: "put_view",
              databaseBlockId: "unrelated-database",
              viewId: "unrelated-view",
              expectedRevision: 0,
              name: "Unrelated",
              layout: "list",
              config: viewConfig(),
              isPrimary: false,
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: Array.from({ length: 65 }, (_, index) => ({
            ...value,
            propertyId: `property-${index}`,
          })),
        }),
      ),
    ).toBe(true);
  });

  test("compresses a bounded ordered multi-Page drag without weakening field conflicts", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      pageId: `card-${index}`,
      propertyId: "status-property",
      expectedValueRevision: index + 1,
      value: "ship",
    }));
    const pages = entries.map((entry, index) => ({
      pageId: entry.pageId,
      expectedPositionRevision: index + 2,
    }));
    const parsed = parseDatabaseMutationRequest({
      ...request(),
      operations: [
        {
          kind: "set_values",
          databaseBlockId: "database-1",
          entries,
        },
        {
          kind: "position_pages",
          viewId: "view-1",
          pages,
          beforePageId: "external-anchor",
        },
      ],
    });
    expect(parsed.operations.length).toBe(2);
    expect(parsed.operations[0]?.kind).toBe("set_values");
    expect(parsed.operations[1]?.kind).toBe("position_pages");
    if (parsed.operations[1]?.kind !== "position_pages") {
      throw new Error("Expected bulk position operation");
    }
    expect(parsed.operations[1].pages.map((entry) => entry.pageId).join(",")).toBe(
      pages.map((entry) => entry.pageId).join(","),
    );

    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: [
            {
              kind: "set_values",
              databaseBlockId: "database-1",
              entries: [entries[0], entries[0]],
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: [
            {
              kind: "position_pages",
              viewId: "view-1",
              pages,
              groupKey: "ship",
              beforePageId: pages[0]?.pageId,
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...request(),
          operations: [
            {
              kind: "position_pages",
              viewId: "view-1",
              pages,
              groupKey: "ship",
            },
            {
              kind: "set_values",
              databaseBlockId: "database-1",
              entries,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("requires strict versioned View configs and stable option identities", () => {
    const looseConfig = {
      ...request(),
      operations: [
        {
          ...request().operations[0],
          initialView: {
            viewId: "view-1",
            name: "Loose",
            layout: "list",
            config: {},
          },
        },
      ],
    };
    expect(fails(() => parseDatabaseMutationRequest(looseConfig))).toBe(true);

    const duplicateOptions = {
      ...request(),
      operations: [
        {
          kind: "put_property",
          databaseBlockId: "database-1",
          propertyId: "property-1",
          expectedDatabaseSchemaRevision: 1,
          expectedPropertyRevision: 0,
          key: "stage",
          name: "Stage",
          valueType: "select",
          config: {
            options: [
              { id: "stable", name: "First" },
              { id: "stable", name: "Renamed" },
            ],
          },
        },
      ],
    };
    expect(fails(() => parseDatabaseMutationRequest(duplicateOptions))).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...duplicateOptions,
          operations: [
            {
              ...duplicateOptions.operations[0],
              valueType: "text",
              config: { optons: [] },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...duplicateOptions,
          operations: [
            {
              ...duplicateOptions.operations[0],
              config: {},
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("evaluates bounded recursive DNF filters with explicit empty-group semantics", () => {
    const filter = parseDatabaseViewConfig({
      ...viewConfig(),
      filter: {
        kind: "group",
        operator: "or",
        children: [
          {
            kind: "group",
            operator: "and",
            children: [
              {
                kind: "clause",
                propertyId: "stage",
                operator: "equals",
                value: "doing",
              },
              {
                kind: "clause",
                propertyId: "p_score000",
                operator: "equals",
                value: 3,
              },
            ],
          },
          {
            kind: "group",
            operator: "and",
            children: [
              {
                kind: "clause",
                propertyId: "tags",
                operator: "contains",
                value: "urgent",
              },
              {
                kind: "clause",
                propertyId: "owner",
                operator: "is_not_empty",
              },
            ],
          },
        ],
      },
    }).filter;
    const values = new Map<string, string | number | readonly string[]>([
      ["stage", "plan"],
      ["p_score000", 3],
      ["tags", ["urgent", "customer"]],
      ["owner", "person-1"],
    ]);
    expect(evaluateDatabaseViewFilter(filter, (id) => values.get(id))).toBe(true);
    expect(
      evaluateDatabaseViewFilter(
        {
          kind: "clause",
          propertyId: "tags",
          operator: "not_contains",
          value: "blocked",
        },
        (id) => values.get(id),
      ),
    ).toBe(true);
    expect(
      evaluateDatabaseViewFilter({ kind: "group", operator: "and", children: [] }, () => undefined),
    ).toBe(true);
    expect(
      evaluateDatabaseViewFilter({ kind: "group", operator: "or", children: [] }, () => undefined),
    ).toBe(false);
  });

  test("rejects recursive filters with unknown fields or excessive bounds", () => {
    expect(
      fails(() =>
        parseDatabaseViewConfig({
          ...viewConfig(),
          filter: {
            kind: "clause",
            propertyId: "stage",
            operator: "is_empty",
            typo: true,
          },
        }),
      ),
    ).toBe(true);

    let tooDeep: unknown = {
      kind: "clause",
      propertyId: "stage",
      operator: "is_empty",
    };
    for (let depth = 0; depth < 8; depth += 1) {
      tooDeep = { kind: "group", operator: "and", children: [tooDeep] };
    }
    expect(
      fails(() =>
        parseDatabaseViewConfig({
          ...viewConfig(),
          filter: tooDeep,
        }),
      ),
    ).toBe(true);
    expect(
      fails(() =>
        parseDatabaseViewConfig({
          ...viewConfig(),
          filter: {
            kind: "group",
            operator: "and",
            children: Array.from({ length: 1_024 }, (_, index) => ({
              kind: "clause",
              propertyId: `property-${index}`,
              operator: "is_empty",
            })),
          },
        }),
      ),
    ).toBe(true);
  });

  test("canonicalizes set intent and rejects overlapping set deltas", () => {
    const delta = {
      ...request(),
      operations: [
        {
          kind: "add_remove_value",
          pageId: "card-1",
          databaseBlockId: "database-1",
          propertyId: "property-1",
          add: ["b", "a", "a"],
          remove: ["c"],
        },
      ],
    };
    const parsed = parseDatabaseMutationRequest(delta);
    const operation = parsed.operations[0];
    if (operation?.kind !== "add_remove_value") {
      throw new Error("Expected add_remove_value operation");
    }
    expect(operation.add.join(",")).toBe("a,b");
    expect(operation.remove.join(",")).toBe("c");
    expect(
      fails(() =>
        parseDatabaseMutationRequest({
          ...delta,
          operations: [{ ...delta.operations[0], remove: ["a"] }],
        }),
      ),
    ).toBe(true);
  });

  test("normalizes values against the authoritative stable option registry", () => {
    const emptySelect = parseDatabasePropertyConfig("select", { options: [] });
    expect(
      fails(() =>
        normalizeDatabasePropertyValue({ valueType: "select", config: emptySelect }, "invented"),
      ),
    ).toBe(true);
    const multi = parseDatabasePropertyConfig("multi_select", {
      options: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    const normalized = normalizeDatabasePropertyValue(
      { valueType: "multi_select", config: multi },
      ["b", "a", "b"],
    );
    expect(Array.isArray(normalized) ? normalized.join(",") : "invalid").toBe("a,b");
  });
});
