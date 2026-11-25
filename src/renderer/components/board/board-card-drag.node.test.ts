import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary, WorkflowStatus, DatabasePageSummary } from "@/lib/types";
import type { DbViewRules } from "../../lib/db-view-prefs";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { resolveBoardCardDragMode, resolveBoardCardDropIntent } from "./board-card-drop-strategy";
import { resolveBoardDropCapabilities } from "./board-drop-capabilities";
import { resolveBoardDropFeedback } from "./drop-feedback";
import { resolveDropIndicatorPlacement } from "./drop-indicator-placement";
import { resolveFilteredDropOrder } from "./filtered-drag-order";
import { computeNativeDropIndex, computeNativeDropIndexFromSurface } from "./native-drop-index";
import { emptyCardSelection, toggleCardSelection } from "./card-selection";
import {
  buildBoardCardDragData,
  canDropOnBoardCard,
  buildBoardCardDropTargetData,
  buildBoardCardEditorTransferTargetData,
  buildBoardColumnDropTargetData,
} from "./pragmatic-drag-data";
import { resolveBoardDropLocation } from "./pragmatic-drop-location";

describe("board card drop strategy", () => {
  function makeCard(
    id: string,
    status: WorkflowStatus,
    order: number,
    overrides: Partial<DatabasePageSummary> = {},
  ): DatabasePageSummary {
    const title = overrides.title ?? id;
    return {
      id,
      status,
      archived: false,
      title,
      richTitle: plainTextToPortableRichText(title),
      descriptionPreview: "",
      descriptionLength: 0,
      hasDescription: false,
      tags: [],
      created: new Date("2026-03-17T00:00:00.000Z"),
      order,
      ...overrides,
      pageKey: overrides.pageKey ?? null,
    };
  }

  function makeBoard(
    columns: Partial<Record<WorkflowStatus, DatabasePageSummary[]>>,
  ): BoardSummary {
    const orderedStatuses: WorkflowStatus[] = ["triage", "plan", "doing", "review", "done"];
    return {
      columns: orderedStatuses.map((status) => ({
        id: status,
        name: status,
        cards: columns[status] ?? [],
      })),
    };
  }

  function makeRules(sort: DbViewRules["sort"]): DbViewRules {
    return {
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["triage", "plan", "doing", "review", "done"] },
              {
                field: "priority",
                op: "in",
                values: ["p0-critical", "p1-high", "p2-medium", "p3-low"],
                includeEmpty: true,
              },
            ],
          },
        ],
      },
      sort,
    };
  }

  describe("board card drop strategy", () => {
    test("treats board-order as manual rank even with secondary sorts", () => {
      const dragMode = resolveBoardCardDragMode({
        rules: makeRules([
          { field: "board-order", direction: "asc" },
          { field: "created", direction: "desc" },
        ]),
      });

      expect(dragMode.kind).toBe("manual-rank");
    });

    test("keeps visible-slot reordering enabled when board-order stays primary", () => {
      const board = makeBoard({
        doing: [makeCard("a", "doing", 0), makeCard("b", "doing", 1), makeCard("c", "doing", 2)],
      });

      const intent = resolveBoardCardDropIntent({
        board,
        visibleBoard: board,
        rules: makeRules([
          { field: "board-order", direction: "asc" },
          { field: "created", direction: "desc" },
        ]),
        destinationColumnId: "doing",
        destinationIndex: 1,
        dragItems: [
          {
            columnId: "doing",
            card: board.columns[2]!.cards[0]!,
          },
        ],
      });

      expect(intent.kind).toBe("reorder");
      if (intent.kind !== "reorder") {
        throw new Error("Expected reorder intent");
      }
      expect(intent.newOrder).toBe(1);
    });

    test("returns a property patch when a priority-sorted drop crosses buckets", () => {
      const board = makeBoard({
        doing: [
          makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
          makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
          makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
        ],
        review: [makeCard("review", "review", 0, { priority: "p3-low" })],
      });

      const intent = resolveBoardCardDropIntent({
        board,
        visibleBoard: board,
        rules: makeRules([{ field: "priority", direction: "asc" }]),
        destinationColumnId: "doing",
        destinationIndex: 2,
        dragItems: [
          {
            columnId: "review",
            card: board.columns[3]!.cards[0]!,
          },
        ],
      });

      expect(intent.kind).toBe("reorder-with-patch");
      if (intent.kind !== "reorder-with-patch") {
        throw new Error("Expected reorder-with-patch intent");
      }
      expect(intent.fieldPatch.priority).toBe("p2-medium");
      expect(intent.newOrder).toBe(2);
    });

    test("keeps within-bucket priority drops as pure reorders", () => {
      const board = makeBoard({
        doing: [
          makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
          makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
          makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
        ],
      });

      const intent = resolveBoardCardDropIntent({
        board,
        visibleBoard: board,
        rules: makeRules([{ field: "priority", direction: "asc" }]),
        destinationColumnId: "doing",
        destinationIndex: 1,
        dragItems: [
          {
            columnId: "doing",
            card: board.columns[2]!.cards[1]!,
          },
        ],
      });

      expect(intent.kind).toBe("reorder");
    });

    test("maps same-column downward priority drops from the remaining visible slot space", () => {
      const board = makeBoard({
        doing: [
          makeCard("p1-a", "doing", 0, { priority: "p1-high" }),
          makeCard("p1-b", "doing", 1, { priority: "p1-high" }),
          makeCard("p2-a", "doing", 2, { priority: "p2-medium" }),
        ],
      });

      const intent = resolveBoardCardDropIntent({
        board,
        visibleBoard: board,
        rules: makeRules([{ field: "priority", direction: "asc" }]),
        destinationColumnId: "doing",
        destinationIndex: 1,
        dragItems: [
          {
            columnId: "doing",
            card: board.columns[2]!.cards[0]!,
          },
        ],
      });

      expect(intent.kind).toBe("reorder");
      if (intent.kind !== "reorder") {
        throw new Error("Expected reorder intent");
      }
      expect(intent.newOrder).toBe(1);
    });

    test("blocks same-column ranking when title owns the sort", () => {
      const board = makeBoard({
        doing: [
          makeCard("a", "doing", 0, { title: "Alpha" }),
          makeCard("b", "doing", 1, { title: "Beta" }),
        ],
      });

      const intent = resolveBoardCardDropIntent({
        board,
        visibleBoard: board,
        rules: makeRules([{ field: "title", direction: "asc" }]),
        destinationColumnId: "doing",
        destinationIndex: 1,
        dragItems: [
          {
            columnId: "doing",
            card: board.columns[2]!.cards[0]!,
          },
        ],
      });

      expect(intent.kind).toBe("blocked");
    });

    test("keeps cross-column moves enabled when title owns the sort", () => {
      const board = makeBoard({
        doing: [makeCard("a", "doing", 0, { title: "Alpha" })],
        review: [makeCard("b", "review", 0, { title: "Beta" })],
      });

      const intent = resolveBoardCardDropIntent({
        board,
        visibleBoard: board,
        rules: makeRules([{ field: "title", direction: "asc" }]),
        destinationColumnId: "done",
        destinationIndex: 0,
        dragItems: [
          {
            columnId: "doing",
            card: board.columns[2]!.cards[0]!,
          },
        ],
      });

      expect(intent.kind).toBe("move-only");
    });
  });
});

describe("resolveBoardDropCapabilities", () => {
  test("keeps both card and column targets active under the default board sort", () => {
    const capabilities = resolveBoardDropCapabilities({
      dragMode: { kind: "manual-rank" },
    });

    expect(capabilities.allowPageTargets).toBe(true);
    expect(capabilities.allowColumnTargets).toBe(true);
  });

  test("keeps card targets active for inferable property-sorted drags", () => {
    const capabilities = resolveBoardDropCapabilities({
      dragMode: { kind: "property-sorted", field: "priority" },
    });

    expect(capabilities.allowPageTargets).toBe(true);
    expect(capabilities.allowColumnTargets).toBe(true);
  });

  test("disables only card targets under move-only derived sorts so cross-column drops still resolve", () => {
    const capabilities = resolveBoardDropCapabilities({
      dragMode: { kind: "derived-move-only", field: "title" },
    });

    expect(capabilities.allowPageTargets).toBe(false);
    expect(capabilities.allowColumnTargets).toBe(true);
  });
});

describe("drop feedback", () => {
  const EMPTY_BOARD: BoardSummary = {
    columns: [
      {
        id: "plan",
        name: "Plan",
        cards: [],
      },
    ],
  };

  const FILLED_BOARD: BoardSummary = {
    columns: [
      {
        id: "plan",
        name: "Plan",
        cards: [
          {
            id: "card-1",
            pageKey: null,
            status: "plan",
            archived: false,
            title: "Task",
            richTitle: plainTextToPortableRichText("Task"),
            descriptionPreview: "",
            descriptionLength: 0,
            hasDescription: false,
            tags: [],
            created: new Date("2026-03-19T00:00:00.000Z"),
            order: 0,
          },
        ],
      },
    ],
  };

  describe("resolveBoardDropFeedback", () => {
    test("uses whole-column feedback for empty target columns", () => {
      const feedback = resolveBoardDropFeedback({
        visibleBoard: EMPTY_BOARD,
        columnId: "plan",
        visibleIndex: 0,
        showSlotIndicator: true,
      });

      expect(feedback.dropIndicator).toBe(null);
      expect(feedback.activeDropColumnId).toBe("plan");
    });

    test("uses an insertion indicator for non-empty columns when slot feedback is truthful", () => {
      const feedback = resolveBoardDropFeedback({
        visibleBoard: FILLED_BOARD,
        columnId: "plan",
        visibleIndex: 1,
        showSlotIndicator: true,
        label: "P1",
      });

      expect(feedback.activeDropColumnId).toBe(null);
      expect(feedback.dropIndicator?.columnId).toBe("plan");
      expect(feedback.dropIndicator?.index).toBe(1);
      expect(feedback.dropIndicator?.label).toBe("P1");
    });

    test("uses whole-column feedback when slot indicators are intentionally disabled", () => {
      const feedback = resolveBoardDropFeedback({
        visibleBoard: FILLED_BOARD,
        columnId: "plan",
        visibleIndex: 0,
        showSlotIndicator: false,
      });

      expect(feedback.dropIndicator).toBe(null);
      expect(feedback.activeDropColumnId).toBe("plan");
    });
  });
});

describe("resolveDropIndicatorPlacement", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("renders before the first remaining card instead of the dragged source ghost", () => {
    const placement = resolveDropIndicatorPlacement(cards, new Set(["a"]), 0);

    expect(placement.beforePageId).toBe("b");
    expect(placement.atEnd).toBe(false);
  });

  test("renders before the matching remaining card in an unfiltered list", () => {
    const placement = resolveDropIndicatorPlacement(cards, new Set<string>(), 1);

    expect(placement.beforePageId).toBe("b");
    expect(placement.atEnd).toBe(false);
  });

  test("renders at the end when the indicator targets the final slot", () => {
    const placement = resolveDropIndicatorPlacement(cards, new Set(["a"]), 2);

    expect(placement.beforePageId).toBe(null);
    expect(placement.atEnd).toBe(true);
  });
});

describe("filtered drag order", () => {
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
});

describe("native drop index", () => {
  test("returns 0 for empty columns", () => {
    expect(computeNativeDropIndex([], 100)).toBe(0);
  });

  test("returns top insertion index when pointer is above first midpoint", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      110,
    );
    expect(index).toBe(0);
  });

  test("returns middle insertion index when pointer is between midpoints", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      160,
    );
    expect(index).toBe(1);
  });

  test("returns the next insertion index when the pointer is in the visual gap between cards", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      145,
    );
    expect(index).toBe(1);
  });

  test("returns end insertion index when pointer is below all cards", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      220,
    );
    expect(index).toBe(2);
  });

  test("reads card rects from DOM surface", () => {
    const cardA = {
      getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
    } as unknown as HTMLElement;
    const cardB = {
      getBoundingClientRect: () => ({ top: 150, bottom: 190 }),
    } as unknown as HTMLElement;
    const surface = {
      querySelectorAll: () => [cardA, cardB],
    } as unknown as HTMLElement;

    expect(computeNativeDropIndexFromSurface(surface, 169)).toBe(1);
  });

  test("ignores dragged cards that remain rendered in the source column", () => {
    const cardA = {
      dataset: { boardUuidV7: "a" },
      getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
    } as unknown as HTMLElement;
    const cardB = {
      dataset: { boardUuidV7: "b" },
      getBoundingClientRect: () => ({ top: 150, bottom: 190 }),
    } as unknown as HTMLElement;
    const surface = {
      querySelectorAll: () => [cardA, cardB],
    } as unknown as HTMLElement;

    expect(
      computeNativeDropIndexFromSurface(surface, 160, {
        ignoredPageIds: new Set(["a"]),
      }),
    ).toBe(0);
  });
});

describe("pragmatic drag data", () => {
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
});

describe("pragmatic drop location", () => {
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
});
