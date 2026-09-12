import type { CodexHistoryBoundaryRef, CodexHistoryTurnItemsPagination } from "./codex-conversation-state/codex-history-topology";

export interface CodexConversationHistoryTurnItemsRef {
  readonly turnId: string;
  readonly expectedTopologyGeneration: number;
  readonly edge: "older" | "newer";
  readonly progressKey: string;
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
    "olderCursor" | "hasLoadedOldest" | "itemsView" | "reconnect"
  >,
  edge: "older" | "newer" = "older",
): string {
  return JSON.stringify([
    edge,
    pagination.olderCursor,
    pagination.hasLoadedOldest,
    pagination.itemsView,
    pagination.reconnect ?? null,
  ]);
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
  if (edge !== "older" || input.pagination.hasLoadedOldest || input.pagination.itemsView === "full") return null;
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
