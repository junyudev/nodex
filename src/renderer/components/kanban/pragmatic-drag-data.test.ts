import { describe, expect, test } from "bun:test";
import type { Board } from "@/lib/types";
import { emptyCardSelection, toggleCardSelection } from "./card-selection";
import {
  buildKanbanCardDragData,
  canDropOnKanbanCard,
} from "./pragmatic-drag-data";

const board: Board = {
  columns: [
    {
      id: "in_progress",
      name: "In Progress",
      cards: [
        {
          id: "card-1",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Persisted body",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        {
          id: "card-2",
          status: "in_progress",
          archived: false,
          title: "Peer",
          description: "Peer body",
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

describe("pragmatic drag data", () => {
  test("uses the persisted card snapshot for drag payload construction", () => {
    const result = buildKanbanCardDragData({
      board,
      selection: emptyCardSelection(),
      instanceId: Symbol("test-instance"),
      projectId: "default",
      activeCard: board.columns[0]!.cards[0]!,
      columnId: "in_progress",
    });

    expect(result.sourceCard.description).toBe("Persisted body");
    expect(result.dragItems[0]?.card.description).toBe("Persisted body");
  });

  test("card drop targets reject cards that are already in the dragged group", () => {
    const instanceId = Symbol("test-instance");
    const selection = toggleCardSelection(
      toggleCardSelection(emptyCardSelection(), "card-1"),
      "card-2",
    );
    const dragData = buildKanbanCardDragData({
      board,
      selection,
      instanceId,
      projectId: "default",
      activeCard: board.columns[0]!.cards[0]!,
      columnId: "in_progress",
    });

    expect(canDropOnKanbanCard({
      targetCardId: "card-1",
      source: dragData,
      instanceId,
    })).toBeFalse();
    expect(canDropOnKanbanCard({
      targetCardId: "card-2",
      source: dragData,
      instanceId,
    })).toBeFalse();
    expect(canDropOnKanbanCard({
      targetCardId: "card-3",
      source: dragData,
      instanceId,
    })).toBeTrue();
  });
});
