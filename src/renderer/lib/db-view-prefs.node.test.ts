import { describe, expect, test } from "vite-plus/test";
import {
  filterDbViewCards,
  getDefaultDbViewPrefs,
  hasActiveDbViewRules,
  normalizeLegacyDbViewPrefs,
  normalizeDbViewPrefs,
  sortDbViewCards,
  type DbViewCardRecord,
} from "./db-view-prefs";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";

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
    expect(normalize(["p0-critical", "p1-high", "p2-medium", "p3-low", "p4-later"])).toMatchObject({
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
    expect(JSON.stringify(normalized.display.hiddenProperties)).toBe(JSON.stringify(["priority"]));
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
