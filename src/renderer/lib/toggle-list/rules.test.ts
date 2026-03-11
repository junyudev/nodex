import { describe, expect, test } from "bun:test";
import { getDefaultToggleListSettings } from "./settings";
import type { ToggleListCard, ToggleListRulesV2, ToggleListSettings } from "./types";
import { filterCards, rankCards } from "./rules";

function makeCard(overrides: Partial<ToggleListCard>): ToggleListCard {
  return {
    id: "card-1",
    status: "backlog",
    archived: false,
    title: "Card title",
    description: "",
    priority: "p2-medium",
    estimate: "m",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "backlog",
    columnName: "Backlog",
    boardIndex: 0,
    ...overrides,
  };
}

function makeSettings(rulesV2?: ToggleListRulesV2): ToggleListSettings {
  const defaults = getDefaultToggleListSettings();
  return {
    ...defaults,
    rulesV2: rulesV2 ?? defaults.rulesV2,
  };
}

describe("toggle-list rules", () => {
  test("filterCards applies canonical status, priority, and search rules together", () => {
    const cards = [
      makeCard({
        id: "card-a",
        title: "Fix parser",
        priority: "p0-critical",
        columnId: "backlog",
        columnName: "Backlog",
      }),
      makeCard({
        id: "card-b",
        title: "Ship docs",
        priority: "p1-high",
        columnId: "backlog",
        columnName: "Ready",
      }),
      makeCard({
        id: "card-c",
        title: "Fix parser quickly",
        priority: "p0-critical",
        columnId: "backlog",
        columnName: "Ready",
      }),
    ];

    const filtered = filterCards(cards, makeSettings({
      mode: "basic",
      includeHostCard: false,
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["backlog"] },
              { field: "priority", op: "in", values: ["p0-critical"] },
            ],
          },
        ],
      },
      sort: [
        { field: "board-order", direction: "asc" },
        { field: "created", direction: "desc" },
      ],
    }), "fix ready");

    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe("card-c");
  });

  test("rankCards honors canonical multi-key sorting", () => {
    const cards = [
      makeCard({
        id: "alpha",
        title: "Alpha",
        priority: "p1-high",
        created: new Date("2026-02-01T00:00:00.000Z"),
        boardIndex: 2,
      }),
      makeCard({
        id: "beta",
        title: "Beta",
        priority: "p0-critical",
        created: new Date("2026-02-03T00:00:00.000Z"),
        boardIndex: 1,
      }),
      makeCard({
        id: "gamma",
        title: "Gamma",
        priority: "p1-high",
        created: new Date("2026-02-05T00:00:00.000Z"),
        boardIndex: 0,
      }),
    ];

    const ranked = rankCards(cards, makeSettings({
      mode: "advanced",
      includeHostCard: false,
      filter: {
        any: [{ all: [] }],
      },
      sort: [
        { field: "priority", direction: "asc" },
        { field: "created", direction: "desc" },
      ],
    }));

    expect(ranked.map((card) => card.id).join(",")).toBe("beta,gamma,alpha");
  });

  test("rankCards uses board-order and id as stable tiebreakers", () => {
    const cards = [
      makeCard({
        id: "c-card",
        title: "Same",
        priority: "p2-medium",
        created: new Date("2026-02-01T00:00:00.000Z"),
        boardIndex: 10,
      }),
      makeCard({
        id: "a-card",
        title: "Same",
        priority: "p2-medium",
        created: new Date("2026-02-01T00:00:00.000Z"),
        boardIndex: 2,
      }),
      makeCard({
        id: "b-card",
        title: "Same",
        priority: "p2-medium",
        created: new Date("2026-02-01T00:00:00.000Z"),
        boardIndex: 2,
      }),
    ];

    const ranked = rankCards(cards, makeSettings({
      mode: "advanced",
      includeHostCard: false,
      filter: {
        any: [{ all: [] }],
      },
      sort: [
        { field: "title", direction: "asc" },
        { field: "created", direction: "asc" },
      ],
    }));

    expect(ranked.map((card) => card.id).join(",")).toBe("a-card,b-card,c-card");
  });

  test("filterCards excludes cards passed in excludedCardIds", () => {
    const cards = [
      makeCard({ id: "host-card", title: "Host card" }),
      makeCard({ id: "other-card", title: "Other card", boardIndex: 1 }),
    ];

    const filtered = filterCards(
      cards,
      makeSettings(),
      "",
      { excludedCardIds: new Set(["host-card"]) },
    );

    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe("other-card");
  });

  test("filterCards supports OR groups and tag exclusion in canonical rulesV2", () => {
    const cards = [
      makeCard({
        id: "ideas-p0",
        columnId: "draft",
        priority: "p0-critical",
        tags: ["product"],
      }),
      makeCard({
        id: "backlog-p1",
        columnId: "backlog",
        priority: "p1-high",
        tags: ["platform"],
      }),
      makeCard({
        id: "ideas-sidebar",
        columnId: "draft",
        priority: "p0-critical",
        tags: ["sidebar"],
      }),
    ];

    const filtered = filterCards(cards, makeSettings({
      mode: "advanced",
      includeHostCard: false,
      filter: {
        any: [
          {
            all: [
              { field: "status", op: "in", values: ["draft"] },
              { field: "priority", op: "in", values: ["p0-critical"] },
              { field: "tags", op: "hasNone", values: ["sidebar"] },
            ],
          },
          {
            all: [
              { field: "status", op: "in", values: ["backlog"] },
              { field: "priority", op: "in", values: ["p0-critical", "p1-high"] },
              { field: "tags", op: "hasNone", values: ["sidebar"] },
            ],
          },
        ],
      },
      sort: [
        { field: "status", direction: "asc" },
        { field: "priority", direction: "asc" },
        { field: "created", direction: "asc" },
        { field: "board-order", direction: "asc" },
      ],
    }), "");

    expect(filtered.map((card) => card.id).join(",")).toBe("ideas-p0,backlog-p1");
  });

  test("rankCards supports deterministic fallback when multiple sorts tie", () => {
    const cards = [
      makeCard({
        id: "a",
        columnId: "backlog",
        priority: "p1-high",
        created: new Date("2026-02-03T00:00:00.000Z"),
        boardIndex: 5,
      }),
      makeCard({
        id: "b",
        columnId: "backlog",
        priority: "p1-high",
        created: new Date("2026-02-02T00:00:00.000Z"),
        boardIndex: 4,
      }),
      makeCard({
        id: "c",
        columnId: "draft",
        priority: "p0-critical",
        created: new Date("2026-02-04T00:00:00.000Z"),
        boardIndex: 3,
      }),
    ];

    const ranked = rankCards(cards, makeSettings({
      mode: "advanced",
      includeHostCard: false,
      filter: {
        any: [{ all: [] }],
      },
      sort: [
        { field: "status", direction: "asc" },
        { field: "priority", direction: "asc" },
        { field: "created", direction: "asc" },
        { field: "board-order", direction: "asc" },
      ],
    }));

    expect(ranked.map((card) => card.id).join(",")).toBe("c,b,a");
  });
});
