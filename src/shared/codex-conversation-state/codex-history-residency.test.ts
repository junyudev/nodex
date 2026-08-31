import { describe, expect, test } from "vite-plus/test";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  insertCodexHistoryIsland,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryEntity,
} from "./codex-history-topology";
import { retainCodexHistoryResidency } from "./codex-history-residency";

function entity(id: string, approximateBytes = 10): CodexHistoryEntity<Turn> {
  return {
    key: id,
    turn: {
      id,
      items: [],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
    itemCount: 0,
    approximateBytes,
    itemsPagination: {
      olderCursor: null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      oldestUserInput: null,
      openingUserMessageId: null,
      itemsView: "full",
    },
    authority: "history",
    revision: 1,
  };
}

function available(id: string) {
  return availableCodexHistoryBoundary(id, {
    cursor: `cursor:${id}`,
    oldestLoadedTurnId: null,
  });
}

function singleIsland(
  values: readonly CodexHistoryEntity<Turn>[],
): CodexCanonicalHistoryTopology<Turn> {
  const result = createCodexHistoryIslandTopology({
    generation: 7,
    islandId: "tail:7",
    entries: values.map((value) => ({ key: `turn:${value.key}`, entityKey: value.key })),
    entities: values,
    olderBoundary: available("older:tail"),
    newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.topology;
}

function sparseTopology(): CodexCanonicalHistoryTopology<Turn> {
  const search = createCodexHistoryIslandTopology({
    generation: 8,
    islandId: "search:8",
    entries: [
      { key: "turn:t2", entityKey: "t2" },
      { key: "turn:t3", entityKey: "t3" },
    ],
    entities: [entity("t2"), entity("t3")],
    olderBoundary: exhaustedCodexHistoryBoundary("older:search"),
    newerBoundary: available("newer:search"),
  });
  if (!search.ok) throw new Error(search.error.message);
  const tail = insertCodexHistoryIsland(search.topology, {
    index: 1,
    islandId: "tail:8",
    entries: [
      { key: "turn:t9", entityKey: "t9" },
      { key: "turn:t10", entityKey: "t10" },
    ],
    entities: [entity("t9"), entity("t10")],
    olderBoundary: available("older:tail"),
    newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
  });
  if (!tail.ok) throw new Error(tail.error.message);
  return tail.topology;
}

describe("Codex active history residency", () => {
  test("preserves topology identity when both limits already hold", () => {
    const topology = singleIsland([entity("t1"), entity("t2"), entity("t3")]);
    const retained = retainCodexHistoryResidency(topology, {
      limits: { maxTurns: 3, maxApproximateBytes: 30 },
      tailTurnCount: 2,
    });

    expect(retained.topology).toBe(topology);
    expect(retained.evictedEntityKeys).toEqual([]);
    expect(retained.limitsSatisfied).toBe(true);
  });

  test("keeps a bounded tail under the simultaneous count and byte budgets", () => {
    const topology = singleIsland([
      entity("t1"),
      entity("t2"),
      entity("t3"),
      entity("t4"),
      entity("t5"),
      entity("t6"),
    ]);
    const retained = retainCodexHistoryResidency(topology, {
      limits: { maxTurns: 3, maxApproximateBytes: 100 },
      tailTurnCount: 2,
    });

    expect(retained.retainedEntityKeys).toEqual(["t4", "t5", "t6"]);
    expect(retained.evictedEntityKeys).toEqual(["t1", "t2", "t3"]);
    expect(retained.topology.residency).toMatchObject({ turnCount: 3, approximateBytes: 30 });
    expect(retained.topology.islands[0]?.olderBoundary.status).toBe("opaque");
    expect(flattenCodexHistoryTopology(retained.topology)[0]).toMatchObject({
      kind: "gap",
      olderBoundary: null,
      newerBoundary: null,
    });
  });

  test("stops at the byte boundary instead of filling holes with less-recent turns", () => {
    const topology = singleIsland([
      entity("t1", 1),
      entity("t2", 1),
      entity("t3", 1),
      entity("t4", 8),
      entity("t5", 8),
    ]);
    const retained = retainCodexHistoryResidency(topology, {
      limits: { maxTurns: 5, maxApproximateBytes: 10 },
      tailTurnCount: 1,
    });

    expect(retained.retainedEntityKeys).toEqual(["t5"]);
    expect(retained.topology.residency.approximateBytes).toBe(8);
    expect(retained.limitsSatisfied).toBe(true);
  });

  test("retains visible Turns and the live tail as separate islands with an inert gap", () => {
    const topology = singleIsland([
      entity("t1"),
      entity("t2"),
      entity("t3"),
      entity("t4"),
      entity("t5"),
      entity("t6"),
      entity("t7"),
      entity("t8"),
    ]);
    const retained = retainCodexHistoryResidency(topology, {
      limits: { maxTurns: 3, maxApproximateBytes: 30 },
      tailTurnCount: 2,
      protectedEntityKeys: ["t3"],
    });

    expect(retained.retainedEntityKeys).toEqual(["t3", "t7", "t8"]);
    expect(retained.topology.islands).toHaveLength(2);
    expect(
      retained.topology.islands.map((island) => island.entries.map((entry) => entry.entityKey)),
    ).toEqual([["t3"], ["t7", "t8"]]);
    const rows = flattenCodexHistoryTopology(retained.topology);
    expect(rows.map((row) => row.kind)).toEqual(["gap", "content", "gap", "content", "content"]);
    expect(rows[2]).toMatchObject({ kind: "gap", olderBoundary: null, newerBoundary: null });
  });

  test("allows a protected search island to exceed limits without releasing visible state", () => {
    const retained = retainCodexHistoryResidency(sparseTopology(), {
      limits: { maxTurns: 2, maxApproximateBytes: 20 },
      tailTurnCount: 2,
      protectedIslandIds: ["search:8"],
    });

    expect(retained.retainedEntityKeys).toEqual(["t2", "t3", "t9", "t10"]);
    expect(retained.protectedResidencyExceedsLimits).toBe(true);
    expect(retained.limitsSatisfied).toBe(false);
  });

  test("preserves a real outer cursor when releasing a whole disjoint island", () => {
    const retained = retainCodexHistoryResidency(sparseTopology(), {
      limits: { maxTurns: 2, maxApproximateBytes: 20 },
      tailTurnCount: 2,
    });

    expect(retained.evictedEntityKeys).toEqual(["t2", "t3"]);
    expect(retained.topology.islands).toHaveLength(1);
    expect(retained.topology.islands[0]?.olderBoundary.status).toBe("available");
    expect(flattenCodexHistoryTopology(retained.topology)[0]).toMatchObject({
      kind: "gap",
      newerBoundary: { islandId: "tail:8", edge: "older" },
    });
  });
});
