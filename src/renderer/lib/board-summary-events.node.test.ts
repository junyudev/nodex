import { describe, expect, test } from "vite-plus/test";
import type { BoardChangeEvent } from "../../shared/ipc-api";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type { BoardSummary, DatabasePageSummary } from "./types";
import { applyBoardChangeEventToBoard, upsertCardSummaryInBoard } from "./board-summary-events";

function makeCard(
  id: string,
  status: DatabasePageSummary["status"],
  order: number,
): DatabasePageSummary {
  return {
    id,
    pageKey: null,
    status,
    archived: false,
    title: id,
    richTitle: plainTextToPortableRichText(id),
    priority: undefined,
    estimate: undefined,
    tags: [],
    dueDate: undefined,
    scheduledStart: undefined,
    scheduledEnd: undefined,
    isAllDay: undefined,
    recurrence: undefined,
    reminders: [],
    scheduleTimezone: undefined,
    assignee: undefined,
    runInTarget: undefined,
    runInLocalPath: undefined,
    runInBaseBranch: undefined,
    runInWorktreePath: undefined,
    runInEnvironmentPath: undefined,
    revision: 1,
    created: new Date("2026-01-01T00:00:00.000Z"),
    order,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  };
}

function makeBoard(): BoardSummary {
  return {
    columns: [
      { id: "triage", name: "Triage", cards: [makeCard("card-1", "triage", 0)] },
      { id: "done", name: "Done", cards: [] },
    ],
  };
}

function makeEvent(summary?: DatabasePageSummary): BoardChangeEvent {
  return {
    projectId: "project-1",
    changeType: "update",
    columnId: summary?.status ?? "triage",
    status: summary?.status ?? "triage",
    pageId: summary?.id ?? "card-1",
    summary,
  };
}

describe("board summary events", () => {
  test("patches an updated card summary without replacing unrelated columns", () => {
    const board = makeBoard();
    const nextSummary = { ...makeCard("card-1", "triage", 0), title: "Updated", revision: 2 };
    const next = applyBoardChangeEventToBoard(board, makeEvent(nextSummary));

    expect(next?.columns[0]?.cards[0]?.title).toBe("Updated");
    expect(next?.columns[1]).toBe(board.columns[1]);
  });

  test("moves a card when the summary status changes", () => {
    const board = makeBoard();
    const moved = { ...makeCard("card-1", "done", 0), title: "Moved", revision: 2 };
    const next = applyBoardChangeEventToBoard(board, makeEvent(moved));

    expect(next?.columns[0]?.cards.length).toBe(0);
    expect(next?.columns[1]?.cards[0]?.id).toBe("card-1");
  });

  test("removes archived summaries from the visible board", () => {
    const board = makeBoard();
    const archived = { ...makeCard("card-1", "triage", 0), archived: true };
    const next = applyBoardChangeEventToBoard(board, makeEvent(archived));

    expect(next?.columns[0]?.cards.length).toBe(0);
  });

  test("inserts remote summaries at their requested ordinal and reindexes siblings", () => {
    const board = makeBoard();
    const withTop = upsertCardSummaryInBoard(board, makeCard("card-z", "triage", 0));

    expect(withTop.columns[0]?.cards.map((card) => [card.id, card.order])).toEqual([
      ["card-z", 0],
      ["card-1", 1],
    ]);
  });

  test("preserves Board identity for a repeated canonical summary", () => {
    const board = makeBoard();
    const repeated = upsertCardSummaryInBoard(
      board,
      board.columns[0]?.cards[0] as DatabasePageSummary,
    );

    expect(repeated).toBe(board);
  });
});
