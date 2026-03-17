import { describe, expect, test } from "bun:test";
import type { Board, Card, CardInput, CardStatus } from "@/lib/types";
import type { DbViewRules } from "../../lib/db-view-prefs";
import { resolveKanbanImportInference } from "./kanban-import-inference";

function makeCard(
  id: string,
  status: CardStatus,
  order: number,
  overrides: Partial<Card> = {},
): Card {
  return {
    id,
    status,
    archived: false,
    title: id,
    description: "",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-03-17T00:00:00.000Z"),
    order,
    ...overrides,
  };
}

function makeBoard(columns: Partial<Record<CardStatus, Card[]>>): Board {
  const orderedStatuses: CardStatus[] = ["draft", "backlog", "in_progress", "in_review", "done"];
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
            { field: "status", op: "in", values: ["draft", "backlog", "in_progress", "in_review", "done"] },
            { field: "priority", op: "in", values: ["p0-critical", "p1-high", "p2-medium", "p3-low", "p4-later"], includeEmpty: true },
          ],
        },
      ],
    },
    sort: [{ field: "board-order", direction: "asc" }],
    ...partial,
  };
}

describe("resolveKanbanImportInference", () => {
  test("maps filtered board-order imports back into persisted order and applies unambiguous filter defaults", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("hidden-a", "in_progress", 0, { priority: "p2-medium" }),
        makeCard("visible-b", "in_progress", 1, { priority: "p1-high" }),
        makeCard("hidden-c", "in_progress", 2, { priority: "p3-low" }),
        makeCard("visible-d", "in_progress", 3, { priority: "p1-high" }),
      ],
    });
    const visibleBoard = makeBoard({
      in_progress: [
        makeCard("visible-b", "in_progress", 0, { priority: "p1-high" }),
        makeCard("visible-d", "in_progress", 1, { priority: "p1-high" }),
      ],
    });

    const result = resolveKanbanImportInference({
      board,
      visibleBoard,
      rules: makeRules({
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["in_progress"] },
                { field: "priority", op: "in", values: ["p1-high"] },
              ],
            },
          ],
        },
      }),
      targetColumnId: "in_progress",
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
      in_progress: [
        makeCard("p1-a", "in_progress", 0, { priority: "p1-high" }),
        makeCard("p1-b", "in_progress", 1, { priority: "p1-high" }),
        makeCard("p2-a", "in_progress", 2, { priority: "p2-medium" }),
      ],
    });
    const visibleBoard = makeBoard({
      in_progress: [
        makeCard("p1-a", "in_progress", 0, { priority: "p1-high" }),
        makeCard("p1-b", "in_progress", 1, { priority: "p1-high" }),
        makeCard("p2-a", "in_progress", 2, { priority: "p2-medium" }),
      ],
    });

    const result = resolveKanbanImportInference({
      board,
      visibleBoard,
      rules: makeRules({
        sort: [{ field: "priority", direction: "asc" }],
      }),
      targetColumnId: "in_progress",
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
      in_progress: [
        makeCard("alpha", "in_progress", 0, { title: "Alpha" }),
        makeCard("beta", "in_progress", 1, { title: "Beta" }),
      ],
    });

    const result = resolveKanbanImportInference({
      board,
      visibleBoard: board,
      rules: makeRules({
        sort: [{ field: "title", direction: "asc" }],
      }),
      targetColumnId: "in_progress",
      targetVisibleIndex: 1,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("column");
  });

  test("blocks board import while search is active", () => {
    const board = makeBoard({
      in_progress: [makeCard("match", "in_progress", 0)],
    });

    const result = resolveKanbanImportInference({
      board,
      visibleBoard: board,
      rules: makeRules(),
      targetColumnId: "in_progress",
      targetVisibleIndex: 0,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: true,
    });

    expect(result.mode).toBe("blocked");
  });

  test("blocks filtered imports when matching a tag subset would require inventing an ambiguous tag", () => {
    const board = makeBoard({
      in_progress: [makeCard("visible", "in_progress", 0, { tags: ["backend"] })],
    });

    const result = resolveKanbanImportInference({
      board,
      visibleBoard: board,
      rules: makeRules({
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["in_progress"] },
                { field: "tags", op: "hasAny", values: ["backend", "frontend"] },
              ],
            },
          ],
        },
      }),
      targetColumnId: "in_progress",
      targetVisibleIndex: 1,
      cards: [{ title: "Dropped block" }],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("blocked");
  });

  test("keeps a sorted import column-only when explicit imported sort values conflict with the hovered slot", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("p1-a", "in_progress", 0, { priority: "p1-high" }),
        makeCard("p1-b", "in_progress", 1, { priority: "p1-high" }),
        makeCard("p2-a", "in_progress", 2, { priority: "p2-medium" }),
      ],
    });

    const result = resolveKanbanImportInference({
      board,
      visibleBoard: board,
      rules: makeRules({
        sort: [{ field: "priority", direction: "asc" }],
      }),
      targetColumnId: "in_progress",
      targetVisibleIndex: 2,
      cards: [{ title: "Snapshot card", priority: "p4-later" } satisfies CardInput],
      hasSearchFilter: false,
    });

    expect(result.mode).toBe("column");
    if (result.mode !== "column") {
      throw new Error("Expected column-only inference");
    }
    expect(result.cards[0]?.priority).toBe("p4-later");
  });
});
