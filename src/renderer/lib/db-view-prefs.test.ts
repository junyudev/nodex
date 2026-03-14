import { describe, expect, test } from "bun:test";
import {
  filterDbViewCards,
  getDefaultDbViewPrefs,
  hasActiveDbViewRules,
  normalizeDbViewPrefs,
  sortDbViewCards,
  type DbViewCardRecord,
} from "./db-view-prefs";

function makeCard(overrides: Partial<DbViewCardRecord>): DbViewCardRecord {
  return {
    id: "card-1",
    status: "backlog",
    archived: false,
    title: "Card title",
    description: "",
    priority: "p2-medium",
    estimate: "m",
    tags: [],
    assignee: "",
    agentBlocked: false,
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "backlog",
    columnName: "Backlog",
    boardIndex: 0,
    ...overrides,
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
              all: [
                { field: "status", op: "in", values: ["backlog"] },
              ],
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

    expect(normalized.summaryExpanded).toBeFalse();
    expect(normalized.rules.sort[0]?.field).toBe("assignee");
    expect(JSON.stringify(normalized.display.propertyOrder)).toBe(JSON.stringify([]));
    expect(JSON.stringify(normalized.display.hiddenProperties)).toBe(JSON.stringify([]));
    expect(normalized.display.showEmptyEstimate).toBeTrue();
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
    expect(normalized.display.showEmptyEstimate).toBeTrue();
  });

  test("uses kanban-specific display properties by default", () => {
    const prefs = getDefaultDbViewPrefs("kanban");

    expect(JSON.stringify(prefs.display.propertyOrder)).toBe(
      JSON.stringify(["priority", "estimate", "tags", "assignee"]),
    );
    expect(JSON.stringify(prefs.display.hiddenProperties)).toBe(JSON.stringify([]));
  });

  test("filterDbViewCards applies shared status and tag rules", () => {
    const prefs = getDefaultDbViewPrefs("kanban");
    prefs.rules.filter.any = [
      {
        all: [
          { field: "status", op: "in", values: ["in_progress"] },
          { field: "tags", op: "hasAny", values: ["ops"] },
        ],
      },
    ];

    const filtered = filterDbViewCards(
      [
        makeCard({ id: "a", columnId: "in_progress", tags: ["ops"] }),
        makeCard({ id: "b", columnId: "in_progress", tags: ["design"], boardIndex: 1 }),
        makeCard({ id: "c", columnId: "backlog", tags: ["ops"], boardIndex: 2 }),
      ],
      prefs.rules,
    );

    expect(filtered.map((card) => card.id).join(",")).toBe("a");
  });

  test("filterDbViewCards respects explicit empty-priority selection", () => {
    const prefs = getDefaultDbViewPrefs("kanban");
    prefs.rules.filter.any = [
      {
        all: [
          { field: "status", op: "in", values: ["backlog"] },
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
    const normalized = normalizeDbViewPrefs("kanban", {
      rules: {
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["backlog"] },
                { field: "priority", op: "in", values: [], includeEmpty: true },
              ],
            },
          ],
        },
        sort: [{ field: "board-order", direction: "asc" }],
      },
    });

    const priorityClause = normalized.rules.filter.any[0]?.all[1];
    expect(JSON.stringify(priorityClause)).toBe(JSON.stringify({
      field: "priority",
      op: "in",
      values: [],
      includeEmpty: true,
    }));
  });

  test("normalization preserves explicit empty status filters", () => {
    const normalized = normalizeDbViewPrefs("kanban", {
      rules: {
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: [] },
              ],
            },
          ],
        },
        sort: [{ field: "board-order", direction: "asc" }],
      },
    });

    expect(JSON.stringify(normalized.rules.filter.any[0]?.all[0])).toBe(JSON.stringify({
      field: "status",
      op: "in",
      values: [],
    }));
  });

  test("sortDbViewCards supports list-specific assignee sorting", () => {
    const prefs = getDefaultDbViewPrefs("list");
    prefs.rules.sort = [{ field: "assignee", direction: "asc" }];

    const sorted = sortDbViewCards(
      [
        makeCard({ id: "c", assignee: "zoe", boardIndex: 2 }),
        makeCard({ id: "a", assignee: "anna", boardIndex: 0 }),
        makeCard({ id: "b", assignee: "mika", boardIndex: 1 }),
      ],
      prefs.rules,
    );

    expect(sorted.map((card) => card.id).join(",")).toBe("a,b,c");
  });

  test("hasActiveDbViewRules respects per-view defaults", () => {
    const kanbanPrefs = getDefaultDbViewPrefs("kanban");
    const listPrefs = getDefaultDbViewPrefs("list");

    expect(hasActiveDbViewRules("kanban", kanbanPrefs.rules)).toBeFalse();
    expect(hasActiveDbViewRules("list", listPrefs.rules)).toBeFalse();

    kanbanPrefs.rules.sort = [{ field: "priority", direction: "asc" }];
    expect(hasActiveDbViewRules("kanban", kanbanPrefs.rules)).toBeTrue();
  });
});
