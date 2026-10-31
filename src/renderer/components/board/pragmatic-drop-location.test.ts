import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import {
  buildBoardCardDragData,
  buildBoardCardDropTargetData,
  buildBoardCardEditorTransferTargetData,
  buildBoardColumnDropTargetData,
} from "./pragmatic-drag-data";
import { emptyCardSelection } from "./card-selection";
import { resolveBoardDropLocation } from "./pragmatic-drop-location";

const instanceId = Symbol("test-dnd");

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
          created: new Date("2026-03-01T00:00:00.000Z"),
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
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
  ],
};

describe("pragmatic drop location", () => {
  const createSurface = () =>
    ({
      querySelectorAll: () => [
        {
          dataset: { boardUuidV7: "a" },
          getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
        },
        {
          dataset: { boardUuidV7: "b" },
          getBoundingClientRect: () => ({ top: 150, bottom: 190 }),
        },
      ],
    }) as unknown as HTMLElement;

  test("uses pointer position to resolve the honest slot among non-dragged cards", () => {
    const surface = createSurface();

    const result = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildBoardCardDropTargetData({
            instanceId,
            pageId: "b",
            columnId: "doing",
          }),
        },
      ],
      draggedPageIds: ["a"],
      pointerY: 151,
      resolveColumnSurface: () => surface,
    });

    expect(result?.columnId).toBe("doing");
    expect(result?.index).toBe(0);
  });

  test("keeps the same slot whether a drag is over the card body or the gap below it", () => {
    const surface = createSurface();

    const overCard = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildBoardCardDropTargetData({
            instanceId,
            pageId: "a",
            columnId: "doing",
          }),
        },
      ],
      draggedPageIds: ["b"],
      pointerY: 139,
      resolveColumnSurface: () => surface,
    });
    const overGap = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildBoardColumnDropTargetData({
            instanceId,
            columnId: "doing",
          }),
        },
      ],
      draggedPageIds: ["b"],
      pointerY: 145,
      resolveColumnSurface: () => surface,
    });

    expect(overCard?.index).toBe(1);
    expect(overGap?.index).toBe(1);
  });

  test("ignores card targets that are already part of the dragged group", () => {
    const result = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildBoardCardDropTargetData({
            instanceId,
            pageId: "a",
            columnId: "doing",
          }),
        },
      ],
      draggedPageIds: ["a"],
      pointerY: 110,
      resolveColumnSurface: () => null,
    });

    expect(result).toBe(null);
  });

  test("falls back to the parent column target when the nested card target is part of the dragged group", () => {
    const dragData = buildBoardCardDragData({
      board,
      selection: emptyCardSelection(),
      instanceId,
      projectId: "default",
      databaseBlockId: "database-default",
      dataSourceId: "source-default",
      storeEpoch: "epoch-default",
      activePage: board.columns[0]!.cards[0]!,
      columnId: "doing",
    });
    const surface = createSurface();

    const result = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildBoardCardDropTargetData({
            instanceId,
            pageId: "a",
            columnId: "doing",
          }),
        },
        {
          data: buildBoardColumnDropTargetData({
            instanceId,
            columnId: "doing",
          }),
        },
      ],
      sourceData: dragData,
      draggedPageIds: ["a"],
      pointerY: 145,
      resolveColumnSurface: () => surface,
    });

    expect(result?.columnId).toBe("doing");
    expect(result?.index).toBe(0);
  });

  test("uses pointer-based gap insertion for bare column targets", () => {
    const surface = createSurface();

    const result = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildBoardColumnDropTargetData({
            instanceId,
            columnId: "doing",
          }),
        },
      ],
      draggedPageIds: ["x"],
      pointerY: 145,
      resolveColumnSurface: () => surface,
    });

    expect(result?.index).toBe(1);
  });

  test("gives an editor reference target ownership over an ancestor column", () => {
    const result = resolveBoardDropLocation({
      visibleBoard: board,
      dropTargets: [
        { data: buildBoardCardEditorTransferTargetData() },
        {
          data: buildBoardColumnDropTargetData({
            instanceId,
            columnId: "doing",
          }),
        },
      ],
      draggedPageIds: ["a"],
      pointerY: 145,
      resolveColumnSurface: createSurface,
    });

    expect(result).toBe(null);
  });
});
