import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary, WorkflowStatus, DatabasePageSummary } from "@/lib/types";
import type { DbViewRules } from "../../lib/db-view-prefs";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { resolveBoardCardDragMode, resolveBoardCardDropIntent } from "./board-card-drop-strategy";

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

function makeRules(sort: DbViewRules["sort"]): DbViewRules {
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
    sort,
  };
}

describe("board card drop strategy", () => {
  test("treats board-order as manual rank even with secondary sorts", () => {
    const dragMode = resolveBoardCardDragMode({
      rules: makeRules([
        { field: "board-order", direction: "asc" },
        { field: "created", direction: "desc" },
      ]),
    });

    expect(dragMode.kind).toBe("manual-rank");
  });

  test("keeps visible-slot reordering enabled when board-order stays primary", () => {
    const board = makeBoard({
      doing: [makeCard("a", "doing", 0), makeCard("b", "doing", 1), makeCard("c", "doing", 2)],
    });

    const intent = resolveBoardCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([
        { field: "board-order", direction: "asc" },
        { field: "created", direction: "desc" },
      ]),
      destinationColumnId: "doing",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "doing",
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
      doing: [
        makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
        makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
        makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
      ],
      review: [makeCard("review", "review", 0, { priority: "p3-low" })],
    });

    const intent = resolveBoardCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "priority", direction: "asc" }]),
      destinationColumnId: "doing",
      destinationIndex: 2,
      dragItems: [
        {
          columnId: "review",
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
      doing: [
        makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
        makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
        makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
      ],
    });

    const intent = resolveBoardCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "priority", direction: "asc" }]),
      destinationColumnId: "doing",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "doing",
          card: board.columns[2]!.cards[1]!,
        },
      ],
    });

    expect(intent.kind).toBe("reorder");
  });

  test("maps same-column downward priority drops from the remaining visible slot space", () => {
    const board = makeBoard({
      doing: [
        makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
        makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
        makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
      ],
    });

    const intent = resolveBoardCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "priority", direction: "asc" }]),
      destinationColumnId: "doing",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "doing",
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

  test("blocks same-column ranking when title owns the sort", () => {
    const board = makeBoard({
      doing: [
        makeCard("a", "doing", 0, { title: "Alpha" }),
        makeCard("b", "doing", 1, { title: "Beta" }),
      ],
    });

    const intent = resolveBoardCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "title", direction: "asc" }]),
      destinationColumnId: "doing",
      destinationIndex: 1,
      dragItems: [
        {
          columnId: "doing",
          card: board.columns[2]!.cards[0]!,
        },
      ],
    });

    expect(intent.kind).toBe("blocked");
  });

  test("keeps cross-column moves enabled when title owns the sort", () => {
    const board = makeBoard({
      doing: [makeCard("a", "doing", 0, { title: "Alpha" })],
      review: [makeCard("b", "review", 0, { title: "Beta" })],
    });

    const intent = resolveBoardCardDropIntent({
      board,
      visibleBoard: board,
      rules: makeRules([{ field: "title", direction: "asc" }]),
      destinationColumnId: "done",
      destinationIndex: 0,
      dragItems: [
        {
          columnId: "doing",
          card: board.columns[2]!.cards[0]!,
        },
      ],
    });

    expect(intent.kind).toBe("move-only");
  });
});
