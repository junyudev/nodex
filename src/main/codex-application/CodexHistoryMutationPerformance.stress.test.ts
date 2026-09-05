import { assert, it } from "@effect/vitest";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
  CodexHistoryTurnItemsPagination,
} from "../../shared/codex-conversation-state/codex-history-topology";
import {
  applyCodexConversationHistoryMutation,
  buildCodexConversationHistoryMutation,
  type CodexConversationHistoryPageRequest,
} from "../../shared/codex-conversation-history-page";
import { hashCodexConversationReplica } from "../../shared/codex-owner-follower-replication";
import type {
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexConversationTurnPagination,
} from "../../shared/types";

const THREAD_ID = "thread-history-mutation-performance";
const CONVERSATION_GENERATION = 11;
const TOPOLOGY_GENERATION = 17;
const HISTORY_MUTATION_REVISION = 23;
const RESIDENT_TAIL_TURNS = 95;
const PAGE_TURNS = 5;
const ITEMS_PER_PAGE_TURN = 20;
const ITEM_TEXT = "m".repeat(2 * 1024);
const PAGE_MUTATION_MAX_BYTES = 1 * 1024 * 1024;

interface MutationMeasurement {
  readonly logicalTurnCount: number;
  readonly mutationBytes: number;
  readonly residentTurnsBefore: number;
  readonly residentTurnsAfter: number;
  readonly upsertTurns: number;
  readonly upsertCanonicalTurns: number;
  readonly rowSplices: number;
  readonly stableLeafReadsDuringMutationAndHash: number;
  readonly elapsedMs: number;
}

const pagination = (
  olderCursor: string | null,
  loadedTurnCount: number,
  oldestLoadedTurnId: string | null,
): CodexConversationTurnPagination =>
  ({
    olderCursor,
    backwardsCursor: "turns:newer",
    oldestLoadedTurnId,
    isLoadingOlder: false,
    hasLoadedOldest: olderCursor === null,
    loadedTurnCount,
    itemsView: "full",
  }) as CodexConversationTurnPagination;

const itemPagination = (): CodexHistoryTurnItemsPagination => ({
  olderCursor: null,
  isLoadingOlder: false,
  hasLoadedOldest: true,
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: "full",
});

const projectedTurn = (turnId: string, onItemsRead?: () => void): CodexConversationTurn => {
  const value = {
    threadId: THREAD_ID,
    turnId,
    status: "completed",
    itemIds: Array.from({ length: ITEMS_PER_PAGE_TURN }, (_, index) => `${turnId}:item-${index}`),
  } as Record<string, unknown>;
  Object.defineProperty(value, "items", {
    enumerable: true,
    get: () => {
      onItemsRead?.();
      return Array.from({ length: ITEMS_PER_PAGE_TURN }, (_, index) => ({
        questions: null,
        type: "agentMessage",
        id: `${turnId}:item-${index}`,
        text: `${ITEM_TEXT}:${index}`,
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
      }));
    },
  });
  return value as unknown as CodexConversationTurn;
};

const canonicalTurn = (turnId: string, onItemsRead?: () => void): CodexCanonicalTurnState => {
  const value = {
    protocol: {
      id: turnId,
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      itemsView: "full",
    },
    sidecar: {},
  } as Record<string, unknown>;
  Object.defineProperty(value, "items", {
    enumerable: true,
    get: () => {
      onItemsRead?.();
      return Array.from({ length: ITEMS_PER_PAGE_TURN }, (_, index) => ({
        protocol: {
          questions: null,
          type: "agentMessage",
          id: `${turnId}:item-${index}`,
          text: `${ITEM_TEXT}:${index}`,
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
        },
        sidecar: {},
      }));
    },
  });
  return value as unknown as CodexCanonicalTurnState;
};

const contentRow = (turnId: string): CodexHistoryRow => ({
  kind: "content",
  key: `turn:${turnId}`,
  turnKey: turnId,
  entityKey: turnId,
});

const gapRow = (key: string, boundary: CodexHistoryBoundaryRef): CodexHistoryRow => ({
  kind: "gap",
  key,
  olderBoundary: boundary,
  newerBoundary: null,
  estimatedHeightPx: 144,
});

const snapshot = (input: {
  readonly turns: readonly CodexConversationTurn[];
  readonly canonicalTurns: readonly CodexCanonicalTurnState[];
  readonly rows: readonly CodexHistoryRow[];
  readonly turnPagination: CodexConversationTurnPagination;
  readonly turnItemsPaginationById: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly historyMutationRevision: number;
}): CodexConversationSnapshot =>
  ({
    threadId: THREAD_ID,
    projectId: "project-performance",
    source: null,
    threadName: "Bounded history mutation fixture",
    threadPreview: "Resident graph only",
    modelProvider: "openai",
    cwd: "/workspace",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-08-31T00:00:00.000Z",
    resumeState: "resumed",
    turns: input.turns,
    canonicalState: {
      protocol: { id: THREAD_ID },
      turns: input.canonicalTurns,
      requests: [],
      sidecar: {},
    } as unknown as CodexCanonicalConversationState,
    canonicalRequests: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditLastUserTurn: false,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    conversationEntityGeneration: CONVERSATION_GENERATION,
    historyTopologyGeneration: TOPOLOGY_GENERATION,
    historyMutationRevision: input.historyMutationRevision,
    historyRows: input.rows,
    turnPagination: input.turnPagination,
    turnItemsPaginationById: input.turnItemsPaginationById,
  }) as unknown as CodexConversationSnapshot;

const elapsedMs = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000;

const measureMutation = (logicalTurnCount: number): MutationMeasurement => {
  let stableLeafReads = 0;
  const stableTurnIds = Array.from(
    { length: RESIDENT_TAIL_TURNS },
    (_, index) => `turn-${logicalTurnCount - RESIDENT_TAIL_TURNS + index}`,
  );
  const pageTurnIds = Array.from(
    { length: PAGE_TURNS },
    (_, index) => `turn-${logicalTurnCount - RESIDENT_TAIL_TURNS - PAGE_TURNS + index}`,
  );
  const stableTurns = stableTurnIds.map((turnId) =>
    projectedTurn(turnId, () => {
      stableLeafReads += 1;
    }),
  );
  const stableCanonicalTurns = stableTurnIds.map((turnId) =>
    canonicalTurn(turnId, () => {
      stableLeafReads += 1;
    }),
  );
  const pageTurns = pageTurnIds.map((turnId) => projectedTurn(turnId));
  const pageCanonicalTurns = pageTurnIds.map((turnId) => canonicalTurn(turnId));
  const cursor = `turns:${logicalTurnCount - RESIDENT_TAIL_TURNS}`;
  const nextCursor = `turns:${logicalTurnCount - RESIDENT_TAIL_TURNS - PAGE_TURNS}`;
  const boundary: CodexHistoryBoundaryRef = {
    generation: TOPOLOGY_GENERATION,
    islandId: "tail:performance",
    edge: "older",
    boundaryId: `older:${cursor}`,
    progressKey: JSON.stringify([cursor, stableTurnIds[0] ?? null]),
  };
  const continuation: CodexHistoryBoundaryRef = {
    ...boundary,
    boundaryId: `older:${nextCursor}`,
    progressKey: JSON.stringify([nextCursor, pageTurnIds[0] ?? null]),
  };
  const beforeItemsPagination = Object.fromEntries(
    stableTurnIds.map((turnId) => [turnId, itemPagination()]),
  );
  const afterItemsPagination = {
    ...beforeItemsPagination,
    ...Object.fromEntries(pageTurnIds.map((turnId) => [turnId, itemPagination()])),
  };
  const before = snapshot({
    turns: stableTurns,
    canonicalTurns: stableCanonicalTurns,
    rows: [gapRow(`gap:${cursor}`, boundary), ...stableTurnIds.map(contentRow)],
    turnPagination: pagination(cursor, stableTurns.length, stableTurnIds[0] ?? null),
    turnItemsPaginationById: beforeItemsPagination,
    historyMutationRevision: HISTORY_MUTATION_REVISION,
  });
  const after = snapshot({
    turns: [...pageTurns, ...stableTurns],
    canonicalTurns: [...pageCanonicalTurns, ...stableCanonicalTurns],
    rows: [
      gapRow(`gap:${nextCursor}`, continuation),
      ...pageTurnIds.map(contentRow),
      ...stableTurnIds.map(contentRow),
    ],
    turnPagination: pagination(
      nextCursor,
      stableTurns.length + pageTurns.length,
      pageTurnIds[0] ?? null,
    ),
    turnItemsPaginationById: afterItemsPagination,
    historyMutationRevision: HISTORY_MUTATION_REVISION + 1,
  });
  const request: CodexConversationHistoryPageRequest = {
    threadId: THREAD_ID,
    expectedConversationGeneration: CONVERSATION_GENERATION,
    expectedHistoryMutationRevision: HISTORY_MUTATION_REVISION,
    target: { kind: "turnBoundary", boundary },
  };

  hashCodexConversationReplica(before);
  const readsAfterInitialHash = stableLeafReads;
  const startedAt = process.hrtime.bigint();
  const mutation = buildCodexConversationHistoryMutation({
    before,
    after,
    origin: { kind: "page", request },
  });
  const applied = applyCodexConversationHistoryMutation(before, mutation);
  if (!applied.ok) throw new Error(`History mutation did not apply: ${applied.reason}`);
  hashCodexConversationReplica(applied.conversation);
  const elapsed = elapsedMs(startedAt);

  assert.strictEqual(applied.conversation.turns.length, RESIDENT_TAIL_TURNS + PAGE_TURNS);
  assert.strictEqual(applied.conversation.turns[PAGE_TURNS], stableTurns[0]);
  assert.strictEqual(
    applied.conversation.canonicalState?.turns[PAGE_TURNS],
    stableCanonicalTurns[0],
  );
  return {
    logicalTurnCount,
    mutationBytes: new TextEncoder().encode(JSON.stringify(mutation)).byteLength,
    residentTurnsBefore: stableTurns.length,
    residentTurnsAfter: applied.conversation.turns.length,
    upsertTurns: mutation.upsertTurns.length,
    upsertCanonicalTurns: mutation.upsertCanonicalTurns.length,
    rowSplices: mutation.rowSplices.length,
    stableLeafReadsDuringMutationAndHash: stableLeafReads - readsAfterInitialHash,
    elapsedMs: elapsed,
  };
};

it("keeps normal page mutation bytes and incremental hash work independent of logical history", () => {
  const measurements = [100, 10_000].map(measureMutation);

  for (const measurement of measurements) {
    assert.strictEqual(measurement.residentTurnsBefore, RESIDENT_TAIL_TURNS);
    assert.strictEqual(measurement.residentTurnsAfter, RESIDENT_TAIL_TURNS + PAGE_TURNS);
    assert.strictEqual(measurement.upsertTurns, PAGE_TURNS);
    assert.strictEqual(measurement.upsertCanonicalTurns, PAGE_TURNS);
    assert.strictEqual(measurement.rowSplices, 1);
    assert.strictEqual(measurement.stableLeafReadsDuringMutationAndHash, 0);
    assert.isAtMost(measurement.mutationBytes, PAGE_MUTATION_MAX_BYTES);
  }
  // Stable IDs gain two decimal digits at 10k; only that O(log N) identifier width may differ.
  assert.isAtMost(
    Math.abs(measurements[0]!.mutationBytes - measurements[1]!.mutationBytes),
    2 * 1024,
  );

  process.stdout.write(
    `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({ kind: "history-page-mutation", measurements })}\n`,
  );
});
