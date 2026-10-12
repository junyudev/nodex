import type { Patch } from "immer";
import type { CodexCanonicalConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { residentConversationTurns } from "../../../shared/codex-conversation-state/codex-turn-mutation";
import { flattenCodexHistoryTopology } from "../../../shared/codex-conversation-state/codex-history-topology";
import type { CodexConversationSnapshot } from "../../../shared/types";

type HistoryMetadata = Pick<
  CodexConversationSnapshot,
  | "conversationEntityGeneration"
  | "historyTopologyGeneration"
  | "historyMutationRevision"
  | "historyRows"
  | "turnPagination"
  | "turnItemsPaginationById"
>;
type PreviousHistory = HistoryMetadata & Pick<CodexConversationSnapshot, "canonicalState">;

function affectsHistoryMetadata({ path }: Patch): boolean {
  if (path.length === 0) return true;
  if (
    ["turnsPagination", "paginatedHistory", "resumeState", "historyMode"].includes(String(path[0]))
  )
    return true;
  if (path[0] === "turns")
    return path.length <= 2 || ["itemsPagination", "turnId", "entityKey"].includes(String(path[2]));
  if (path[0] !== "turnHistory") return false;
  if (path.length <= 2 || path[2] !== "entitiesByKey") return true;
  return path.length <= 4 || ["itemsPagination", "turnId", "entityKey"].includes(String(path[4]));
}

/** Compatibility metadata never materializes item bodies; text receipts retain these identities. */
export function projectCanonicalHistoryPresentation(
  state: CodexCanonicalConversationState,
  previous?: PreviousHistory,
  patches?: readonly Patch[],
): HistoryMetadata {
  const before = previous?.canonicalState;
  const history = state.turnHistory?.history;
  const historyTopologyGeneration = history?.generation ?? 0;
  if (
    before?.id === state.id &&
    previous?.historyTopologyGeneration === historyTopologyGeneration &&
    previous.turnPagination &&
    previous.turnItemsPaginationById &&
    patches &&
    !patches.some(affectsHistoryMetadata)
  )
    return {
      conversationEntityGeneration: previous.conversationEntityGeneration ?? 0,
      historyTopologyGeneration,
      historyMutationRevision: previous.historyMutationRevision ?? 0,
      historyRows: previous.historyRows,
      turnPagination: previous.turnPagination,
      turnItemsPaginationById: previous.turnItemsPaginationById,
    };

  const turns = residentConversationTurns(state);
  const items = Object.fromEntries(
    turns.flatMap((turn) =>
      turn.turnId !== null && turn.itemsPagination
        ? [[turn.turnId, turn.itemsPagination] as const]
        : [],
    ),
  );
  const previousItems = previous?.turnItemsPaginationById;
  const turnItemsPaginationById =
    previousItems &&
    Object.keys(previousItems).length === Object.keys(items).length &&
    Object.entries(items).every(([id, pagination]) => previousItems[id] === pagination)
      ? previousItems
      : items;
  const historyRows = history
    ? before?.turnHistory?.history.islands === history.islands &&
      before.turnHistory.history.generation === history.generation &&
      previous?.historyRows
      ? previous.historyRows
      : flattenCodexHistoryTopology(history)
    : undefined;
  const tail = history?.islands[0]?.olderBoundary;
  const pagination = state.turnsPagination;
  const nextTurnPagination: NonNullable<HistoryMetadata["turnPagination"]> = {
    source: pagination?.source ?? (tail?.status === "available" ? tail.handle.source : undefined),
    olderCursor:
      pagination?.olderCursor ?? (tail?.status === "available" ? tail.handle.cursor : null),
    oldestLoadedTurnId: pagination?.oldestLoadedTurnId ?? turns[0]?.turnId ?? null,
    backwardsCursor: state.paginatedHistory?.turnsBackwardsCursor ?? null,
    isLoadingOlder: pagination?.isLoadingOlder ?? false,
    hasLoadedOldest:
      pagination?.hasLoadedOldest ??
      (tail
        ? tail.status === "exhausted"
        : state.historyMode === "legacy" || state.resumeState === "resumed"),
    loadedTurnCount: turns.length,
    itemsView: "full",
  };
  const turnPagination =
    previous?.turnPagination &&
    Object.entries(nextTurnPagination).every(
      ([key, value]) => previous.turnPagination?.[key as keyof typeof nextTurnPagination] === value,
    )
      ? previous.turnPagination
      : nextTurnPagination;
  const changed =
    previous !== undefined &&
    (historyTopologyGeneration !== previous.historyTopologyGeneration ||
      historyRows !== previous.historyRows ||
      turnPagination !== previous.turnPagination ||
      turnItemsPaginationById !== previous.turnItemsPaginationById);
  return {
    conversationEntityGeneration: previous?.conversationEntityGeneration ?? 0,
    historyTopologyGeneration,
    historyMutationRevision: (previous?.historyMutationRevision ?? 0) + Number(changed),
    historyRows,
    turnPagination,
    turnItemsPaginationById,
  };
}
