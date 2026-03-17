import { describe, expect, test } from "bun:test";
import type { Board, Card, CardStatus } from "@/lib/types";
import type { DbViewRules } from "../../lib/db-view-prefs";
import {
  resolveKanbanCardDragMode,
  resolveKanbanCardDropIntent,
} from "./kanban-card-drop-strategy";

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

function makeRules(sort: DbViewRules["sort"]): DbViewRules {
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
    sort,
  };
}

describe("kanban card drop strategy", () => {
  test("treats board-order as manual rank even with secondary sorts", () => {
    const dragMode = resolveKanbanCardDragMode({
      rules: makeRules([
        { field: "board-order", direction: "asc" },
        { field: "created", direction: "desc" },
      ]),
    });

    expect(dragMode.kind).toBe("manual-rank");
  });

  test("keeps visible-slot reordering enabled when board-order stays primary", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("a", "in_progress", 0),
        makeCard("b", "in_progress", 1),
        makeCard("c", "in_progress", 2),
      ],
    });

    const intent = resolveKanbanCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([
        { field: "board-order", direction: "asc" },
        { field: "created", direction: "desc" },
      ]),
      destinationColumnId: "in_progress",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "in_progress",
          card: board.columns[2]!.cards[0]!,
        },
      ],
    });

    expect(intent.kind).toBe("reorder");
    if (intent.kind !== "reorder") {
      throw new Error("Expected reorder intent");
    }
    expect(intent.newOrder).toBe(1);
  });

  test("returns a property patch when a priority-sorted drop crosses buckets", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("p1-a", "in_progress", 0, { priority: "p1-high" }),
        makeCard("p1-b", "in_progress", 1, { priority: "p1-high" }),
        makeCard("p2-a", "in_progress", 2, { priority: "p2-medium" }),
      ],
      in_review: [
        makeCard("review", "in_review", 0, { priority: "p3-low" }),
      ],
    });

    const intent = resolveKanbanCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "priority", direction: "asc" }]),
      destinationColumnId: "in_progress",
      destinationIndex: 2,
      dragItems: [
        {
          columnId: "in_review",
          card: board.columns[3]!.cards[0]!,
        },
      ],
    });

    expect(intent.kind).toBe("reorder-with-patch");
    if (intent.kind !== "reorder-with-patch") {
      throw new Error("Expected reorder-with-patch intent");
    }
    expect(intent.fieldPatch.priority).toBe("p2-medium");
    expect(intent.newOrder).toBe(2);
  });

  test("keeps within-bucket priority drops as pure reorders", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("p1-a", "in_progress", 0, { priority: "p1-high" }),
        makeCard("p1-b", "in_progress", 1, { priority: "p1-high" }),
        makeCard("p2-a", "in_progress", 2, { priority: "p2-medium" }),
      ],
    });

    const intent = resolveKanbanCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "priority", direction: "asc" }]),
      destinationColumnId: "in_progress",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "in_progress",
          card: board.columns[2]!.cards[1]!,
        },
      ],
    });

    expect(intent.kind).toBe("reorder");
  });

  test("blocks same-column ranking when title owns the sort", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("a", "in_progress", 0, { title: "Alpha" }),
        makeCard("b", "in_progress", 1, { title: "Beta" }),
      ],
    });

    const intent = resolveKanbanCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "title", direction: "asc" }]),
      destinationColumnId: "in_progress",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "in_progress",
          card: board.columns[2]!.cards[0]!,
        },
      ],
    });

    expect(intent.kind).toBe("blocked");
  });

  test("keeps cross-column moves enabled when title owns the sort", () => {
    const board = makeBoard({
      in_progress: [
        makeCard("a", "in_progress", 0, { title: "Alpha" }),
      ],
      in_review: [
        makeCard("b", "in_review", 0, { title: "Beta" }),
      ],
    });

    const intent = resolveKanbanCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "title", direction: "asc" }]),
      destinationColumnId: "done",
      destinationIndex: 0,
      dragItems: [
        {
          columnId: "in_progress",
          card: board.columns[2]!.cards[0]!,
        },
      ],
    });

    expect(intent.kind).toBe("move-only");
  });
});
