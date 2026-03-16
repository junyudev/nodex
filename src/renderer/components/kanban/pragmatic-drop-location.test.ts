import { describe, expect, test } from "bun:test";
import type { Board } from "@/lib/types";
import {
  buildKanbanCardDragData,
  buildKanbanCardDropTargetData,
  buildKanbanColumnDropTargetData,
} from "./pragmatic-drag-data";
import { emptyCardSelection } from "./card-selection";
import { resolveKanbanDropLocation } from "./pragmatic-drop-location";

const instanceId = Symbol("test-dnd");

const board: Board = {
  columns: [
    {
      id: "in_progress",
      name: "In Progress",
      cards: [
        {
          id: "a",
          status: "in_progress",
          archived: false,
          title: "A",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "b",
          status: "in_progress",
          archived: false,
          title: "B",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 1,
        },
      ],
    },
  ],
};

describe("pragmatic drop location", () => {
  const createSurface = () => ({
    querySelectorAll: () => [
      {
        dataset: { kanbanCardId: "a" },
        getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
      },
      {
        dataset: { kanbanCardId: "b" },
        getBoundingClientRect: () => ({ top: 150, bottom: 190 }),
      },
    ],
  } as unknown as HTMLElement);

  test("uses pointer position to resolve the honest slot among non-dragged cards", () => {
    const surface = createSurface();

    const result = resolveKanbanDropLocation({
      visibleBoard: board,
      dropTargets: [{
        data: buildKanbanCardDropTargetData({
          instanceId,
          cardId: "b",
          columnId: "in_progress",
        }),
      }],
      draggedCardIds: ["a"],
      pointerY: 151,
      resolveColumnSurface: () => surface,
    });

    expect(result?.columnId).toBe("in_progress");
    expect(result?.index).toBe(0);
  });

  test("keeps the same slot whether a drag is over the card body or the gap below it", () => {
    const surface = createSurface();

    const overCard = resolveKanbanDropLocation({
      visibleBoard: board,
      dropTargets: [{
        data: buildKanbanCardDropTargetData({
          instanceId,
          cardId: "a",
          columnId: "in_progress",
        }),
      }],
      draggedCardIds: ["b"],
      pointerY: 139,
      resolveColumnSurface: () => surface,
    });
    const overGap = resolveKanbanDropLocation({
      visibleBoard: board,
      dropTargets: [{
        data: buildKanbanColumnDropTargetData({
          instanceId,
          columnId: "in_progress",
        }),
      }],
      draggedCardIds: ["b"],
      pointerY: 145,
      resolveColumnSurface: () => surface,
    });

    expect(overCard?.index).toBe(1);
    expect(overGap?.index).toBe(1);
  });

  test("ignores card targets that are already part of the dragged group", () => {
    const result = resolveKanbanDropLocation({
      visibleBoard: board,
      dropTargets: [{
        data: buildKanbanCardDropTargetData({
          instanceId,
          cardId: "a",
          columnId: "in_progress",
        }),
      }],
      draggedCardIds: ["a"],
      pointerY: 110,
      resolveColumnSurface: () => null,
    });

    expect(result).toBe(null);
  });

  test("falls back to the parent column target when the nested card target is part of the dragged group", () => {
    const dragData = buildKanbanCardDragData({
      board,
      selection: emptyCardSelection(),
      instanceId,
      projectId: "default",
      activeCard: board.columns[0]!.cards[0]!,
      columnId: "in_progress",
    });
    const surface = createSurface();

    const result = resolveKanbanDropLocation({
      visibleBoard: board,
      dropTargets: [
        {
          data: buildKanbanCardDropTargetData({
            instanceId,
            cardId: "a",
            columnId: "in_progress",
          }),
        },
        {
          data: buildKanbanColumnDropTargetData({
            instanceId,
            columnId: "in_progress",
          }),
        },
      ],
      sourceData: dragData,
      draggedCardIds: ["a"],
      pointerY: 145,
      resolveColumnSurface: () => surface,
    });

    expect(result?.columnId).toBe("in_progress");
    expect(result?.index).toBe(0);
  });

  test("uses pointer-based gap insertion for bare column targets", () => {
    const surface = createSurface();

    const result = resolveKanbanDropLocation({
      visibleBoard: board,
      dropTargets: [{
        data: buildKanbanColumnDropTargetData({
          instanceId,
          columnId: "in_progress",
        }),
      }],
      draggedCardIds: ["x"],
      pointerY: 145,
      resolveColumnSurface: () => surface,
    });

    expect(result?.index).toBe(1);
  });
});
