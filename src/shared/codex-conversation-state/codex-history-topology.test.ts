import { describe, expect, test } from "vite-plus/test";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryBoundaryRef,
  createCodexHistoryIslandTopology,
  createEmptyCodexHistoryTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  insertCodexHistoryIsland,
  mergeCodexHistoryBoundaryPage,
  type CodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryEntry,
} from "./codex-history-topology";

function turn(id: string, itemsView: Turn["itemsView"] = "full"): Turn {
  return {
    id,
    items: [],
    itemsView,
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function entity(
  id: string,
  options: {
    readonly itemsView?: Turn["itemsView"];
    readonly authority?: "history" | "live";
    readonly revision?: number;
  } = {},
): CodexHistoryEntity<Turn> {
  const itemsView = options.itemsView ?? "full";
  return {
    key: id,
    turn: turn(id, itemsView),
    itemCount: 0,
    approximateBytes: id.length,
    itemsPagination: {
      olderCursor: itemsView === "full" ? null : `items:${id}`,
      isLoadingOlder: false,
      hasLoadedOldest: itemsView === "full",
      oldestUserInput: null,
      openingUserMessageId: null,
      itemsView,
    },
    authority: options.authority ?? "history",
    revision: options.revision ?? 0,
  };
}

function entry(id: string): CodexHistoryEntry {
  return { key: id, entityKey: id };
}

function available(id: string, cursor = id): CodexHistoryBoundary {
  return availableCodexHistoryBoundary(id, { cursor, oldestLoadedTurnId: null });
}

function expectTopology<TTurn>(result: ReturnType<typeof createCodexHistoryIslandTopology<TTurn>>) {
  if (!result.ok) throw new Error(result.error.message);
  return result.topology;
}

describe("Codex sparse history topology", () => {
  test("represents an empty tail without inventing a gap", () => {
    const topology = createEmptyCodexHistoryTopology<Turn>(4);
    expect(topology).toMatchObject({
      generation: 4,
      isComplete: false,
      islands: [],
      residency: { islandCount: 0, turnCount: 0, itemCount: 0, approximateBytes: 0 },
    });
    expect(flattenCodexHistoryTopology(topology)).toEqual([]);
  });

  test("projects five tail turns after one inert older gap", () => {
    const ids = ["turn-6", "turn-7", "turn-8", "turn-9", "turn-10"];
    const topology = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 2,
        islandId: "tail:2",
        entries: ids.map(entry),
        entities: ids.map((id) => entity(id)),
        olderBoundary: available("older:tail", "cursor:5"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      }),
    );
    const rows = flattenCodexHistoryTopology(topology);
    expect(rows.map((row) => row.kind)).toEqual([
      "gap",
      "content",
      "content",
      "content",
      "content",
      "content",
    ]);
    expect(rows[0]).toMatchObject({ kind: "gap", estimatedHeightPx: 144, olderBoundary: null });
    expect(topology.isComplete).toBe(false);
    expect(topology.residency.turnCount).toBe(5);
  });

  test("prepends one page, advances the exact boundary, and preserves loaded identity", () => {
    const tail = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 1,
        islandId: "tail:1",
        entries: [entry("turn-4"), entry("turn-5")],
        entities: [entity("turn-4"), entity("turn-5")],
        olderBoundary: available("older:tail", "cursor:3"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      }),
    );
    const oldTurn = tail.entitiesByKey["turn-4"];
    const boundary = tail.islands[0]!.olderBoundary;
    if (boundary.status !== "available") throw new Error("expected available boundary");
    const result = mergeCodexHistoryBoundaryPage(tail, {
      boundary: createCodexHistoryBoundaryRef(1, "tail:1", "older", boundary),
      entries: [entry("turn-2"), entry("turn-3")],
      entities: [entity("turn-2"), entity("turn-3")],
      continuation: available("older:page-2", "cursor:1"),
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.topology.islands[0]!.entries.map((value) => value.entityKey)).toEqual([
      "turn-2",
      "turn-3",
      "turn-4",
      "turn-5",
    ]);
    expect(result.topology.entitiesByKey["turn-4"]).toBe(oldTurn);
    expect(result.topology.residency.turnCount).toBe(4);
  });

  test("rejects a stale generation and a cursor that does not advance", () => {
    const topology = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 8,
        islandId: "tail:8",
        entries: [entry("turn-2")],
        entities: [entity("turn-2")],
        olderBoundary: available("older:tail", "cursor:1"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      }),
    );
    const boundary = topology.islands[0]!.olderBoundary;
    if (boundary.status !== "available") throw new Error("expected available boundary");
    const stale = mergeCodexHistoryBoundaryPage(topology, {
      boundary: createCodexHistoryBoundaryRef(7, "tail:8", "older", boundary),
      entries: [entry("turn-1")],
      entities: [entity("turn-1")],
      continuation: exhaustedCodexHistoryBoundary("older:done"),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "staleGeneration" } });
    const stalled = mergeCodexHistoryBoundaryPage(topology, {
      boundary: createCodexHistoryBoundaryRef(8, "tail:8", "older", boundary),
      entries: [entry("turn-1")],
      entities: [entity("turn-1")],
      continuation: available("older:still", "cursor:1"),
    });
    expect(stalled).toMatchObject({ ok: false, error: { code: "cursorStalled" } });
  });

  test("merges a search island into the tail and lets the live entity win", () => {
    const search = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 3,
        islandId: "search:1",
        entries: [entry("turn-1"), entry("turn-2")],
        entities: [entity("turn-1"), entity("turn-2", { authority: "live", revision: 4 })],
        olderBoundary: exhaustedCodexHistoryBoundary("older:search"),
        newerBoundary: available("newer:search"),
      }),
    );
    const merged = insertCodexHistoryIsland(search, {
      index: 1,
      islandId: "tail:3",
      entries: [entry("turn-2"), entry("turn-3")],
      entities: [entity("turn-2", { authority: "history", revision: 99 }), entity("turn-3")],
      olderBoundary: available("older:tail"),
      newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
    });
    if (!merged.ok) throw new Error(merged.error.message);
    expect(merged.topology.islands).toHaveLength(1);
    expect(merged.topology.islands[0]!.entries.map((value) => value.entityKey)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
    expect(merged.topology.entitiesByKey["turn-2"]?.authority).toBe("live");
  });

  test("keeps disjoint search and tail islands separated by one bidirectional gap", () => {
    const search = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 5,
        islandId: "search:5",
        entries: [entry("turn-20")],
        entities: [entity("turn-20")],
        olderBoundary: available("older:search"),
        newerBoundary: available("newer:search"),
      }),
    );
    const inserted = insertCodexHistoryIsland(search, {
      index: 1,
      islandId: "tail:5",
      entries: [entry("turn-100")],
      entities: [entity("turn-100")],
      olderBoundary: available("older:tail"),
      newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    const rows = flattenCodexHistoryTopology(inserted.topology);
    expect(rows.map((row) => row.kind)).toEqual(["gap", "content", "gap", "content"]);
    expect(rows[2]).toMatchObject({
      kind: "gap",
      olderBoundary: { islandId: "search:5", edge: "newer" },
      newerBoundary: { islandId: "tail:5", edge: "older" },
    });
  });

  test("does not mark a single exhausted island complete while one turn is partial", () => {
    const partial = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 6,
        islandId: "tail:6",
        entries: [entry("turn-1")],
        entities: [entity("turn-1", { itemsView: "summary" })],
        olderBoundary: exhaustedCodexHistoryBoundary("older:tail"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      }),
    );
    expect(partial.isComplete).toBe(false);
  });
});
