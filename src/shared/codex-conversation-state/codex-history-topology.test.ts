import { measureCodexHistoryResidency } from "./codex-history-topology";
import { describe, expect, test } from "vite-plus/test";
import type { Turn as ProtocolTurn } from "@nodex/codex-app-server-protocol/v2";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryBoundaryRef,
  readCurrentCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  createEmptyCodexHistoryTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  insertCodexHistoryIsland,
  mergeCodexHistoryBoundaryPage,
  replaceCodexHistoryEntity,
  validateCodexHistoryTopology,
  type CodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryEntry,
} from "./codex-history-topology";

type Turn = ProtocolTurn & {
  readonly itemsPagination: import("./codex-history-topology").CodexHistoryTurnItemsPagination;
};

function turn(id: string, itemsView: Turn["itemsView"] = "full"): Turn {
  return {
    id,
    itemsPagination: {
      olderCursor: itemsView === "full" ? null : `items:${id}`,
      isLoadingOlder: false,
      hasLoadedOldest: itemsView === "full",
      itemsView,
    },
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
    readonly durationMs?: number;
  } = {},
): CodexHistoryEntity<Turn> {
  const itemsView = options.itemsView ?? "full";
  return {
    key: id,
    turn: {...turn(id, itemsView), durationMs: options.durationMs ?? null},

  };
}

function entry(id: string): CodexHistoryEntry {
  return { key: id, value: id };
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
    });
    expect(flattenCodexHistoryTopology(topology)).toEqual([]);
  });

  test("keeps the completeness and boundaries of an empty fetched tail", () => {
    const complete = expectTopology(
      createCodexHistoryIslandTopology<Turn>({
        generation: 3,
        isComplete: true,
        islandId: "tail:3",
        entries: [],
        entities: [],
        olderBoundary: exhaustedCodexHistoryBoundary("tail:3:older"),
        newerBoundary: exhaustedCodexHistoryBoundary("tail:3:newer"),
      }),
    );
    expect(complete.isComplete).toBe(true);
    expect(complete.islands).toHaveLength(1);
    expect(flattenCodexHistoryTopology(complete)).toEqual([]);
    const incomplete = { ...complete, isComplete: false };
    expect(validateCodexHistoryTopology(incomplete)).toBeNull();
    expect(flattenCodexHistoryTopology(incomplete)).toEqual([]);
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
    expect(measureCodexHistoryResidency(topology).turnCount).toBe(5);
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
    expect(result.topology.islands[0]!.entries.map((value) => value.value)).toEqual([
      "turn-2",
      "turn-3",
      "turn-4",
      "turn-5",
    ]);
    expect(result.topology.entitiesByKey["turn-4"]).toBe(oldTurn);
    expect(measureCodexHistoryResidency(result.topology).turnCount).toBe(4);
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

  test("accepts an outstanding page after its boundary survives an island merge", () => {
    const boundary = available("retained:older", "cursor:1");
    const topology = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 6,
        islandId: "merged:6",
        entries: [entry("turn-2")],
        entities: [entity("turn-2")],
        olderBoundary: boundary,
        newerBoundary: exhaustedCodexHistoryBoundary("merged:newer"),
      }),
    );
    if (boundary.status !== "available") throw new Error("Expected available boundary");
    const reference = createCodexHistoryBoundaryRef(6, "old:6", "older", boundary);
    const result = mergeCodexHistoryBoundaryPage(topology, {
      boundary: reference,
      entries: [entry("turn-1")],
      entities: [entity("turn-1")],
      continuation: exhaustedCodexHistoryBoundary("page:newer-id"),
    });
    const next = expectTopology(result);
    expect(next.islands[0]?.olderBoundary.boundaryId).toBe("retained:older");
    expect(next.islands[0]?.entries.map((item) => item.value)).toEqual(["turn-1", "turn-2"]);
    expect(next.isComplete).toBe(true);
  });

  test("advances a cursor when its anchor changes and rejects replaying its old progress", () => {
    const boundary = availableCodexHistoryBoundary("tail:older", {
      cursor: "cursor:1",
      oldestLoadedTurnId: "turn-2",
    });
    const topology = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 6,
        islandId: "tail:6",
        entries: [entry("turn-2")],
        entities: [entity("turn-2")],
        olderBoundary: boundary,
        newerBoundary: exhaustedCodexHistoryBoundary("tail:newer"),
      }),
    );
    if (boundary.status !== "available") throw new Error("Expected available boundary");
    const reference = createCodexHistoryBoundaryRef(6, "tail:6", "older", boundary);
    const page = {
      boundary: reference,
      entries: [entry("turn-1")],
      entities: [entity("turn-1")],
      continuation: availableCodexHistoryBoundary("ignored:page-id", {
        cursor: "cursor:1",
        oldestLoadedTurnId: "turn-1",
      }),
    };
    const next = expectTopology(mergeCodexHistoryBoundaryPage(topology, page));
    expect(next.islands[0]?.olderBoundary).toMatchObject({
      boundaryId: "tail:older",
      handle: { cursor: "cursor:1", oldestLoadedTurnId: "turn-1" },
    });
    expect(mergeCodexHistoryBoundaryPage(next, page).ok).toBe(false);
  });

  test("merges an overlapping search island using the caller Turn policy", () => {
    const search = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 3,
        islandId: "search:1",
        entries: [entry("turn-1"), entry("turn-2")],
        entities: [entity("turn-1"), entity("turn-2", { durationMs: 4 })],
        olderBoundary: exhaustedCodexHistoryBoundary("older:search"),
        newerBoundary: available("newer:search"),
      }),
    );
    const merged = insertCodexHistoryIsland(search, {
      index: 1,
      mergeTurns: (current, incoming) => ({...incoming, durationMs: current.durationMs}),
      islandId: "tail:3",
      entries: [entry("turn-2"), entry("turn-3")],
      entities: [entity("turn-2", { durationMs: 99 }), entity("turn-3")],
      olderBoundary: available("older:tail"),
      newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
    });
    if (!merged.ok) throw new Error(merged.error.message);
    expect(merged.topology.islands).toHaveLength(1);
    expect(merged.topology.islands[0]!.entries.map((value) => value.value)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
    expect(merged.topology.entitiesByKey["turn-2"]?.durationMs).toBe(4);
  });

  test("aligns an overlapping search window around its resident anchor positions", () => {
    const tail = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 4,
        islandId: "tail:4",
        entries: [entry("turn-a"), entry("turn-b"), entry("turn-c")],
        entities: [entity("turn-a"), entity("turn-b"), entity("turn-c")],
        olderBoundary: available("older:tail"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      }),
    );
    const inserted = insertCodexHistoryIsland(tail, {
      index: 0,
      islandId: "search:4",
      entries: [entry("turn-x"), entry("turn-b"), entry("turn-c"), entry("turn-d")],
      entities: [entity("turn-x"), entity("turn-b"), entity("turn-c"), entity("turn-d")],
      olderBoundary: available("older:search"),
      newerBoundary: available("newer:search"),
      positionsByEntityKey: {
        "turn-a": 0,
        "turn-x": 1,
        "turn-b": 2,
        "turn-c": 3,
        "turn-d": 4,
      },
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect(inserted.topology.islands[0]?.entries.map((value) => value.value)).toEqual([
      "turn-a",
      "turn-x",
      "turn-b",
      "turn-c",
      "turn-d",
    ]);
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

  test("records complete Turn history independently from partially loaded items", () => {
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
    expect(partial.isComplete).toBe(true);
    expect(partial.entitiesByKey["turn-1"]?.itemsPagination.hasLoadedOldest).toBe(false);
  });

  test("preserves explicit incomplete history through a resident item update with exhausted boundaries", () => {
    const incomplete = expectTopology(
      createCodexHistoryIslandTopology({
        generation: 7,
        isComplete: false,
        islandId: "tail:7",
        entries: [entry("turn-1")],
        entities: [entity("turn-1")],
        olderBoundary: exhaustedCodexHistoryBoundary("older:tail"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      }),
    );
    expect(incomplete.isComplete).toBe(false);
    expect(validateCodexHistoryTopology(incomplete)).toBeNull();
    const updated = replaceCodexHistoryEntity(incomplete, {
      expectedGeneration: 7,
      entity: entity("turn-1", { durationMs: 1 }),
    });
    expect(updated.ok && updated.topology.isComplete).toBe(false);
  });
  test("retires a boundary reference when its native source changes at the same cursor", () => {
    const older = availableCodexHistoryBoundary("older", { source: "ordinary", cursor: "same", oldestLoadedTurnId: "turn-1" });
    if (older.status !== "available") throw new Error("Expected available boundary");
    const topology = expectTopology(createCodexHistoryIslandTopology({ generation: 1, islandId: "tail", entries: [entry("turn-1")], entities: [entity("turn-1")], olderBoundary: older, newerBoundary: exhaustedCodexHistoryBoundary("newer") }));
    const reference = createCodexHistoryBoundaryRef(1, "tail", "older", older);
    expect(readCurrentCodexHistoryBoundary(topology, reference)).toBe(older);
    const replaced = { ...topology, islands: topology.islands.map((island) => ({ ...island, olderBoundary: { ...older, handle: { ...older.handle, source: "compact" as const } } })) };
    expect(readCurrentCodexHistoryBoundary(replaced, reference)).toBeNull();
  });

});
