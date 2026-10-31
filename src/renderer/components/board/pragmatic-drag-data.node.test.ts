import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { emptyCardSelection, toggleCardSelection } from "./card-selection";
import { buildBoardCardDragData, canDropOnBoardCard } from "./pragmatic-drag-data";

const board: BoardSummary = {
  columns: [
    {
      id: "doing",
      name: "Doing",
      cards: [
        {
          id: "card-1",
          pageKey: null,
          status: "doing",
          archived: false,
          title: "Task",
          richTitle: plainTextToPortableRichText("Task"),
          descriptionPreview: "Persisted body",
          descriptionLength: "Persisted body".length,
          hasDescription: true,
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "card-2",
          pageKey: null,
          status: "doing",
          archived: false,
          title: "Peer",
          richTitle: plainTextToPortableRichText("Peer"),
          descriptionPreview: "Peer body",
          descriptionLength: "Peer body".length,
          hasDescription: true,
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
  ],
};

describe("pragmatic drag data", () => {
  test("uses the summary card snapshot for drag payload construction", () => {
    const result = buildBoardCardDragData({
      board,
      selection: emptyCardSelection(),
      instanceId: Symbol("test-instance"),
      projectId: "default",
      databaseBlockId: "database-default",
      dataSourceId: "source-default",
      storeEpoch: "epoch-default",
      activePage: board.columns[0]!.cards[0]!,
      columnId: "doing",
    });

    expect(result.sourcePage.descriptionPreview).toBe("Persisted body");
    expect(result.dragItems[0]?.card.descriptionPreview).toBe("Persisted body");
  });

  test("card drop targets reject cards that are already in the dragged group", () => {
    const instanceId = Symbol("test-instance");
    const selection = toggleCardSelection(
      toggleCardSelection(emptyCardSelection(), "card-1"),
      "card-2",
    );
    const dragData = buildBoardCardDragData({
      board,
      selection,
      instanceId,
      projectId: "default",
      databaseBlockId: "database-default",
      dataSourceId: "source-default",
      storeEpoch: "epoch-default",
      activePage: board.columns[0]!.cards[0]!,
      columnId: "doing",
    });

    expect(
      canDropOnBoardCard({
        targetPageId: "card-1",
        source: dragData,
        instanceId,
      }),
    ).toBe(false);
    expect(
      canDropOnBoardCard({
        targetPageId: "card-2",
        source: dragData,
        instanceId,
      }),
    ).toBe(false);
    expect(
      canDropOnBoardCard({
        targetPageId: "card-3",
        source: dragData,
        instanceId,
      }),
    ).toBe(true);
  });
});
