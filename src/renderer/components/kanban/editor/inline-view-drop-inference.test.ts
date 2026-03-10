import { describe, expect, test } from "bun:test";
import { getDefaultToggleListSettings } from "../../../lib/toggle-list/settings";
import type { Board, Card } from "../../../lib/types";
import {
  inferInlineViewDropImport,
  type InlineViewProjectedRow,
} from "./inline-view-drop-inference";

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    priority: "p2-medium",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-02-16T00:00:00.000Z"),
    order: 0,
    ...overrides,
  };
}

function makeBoard(): Board {
  return {
    columns: [
      {
        id: "1-ideas",
        name: "Ideas",
        cards: [
          makeCard("ideas-1", { order: 0, priority: "p1-high", estimate: "s" }),
          makeCard("ideas-2", { order: 1, priority: "p1-high", estimate: "m" }),
        ],
      },
      {
        id: "3-backlog",
        name: "Backlog",
        cards: [
          makeCard("backlog-1", { order: 0, priority: "p3-low" }),
        ],
      },
    ],
  };
}

describe("inline view drop inference", () => {
  test("infers target column and insert index from pointed projected rows", () => {
    const settings = getDefaultToggleListSettings();
    const projectedRows: InlineViewProjectedRow[] = [
      { blockId: "row-1", cardId: "ideas-1", sourceColumnId: "1-ideas" },
      { blockId: "row-2", cardId: "ideas-2", sourceColumnId: "1-ideas" },
    ];

    const inferred = inferInlineViewDropImport({
      settings,
      projectedRows,
      insertRowIndex: 1,
      board: makeBoard(),
      cards: [{ title: "Dropped block" }],
    });

    expect(inferred.targetColumnId).toBe("1-ideas");
    expect(inferred.insertIndex).toBe(1);
  });

  test("falls back to first allowed status when no neighboring rows exist", () => {
    const settings = getDefaultToggleListSettings();
    settings.rulesV2 = {
      ...settings.rulesV2,
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["3-backlog"] },
              { field: "priority", op: "in", values: ["p0-critical", "p1-high", "p2-medium", "p3-low", "p4-later"] },
            ],
          },
        ],
      },
    };

    const inferred = inferInlineViewDropImport({
      settings,
      projectedRows: [],
      insertRowIndex: 0,
      board: makeBoard(),
      cards: [{ title: "Dropped block" }],
    });

    expect(inferred.targetColumnId).toBe("3-backlog");
    expect(inferred.insertIndex).toBe(undefined);
  });

  test("infers ranking defaults from nearest card when missing", () => {
    const settings = getDefaultToggleListSettings();
    settings.rulesV2 = {
      ...settings.rulesV2,
      sort: [
        { field: "priority", direction: "asc" },
        { field: "estimate", direction: "asc" },
      ],
    };

    const projectedRows: InlineViewProjectedRow[] = [
      { blockId: "row-1", cardId: "ideas-2", sourceColumnId: "1-ideas" },
    ];

    const inferred = inferInlineViewDropImport({
      settings,
      projectedRows,
      insertRowIndex: 0,
      board: makeBoard(),
      cards: [{ title: "Dropped block" }],
    });

    expect(inferred.cards[0]?.priority).toBe("p1-high");
    expect(inferred.cards[0]?.estimate).toBe("m");
  });
});
