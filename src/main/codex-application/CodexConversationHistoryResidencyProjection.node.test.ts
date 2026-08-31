import { describe, expect, test } from "vite-plus/test";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
  CodexConversationSnapshot,
} from "../../shared/types";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  exhaustedCodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryTurnItemsPagination,
} from "../../shared/codex-conversation-state/codex-history-topology";
import { retainCodexHistoryResidency } from "../../shared/codex-conversation-state/codex-history-residency";
import { projectCodexConversationHistoryResidency } from "./CodexConversationHistoryResidencyProjection";

function canonicalTurn(id: string | null): CodexCanonicalTurnState {
  return {
    protocol: {
      id,
      items: [],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
    items: [],
    sidecar: {
      params: { input: [] },
      diff: null,
      turnStartedAtMs: null,
      finalAssistantStartedAtMs: null,
    },
  } as unknown as CodexCanonicalTurnState;
}

function historyEntity(id: string): CodexHistoryEntity<CodexCanonicalTurnState> {
  const turn = canonicalTurn(id);
  return {
    key: id,
    turn,
    itemCount: 0,
    approximateBytes: 10,
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

const itemPagination = (id: string): CodexHistoryTurnItemsPagination => ({
  olderCursor: `items:${id}`,
  isLoadingOlder: false,
  hasLoadedOldest: false,
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: "summary",
});

describe("Codex conversation history residency projection", () => {
  test("trims canonical, snapshot, item-pagination, and replica-shaped documents together", () => {
    const entities = [historyEntity("t1"), historyEntity("t2"), historyEntity("t3")];
    const created = createCodexHistoryIslandTopology({
      generation: 4,
      islandId: "tail:4",
      entries: entities.map((entity) => ({
        key: `turn:${entity.key}`,
        entityKey: entity.key,
      })),
      entities,
      olderBoundary: availableCodexHistoryBoundary("older:tail", {
        cursor: "cursor:older",
        oldestLoadedTurnId: "t1",
      }),
      newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
    });
    if (!created.ok) throw new Error(created.error.message);
    const retained = retainCodexHistoryResidency(created.topology, {
      limits: { maxTurns: 2, maxApproximateBytes: 20 },
      tailTurnCount: 2,
    });
    const optimistic = canonicalTurn(null);
    const canonicalState = {
      protocol: {},
      turns: [...entities.map((entity) => entity.turn), optimistic],
      requests: [],
      sidecar: {},
    } as unknown as CodexCanonicalConversationState;
    const conversation = {
      threadId: "thread-1",
      turns: [
        { turnId: "t1", items: [] },
        { turnId: "t2", items: [] },
        { turnId: "t3", items: [] },
        { turnId: null, items: [] },
      ],
    } as unknown as CodexConversationSnapshot;
    const projection = projectCodexConversationHistoryResidency({
      canonicalState,
      conversationPagination: {
        olderCursor: "cursor:older",
        backwardsCursor: "cursor:newer",
        oldestLoadedTurnId: "t1",
        isLoadingOlder: true,
        hasLoadedOldest: false,
        loadedTurnCount: 3,
        itemsView: "summary",
      },
      turnItemsPaginationById: {
        t1: itemPagination("t1"),
        t2: itemPagination("t2"),
        t3: itemPagination("t3"),
      },
      topology: retained.topology,
    });

    expect(projection.canonicalState.turns.map((turn) => turn.protocol.id)).toEqual([
      "t2",
      "t3",
      null,
    ]);
    expect(Object.keys(projection.turnItemsPaginationById)).toEqual(["t2", "t3"]);
    expect(projection.turnPagination).toMatchObject({
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: "t2",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 2,
    });

    const snapshot = projection.projectConversation(conversation);
    const replicaShaped = projection.projectConversation({ ...conversation, threadId: "replica" });
    for (const projected of [snapshot, replicaShaped]) {
      expect(projected.turns.map((turn) => turn.turnId)).toEqual(["t2", "t3", null]);
      expect(projected.canonicalState).toBe(projection.canonicalState);
      expect(projected.historyRows?.[0]).toMatchObject({
        kind: "gap",
        olderBoundary: null,
        newerBoundary: null,
      });
      expect(Object.keys(projected.turnItemsPaginationById ?? {})).toEqual(["t2", "t3"]);
    }
  });

  test("preserves a real tail cursor when retention removes only a disjoint island", () => {
    const tail = historyEntity("tail");
    const created = createCodexHistoryIslandTopology({
      generation: 1,
      islandId: "tail:1",
      entries: [{ key: "turn:tail", entityKey: "tail" }],
      entities: [tail],
      olderBoundary: availableCodexHistoryBoundary("older:tail", {
        cursor: "cursor:real",
        oldestLoadedTurnId: "tail",
      }),
      newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
    });
    if (!created.ok) throw new Error(created.error.message);
    const canonicalState = {
      protocol: {},
      turns: [tail.turn],
      requests: [],
      sidecar: {},
    } as unknown as CodexCanonicalConversationState;
    const projection = projectCodexConversationHistoryResidency({
      canonicalState,
      conversationPagination: {
        olderCursor: "cursor:real",
        backwardsCursor: null,
        oldestLoadedTurnId: "tail",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 1,
        itemsView: "full",
      },
      turnItemsPaginationById: {},
      topology: created.topology,
    });

    expect(projection.turnPagination.olderCursor).toBe("cursor:real");
    expect(projection.turnPagination.hasLoadedOldest).toBe(false);
  });
});
