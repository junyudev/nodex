import { describe, expect, test } from "bun:test";
import type { Board } from "@/lib/types";
import {
  emptyCardSelection,
  normalizeCardSelection,
  resolveDragGroup,
  resolveSelectedCardEntries,
  toggleCardSelection,
} from "./card-selection";

const board: Board = {
  columns: [
    {
      id: "6-in-progress",
      name: "In Progress",
      cards: [
        {
          id: "a",
          title: "A",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "b",
          title: "B",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
    {
      id: "7-review",
      name: "Review",
      cards: [
        {
          id: "c",
          title: "C",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "d",
          title: "D",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
  ],
};

function ids(selection: CardSelectionStateLike): string[] {
  return Array.from(selection.cardIds);
}

type CardSelectionStateLike = ReturnType<typeof emptyCardSelection>;

describe("card selection", () => {
  test("initial shift-toggle selects only the clicked card", () => {
    const selected = toggleCardSelection(emptyCardSelection(), "b");

    expect(ids(selected).join(",")).toBe("b");
  });

  test("shift-toggle can add cards across columns", () => {
    const once = toggleCardSelection(emptyCardSelection(), "a");
    const twice = toggleCardSelection(once, "c");

    expect(ids(twice).join(",")).toBe("a,c");
  });

  test("normalize drops removed cards regardless of source column", () => {
    const selection = {
      cardIds: new Set(["b", "missing", "d"]),
    };

    const normalized = normalizeCardSelection(selection, board);

    expect(ids(normalized).join(",")).toBe("b,d");
  });

  test("resolveSelectedCardEntries preserves board-visible order across columns", () => {
    const selection = {
      cardIds: new Set(["d", "a", "c"]),
    };

    const selected = resolveSelectedCardEntries(board, selection);

    expect(selected.map((entry) => entry.card.id).join(",")).toBe("a,c,d");
  });

  test("resolveDragGroup uses the full selection when the active card is selected", () => {
    const selection = {
      cardIds: new Set(["d", "a", "c"]),
    };

    const dragGroup = resolveDragGroup(board, selection, {
      card: board.columns[1]!.cards[0]!,
      columnId: "7-review",
    });

    expect(dragGroup.map((entry) => entry.card.id).join(",")).toBe("a,c,d");
  });

  test("resolveDragGroup falls back to the active card when it is not in the selection", () => {
    const selection = {
      cardIds: new Set(["a", "c"]),
    };

    const dragGroup = resolveDragGroup(board, selection, {
      card: board.columns[1]!.cards[1]!,
      columnId: "7-review",
    });

    expect(dragGroup.map((entry) => entry.card.id).join(",")).toBe("d");
  });
});
