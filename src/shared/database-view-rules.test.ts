import { describe, expect, test } from "vite-plus/test";

import { evaluateDatabaseViewFilter, type DatabaseViewRules } from "./database-kernel";
import {
  clearDatabaseViewRulesOverrideScope,
  databaseViewFilterClauseIsEmpty,
  effectiveDatabaseViewFilter,
} from "./database-view-rules";

describe("Database View effective rules", () => {
  test("retains empty quick filters for authoring but excludes them from the query", () => {
    const rules: DatabaseViewRules = {
      propertyFilters: [
        {
          filterId: "filter-empty",
          clause: { kind: "clause", propertyId: "name", operator: "text_contains", value: "" },
        },
      ],
      advancedFilter: null,
      sorts: [],
    };

    expect(databaseViewFilterClauseIsEmpty(rules.propertyFilters[0]!.clause)).toBe(true);
    expect(effectiveDatabaseViewFilter(rules).children).toEqual([]);
  });

  test("ANDs ordered quick filters with the advanced group", () => {
    const rules: DatabaseViewRules = {
      propertyFilters: [
        {
          filterId: "filter-name",
          clause: {
            kind: "clause",
            propertyId: "name",
            operator: "text_contains",
            value: "alpha",
          },
        },
      ],
      advancedFilter: {
        kind: "group",
        operator: "or",
        children: [{ kind: "clause", propertyId: "status", operator: "select_is", value: "build" }],
      },
      sorts: [],
    };

    expect(effectiveDatabaseViewFilter(rules)).toEqual({
      kind: "group",
      operator: "and",
      children: [rules.propertyFilters[0]!.clause, rules.advancedFilter],
    });
  });

  test("treats an incomplete date range as an empty quick filter", () => {
    expect(
      databaseViewFilterClauseIsEmpty({
        kind: "clause",
        propertyId: "due",
        operator: "date_within",
        value: { start: "2026-08-01", end: "" },
      }),
    ).toBe(true);
  });

  test("prunes incomplete advanced drafts without changing group semantics", () => {
    const rules: DatabaseViewRules = {
      propertyFilters: [],
      advancedFilter: {
        kind: "group",
        operator: "or",
        children: [
          { kind: "clause", propertyId: "name", operator: "text_contains", value: "" },
          {
            kind: "group",
            operator: "and",
            children: [
              { kind: "clause", propertyId: "status", operator: "select_is", value: "build" },
              { kind: "clause", propertyId: "tags", operator: "multi_select_contains", value: [] },
            ],
          },
        ],
      },
      sorts: [],
    };

    expect(effectiveDatabaseViewFilter(rules).children).toEqual([
      {
        kind: "group",
        operator: "or",
        children: [
          {
            kind: "group",
            operator: "and",
            children: [
              { kind: "clause", propertyId: "status", operator: "select_is", value: "build" },
            ],
          },
        ],
      },
    ]);
  });

  test("clears only the published personal rule scope", () => {
    const override = {
      propertyFilters: [],
      advancedFilter: null,
      sorts: [
        { field: { kind: "created" as const }, direction: "desc" as const, nulls: "last" as const },
      ],
    };
    expect(clearDatabaseViewRulesOverrideScope(override, "filters")).toEqual({
      sorts: override.sorts,
    });
    expect(clearDatabaseViewRulesOverrideScope(override, "sorts")).toEqual({
      propertyFilters: [],
      advancedFilter: null,
    });
    expect(clearDatabaseViewRulesOverrideScope(override, "all")).toBeNull();
  });

  test("keeps a 1,000-row pressure evaluation bounded at the authored rule limits", () => {
    const quickClauses = Array.from({ length: 32 }, (_, index) => ({
      filterId: `quick-${index}`,
      clause: {
        kind: "clause" as const,
        propertyId: `quick-property-${index}`,
        operator: "text_is" as const,
        value: "match",
      },
    }));
    const advancedClauses = Array.from({ length: 128 }, (_, index) => ({
      kind: "clause" as const,
      propertyId: `advanced-property-${index}`,
      operator: "text_is" as const,
      value: "match",
    }));
    const filter = effectiveDatabaseViewFilter({
      propertyFilters: quickClauses,
      advancedFilter: { kind: "group", operator: "and", children: advancedClauses },
      sorts: [],
    });
    const values = new Map<string, "match">(
      [...quickClauses.map((item) => item.clause), ...advancedClauses].map((clause) => [
        clause.propertyId,
        "match",
      ]),
    );

    const startedAt = performance.now();
    let matches = 0;
    for (let row = 0; row < 1_000; row += 1) {
      if (evaluateDatabaseViewFilter(filter, (propertyId) => values.get(propertyId))) matches += 1;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(matches).toBe(1_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
