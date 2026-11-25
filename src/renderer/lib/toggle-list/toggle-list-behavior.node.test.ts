import { describe, expect, test } from "vite-plus/test";
import type { ToggleListCard, ToggleListRulesV2 } from "./types";
import { formatMeta } from "./meta";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { formatRulesV2AsJsonLogic, parseRulesV2FromJsonLogic } from "./rules-v2-jsonlogic";
import {
  deriveToggleListFilterRule,
  getDefaultToggleListSettings,
  normalizeToggleListSettings,
  resolveToggleListPrimarySort,
  resolveToggleListSecondarySort,
  setToggleListRulesV2,
} from "./settings";

describe("meta", () => {
  const baseCard: ToggleListCard = {
    id: "card-1",
    pageKey: null,
    status: "plan",
    archived: false,
    title: "Example",
    richTitle: plainTextToPortableRichText("Example"),
    description: "",
    priority: "p0-critical",
    estimate: "l",
    tags: [],
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "plan",
    columnName: "Plan",
    boardIndex: 0,
  };

  const taggedCard: ToggleListCard = {
    ...baseCard,
    tags: ["frontend", "bug"],
  };

  describe("toggle-list meta formatting", () => {
    test("formats all properties in requested order", () => {
      const meta = formatMeta(baseCard, ["priority", "estimate", "status"], []);
      expect(meta).toBe("[P0] [L] [Plan]");
    });

    test("hides selected properties", () => {
      const meta = formatMeta(baseCard, ["priority", "estimate", "status"], ["estimate"]);
      expect(meta).toBe("[P0] [Plan]");
    });

    test("respects custom property ordering", () => {
      const meta = formatMeta(baseCard, ["status", "priority", "estimate"], []);
      expect(meta).toBe("[Plan] [P0] [L]");
    });

    test("includes tags as individual tokens", () => {
      const meta = formatMeta(taggedCard, ["priority", "estimate", "status", "tags"], []);
      expect(meta).toBe("[P0] [L] [Plan] [frontend] [bug]");
    });

    test("hides tags when in hiddenProperties", () => {
      const meta = formatMeta(taggedCard, ["priority", "estimate", "status", "tags"], ["tags"]);
      expect(meta).toBe("[P0] [L] [Plan]");
    });

    test("respects tag position in propertyOrder", () => {
      const meta = formatMeta(taggedCard, ["tags", "priority", "status"], ["estimate"]);
      expect(meta).toBe("[frontend] [bug] [P0] [Plan]");
    });

    test("empty tags array produces no extra tokens", () => {
      const meta = formatMeta(baseCard, ["priority", "tags", "status"], []);
      expect(meta).toBe("[P0] [Plan]");
    });

    test("hides estimate chip when estimate is empty", () => {
      const card: ToggleListCard = { ...baseCard, estimate: undefined };
      const meta = formatMeta(card, ["priority", "estimate", "status"], []);
      expect(meta).toBe("[P0] [Plan]");
    });
  });
});

describe("toggle-list rules v2 jsonlogic interop", () => {
  test("round-trips supported rules through JSONLogic document", () => {
    const rules: ToggleListRulesV2 = {
      mode: "advanced",
      includeHostCard: true,
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["triage"] },
              { field: "priority", op: "in", values: ["p0-critical"], includeEmpty: true },
              { field: "tags", op: "hasNone", values: ["sidebar"] },
            ],
          },
          {
            all: [
              { field: "status", op: "in", values: ["plan"] },
              {
                field: "priority",
                op: "in",
                values: ["p0-critical", "p1-high"],
                includeEmpty: false,
              },
            ],
          },
        ],
      },
      sort: [
        { field: "status", direction: "asc" },
        { field: "priority", direction: "asc", emptyPlacement: "first" },
        { field: "created", direction: "asc" },
        { field: "board-order", direction: "asc" },
      ],
    };

    const json = formatRulesV2AsJsonLogic(rules);
    const parsed = parseRulesV2FromJsonLogic(json);

    expect(parsed.error).toBe(null);
    expect(JSON.stringify(parsed.rules)).toBe(JSON.stringify(rules));
  });

  test("returns errors for malformed or unsupported documents", () => {
    const malformed = parseRulesV2FromJsonLogic("{");
    expect(malformed.rules).toBe(null);
    expect(malformed.error).toBe("Invalid JSON.");

    const unsupported = parseRulesV2FromJsonLogic(
      JSON.stringify({
        mode: "advanced",
        includeHostCard: false,
        filter: { "<": [1, 2] },
        sort: [],
      }),
    );
    expect(unsupported.rules).toBe(null);
    expect(unsupported.error).toBe("Unsupported filter expression.");
  });

  test("parses hasAll and hasAny tag patterns", () => {
    const parsed = parseRulesV2FromJsonLogic(
      JSON.stringify({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          or: [
            {
              and: [
                { in: [{ var: "status" }, ["triage"]] },
                { and: [{ in: ["frontend", { var: "tags" }] }, { in: ["ui", { var: "tags" }] }] },
              ],
            },
            {
              and: [
                { in: [{ var: "priority" }, ["p0-critical", "p1-high"]] },
                { or: [{ in: ["api", { var: "tags" }] }, { in: ["infra", { var: "tags" }] }] },
              ],
            },
          ],
        },
        sort: [{ field: "status", direction: "asc" }],
      }),
    );

    expect(parsed.error).toBe(null);
    expect(JSON.stringify(parsed.rules?.filter.any[0]?.all[1])).toBe(
      JSON.stringify({
        field: "tags",
        op: "hasAll",
        values: ["frontend", "ui"],
      }),
    );
    expect(JSON.stringify(parsed.rules?.filter.any[1]?.all[1])).toBe(
      JSON.stringify({
        field: "tags",
        op: "hasAny",
        values: ["api", "infra"],
      }),
    );
    expect(parsed.rules?.includeHostCard).toBe(false);
  });

  test("parses explicit empty-priority jsonlogic conditions", () => {
    const parsed = parseRulesV2FromJsonLogic(
      JSON.stringify({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          or: [
            {
              and: [{ in: [{ var: "status" }, ["triage"]] }, { missing: ["priority"] }],
            },
            {
              and: [
                { in: [{ var: "status" }, ["plan"]] },
                {
                  or: [{ in: [{ var: "priority" }, ["p0-critical"]] }, { missing: ["priority"] }],
                },
              ],
            },
          ],
        },
        sort: [{ field: "status", direction: "asc" }],
      }),
    );

    expect(parsed.error).toBe(null);
    expect(JSON.stringify(parsed.rules?.filter.any[0]?.all[1])).toBe(
      JSON.stringify({
        field: "priority",
        op: "in",
        values: [],
        includeEmpty: true,
      }),
    );
    expect(JSON.stringify(parsed.rules?.filter.any[1]?.all[1])).toBe(
      JSON.stringify({
        field: "priority",
        op: "in",
        values: ["p0-critical"],
        includeEmpty: true,
      }),
    );
  });

  test("round-trips empty-only priority filters through JSONLogic", () => {
    const rules: ToggleListRulesV2 = {
      mode: "advanced",
      includeHostCard: false,
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
    };

    const json = formatRulesV2AsJsonLogic(rules);

    expect(json.includes('"missing"')).toBe(true);

    const parsed = parseRulesV2FromJsonLogic(json);
    expect(parsed.error).toBe(null);
    expect(JSON.stringify(parsed.rules)).toBe(JSON.stringify(rules));
  });
});

describe("toggle-list settings rules v2", () => {
  test("ignores legacy persisted filter and rank fields", () => {
    const normalized = normalizeToggleListSettings({
      filter: {
        statuses: ["plan", "plan"],
        priorities: ["p0-critical", "p1-high"],
        tags: ["infra"],
        tagMode: "none",
        includeHostCard: true,
      },
      rank: {
        primary: "priority",
        primaryDirection: "asc",
        secondary: "created",
        secondaryDirection: "desc",
      },
      propertyOrder: ["status", "priority", "estimate", "tags"],
      hiddenProperties: ["estimate"],
      showEmptyEstimate: true,
    });

    const defaults = getDefaultToggleListSettings();
    expect(JSON.stringify(normalized.rulesV2)).toBe(JSON.stringify(defaults.rulesV2));
    expect(JSON.stringify(normalized.propertyOrder)).toBe(
      JSON.stringify(["status", "priority", "estimate", "tags"]),
    );
    expect(JSON.stringify(normalized.hiddenProperties)).toBe(JSON.stringify(["estimate"]));
    expect(normalized.showEmptyEstimate).toBe(true);
  });

  test("setToggleListRulesV2 keeps canonical rules only", () => {
    const defaults = getDefaultToggleListSettings();
    const next = setToggleListRulesV2(defaults, {
      mode: "advanced",
      includeHostCard: true,
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["triage", "plan"] },
              { field: "priority", op: "in", values: ["p0-critical", "p1-high"] },
              { field: "tags", op: "hasNone", values: ["blocked"] },
            ],
          },
        ],
      },
      sort: [
        { field: "status", direction: "asc" },
        { field: "priority", direction: "asc" },
        { field: "created", direction: "desc" },
      ],
    });

    const derivedFilter = deriveToggleListFilterRule(next.rulesV2);
    expect(next.rulesV2.mode).toBe("advanced");
    expect(next.rulesV2.includeHostCard).toBe(true);
    expect(JSON.stringify(derivedFilter.statuses)).toBe(JSON.stringify(["triage", "plan"]));
    expect(JSON.stringify(derivedFilter.priorities)).toBe(
      JSON.stringify(["p0-critical", "p1-high"]),
    );
    expect(derivedFilter.includeEmptyPriority).toBe(false);
    expect(JSON.stringify(derivedFilter.tags)).toBe(JSON.stringify(["blocked"]));
    expect(derivedFilter.tagMode).toBe("none");
    expect(resolveToggleListPrimarySort(next.rulesV2).field).toBe("status");
    expect(resolveToggleListSecondarySort(next.rulesV2).field).toBe("priority");
  });

  test("normalizes legacy all-priority clauses to include empty priority", () => {
    const normalized = normalizeToggleListSettings({
      rulesV2: {
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                {
                  field: "priority",
                  op: "in",
                  values: ["p0-critical", "p1-high", "p2-medium", "p3-low"],
                },
              ],
            },
          ],
        },
        sort: [{ field: "board-order", direction: "asc" }],
      },
    });

    const clause = normalized.rulesV2.filter.any[0]?.all[0];
    expect(clause && "includeEmpty" in clause ? clause.includeEmpty : false).toBe(true);
  });
});
