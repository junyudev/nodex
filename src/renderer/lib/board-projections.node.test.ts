import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_BOARD_COLUMN_WIDTH,
  getBoardColumnLayout,
  normalizeBoardColumnLayoutPrefs,
  readBoardColumnLayoutPrefs,
  updateBoardColumnLayoutPrefs,
  writeBoardColumnLayoutPrefs,
} from "./board-column-layout";
import {
  buildCreateCardTransform,
  buildCompleteOrSkipOccurrenceTransform,
  buildMovePageTransform,
  buildMovePagesTransform,
  buildPatchPageTransform,
  conflictKeysForMove,
  createOptimisticCard,
  overlap,
} from "./board-optimistic-ops";
import type { BoardSummary, DatabasePageSummary } from "./types";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type { BoardChangeEvent } from "../../shared/ipc-api";
import { applyBoardChangeEventToBoard, upsertCardSummaryInBoard } from "./board-summary-events";

describe("board column layout", () => {
  const storage = new Map<string, string>();
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );

  function withMockedLocalStorage(run: () => void): void {
    storage.clear();

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });

    try {
      run();
    } finally {
      storage.clear();

      if (originalLocalStorageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
        return;
      }

      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }

  describe("board column layout prefs", () => {
    test("defaults each column to expanded with the standard width", () => {
      expect(JSON.stringify(getBoardColumnLayout({}, "doing"))).toBe(
        JSON.stringify({
          collapsed: false,
          width: DEFAULT_BOARD_COLUMN_WIDTH,
        }),
      );
    });

    test("normalizes invalid persisted values and ignores unknown statuses", () => {
      const normalized = normalizeBoardColumnLayoutPrefs({
        backlog: {
          collapsed: true,
          width: 999,
        },
        done: {
          width: 120,
        },
        archive: {
          collapsed: true,
        },
      });

      expect(JSON.stringify(normalized)).toBe(
        JSON.stringify({
          plan: {
            collapsed: true,
            width: 416,
          },
          done: {
            width: 224,
          },
        }),
      );
    });

    test("prefers a canonical column key over its legacy alias", () => {
      expect(
        normalizeBoardColumnLayoutPrefs({
          backlog: { collapsed: true, width: 320 },
          plan: { collapsed: false, width: 360 },
        }),
      ).toEqual({
        plan: { collapsed: false, width: 360 },
      });
    });

    test("writes and reads project-scoped layout prefs", () => {
      withMockedLocalStorage(() => {
        const written = writeBoardColumnLayoutPrefs("alpha", {
          plan: { collapsed: true, width: 360 },
        });

        expect(JSON.stringify(written)).toBe(
          JSON.stringify({
            plan: { collapsed: true, width: 360 },
          }),
        );
        expect(JSON.stringify(readBoardColumnLayoutPrefs("alpha"))).toBe(
          JSON.stringify({
            plan: { collapsed: true, width: 360 },
          }),
        );
        expect(JSON.stringify(readBoardColumnLayoutPrefs("beta"))).toBe(JSON.stringify({}));
      });
    });

    test("updates a single column while preserving the rest of the layout map", () => {
      const next = updateBoardColumnLayoutPrefs(
        {
          plan: { collapsed: true, width: 360 },
          done: { width: 240 },
        },
        "done",
        { collapsed: true, width: 288 },
      );

      expect(JSON.stringify(next)).toBe(
        JSON.stringify({
          plan: { collapsed: true, width: 360 },
          done: { collapsed: true, width: 288 },
        }),
      );
    });
  });
});

describe("board optimistic ops", () => {
  function createPageSummary(id: string, order: number): DatabasePageSummary {
    return {
      id,
      pageKey: null,
      status: "doing",
      archived: false,
      title: id,
      richTitle: plainTextToPortableRichText(id),
      descriptionPreview: "",
      descriptionLength: 0,
      hasDescription: false,
      tags: [],
      created: new Date("2026-03-17T00:00:00.000Z"),
      order,
    };
  }

  function createBoard(): BoardSummary {
    return {
      columns: [
        {
          id: "triage",
          name: "Triage",
          cards: [],
        },
        {
          id: "plan",
          name: "Plan",
          cards: [],
        },
        {
          id: "doing",
          name: "Doing",
          cards: ["a", "b", "c", "d"].map((id, order) => createPageSummary(id, order)),
        },
        {
          id: "review",
          name: "Review",
          cards: [],
        },
        {
          id: "done",
          name: "Done",
          cards: [],
        },
      ],
    };
  }

  describe("board optimistic ops", () => {
    test("creates optimistic cards without a default priority", () => {
      const card = createOptimisticCard({
        title: "Optimistic card",
      });

      expect(card.priority ?? null).toBe(null);
    });

    test("creates a Card before the stable View anchor used by the mutation", () => {
      const board = createBoard();
      const card = createPageSummary("new", 0);

      const nextBoard = buildCreateCardTransform("doing", card, { beforePageId: "c" })(board);

      expect(nextBoard.columns[2]?.cards.map((item) => item.id)).toEqual([
        "a",
        "b",
        "new",
        "c",
        "d",
      ]);
    });

    test("treats an existing Page identity as a converged create", () => {
      const board = createBoard();
      const optimisticCard = {
        ...createPageSummary("new", 0),
        title: "Optimistic title",
        richTitle: plainTextToPortableRichText("Optimistic title"),
      };
      const transform = buildCreateCardTransform("doing", optimisticCard, "top");

      const created = transform(board);
      const reapplied = transform(created);

      expect(reapplied).toBe(created);
      expect(
        reapplied.columns
          .flatMap((column) => column.cards)
          .filter((card) => card.id === optimisticCard.id),
      ).toHaveLength(1);
    });

    test("preserves requested placement and canonical fields while create authority converges", () => {
      const baseBoard = createBoard();
      const canonicalCard = {
        ...createPageSummary("canonical", 4),
        title: "Canonical title",
        richTitle: plainTextToPortableRichText("Canonical title"),
        revision: 1,
      };
      const board: BoardSummary = {
        ...baseBoard,
        columns: baseBoard.columns.map((column) =>
          column.id === "doing" ? { ...column, cards: [...column.cards, canonicalCard] } : column,
        ),
      };
      const optimisticCard = {
        ...canonicalCard,
        title: "Optimistic title",
        richTitle: plainTextToPortableRichText("Optimistic title"),
        revision: undefined,
      };

      const projected = buildCreateCardTransform("doing", optimisticCard, "top")(board);

      expect(projected.columns[2]?.cards[0]).toMatchObject({
        id: canonicalCard.id,
        title: "Canonical title",
        revision: 1,
        order: 0,
      });
      expect(projected.columns[2]?.cards.map((card) => card.id)).toEqual([
        "canonical",
        "a",
        "b",
        "c",
        "d",
      ]);
    });

    test("treats equivalent projected title and structured values as a no-op", () => {
      const board = createBoard();

      expect(
        buildPatchPageTransform("doing", "a", {
          title: "a",
          tags: [],
        })(board),
      ).toBe(board);

      const renamed = buildPatchPageTransform("doing", "a", {
        title: "Renamed",
      })(board);
      expect(renamed).not.toBe(board);
      expect(renamed.columns[2]?.cards[0]).toMatchObject({
        title: "Renamed",
        richTitle: [{ type: "text", text: "Renamed", styles: {} }],
      });
    });

    test("move-card uses post-removal insertion indices for same-column reorders", () => {
      const board = createBoard();

      const nextBoard = buildMovePageTransform({
        pageId: "a",
        fromStatus: "doing",
        toStatus: "doing",
        newOrder: 1,
      })(board);

      expect(nextBoard.columns[2]?.cards.map((card) => card.id).join(",")).toBe("b,a,c,d");
    });

    test("move-card converges by target column, slot, and projected fields", () => {
      const transform = buildMovePageTransform({
        pageId: "a",
        fromStatus: "doing",
        toStatus: "done",
        newOrder: 0,
        fieldPatch: { priority: "p1-high" },
      });

      const moved = transform(createBoard());
      const movedCard = moved.columns[4]?.cards[0];

      expect(movedCard).toMatchObject({
        id: "a",
        status: "done",
        priority: "p1-high",
      });
      expect(transform(moved)).toBe(moved);
    });

    test("move-many uses post-removal insertion indices for same-column reorders", () => {
      const board = createBoard();

      const nextBoard = buildMovePagesTransform({
        pageIds: ["a", "c"],
        fromStatus: "doing",
        toStatus: "doing",
        newOrder: 1,
      })(board);

      expect(nextBoard.columns[2]?.cards.map((card) => card.id).join(",")).toBe("b,a,c,d");
    });

    test("move-many preserves the visual input order and converges atomically", () => {
      const transform = buildMovePagesTransform({
        pageIds: ["c", "a"],
        fromStatus: "doing",
        toStatus: "done",
        newOrder: 0,
      });

      const moved = transform(createBoard());

      expect(moved.columns[4]?.cards.map((card) => card.id)).toEqual(["c", "a"]);
      expect(moved.columns[4]?.cards.every((card) => card.status === "done")).toBe(true);
      expect(transform(moved)).toBe(moved);
    });

    test("move-many does not project a partial run", () => {
      const board = createBoard();

      expect(
        buildMovePagesTransform({
          pageIds: ["a", "missing"],
          fromStatus: "doing",
          toStatus: "done",
          newOrder: 0,
        })(board),
      ).toBe(board);
    });

    test("move-card applies the drag field patch before reinserting", () => {
      const board = createBoard();

      const nextBoard = buildMovePageTransform({
        pageId: "a",
        fromStatus: "doing",
        toStatus: "doing",
        newOrder: 1,
        fieldPatch: { priority: "p1-high" },
      })(board);

      expect(nextBoard.columns[2]?.cards[1]?.priority).toBe("p1-high");
    });

    test("move-many applies the drag field patch to every dragged card", () => {
      const board = createBoard();

      const nextBoard = buildMovePagesTransform({
        pageIds: ["a", "c"],
        fromStatus: "doing",
        toStatus: "doing",
        newOrder: 1,
        fieldPatch: { estimate: "m" },
      })(board);

      expect(nextBoard.columns[2]?.cards[1]?.estimate).toBe("m");
      expect(nextBoard.columns[2]?.cards[2]?.estimate).toBe("m");
    });

    test("complete-or-skip converges once canonical scheduling is already clear", () => {
      const board = createBoard();

      expect(buildCompleteOrSkipOccurrenceTransform("a")(board)).toBe(board);
    });

    test("different Page moves coexist while the placement lane serializes authority", () => {
      const first = conflictKeysForMove({
        pageId: "a",
        fromStatus: "doing",
        toStatus: "done",
      });
      const second = conflictKeysForMove({
        pageId: "b",
        fromStatus: "doing",
        toStatus: "done",
      });

      expect(overlap(first, second)).toBe(false);
      expect(
        overlap(
          first,
          conflictKeysForMove({
            pageId: "a",
            fromStatus: "doing",
            toStatus: "plan",
          }),
        ),
      ).toBe(true);
    });
  });
});

describe("board summary events", () => {
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
});
