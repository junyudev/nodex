import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import { castDraft, type Draft } from "immer";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import { areStructurallyEqual } from "../structural-equality";
import {
  mergeCodexCanonicalTurnStates,
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
} from "./codex-conversation-state";
import type { CodexHistoryTurnItemsPagination } from "./codex-history-topology";

type PaginationByTurnId = Readonly<Record<string, CodexHistoryTurnItemsPagination>>;

/** Resume refreshes server-owned Turn fields without replacing profile provenance or output. */
export function refreshResumedConversationTurnParams(
  state: Draft<CodexCanonicalConversationState>,
  response: Pick<
    ThreadResumeResponse,
    "approvalPolicy" | "approvalsReviewer" | "sandbox" | "model" | "reasoningEffort"
  >,
  cwd: string | null,
): void {
  for (const { address } of residentConversationTurnEntries(state)) {
    const turn = conversationTurnDraft(state, address);
    if (!turn) continue;
    turn.params = {
      ...turn.params,
      approvalPolicy: castDraft(response.approvalPolicy),
      approvalsReviewer: response.approvalsReviewer,
      sandboxPolicy: castDraft(response.sandbox),
      model: response.model,
      cwd,
      effort: response.reasoningEffort,
    };
  }
}

/** A remaining legacy cursor may drain only after this resume's publication and goal hydration. */
export function allowsAutomaticResumeHistoryDrain(input: {
  readonly hostId: string;
  readonly tailHydration: boolean;
  readonly paginated: boolean;
  readonly requested: boolean;
  readonly reconnectRecovery: boolean;
  readonly suppressed: boolean;
}): boolean {
  return (
    input.tailHydration &&
    input.hostId !== "durable" &&
    !input.paginated &&
    input.requested &&
    !input.reconnectRecovery &&
    !input.suppressed
  );
}

/** A resumed tail either meets the resident snapshot or leaves a cursor interval to reconnect. */
export function mergeCodexResumedItemsPagination(
  existing: CodexHistoryTurnItemsPagination | undefined,
  incoming: CodexHistoryTurnItemsPagination,
  items: readonly CodexCanonicalItem[],
): CodexHistoryTurnItemsPagination {
  const stopItemId =
    existing?.reconnect == null ? existing?.newestSnapshotItemId : existing.reconnect.stopItemId;
  const previousCursor =
    existing?.reconnect == null
      ? existing?.olderCursor
      : existing.reconnect.olderCursorAfterReconnect;
  const overlaps =
    incoming.summaryItemIds == null &&
    stopItemId != null &&
    items.some((item) => item.id === stopItemId);
  const olderCursor = overlaps ? (previousCursor ?? null) : incoming.olderCursor;
  const hasLoadedOldest = incoming.hasLoadedOldest || (overlaps && previousCursor == null);
  const result: CodexHistoryTurnItemsPagination = {
    ...incoming,
    olderCursor: hasLoadedOldest ? null : olderCursor,
    hasLoadedOldest,
    itemsView: hasLoadedOldest ? "full" : incoming.itemsView,
    reconnect:
      hasLoadedOldest || overlaps
        ? undefined
        : {
            beforeItemId: items[0]?.id ?? null,
            stopItemId,
            olderCursorAfterReconnect: previousCursor ?? undefined,
          },
  };
  return existing && areStructurallyEqual(existing, result) ? existing : result;
}

export function mergeCodexResumedHistory(input: {
  readonly existing: CodexCanonicalConversationState;
  readonly incoming: CodexCanonicalConversationState;
  readonly existingPagination: PaginationByTurnId;
  readonly incomingPagination: PaginationByTurnId;
}): { canonical: CodexCanonicalConversationState; pagination: PaginationByTurnId } {
  const pagination = { ...input.existingPagination };
  const residentIds = new Set(residentConversationTurns(input.existing).map((turn) => turn.turnId));
  for (const turn of input.incoming.turns) {
    const id = turn.turnId;
    if (id === null) continue;
    const incoming = input.incomingPagination[id];
    if (incoming && !residentIds.has(id)) {
      pagination[id] = incoming;
      continue;
    }
    if (incoming)
      pagination[id] = mergeCodexResumedItemsPagination(
        input.existingPagination[id],
        incoming,
        turn.items,
      );
  }
  const turns = mergeCodexCanonicalTurnStates(
    residentConversationTurns(input.existing),
    input.incoming.turns,
    (turnId) => ({
      itemsPagination: turnId === null ? undefined : pagination[turnId],
      isResumeSnapshot: true,
    }),
  );
  return {
    canonical: {
      ...input.incoming,
      turns: turns.map((turn) => {
        const view = turn.turnId === null ? undefined : pagination[turn.turnId]?.itemsView;
        return view && view !== turn.itemsView ? { ...turn, itemsView: view } : turn;
      }),
    },
    pagination,
  };
}

/** Stops a reconnect scan at its resident anchor, then resumes the previous older cursor. */
export function advanceCodexReconnectedItemsPagination(
  current: CodexHistoryTurnItemsPagination,
  items: readonly CodexCanonicalItem[],
  nextCursor: string | null,
): CodexHistoryTurnItemsPagination {
  const reconnect = current.reconnect;
  const reached =
    reconnect?.stopItemId != null && items.some((item) => item.id === reconnect.stopItemId);
  const olderCursor = reached ? (reconnect?.olderCursorAfterReconnect ?? null) : nextCursor;
  return {
    ...current,
    summaryItemIds: undefined,
    olderCursor,
    hasLoadedOldest: olderCursor === null,
    isLoadingOlder: false,
    itemsView: olderCursor === null ? "full" : "summary",
    newestSnapshotItemId: current.newestSnapshotItemId ?? items.at(-1)?.id,
    reconnect:
      olderCursor === null || !reconnect || reached
        ? undefined
        : { ...reconnect, beforeItemId: items[0]?.id ?? reconnect.beforeItemId },
  };
}
