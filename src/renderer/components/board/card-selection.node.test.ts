import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import {
  emptyCardSelection,
  normalizeCardSelection,
  resolveDragGroup,
  resolveSelectedCardEntries,
  toggleCardSelection,
} from "./card-selection";

const board: BoardSummary = {
  columns: [
    {
      id: "doing",
      name: "Doing",
      cards: [
        {
          id: "a",
          pageKey: null,
          status: "doing",
          archived: false,
          title: "A",
          richTitle: plainTextToPortableRichText("A"),
          descriptionPreview: "",
          descriptionLength: 0,
          hasDescription: false,
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "b",
          pageKey: null,
          status: "doing",
          archived: false,
          title: "B",
          richTitle: plainTextToPortableRichText("B"),
          descriptionPreview: "",
          descriptionLength: 0,
          hasDescription: false,
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
    {
      id: "review",
      name: "Review",
      cards: [
        {
          id: "c",
          pageKey: null,
          status: "review",
          archived: false,
          title: "C",
          richTitle: plainTextToPortableRichText("C"),
          descriptionPreview: "",
          descriptionLength: 0,
          hasDescription: false,
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "d",
          pageKey: null,
          status: "review",
          archived: false,
          title: "D",
          richTitle: plainTextToPortableRichText("D"),
          descriptionPreview: "",
          descriptionLength: 0,
          hasDescription: false,
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-02-28T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
  ],
};

function ids(selection: CardSelectionStateLike): string[] {
  return Array.from(selection.pageIds);
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
      pageIds: new Set(["b", "missing", "d"]),
    };

    const normalized = normalizeCardSelection(selection, board);

    expect(ids(normalized).join(",")).toBe("b,d");
  });

  test("resolveSelectedCardEntries preserves board-visible order across columns", () => {
    const selection = {
      pageIds: new Set(["d", "a", "c"]),
    };

    const selected = resolveSelectedCardEntries(board, selection);

    expect(selected.map((entry) => entry.card.id).join(",")).toBe("a,c,d");
  });

  test("resolveDragGroup uses the full selection when the active card is selected", () => {
    const selection = {
      pageIds: new Set(["d", "a", "c"]),
    };

    const dragGroup = resolveDragGroup(board, selection, {
      card: board.columns[1]!.cards[0]!,
      columnId: "review",
    });

    expect(dragGroup.map((entry) => entry.card.id).join(",")).toBe("a,c,d");
  });

  test("resolveDragGroup falls back to the active card when it is not in the selection", () => {
    const selection = {
      pageIds: new Set(["a", "c"]),
    };

    const dragGroup = resolveDragGroup(board, selection, {
      card: board.columns[1]!.cards[1]!,
      columnId: "review",
    });

    expect(dragGroup.map((entry) => entry.card.id).join(",")).toBe("d");
  });
});
