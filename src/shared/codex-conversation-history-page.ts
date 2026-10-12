import type {
  CodexHistoryBoundaryRef,
  CodexHistoryTurnItemsPagination,
} from "./codex-conversation-state/codex-history-topology";
import type { CodexCanonicalConversationState } from "./codex-conversation-state/codex-conversation-state";
import { residentConversationTurns } from "./codex-conversation-state/codex-turn-mutation";

export interface CodexConversationHistoryTurnItemsRef {
  readonly turnId: string;
  readonly expectedTopologyGeneration: number;
  readonly edge: "older" | "newer";
  readonly progressKey: string;
}

/** Request-gate identity includes the owning topology, even when the physical cursor is reused. */
export function codexConversationHistoryTurnItemsRefKey(
  ref: CodexConversationHistoryTurnItemsRef,
): string {
  return JSON.stringify([ref.expectedTopologyGeneration, ref.turnId, ref.edge, ref.progressKey]);
}

export type CodexConversationHistoryPageTarget =
  | {
      readonly kind: "turnBoundary";
      readonly boundary: CodexHistoryBoundaryRef;
    }
  | {
      readonly kind: "turnItems";
      readonly items: CodexConversationHistoryTurnItemsRef;
    };

/** The only ordinary resident-history read command. It always addresses one physical page. */
export interface CodexConversationHistoryPageRequest {
  readonly threadId: string;
  readonly expectedConversationGeneration: number;
  readonly expectedHistoryMutationRevision: number;
  readonly target: CodexConversationHistoryPageTarget;
}

export function codexConversationHistoryTurnItemsProgressKey(
  pagination: Pick<
    CodexHistoryTurnItemsPagination,
    | "source"
    | "olderCursor"
    | "olderItemId"
    | "evicted"
    | "hasLoadedOldest"
    | "itemsView"
    | "reconnect"
  >,
  edge: "older" | "newer" = "older",
): string {
  return JSON.stringify([
    edge,
    pagination.source ?? "ordinary",
    pagination.olderCursor,
    pagination.olderItemId ?? null,
    pagination.evicted ?? false,
    pagination.hasLoadedOldest,
    pagination.itemsView,
    pagination.reconnect ?? null,
  ]);
}

/** A delayed viewport intent must still address the current Turn's recovery boundary. */
export function isCodexConversationHistoryTurnItemsRefCurrent(
  state: CodexCanonicalConversationState,
  ref: CodexConversationHistoryTurnItemsRef,
): boolean {
  const generation = state.turnHistory?.history.generation ?? 0;
  if (generation !== ref.expectedTopologyGeneration) return false;
  const turn = residentConversationTurns(state).find((turn) => turn.turnId === ref.turnId);
  if (!turn?.itemsPagination) return false;
  const current = createCodexConversationHistoryTurnItemsRef({
    turnId: ref.turnId,
    expectedTopologyGeneration: generation,
    pagination: turn.itemsPagination,
    edge: ref.edge,
  });
  return current !== null && current.progressKey === ref.progressKey;
}

export function createCodexConversationHistoryTurnItemsRef(input: {
  readonly turnId: string;
  readonly expectedTopologyGeneration: number;
  readonly pagination: CodexHistoryTurnItemsPagination;
  readonly edge?: "older" | "newer";
}): CodexConversationHistoryTurnItemsRef | null {
  const edge = input.edge ?? "older";
  if (
    !input.turnId ||
    !Number.isSafeInteger(input.expectedTopologyGeneration) ||
    input.expectedTopologyGeneration < 0
  ) {
    return null;
  }
  if (
    edge !== "older" ||
    input.pagination.hasLoadedOldest ||
    (input.pagination.itemsView === "full" && input.pagination.evicted !== true)
  )
    return null;
  return {
    turnId: input.turnId,
    expectedTopologyGeneration: input.expectedTopologyGeneration,
    edge,
    progressKey: codexConversationHistoryTurnItemsProgressKey(input.pagination, edge),
  };
}

export function codexConversationHistoryPageRequestKey(
  request: CodexConversationHistoryPageRequest,
): string {
  const target = request.target;
  return target.kind === "turnBoundary"
    ? JSON.stringify([
        request.threadId,
        request.expectedConversationGeneration,
        target.kind,
        target.boundary.generation,
        target.boundary.islandId,
        target.boundary.edge,
        target.boundary.boundaryId,
        target.boundary.progressKey,
      ])
    : JSON.stringify([
        request.threadId,
        request.expectedConversationGeneration,
        target.kind,
        target.items.expectedTopologyGeneration,
        target.items.turnId,
        target.items.edge,
        target.items.progressKey,
      ]);
}
