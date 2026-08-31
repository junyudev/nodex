import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
  CodexConversationTurnPagination,
} from "../../shared/types";
import {
  flattenCodexHistoryTopology,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryTurnItemsPagination,
} from "../../shared/codex-conversation-state/codex-history-topology";
import type { CodexCanonicalTurnState } from "../../shared/codex-conversation-state/codex-conversation-state";

export interface CodexConversationHistoryResidencyProjection {
  readonly canonicalState: CodexCanonicalConversationState;
  readonly turnPagination: CodexConversationTurnPagination;
  readonly turnItemsPaginationById: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly projectConversation: (
    conversation: CodexConversationSnapshot,
  ) => CodexConversationSnapshot;
}

function writableTail(topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>) {
  for (let index = topology.islands.length - 1; index >= 0; index -= 1) {
    const island = topology.islands[index];
    if (island?.newerBoundary.status === "exhausted") return island;
  }
  return topology.islands.at(-1) ?? null;
}

/**
 * Projects one retained topology through every duplicate conversation graph. The Entity remains
 * responsible for committing the result atomically and rebuilding a replica checkpoint/revision.
 */
export function projectCodexConversationHistoryResidency(input: {
  readonly canonicalState: CodexCanonicalConversationState;
  readonly conversationPagination: CodexConversationTurnPagination;
  readonly turnItemsPaginationById: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
}): CodexConversationHistoryResidencyProjection {
  const residentTurnIds = new Set(Object.keys(input.topology.entitiesByKey));
  const canonicalState: CodexCanonicalConversationState = {
    ...input.canonicalState,
    // Null-id optimistic/live Turns have no durable history entity yet and are never residency
    // candidates. Releasing them would turn memory pressure into lost local work.
    turns: input.canonicalState.turns.filter(
      (turn) => turn.protocol.id === null || residentTurnIds.has(turn.protocol.id),
    ),
  };
  const tail = writableTail(input.topology);
  const tailOlderBoundary = tail?.olderBoundary ?? null;
  const turnPagination: CodexConversationTurnPagination = {
    ...input.conversationPagination,
    olderCursor: tailOlderBoundary?.status === "available" ? tailOlderBoundary.handle.cursor : null,
    // A global newer cursor is not an address for an arbitrary retained island. Sparse topology
    // owns every remaining direction explicitly after compaction.
    backwardsCursor: null,
    oldestLoadedTurnId: tail?.entries[0]?.entityKey ?? null,
    isLoadingOlder: false,
    hasLoadedOldest: tailOlderBoundary?.status === "exhausted",
    loadedTurnCount: input.topology.residency.turnCount,
  };
  const turnItemsPaginationById = Object.fromEntries(
    Object.entries(input.turnItemsPaginationById).filter(([turnId]) => residentTurnIds.has(turnId)),
  );
  const historyRows = flattenCodexHistoryTopology(input.topology);

  return {
    canonicalState,
    turnPagination,
    turnItemsPaginationById,
    projectConversation: (conversation) => ({
      ...conversation,
      turns: conversation.turns.filter(
        (turn) => turn.turnId === null || residentTurnIds.has(turn.turnId),
      ),
      canonicalState,
      turnPagination,
      turnItemsPaginationById,
      historyRows,
      historyTopologyGeneration: input.topology.generation,
    }),
  };
}
