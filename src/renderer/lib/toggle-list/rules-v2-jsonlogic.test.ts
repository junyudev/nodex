import { describe, expect, test } from "bun:test";
import { formatRulesV2AsJsonLogic, parseRulesV2FromJsonLogic } from "./rules-v2-jsonlogic";
import type { ToggleListRulesV2 } from "./types";

describe("toggle-list rules v2 jsonlogic interop", () => {
  test("round-trips supported rules through JSONLogic document", () => {
    const rules: ToggleListRulesV2 = {
      mode: "advanced",
      includeHostCard: true,
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["draft"] },
              { field: "priority", op: "in", values: ["p0-critical"] },
              { field: "tags", op: "hasNone", values: ["sidebar"] },
            ],
          },
          {
            all: [
              { field: "status", op: "in", values: ["backlog"] },
              { field: "priority", op: "in", values: ["p0-critical", "p1-high"] },
            ],
          },
        ],
      },
      sort: [
        { field: "status", direction: "asc" },
        { field: "priority", direction: "asc" },
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

    const unsupported = parseRulesV2FromJsonLogic(JSON.stringify({
      mode: "advanced",
      includeHostCard: false,
      filter: { "<": [1, 2] },
      sort: [],
    }));
    expect(unsupported.rules).toBe(null);
    expect(unsupported.error).toBe("Unsupported filter expression.");
  });

  test("parses hasAll and hasAny tag patterns", () => {
    const parsed = parseRulesV2FromJsonLogic(JSON.stringify({
      mode: "advanced",
      includeHostCard: false,
      filter: {
        or: [
          {
            and: [
              { in: [{ var: "status" }, ["draft"]] },
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
    }));

    expect(parsed.error).toBe(null);
    expect(JSON.stringify(parsed.rules?.filter.any[0]?.all[1])).toBe(JSON.stringify({
      field: "tags",
      op: "hasAll",
      values: ["frontend", "ui"],
    }));
    expect(JSON.stringify(parsed.rules?.filter.any[1]?.all[1])).toBe(JSON.stringify({
      field: "tags",
      op: "hasAny",
      values: ["api", "infra"],
    }));
    expect(parsed.rules?.includeHostCard).toBeFalse();
  });
});
