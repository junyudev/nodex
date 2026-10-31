import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary, PageInput, WorkflowStatus, DatabasePageSummary } from "@/lib/types";
import type { DbViewRules } from "../../lib/db-view-prefs";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { resolveBoardImportInference } from "./board-import-inference";

function makeCard(
  id: string,
  status: WorkflowStatus,
  order: number,
  overrides: Partial<DatabasePageSummary> = {},
): DatabasePageSummary {
  const title = overrides.title ?? id;
  return {
    id,
    status,
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
    tags: [],
    created: new Date("2026-03-17T00:00:00.000Z"),
    order,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
  };
}

function makeBoard(columns: Partial<Record<WorkflowStatus, DatabasePageSummary[]>>): BoardSummary {
  const orderedStatuses: WorkflowStatus[] = ["triage", "plan", "doing", "review", "done"];
  return {
    columns: orderedStatuses.map((status) => ({
      id: status,
      name: status,
      cards: columns[status] ?? [],
    })),
  };
}

function makeRules(partial: Partial<DbViewRules> = {}): DbViewRules {
  return {
    filter: {
      any: [
        {
          all: [
            { field: "status", op: "in", values: ["triage", "plan", "doing", "review", "done"] },
            {
              field: "priority",
              op: "in",
              values: ["p0-critical", "p1-high", "p2-medium", "p3-low"],
              includeEmpty: true,
            },
          ],
        },
      ],
    },
    sort: [{ field: "board-order", direction: "asc" }],
    ...partial,
  };
}

describe("resolveBoardImportInference", () => {
  test("maps filtered board-order imports back into persisted order and applies unambiguous filter defaults", () => {
    const board = makeBoard({
      doing: [
        makeCard("hidden-a", "doing", 0, { priority: "p2-medium" }),
        makeCard("visible-b", "doing", 1, { priority: "p1-high" }),
        makeCard("hidden-c", "doing", 2, { priority: "p3-low" }),
        makeCard("visible-d", "doing", 3, { priority: "p1-high" }),
      ],
    });
    const visibleBoard = makeBoard({
      doing: [
        makeCard("visible-b", "doing", 0, { priority: "p1-high" }),
        makeCard("visible-d", "doing", 1, { priority: "p1-high" }),
      ],
    });

    const result = resolveBoardImportInference({
      board,
      visibleBoard,
      rules: makeRules({
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["doing"] },
                { field: "priority", op: "in", values: ["p1-high"] },
              ],
            },
          ],
        },
      }),
      targetColumnId: "doing",
      targetVisibleIndex: 1,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("slot");
    if (result.mode !== "slot") {
      throw new Error("Expected slot inference");
    }

    expect(result.insertIndex).toBe(3);
    expect(result.cards[0]?.priority).toBe("p1-high");
  });

  test("uses sortable neighbor properties to keep exact-slot imports under a priority sort", () => {
    const board = makeBoard({
      doing: [
        makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
        makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
        makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
      ],
    });
    const visibleBoard = makeBoard({
      doing: [
        makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
        makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
        makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
      ],
    });

    const result = resolveBoardImportInference({
      board,
      visibleBoard,
      rules: makeRules({
        sort: [{ field: "priority", direction: "asc" }],
      }),
      targetColumnId: "doing",
      targetVisibleIndex: 2,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("slot");
    if (result.mode !== "slot") {
      throw new Error("Expected slot inference");
    }

    expect(result.insertIndex).toBe(2);
    expect(result.cards[0]?.priority).toBe("p1-high");
  });

  test("falls back to column-only import when the active sort depends on title", () => {
    const board = makeBoard({
      doing: [
        makeCard("alpha", "doing", 0, { title: "Alpha" }),
        makeCard("beta", "doing", 1, { title: "Beta" }),
      ],
    });

    const result = resolveBoardImportInference({
      board,
      visibleBoard: board,
      rules: makeRules({
        sort: [{ field: "title", direction: "asc" }],
      }),
      targetColumnId: "doing",
      targetVisibleIndex: 1,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("column");
  });

  test("blocks board import while search is active", () => {
    const board = makeBoard({
      doing: [makeCard("match", "doing", 0)],
    });

    const result = resolveBoardImportInference({
      board,
      visibleBoard: board,
      rules: makeRules(),
      targetColumnId: "doing",
      targetVisibleIndex: 0,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: true,
    });

    expect(result.mode).toBe("blocked");
  });

  test("blocks filtered imports when matching a tag subset would require inventing an ambiguous tag", () => {
    const board = makeBoard({
      doing: [makeCard("visible", "doing", 0, { tags: ["backend"] })],
    });

    const result = resolveBoardImportInference({
      board,
      visibleBoard: board,
      rules: makeRules({
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["doing"] },
                { field: "tags", op: "hasAny", values: ["backend", "frontend"] },
              ],
            },
          ],
        },
      }),
      targetColumnId: "doing",
      targetVisibleIndex: 1,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("blocked");
  });

  test("keeps a sorted import column-only when explicit imported sort values conflict with the hovered slot", () => {
    const board = makeBoard({
      doing: [
        makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
        makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
        makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
      ],
    });

    const result = resolveBoardImportInference({
      board,
      visibleBoard: board,
      rules: makeRules({
        sort: [{ field: "priority", direction: "asc" }],
      }),
      targetColumnId: "doing",
      targetVisibleIndex: 2,
      cards: [{ title: "Snapshot card", priority: "p3-low" } satisfies PageInput],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("column");
    if (result.mode !== "column") {
      throw new Error("Expected column-only inference");
    }
    expect(result.cards[0]?.priority).toBe("p3-low");
  });
});
