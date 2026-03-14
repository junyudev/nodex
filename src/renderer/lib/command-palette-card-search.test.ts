import { describe, expect, test } from "bun:test";
import {
  createCommandPaletteCardSearchIndex,
  hydrateCommandPaletteCardSearchIndex,
  resetCommandPaletteCardSearchCacheForTests,
  type CommandPaletteCardSearchCacheSnapshot,
  type CommandPaletteCardSearchCacheStore,
} from "./command-palette-card-search";
import type { CommandPaletteCard } from "./command-palette";
import type { Card } from "./types";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: overrides.id ?? "card-1",
    title: overrides.title ?? "Polish command palette",
    description: overrides.description ?? "Add quick card switching and commands.",
    status: overrides.status ?? "in_progress",
    archived: overrides.archived ?? false,
    priority: overrides.priority,
    estimate: overrides.estimate,
    tags: overrides.tags ?? ["search"],
    dueDate: overrides.dueDate,
    scheduledStart: overrides.scheduledStart,
    scheduledEnd: overrides.scheduledEnd,
    isAllDay: overrides.isAllDay ?? false,
    recurrence: overrides.recurrence,
    reminders: overrides.reminders ?? [],
    scheduleTimezone: overrides.scheduleTimezone,
    assignee: overrides.assignee,
    agentStatus: overrides.agentStatus,
    agentBlocked: overrides.agentBlocked ?? false,
    runInTarget: overrides.runInTarget ?? "localProject",
    runInLocalPath: overrides.runInLocalPath,
    runInBaseBranch: overrides.runInBaseBranch,
    runInWorktreePath: overrides.runInWorktreePath,
    runInEnvironmentPath: overrides.runInEnvironmentPath,
    revision: overrides.revision ?? 1,
    created: overrides.created ?? new Date("2026-03-13T00:00:00.000Z"),
    order: overrides.order ?? 0,
  };
}

function makePaletteCard(overrides: Partial<CommandPaletteCard> = {}): CommandPaletteCard {
  const card = overrides.card ?? makeCard();
  return {
    kind: "card",
    id: overrides.id ?? `${overrides.projectId ?? "default"}:${card.id}`,
    projectId: overrides.projectId ?? "default",
    projectName: overrides.projectName ?? "Default",
    projectIcon: overrides.projectIcon ?? "",
    columnName: overrides.columnName ?? "In progress",
    card,
    inActiveProject: overrides.inActiveProject ?? true,
    recentIndex: overrides.recentIndex ?? null,
    boardIndex: overrides.boardIndex ?? 0,
  };
}

function cloneSnapshot(
  snapshot: CommandPaletteCardSearchCacheSnapshot,
): CommandPaletteCardSearchCacheSnapshot {
  return {
    version: snapshot.version,
    documentRefs: snapshot.documentRefs.map((ref) => ({ ...ref })),
    data: JSON.parse(JSON.stringify(snapshot.data)) as CommandPaletteCardSearchCacheSnapshot["data"],
  };
}

function createMemoryCacheStore(): {
  store: CommandPaletteCardSearchCacheStore;
  stats: { reads: number; writes: number };
} {
  let snapshot: CommandPaletteCardSearchCacheSnapshot | null = null;
  const stats = { reads: 0, writes: 0 };

  return {
    store: {
      async read() {
        stats.reads += 1;
        return snapshot ? cloneSnapshot(snapshot) : null;
      },
      async write(next) {
        stats.writes += 1;
        snapshot = cloneSnapshot(next);
      },
    },
    stats,
  };
}

describe("command palette card search index", () => {
  test("matches fuzzy title queries", () => {
    resetCommandPaletteCardSearchCacheForTests();
    const index = createCommandPaletteCardSearchIndex([
      makePaletteCard({
        card: makeCard({ id: "fuzzy-target", title: "Command palette" }),
      }),
      makePaletteCard({
        card: makeCard({ id: "other-card", title: "Terminal panel" }),
      }),
    ]);

    const results = index.search("commnd palete");

    expect(results.length > 0).toBeTrue();
    expect(results[0]?.item.card.id).toBe("fuzzy-target");
    expect(results[0]?.item.searchDecorations?.titleSegments?.some((segment) => segment.highlight)).toBeTrue();
  });

  test("matches description-only queries", () => {
    resetCommandPaletteCardSearchCacheForTests();
    const index = createCommandPaletteCardSearchIndex([
      makePaletteCard({
        card: makeCard({
          id: "description-hit",
          title: "Misc task",
          description: "Document the OCR pipeline and index refresh behavior.",
        }),
      }),
    ]);

    const results = index.search("ocr pipeline");

    expect(results.length).toBe(1);
    expect(results[0]?.item.card.id).toBe("description-hit");
    expect(results[0]?.item.searchPreview?.excerpt.includes("OCR pipeline")).toBeTrue();
    expect(results[0]?.item.searchPreview?.segments.some((segment) => segment.highlight)).toBeTrue();
  });

  test("supports prefix matching for multi-term queries", () => {
    resetCommandPaletteCardSearchCacheForTests();
    const index = createCommandPaletteCardSearchIndex([
      makePaletteCard({
        card: makeCard({
          id: "prefix-hit",
          title: "Terminal panel polish",
          description: "Tighten terminal status affordances.",
        }),
      }),
    ]);

    const results = index.search("term pol");

    expect(results.length).toBe(1);
    expect(results[0]?.item.card.id).toBe("prefix-hit");
  });

  test("requires all query terms to match", () => {
    resetCommandPaletteCardSearchCacheForTests();
    const index = createCommandPaletteCardSearchIndex([
      makePaletteCard({
        card: makeCard({
          id: "alpha-beta",
          title: "Alpha",
          description: "Contains both alpha and beta terms.",
        }),
      }),
      makePaletteCard({
        card: makeCard({
          id: "alpha-only",
          title: "Alpha only",
          description: "Contains alpha but not the other term.",
        }),
      }),
    ]);

    const results = index.search("alpha beta");

    expect(results.length).toBe(1);
    expect(results[0]?.item.card.id).toBe("alpha-beta");
  });

  test("omits preview when the description has no matched text", () => {
    resetCommandPaletteCardSearchCacheForTests();
    const index = createCommandPaletteCardSearchIndex([
      makePaletteCard({
        card: makeCard({
          id: "title-hit",
          title: "Telemetry dashboard",
          description: "A general notes card without the searched word.",
        }),
      }),
    ]);

    const results = index.search("telemetry");

    expect(results.length).toBe(1);
    expect(results[0]?.item.card.id).toBe("title-hit");
    expect(results[0]?.item.searchPreview ?? null).toBe(null);
    expect(results[0]?.item.searchDecorations?.titleSegments?.some((segment) => segment.highlight)).toBeTrue();
  });

  test("adds matched field badges for secondary field hits", () => {
    resetCommandPaletteCardSearchCacheForTests();
    const index = createCommandPaletteCardSearchIndex([
      makePaletteCard({
        card: makeCard({
          id: "tag-hit",
          title: "General task",
          description: "No search terms in the body.",
          tags: ["telemetry", "search"],
          assignee: "alex",
          agentStatus: "Waiting for telemetry snapshot",
        }),
      }),
    ]);

    const results = index.search("telemetry");

    expect(results.length).toBe(1);
    expect(results[0]?.item.searchDecorations?.badges.some((badge) => badge.label === "tag")).toBeTrue();
    expect(results[0]?.item.searchDecorations?.badges.some((badge) => badge.label === "status")).toBeTrue();
  });

  test("hydrates a persisted cache snapshot and incrementally updates changed cards", async () => {
    resetCommandPaletteCardSearchCacheForTests();
    const { store, stats } = createMemoryCacheStore();
    const initialCards = [
      makePaletteCard({
        card: makeCard({
          id: "alpha",
          title: "Telemetry dashboard",
          description: "Track search latency over time.",
        }),
      }),
      makePaletteCard({
        card: makeCard({
          id: "beta",
          title: "Old panel",
          description: "This card will be removed.",
        }),
      }),
    ];

    const initialIndex = await hydrateCommandPaletteCardSearchIndex(initialCards, store);
    expect(initialIndex.search("telemetry").length).toBe(1);
    expect(stats.reads).toBe(1);
    expect(stats.writes).toBe(1);

    resetCommandPaletteCardSearchCacheForTests();
    const nextCards = [
      makePaletteCard({
        card: makeCard({
          id: "alpha",
          title: "Telemetry board",
          description: "Track search latency over time.",
          revision: 2,
        }),
      }),
      makePaletteCard({
        card: makeCard({
          id: "gamma",
          title: "Executor queue",
          description: "Document the cached palette hydrator.",
        }),
      }),
    ];

    const nextIndex = await hydrateCommandPaletteCardSearchIndex(nextCards, store);

    expect(stats.reads).toBe(2);
    expect(stats.writes).toBe(2);
    expect(nextIndex.search("telemetry board").length).toBe(1);
    expect(nextIndex.search("telemetry board")[0]?.item.card.id).toBe("alpha");
    expect(nextIndex.search("old panel").length).toBe(0);
    expect(nextIndex.search("executor")[0]?.item.card.id).toBe("gamma");
  });
});
