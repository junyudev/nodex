import type {
  CodexBackgroundTerminalRow,
  CodexCanonicalConversationState,
  CodexCanonicalServerRequest,
  CodexConversationCapabilityFlags,
  CodexConversationItem,
  CodexCollaborationModeState,
  CodexConversationResumeState,
  CodexPendingSteer,
  CodexQueuedFollowUpProjection,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexConversationTurnPagination,
  CodexThreadDetail,
  CodexTranscriptEntry,
} from "../../shared/types";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import { EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION } from "../../shared/codex-queued-follow-up-state";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";

const DEFAULT_COLLABORATION_MODE_STATE: CodexCollaborationModeState = {
  mode: "default",
  settings: {
    model: "",
    reasoning_effort: null,
    developer_instructions: null,
  },
};

function sortConversationItems(left: CodexTranscriptEntry, right: CodexTranscriptEntry): number {
  return (
    (left.sequence ?? 0) - (right.sequence ?? 0) ||
    left.createdAt - right.createdAt ||
    left.updatedAt - right.updatedAt ||
    left.itemId.localeCompare(right.itemId)
  );
}

function sortTurnItemsByCanonicalOrder(
  entries: CodexTranscriptEntry[],
  turn: CodexThreadDetail["turns"][number],
): CodexTranscriptEntry[] {
  if (turn.itemIds.length === 0) {
    return [...entries].sort(sortConversationItems);
  }

  const orderByItemId = new Map(turn.itemIds.map((itemId, index) => [itemId, index]));
  const paramsItemId = turn.turnId === null ? null : `${turn.turnId}:input`;

  return [...entries].sort((left, right) => {
    if (paramsItemId !== null) {
      if (left.itemId === paramsItemId && right.itemId !== paramsItemId) return -1;
      if (right.itemId === paramsItemId && left.itemId !== paramsItemId) return 1;
    }
    const leftOrder = orderByItemId.get(left.itemId);
    const rightOrder = orderByItemId.get(right.itemId);

    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }
    if (leftOrder !== undefined) return -1;
    if (rightOrder !== undefined) return 1;
    return sortConversationItems(left, right);
  });
}

export function buildCodexConversationTurn(
  detail: CodexThreadDetail,
  turn: CodexThreadDetail["turns"][number],
): CodexConversationTurn {
  const nullableTurnId = (turn as { turnId: string | null }).turnId;
  const projectedItemIds = new Set(turn.itemIds);
  const items = detail.transcript
    .filter((entry) =>
      nullableTurnId === null && projectedItemIds.size > 0
        ? projectedItemIds.has(entry.itemId)
        : entry.turnId === turn.turnId,
    )
    .sort(sortConversationItems);

  const orderedItems = sortTurnItemsByCanonicalOrder(items, turn).map<CodexConversationItem>(
    (entry) => ({ ...entry }),
  );

  return {
    ...turn,
    items: orderedItems,
  };
}

export function buildCodexConversationSnapshot(input: {
  detail: CodexThreadDetail;
  resumeState: CodexConversationResumeState;
  requests: CodexConversationServerRequest[];
  canonicalState?: CodexCanonicalConversationState | null;
  canonicalRequests?: readonly CodexCanonicalServerRequest[];
  hasUnreadTurn?: boolean;
  unreadMessageCount?: number;
  queuedFollowUps?: CodexQueuedFollowUpProjection;
  pendingSteers?: CodexPendingSteer[];
  backgroundTerminalRows?: CodexBackgroundTerminalRow[];
  capabilityFlags: CodexConversationCapabilityFlags;
  turnPagination?: CodexConversationTurnPagination;
  turnItemsPaginationById?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  threadGoal?: ThreadGoal | null;
  completedThreadGoal?: ThreadGoal | null;
  threadGoalResumeConfirmation?: ThreadGoal | null;
}): CodexConversationSnapshot {
  const { transcript, ...detail } = input.detail;
  void transcript;

  return {
    ...detail,
    latestCollaborationMode:
      input.detail.latestCollaborationMode ?? DEFAULT_COLLABORATION_MODE_STATE,
    latestThreadSettings: input.detail.latestThreadSettings ?? null,
    latestTokenUsageInfo: input.detail.latestTokenUsageInfo ?? null,
    threadGoal: input.threadGoal ?? null,
    completedThreadGoal: input.completedThreadGoal ?? null,
    threadGoalResumeConfirmation: input.threadGoalResumeConfirmation ?? null,
    resumeState: input.resumeState,
    turnPagination: input.turnPagination ?? {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: input.detail.turns.length,
      itemsView: "full",
    },
    ...(input.turnItemsPaginationById
      ? { turnItemsPaginationById: { ...input.turnItemsPaginationById } }
      : {}),
    turns: input.detail.turns.map((turn) => buildCodexConversationTurn(input.detail, turn)),
    canonicalState: input.canonicalState ?? null,
    canonicalRequests: [...(input.canonicalRequests ?? [])],
    hasUnreadTurn: input.hasUnreadTurn ?? false,
    ...(input.unreadMessageCount === undefined
      ? {}
      : { unreadMessageCount: input.unreadMessageCount }),
    requests: [...input.requests],
    queuedFollowUps: input.queuedFollowUps
      ? { ...input.queuedFollowUps, entries: [...input.queuedFollowUps.entries] }
      : EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
    pendingSteers: [...(input.pendingSteers ?? [])].sort(
      (left, right) => left.createdAt - right.createdAt,
    ),
    backgroundTerminalRows: [...(input.backgroundTerminalRows ?? [])],
    capabilityFlags: input.capabilityFlags,
  };
}
