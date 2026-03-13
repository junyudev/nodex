import { describe, expect, test } from "bun:test";
import type { Board, Card, CardStatus } from "@/lib/types";
import { resolveFilteredDropOrder } from "./filtered-drag-order";

function createCard(id: string, status: CardStatus, order: number): Card {
  return {
    id,
    status,
    archived: false,
    title: id,
    description: "",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-03-14T00:00:00.000Z"),
    order,
  };
}

function createBoard(columns: Record<CardStatus, string[]>): Board {
  const orderedStatuses: CardStatus[] = ["draft", "backlog", "in_progress", "in_review", "done"];
  return {
    columns: orderedStatuses.map((status) => ({
      id: status,
      name: status,
      cards: (columns[status] ?? []).map((id, index) => createCard(id, status, index)),
    })),
  };
}

describe("resolveFilteredDropOrder", () => {
  test("inserts before the next visible anchor while preserving hidden cards", () => {
    const board = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["hidden-a", "visible-b", "hidden-c", "visible-d", "hidden-e"],
      in_review: ["moved"],
      done: [],
    });
    const visibleBoard = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["visible-b", "visible-d"],
      in_review: ["moved"],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedCardIds: ["moved"],
      targetColumnId: "in_progress",
      targetVisibleIndex: 1,
    });

    expect(order).toBe(3);
  });

  test("drops after the last visible card instead of after trailing hidden cards", () => {
    const board = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["hidden-a", "visible-b", "hidden-c", "visible-d", "hidden-e"],
      in_review: ["moved"],
      done: [],
    });
    const visibleBoard = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["visible-b", "visible-d"],
      in_review: ["moved"],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedCardIds: ["moved"],
      targetColumnId: "in_progress",
      targetVisibleIndex: 2,
    });

    expect(order).toBe(4);
  });

  test("keeps same-column drops stable when the dragged card is the only visible match", () => {
    const board = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["visible-a", "hidden-b"],
      in_review: [],
      done: [],
    });
    const visibleBoard = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["visible-a"],
      in_review: [],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedCardIds: ["visible-a"],
      targetColumnId: "in_progress",
      targetVisibleIndex: 1,
    });

    expect(order).toBe(0);
  });

  test("adjusts visible indices when moving multiple selected visible cards in the same column", () => {
    const board = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["visible-a", "hidden-b", "visible-c", "visible-d", "hidden-e"],
      in_review: [],
      done: [],
    });
    const visibleBoard = createBoard({
      draft: [],
      backlog: [],
      in_progress: ["visible-a", "visible-c", "visible-d"],
      in_review: [],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedCardIds: ["visible-a", "visible-c"],
      targetColumnId: "in_progress",
      targetVisibleIndex: 3,
    });

    expect(order).toBe(2);
  });
});
