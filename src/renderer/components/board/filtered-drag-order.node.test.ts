import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary, WorkflowStatus, DatabasePageSummary } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { resolveFilteredDropOrder } from "./filtered-drag-order";

function createPage(id: string, status: WorkflowStatus, order: number): DatabasePageSummary {
  return {
    id,
    pageKey: null,
    status,
    archived: false,
    title: id,
    richTitle: plainTextToPortableRichText(id),
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
    tags: [],
    created: new Date("2026-03-14T00:00:00.000Z"),
    order,
  };
}

function createBoard(columns: Partial<Record<WorkflowStatus, string[]>>): BoardSummary {
  const orderedStatuses: WorkflowStatus[] = [
    "triage",
    "plan",
    "doing",
    "review",
    "done",
    "canceled",
  ];
  return {
    columns: orderedStatuses.map((status) => ({
      id: status,
      name: status,
      cards: (columns[status] ?? []).map((id, index) => createPage(id, status, index)),
    })),
  };
}

describe("resolveFilteredDropOrder", () => {
  test("inserts before the next visible anchor while preserving hidden cards", () => {
    const board = createBoard({
      triage: [],
      plan: [],
      doing: ["hidden-a", "visible-b", "hidden-c", "visible-d", "hidden-e"],
      review: ["moved"],
      done: [],
    });
    const visibleBoard = createBoard({
      triage: [],
      plan: [],
      doing: ["visible-b", "visible-d"],
      review: ["moved"],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedPageIds: ["moved"],
      targetColumnId: "doing",
      targetVisibleIndex: 1,
    });

    expect(order).toBe(3);
  });

  test("drops after the last visible card instead of after trailing hidden cards", () => {
    const board = createBoard({
      triage: [],
      plan: [],
      doing: ["hidden-a", "visible-b", "hidden-c", "visible-d", "hidden-e"],
      review: ["moved"],
      done: [],
    });
    const visibleBoard = createBoard({
      triage: [],
      plan: [],
      doing: ["visible-b", "visible-d"],
      review: ["moved"],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedPageIds: ["moved"],
      targetColumnId: "doing",
      targetVisibleIndex: 2,
    });

    expect(order).toBe(4);
  });

  test("keeps same-column drops stable when the dragged card is the only visible match", () => {
    const board = createBoard({
      triage: [],
      plan: [],
      doing: ["visible-a", "hidden-b"],
      review: [],
      done: [],
    });
    const visibleBoard = createBoard({
      triage: [],
      plan: [],
      doing: ["visible-a"],
      review: [],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedPageIds: ["visible-a"],
      targetColumnId: "doing",
      targetVisibleIndex: 1,
    });

    expect(order).toBe(0);
  });

  test("maps same-column filtered drops from the remaining visible slot space", () => {
    const board = createBoard({
      triage: [],
      plan: [],
      doing: ["hidden-a", "visible-b", "hidden-c", "visible-d", "hidden-e"],
      review: [],
      done: [],
    });
    const visibleBoard = createBoard({
      triage: [],
      plan: [],
      doing: ["visible-b", "visible-d"],
      review: [],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard,
      draggedPageIds: ["visible-b"],
      targetColumnId: "doing",
      targetVisibleIndex: 1,
    });

    expect(order).toBe(3);
  });

  test("maps same-column unfiltered drops from the remaining visible slot space", () => {
    const board = createBoard({
      triage: [],
      plan: [],
      doing: ["a", "b", "c"],
      review: [],
      done: [],
    });

    const order = resolveFilteredDropOrder({
      board,
      visibleBoard: board,
      draggedPageIds: ["a"],
      targetColumnId: "doing",
      targetVisibleIndex: 1,
    });

    expect(order).toBe(1);
  });
});
