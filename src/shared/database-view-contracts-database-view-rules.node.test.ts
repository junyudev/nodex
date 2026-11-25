import { describe, expect, test, it } from "vite-plus/test";
import { evaluateDatabaseViewFilter, type DatabaseViewRules } from "./database-kernel";
import {
  clearDatabaseViewRulesOverrideScope,
  databaseViewFilterClauseIsEmpty,
  effectiveDatabaseViewFilter,
} from "./database-view-rules";
import { evaluateDatabaseViewRows, type DatabaseViewReadModel } from "./database-views";
import type { DatabasePageSummary } from "./types";
import {
  legacyPrioritySelectionIncludesEveryAssigned,
  upgradeLegacyPriority,
} from "./priority-cutover";
import {
  PRIORITY_VALUES,
  comparePriorities,
  isPriority,
  parsePriority,
  priorityRank,
} from "./priority";
import {
  LEGACY_WORKFLOW_STATUS_ORDER,
  WORKFLOW_STATUS_CUTOVER_MAP,
  upgradeLegacyWorkflowStatus,
} from "./workflow-status-cutover";
import {
  WORKFLOW_STATUS_ORDER,
  COMPLETED_WORKFLOW_STATUS,
  DEFAULT_WORKFLOW_STATUS_COLUMNS,
  compareWorkflowStatuses,
  isWorkflowStatus,
  resolveWorkflowStatusName,
} from "./workflow-status";

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
        children: [{ kind: "clause", propertyId: "status", operator: "select_is", value: "doing" }],
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
              { kind: "clause", propertyId: "status", operator: "select_is", value: "doing" },
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
              { kind: "clause", propertyId: "status", operator: "select_is", value: "doing" },
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

    let propertyReads = 0;
    const readProperty = (propertyId: string) => {
      propertyReads += 1;
      return values.get(propertyId);
    };
    let matches = 0;
    for (let row = 0; row < 1_000; row += 1) {
      if (evaluateDatabaseViewFilter(filter, readProperty)) matches += 1;
    }

    expect(matches).toBe(1_000);
    expect(propertyReads).toBeLessThanOrEqual(1_000 * values.size);
  });
});

describe("database views", () => {
  const makePage = (id: string): DatabasePageSummary => ({
    id,
    pageKey: null,
    status: "doing",
    archived: false,
    title: id,
    richTitle: [{ type: "text", text: id, styles: {} }],
    priority: undefined,
    tags: [],
    created: new Date("2026-01-01T00:00:00.000Z"),
    order: 0,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  });

  const makeReadModel = (includeHostPage: boolean): DatabaseViewReadModel => ({
    statusOptions: [],
    libraryId: "library:test",
    storeEpoch: "epoch:test",
    commitSeq: 1,
    dataSourceId: "data-source:test",
    view: {
      id: "view:test",
      databaseBlockId: "database:test",
      projectId: "project:test",
      name: "Test",
      layout: "list",
      config: { options: { includeHostPage } },
      isPrimary: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    rows: ["host", "sibling"].map((id) => ({
      page: makePage(id),
      groupKey: null,
      subgroupKey: null,
      rankKey: id,
    })),
  });

  describe("durable Database View contracts", () => {
    test("hides the host Page unless the canonical View opts in", () => {
      expect(evaluateDatabaseViewRows(makeReadModel(false), { hostBlockId: "host" })).toHaveLength(
        1,
      );
      expect(evaluateDatabaseViewRows(makeReadModel(true), { hostBlockId: "host" })).toHaveLength(
        2,
      );
    });
  });
});

describe("priority cutover", () => {
  test("maps retired P4 to the current lowest assigned priority", () => {
    expect(upgradeLegacyPriority("p4-later")).toBe("p3-low");
    expect(upgradeLegacyPriority("p0-critical")).toBe("p0-critical");
    expect(upgradeLegacyPriority("unknown")).toBeNull();
    expect(upgradeLegacyPriority(null)).toBeNull();
  });

  test("derives legacy include-empty semantics before collapsing P4 into P3", () => {
    expect(
      legacyPrioritySelectionIncludesEveryAssigned([
        "p0-critical",
        "p1-high",
        "p2-medium",
        "p3-low",
      ]),
    ).toBe(false);
    expect(
      legacyPrioritySelectionIncludesEveryAssigned([
        "p0-critical",
        "p1-high",
        "p2-medium",
        "p3-low",
        "p4-later",
      ]),
    ).toBe(true);
  });
});

describe("priority", () => {
  test("defines the four assigned levels in stable rank order", () => {
    expect(PRIORITY_VALUES).toEqual(["p0-critical", "p1-high", "p2-medium", "p3-low"]);
    expect(PRIORITY_VALUES.map(priorityRank)).toEqual([0, 1, 2, 3]);
    expect(comparePriorities("p0-critical", "p3-low")).toBeLessThan(0);
  });

  test("accepts current priorities and rejects retired or malformed values", () => {
    for (const priority of PRIORITY_VALUES) {
      expect(isPriority(priority)).toBe(true);
      expect(parsePriority(priority)).toBe(priority);
    }

    for (const value of ["p4-later", "unknown", null, 4, {}]) {
      expect(isPriority(value)).toBe(false);
      expect(() => parsePriority(value)).toThrow(TypeError);
    }
  });
});

describe("workflow status cutover", () => {
  it("maps every legacy status bijectively and preserves workflow order", () => {
    const mapped = LEGACY_WORKFLOW_STATUS_ORDER.map(
      (status) => WORKFLOW_STATUS_CUTOVER_MAP[status],
    );

    expect(mapped).toEqual(WORKFLOW_STATUS_ORDER);
    expect(new Set(mapped).size).toBe(WORKFLOW_STATUS_ORDER.length);
  });

  it("normalizes legacy and current values at migration boundaries", () => {
    expect(upgradeLegacyWorkflowStatus("draft")).toBe("triage");
    expect(upgradeLegacyWorkflowStatus("in_progress")).toBe("doing");
    expect(upgradeLegacyWorkflowStatus("in_review")).toBe("review");
    expect(upgradeLegacyWorkflowStatus("done")).toBe("done");
    expect(upgradeLegacyWorkflowStatus("doing")).toBe("doing");
    expect(upgradeLegacyWorkflowStatus("build")).toBe("doing");
    expect(upgradeLegacyWorkflowStatus("ship")).toBe("done");
    expect(upgradeLegacyWorkflowStatus("unknown")).toBeNull();
    expect(upgradeLegacyWorkflowStatus(null)).toBeNull();
  });
});

describe("Page workflow status", () => {
  it("uses the fixed domain-neutral workflow and completes at Done", () => {
    expect(DEFAULT_WORKFLOW_STATUS_COLUMNS).toEqual([
      { id: "triage", name: "Triage" },
      { id: "plan", name: "Todo" },
      { id: "doing", name: "In Progress" },
      { id: "review", name: "In Review" },
      { id: "done", name: "Done" },
      { id: "canceled", name: "Canceled" },
    ]);
    expect(COMPLETED_WORKFLOW_STATUS).toBe("done");
    expect(compareWorkflowStatuses("doing", "review")).toBeLessThan(0);
    expect(compareWorkflowStatuses("review", "done")).toBeLessThan(0);
  });

  it("rejects retired identities at ordinary input boundaries", () => {
    for (const status of ["build", "ship", "in_progress", "Done", null]) {
      expect(isWorkflowStatus(status)).toBe(false);
    }
    expect(isWorkflowStatus("doing")).toBe(true);
    expect(isWorkflowStatus("done")).toBe(true);
    expect(isWorkflowStatus("canceled")).toBe(true);
  });
});

describe("Source-owned stage names", () => {
  it("uses a renamed option without changing the stage identity", () => {
    expect(resolveWorkflowStatusName("doing", [{ id: "doing", name: "In progress" }])).toBe(
      "In progress",
    );
  });
  it("falls back for a missing stage and retains unknown identities", () => {
    expect(resolveWorkflowStatusName("doing", [])).toBe("In Progress");
    expect(resolveWorkflowStatusName("unknown", [])).toBe("unknown");
  });
});
