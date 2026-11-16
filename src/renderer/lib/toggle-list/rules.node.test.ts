import { describe, expect, test } from "vite-plus/test";
import { getDefaultToggleListSettings } from "./settings";
import type { ToggleListCard, ToggleListRulesV2, ToggleListSettings } from "./types";
import { filterCards, rankCards } from "./rules";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";

function makeCard(overrides: Partial<ToggleListCard>): ToggleListCard {
  const title = overrides.title ?? "Card title";
  return {
    id: "card-1",
    status: "plan",
    archived: false,
    title,
    richTitle: overrides.richTitle ?? plainTextToPortableRichText(title),
    description: "",
    priority: "p2-medium",
    estimate: "m",
    tags: [],
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "plan",
    columnName: "Plan",
    boardIndex: 0,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
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
  test("searches projected titles and summaries through the kernel", () => {
    const card = {
      ...makeCard({ title: "PageSearchKernel" }),
      descriptionPreview: "数据库迁移方案",
    };
    expect(filterCards([card], makeSettings(), "ｐａｇｅ＿ｓｅａｒｃｈ 迁移")).toEqual([card]);
    expect(filterCards([card], makeSettings(), "kernle")).toEqual([card]);
  });

  test("filterCards applies canonical status, priority, and search rules together", () => {
    const cards = [
      makeCard({
        id: "card-a",
        title: "Fix parser",
        priority: "p0-critical",
        columnId: "plan",
        columnName: "Plan",
      }),
      makeCard({
        id: "card-b",
        title: "Ship docs",
        priority: "p1-high",
        columnId: "plan",
        columnName: "Ready",
      }),
      makeCard({
        id: "card-c",
        title: "Fix parser quickly",
        priority: "p0-critical",
        columnId: "plan",
        columnName: "Ready",
      }),
    ];

    const filtered = filterCards(
      cards,
      makeSettings({
        mode: "basic",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["plan"] },
                { field: "priority", op: "in", values: ["p0-critical"] },
              ],
            },
          ],
        },
        sort: [
          { field: "board-order", direction: "asc" },
          { field: "created", direction: "desc" },
        ],
      }),
      "fix ready",
    );

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

    const ranked = rankCards(
      cards,
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [{ all: [] }],
        },
        sort: [
          { field: "priority", direction: "asc" },
          { field: "created", direction: "desc" },
        ],
      }),
    );

    expect(ranked.map((card) => card.id).join(",")).toBe("beta,gamma,alpha");
  });

  test("rankCards can place empty priorities first", () => {
    const ranked = rankCards(
      [
        makeCard({ id: "filled-low", priority: "p2-medium", boardIndex: 2 }),
        makeCard({ id: "empty", priority: undefined, boardIndex: 1 }),
        makeCard({ id: "filled-high", priority: "p1-high", boardIndex: 0 }),
      ],
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [{ all: [] }],
        },
        sort: [
          { field: "priority", direction: "asc", emptyPlacement: "first" },
          { field: "created", direction: "desc" },
        ],
      }),
    );

    expect(ranked.map((card) => card.id).join(",")).toBe("empty,filled-high,filled-low");
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

    const ranked = rankCards(
      cards,
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [{ all: [] }],
        },
        sort: [
          { field: "title", direction: "asc" },
          { field: "created", direction: "asc" },
        ],
      }),
    );

    expect(ranked.map((card) => card.id).join(",")).toBe("a-card,b-card,c-card");
  });

  test("filterCards excludes cards passed in excludedPageIds", () => {
    const cards = [
      makeCard({ id: "host-card", title: "Host card" }),
      makeCard({ id: "other-card", title: "Other card", boardIndex: 1 }),
    ];

    const filtered = filterCards(cards, makeSettings(), "", {
      excludedPageIds: new Set(["host-card"]),
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe("other-card");
  });

  test("default settings keep empty-priority cards visible", () => {
    const cards = [
      makeCard({ id: "no-priority", priority: undefined }),
      makeCard({ id: "has-priority", priority: "p1-high", boardIndex: 1 }),
    ];

    const filtered = filterCards(cards, makeSettings(), "");

    expect(filtered.map((card) => card.id).join(",")).toBe("no-priority,has-priority");
  });

  test("legacy all-priority clauses still include empty-priority cards", () => {
    const cards = [
      makeCard({ id: "no-priority", priority: undefined }),
      makeCard({ id: "has-priority", priority: "p1-high", boardIndex: 1 }),
    ];

    const filtered = filterCards(
      cards,
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["plan"] },
                {
                  field: "priority",
                  op: "in",
                  values: ["p0-critical", "p1-high", "p2-medium", "p3-low"],
                },
              ],
            },
          ],
        },
        sort: [{ field: "board-order", direction: "asc" }],
      }),
      "",
    );

    expect(filtered.map((card) => card.id).join(",")).toBe("no-priority,has-priority");
  });

  test("explicit empty-priority selection can exclude empty cards", () => {
    const cards = [
      makeCard({ id: "no-priority", priority: undefined }),
      makeCard({ id: "has-priority", priority: "p1-high", boardIndex: 1 }),
    ];

    const filtered = filterCards(
      cards,
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["plan"] },
                { field: "priority", op: "in", values: ["p1-high"], includeEmpty: false },
              ],
            },
          ],
        },
        sort: [{ field: "board-order", direction: "asc" }],
      }),
      "",
    );

    expect(filtered.map((card) => card.id).join(",")).toBe("has-priority");
  });

  test("explicit empty-priority selection can match empty cards only", () => {
    const cards = [
      makeCard({ id: "no-priority", priority: undefined }),
      makeCard({ id: "has-priority", priority: "p1-high", boardIndex: 1 }),
    ];

    const filtered = filterCards(
      cards,
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["plan"] },
                { field: "priority", op: "in", values: [], includeEmpty: true },
              ],
            },
          ],
        },
        sort: [{ field: "board-order", direction: "asc" }],
      }),
      "",
    );

    expect(filtered.map((card) => card.id).join(",")).toBe("no-priority");
  });

  test("filterCards supports OR groups and tag exclusion in canonical rulesV2", () => {
    const cards = [
      makeCard({
        id: "ideas-p0",
        columnId: "triage",
        priority: "p0-critical",
        tags: ["product"],
      }),
      makeCard({
        id: "backlog-p1",
        columnId: "plan",
        priority: "p1-high",
        tags: ["platform"],
      }),
      makeCard({
        id: "ideas-sidebar",
        columnId: "triage",
        priority: "p0-critical",
        tags: ["sidebar"],
      }),
    ];

    const filtered = filterCards(
      cards,
      makeSettings({
        mode: "advanced",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["triage"] },
                { field: "priority", op: "in", values: ["p0-critical"] },
                { field: "tags", op: "hasNone", values: ["sidebar"] },
              ],
            },
            {
              all: [
                { field: "status", op: "in", values: ["plan"] },
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
      }),
      "",
    );

    expect(filtered.map((card) => card.id).join(",")).toBe("ideas-p0,backlog-p1");
  });

  test("rankCards supports deterministic fallback when multiple sorts tie", () => {
    const cards = [
      makeCard({
        id: "a",
        columnId: "plan",
        priority: "p1-high",
        created: new Date("2026-02-03T00:00:00.000Z"),
        boardIndex: 5,
      }),
      makeCard({
        id: "b",
        columnId: "plan",
        priority: "p1-high",
        created: new Date("2026-02-02T00:00:00.000Z"),
        boardIndex: 4,
      }),
      makeCard({
        id: "c",
        columnId: "triage",
        priority: "p0-critical",
        created: new Date("2026-02-04T00:00:00.000Z"),
        boardIndex: 3,
      }),
    ];

    const ranked = rankCards(
      cards,
      makeSettings({
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
      }),
    );

    expect(ranked.map((card) => card.id).join(",")).toBe("c,b,a");
  });
});
