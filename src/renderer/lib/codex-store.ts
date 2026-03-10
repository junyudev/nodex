import type {
  CodexAccountSnapshot,
  CodexApprovalRequest,
  CodexConnectionState,
  CodexEvent,
  CodexItemView,
  CodexPlanImplementationRequest,
  CodexPermissionMode,
  CodexThreadDetail,
  CodexThreadStartProgressPhase,
  CodexThreadSummary,
  CodexTurnSummary,
  CodexUserInputRequest,
} from "./types";
import {
  canMergeSyntheticTextDuplicate,
  isSyntheticCodexItemId,
  mergeCodexItemView,
  resolveCodexItemPrimaryIdentityKey,
  resolveCodexItemTextIdentityKey,
} from "../../shared/codex-item-identity";

export interface CodexStoreState {
  connection: CodexConnectionState;
  account: CodexAccountSnapshot | null;
  threadsByProject: Record<string, CodexThreadSummary[]>;
  threadDetailsById: Record<string, CodexThreadDetail>;
  approvalQueue: CodexApprovalRequest[];
  userInputQueue: CodexUserInputRequest[];
  planImplementationQueue: CodexPlanImplementationRequest[];
  dismissedPlanImplementationTurnIdByThread: Record<string, string>;
  permissionModeByProject: Record<string, CodexPermissionMode>;
  threadStartProgressByTarget: Record<string, CodexThreadStartProgressState>;
  errorMessage: string | null;
}

export interface CodexThreadStartProgressState {
  projectId: string;
  cardId: string;
  phase: CodexThreadStartProgressPhase;
  message: string;
  outputText: string;
  outputCarriageReturnPending: boolean;
  updatedAt: number;
}

export type CodexStoreAction =
  | { type: "event"; event: CodexEvent }
  | { type: "setThreads"; projectId: string; threads: CodexThreadSummary[] }
  | { type: "setThreadDetail"; detail: CodexThreadDetail }
  | { type: "optimisticItemUpsert"; item: CodexItemView }
  | { type: "removeThreadItem"; threadId: string; turnId: string; itemId: string }
  | { type: "setPermissionMode"; projectId: string; mode: CodexPermissionMode }
  | { type: "resolvePlanImplementation"; threadId: string; turnId: string };

const INITIAL_CONNECTION: CodexConnectionState = {
  status: "disconnected",
  retries: 0,
};

export function createInitialCodexStoreState(): CodexStoreState {
  return {
    connection: INITIAL_CONNECTION,
    account: null,
    threadsByProject: {},
    threadDetailsById: {},
    approvalQueue: [],
    userInputQueue: [],
    planImplementationQueue: [],
    dismissedPlanImplementationTurnIdByThread: {},
    permissionModeByProject: {},
    threadStartProgressByTarget: {},
    errorMessage: null,
  };
}

function buildPlanImplementationRequestId(turnId: string): string {
  return `implement-plan:${turnId}`;
}

function getThreadStartProgressTargetKey(projectId: string, cardId: string): string {
  return `${projectId}:${cardId}`;
}

function applyTerminalOutputDelta(input: {
  existingText: string;
  outputDelta: string;
  outputCarriageReturnPending: boolean;
}): { outputText: string; outputCarriageReturnPending: boolean } {
  let outputText = input.existingText;
  let outputCarriageReturnPending = input.outputCarriageReturnPending;

  for (const character of input.outputDelta) {
    if (outputCarriageReturnPending) {
      if (character === "\n") {
        outputText += "\n";
        outputCarriageReturnPending = false;
        continue;
      }
      const lastLineBreakIndex = outputText.lastIndexOf("\n");
      outputText = lastLineBreakIndex >= 0 ? outputText.slice(0, lastLineBreakIndex + 1) : "";
      outputCarriageReturnPending = false;
    }

    if (character === "\r") {
      outputCarriageReturnPending = true;
      continue;
    }
    if (character === "\b") {
      if (outputText.length > 0) {
        outputText = outputText.slice(0, -1);
      }
      continue;
    }
    outputText += character;
  }

  return {
    outputText,
    outputCarriageReturnPending,
  };
}

function upsertThread(threads: CodexThreadSummary[], thread: CodexThreadSummary): CodexThreadSummary[] {
  const existing = threads.find((candidate) => candidate.threadId === thread.threadId);
  if (!existing) {
    return [thread, ...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return threads
    .map((candidate) => (candidate.threadId === thread.threadId ? thread : candidate))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeTurns(turns: CodexTurnSummary[], turn: CodexTurnSummary): CodexTurnSummary[] {
  const existing = turns.find((candidate) => candidate.turnId === turn.turnId);
  if (!existing) return [...turns, turn];
  return turns.map((candidate) =>
    candidate.turnId === turn.turnId
      ? {
          ...existing,
          ...turn,
          errorMessage: turn.errorMessage ?? existing.errorMessage,
          itemIds: turn.itemIds.length > 0 ? turn.itemIds : existing.itemIds,
          tokenUsage: turn.tokenUsage ?? existing.tokenUsage,
        }
      : candidate,
  );
}

function mergeThreadDetailTurns(existingTurns: CodexTurnSummary[], incomingTurns: CodexTurnSummary[]): CodexTurnSummary[] {
  if (existingTurns.length === 0) return incomingTurns;
  if (incomingTurns.length === 0) return existingTurns;

  const existingByTurn = new Map(existingTurns.map((turn) => [turn.turnId, turn]));
  const seen = new Set<string>();

  const merged = incomingTurns.map((turn) => {
    seen.add(turn.turnId);
    const existing = existingByTurn.get(turn.turnId);
    if (!existing) return turn;
    return {
      ...existing,
      ...turn,
      errorMessage: turn.errorMessage ?? existing.errorMessage,
      itemIds: turn.itemIds.length > 0 ? turn.itemIds : existing.itemIds,
      tokenUsage: turn.tokenUsage ?? existing.tokenUsage,
    };
  });

  for (const existing of existingTurns) {
    if (seen.has(existing.turnId)) continue;
    merged.push(existing);
  }

  return merged;
}

function doesIncomingDetailSettleKnownInProgressTurn(
  existingTurns: CodexTurnSummary[] | undefined,
  incomingTurns: CodexTurnSummary[],
): boolean {
  if (!existingTurns || existingTurns.length === 0 || incomingTurns.length === 0) return false;

  const previouslyInProgressTurnIds = new Set(
    existingTurns
      .filter((turn) => turn.status === "inProgress")
      .map((turn) => turn.turnId),
  );
  if (previouslyInProgressTurnIds.size === 0) return false;

  return incomingTurns.some(
    (turn) => previouslyInProgressTurnIds.has(turn.turnId) && turn.status !== "inProgress",
  );
}

function resolveLatestPlanImplementationRequest(detail: CodexThreadDetail): CodexPlanImplementationRequest | null {
  const latestTurn = detail.turns[detail.turns.length - 1];
  if (!latestTurn || latestTurn.status !== "completed") return null;

  const latestPlanItem = [...detail.items]
    .filter((item) =>
      item.turnId === latestTurn.turnId
      && (item.normalizedKind === "plan" || item.type === "plan")
      && (item.markdownText ?? "").trim().length > 0,
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt)
    .at(-1);

  if (!latestPlanItem) return null;

  const planContent = (latestPlanItem.markdownText ?? "").trim();
  if (!planContent) return null;

  return {
    requestId: buildPlanImplementationRequestId(latestTurn.turnId),
    projectId: detail.projectId,
    cardId: detail.cardId,
    threadId: detail.threadId,
    turnId: latestTurn.turnId,
    itemId: latestPlanItem.itemId,
    planContent,
    createdAt: latestPlanItem.updatedAt,
  };
}

function syncPlanImplementationQueueForThread(
  state: CodexStoreState,
  threadId: string,
): CodexStoreState {
  const detail = state.threadDetailsById[threadId];
  const nextQueue = state.planImplementationQueue.filter((request) => request.threadId !== threadId);
  if (!detail) {
    return {
      ...state,
      planImplementationQueue: nextQueue,
    };
  }

  const request = resolveLatestPlanImplementationRequest(detail);
  if (!request || state.dismissedPlanImplementationTurnIdByThread[threadId] === request.turnId) {
    return {
      ...state,
      planImplementationQueue: nextQueue,
    };
  }

  return {
    ...state,
    planImplementationQueue: [...nextQueue, request].sort((a, b) => a.createdAt - b.createdAt),
  };
}

function dedupeItemsByIdentity(items: CodexItemView[]): CodexItemView[] {
  if (items.length < 2) return items;

  const dedupedByPrimaryKey = new Map<string, CodexItemView>();
  const nonSyntheticByTextKey = new Map<string, string>();
  const syntheticByTextKey = new Map<string, string>();

  const remapTextIndexes = (fromPrimaryKey: string, toPrimaryKey: string): void => {
    for (const [textKey, primaryKey] of nonSyntheticByTextKey.entries()) {
      if (primaryKey !== fromPrimaryKey) continue;
      nonSyntheticByTextKey.set(textKey, toPrimaryKey);
    }
    for (const [textKey, primaryKey] of syntheticByTextKey.entries()) {
      if (primaryKey !== fromPrimaryKey) continue;
      syntheticByTextKey.set(textKey, toPrimaryKey);
    }
  };

  const registerTextKey = (item: CodexItemView, primaryKey: string): void => {
    const textKey = resolveCodexItemTextIdentityKey(item);
    if (!textKey) return;
    if (isSyntheticCodexItemId(item.itemId)) {
      if (!syntheticByTextKey.has(textKey)) syntheticByTextKey.set(textKey, primaryKey);
      return;
    }
    nonSyntheticByTextKey.set(textKey, primaryKey);
  };

  for (const item of items) {
    const primaryKey = resolveCodexItemPrimaryIdentityKey(item);
    const existingPrimary = dedupedByPrimaryKey.get(primaryKey);
    if (existingPrimary) {
      dedupedByPrimaryKey.set(primaryKey, mergeCodexItemView(existingPrimary, item));
      registerTextKey(item, primaryKey);
      continue;
    }

    const textKey = resolveCodexItemTextIdentityKey(item);
    const fallbackPrimaryKey = textKey
      ? (
          isSyntheticCodexItemId(item.itemId)
            ? nonSyntheticByTextKey.get(textKey)
            : syntheticByTextKey.get(textKey)
        )
      : undefined;

    if (!fallbackPrimaryKey) {
      dedupedByPrimaryKey.set(primaryKey, item);
      registerTextKey(item, primaryKey);
      continue;
    }

    const fallback = dedupedByPrimaryKey.get(fallbackPrimaryKey);
    if (!fallback || !canMergeSyntheticTextDuplicate(fallback, item)) {
      dedupedByPrimaryKey.set(primaryKey, item);
      registerTextKey(item, primaryKey);
      continue;
    }

    const merged = mergeCodexItemView(fallback, item);
    const fallbackIsSynthetic = isSyntheticCodexItemId(fallback.itemId);
    const incomingIsSynthetic = isSyntheticCodexItemId(item.itemId);
    const keepPrimaryKey = fallbackIsSynthetic && !incomingIsSynthetic ? primaryKey : fallbackPrimaryKey;

    if (keepPrimaryKey !== fallbackPrimaryKey) {
      dedupedByPrimaryKey.delete(fallbackPrimaryKey);
      remapTextIndexes(fallbackPrimaryKey, keepPrimaryKey);
    }
    dedupedByPrimaryKey.set(keepPrimaryKey, merged);
    registerTextKey(merged, keepPrimaryKey);
  }

  return Array.from(dedupedByPrimaryKey.values());
}

function mergeItem(items: CodexItemView[], item: CodexItemView): CodexItemView[] {
  const existingIndex = items.findIndex((candidate) => canMergeSyntheticTextDuplicate(candidate, item));
  if (existingIndex < 0) return [...items, item];

  const merged = [...items];
  merged[existingIndex] = mergeCodexItemView(items[existingIndex], item);
  return dedupeItemsByIdentity(merged).sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);
}

function mergeThreadDetailItems(existingItems: CodexItemView[], incomingItems: CodexItemView[]): CodexItemView[] {
  return dedupeItemsByIdentity([...existingItems, ...incomingItems]).sort(
    (a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt,
  );
}

function upsertOptimisticThreadItem(detail: CodexThreadDetail, item: CodexItemView): CodexThreadDetail {
  return {
    ...detail,
    turns: detail.turns.map((turn) =>
      turn.turnId === item.turnId && !turn.itemIds.includes(item.itemId)
        ? {
            ...turn,
            itemIds: [...turn.itemIds, item.itemId],
          }
        : turn
    ),
    items: mergeItem(detail.items, item),
  };
}

function removeThreadItem(detail: CodexThreadDetail, turnId: string, itemId: string): CodexThreadDetail {
  return {
    ...detail,
    turns: detail.turns.map((turn) =>
      turn.turnId === turnId
        ? {
            ...turn,
            itemIds: turn.itemIds.filter((candidate) => candidate !== itemId),
          }
        : turn
    ),
    items: detail.items.filter((item) => !(item.turnId === turnId && item.itemId === itemId)),
  };
}

function updateThreadLists(
  threadsByProject: Record<string, CodexThreadSummary[]>,
  thread: CodexThreadSummary,
): Record<string, CodexThreadSummary[]> {
  const current = threadsByProject[thread.projectId] ?? [];
  return {
    ...threadsByProject,
    [thread.projectId]: upsertThread(current, thread),
  };
}

function withThreadDetail(
  state: CodexStoreState,
  threadId: string,
  mutate: (detail: CodexThreadDetail) => CodexThreadDetail,
): CodexStoreState {
  const current = state.threadDetailsById[threadId];
  if (!current) return state;
  return {
    ...state,
    threadDetailsById: {
      ...state.threadDetailsById,
      [threadId]: mutate(current),
    },
  };
}

function reduceEvent(state: CodexStoreState, event: CodexEvent): CodexStoreState {
  if (event.type === "connection") {
    return {
      ...state,
      connection: event.connection,
    };
  }

  if (event.type === "account") {
    return {
      ...state,
      account: event.account,
      errorMessage: null,
    };
  }

  if (event.type === "rateLimits") {
    if (!state.account) return state;
    return {
      ...state,
      account: {
        ...state.account,
        rateLimits: event.rateLimits,
      },
    };
  }

  if (event.type === "threadSummary") {
    const nextDetails = state.threadDetailsById[event.thread.threadId]
      ? {
          ...state.threadDetailsById,
          [event.thread.threadId]: {
            ...state.threadDetailsById[event.thread.threadId],
            ...event.thread,
          },
        }
      : state.threadDetailsById;

    return {
      ...state,
      threadsByProject: updateThreadLists(state.threadsByProject, event.thread),
      threadDetailsById: nextDetails,
    };
  }

  if (event.type === "threadArchivedState") {
    const nextThreadsByProject = Object.entries(state.threadsByProject).reduce<Record<string, CodexThreadSummary[]>>(
      (acc, [projectId, threads]) => {
        acc[projectId] = threads.map((thread) =>
          thread.threadId === event.threadId
            ? {
                ...thread,
                archived: event.archived,
              }
            : thread,
        );
        return acc;
      },
      {},
    );

    const nextState = {
      ...state,
      threadsByProject: nextThreadsByProject,
    };

    return withThreadDetail(nextState, event.threadId, (detail) => ({
      ...detail,
      archived: event.archived,
    }));
  }

  if (event.type === "threadStatus") {
    const nextThreadsByProject = Object.entries(state.threadsByProject).reduce<Record<string, CodexThreadSummary[]>>(
      (acc, [projectId, threads]) => {
        acc[projectId] = threads.map((thread) =>
          thread.threadId === event.threadId
            ? {
                ...thread,
                statusType: event.statusType,
                statusActiveFlags: event.statusActiveFlags,
              }
            : thread,
        );
        return acc;
      },
      {},
    );

    const nextState = {
      ...state,
      threadsByProject: nextThreadsByProject,
    };

    return withThreadDetail(nextState, event.threadId, (detail) => ({
      ...detail,
      statusType: event.statusType,
      statusActiveFlags: event.statusActiveFlags,
    }));
  }

  if (event.type === "turn") {
    return syncPlanImplementationQueueForThread(withThreadDetail(state, event.turn.threadId, (detail) => ({
      ...detail,
      turns: mergeTurns(detail.turns, event.turn),
    })), event.turn.threadId);
  }

  if (event.type === "itemUpsert") {
    return withThreadDetail(state, event.item.threadId, (detail) => ({
      ...detail,
      items: mergeItem(detail.items, event.item),
    }));
  }

  if (event.type === "itemDelta") {
    return withThreadDetail(state, event.threadId, (detail) => ({
      ...detail,
      items: detail.items.map((item) =>
        item.itemId === event.itemId && item.turnId === event.turnId
          ? {
              ...item,
              ...(item.markdownText !== undefined
                ? { markdownText: `${item.markdownText}${event.delta}` }
                : {}),
              updatedAt: Date.now(),
            }
          : item,
      ),
    }));
  }

  if (event.type === "approvalRequested") {
    const existing = state.approvalQueue.some((entry) => entry.requestId === event.request.requestId);
    if (existing) return state;

    return {
      ...state,
      approvalQueue: [...state.approvalQueue, event.request],
    };
  }

  if (event.type === "approvalResolved") {
    return {
      ...state,
      approvalQueue: state.approvalQueue.filter((entry) => entry.requestId !== event.requestId),
    };
  }

  if (event.type === "userInputRequested") {
    const existing = state.userInputQueue.some((entry) => entry.requestId === event.request.requestId);
    if (existing) return state;

    return {
      ...state,
      userInputQueue: [...state.userInputQueue, event.request],
    };
  }

  if (event.type === "userInputResolved") {
    return {
      ...state,
      userInputQueue: state.userInputQueue.filter((entry) => entry.requestId !== event.requestId),
    };
  }

  if (event.type === "threadStartProgress") {
    const targetKey = getThreadStartProgressTargetKey(event.projectId, event.cardId);
    const previous = state.threadStartProgressByTarget[targetKey];
    const previousText = event.clearOutput ? "" : previous?.outputText ?? "";
    const previousCarriageReturnPending = event.clearOutput ? false : previous?.outputCarriageReturnPending ?? false;
    const mergedOutput = event.outputDelta
      ? applyTerminalOutputDelta({
          existingText: previousText,
          outputDelta: event.outputDelta,
          outputCarriageReturnPending: previousCarriageReturnPending,
        })
      : {
          outputText: previousText,
          outputCarriageReturnPending: previousCarriageReturnPending,
        };

    return {
      ...state,
      threadStartProgressByTarget: {
        ...state.threadStartProgressByTarget,
        [targetKey]: {
          projectId: event.projectId,
          cardId: event.cardId,
          phase: event.phase,
          message: event.message,
          outputText: mergedOutput.outputText,
          outputCarriageReturnPending: mergedOutput.outputCarriageReturnPending,
          updatedAt: event.updatedAt,
        },
      },
    };
  }

  if (event.type === "error") {
    return {
      ...state,
      errorMessage: event.message,
    };
  }

  return state;
}

export function codexStoreReducer(state: CodexStoreState, action: CodexStoreAction): CodexStoreState {
  if (action.type === "event") {
    return reduceEvent(state, action.event);
  }

  if (action.type === "setThreads") {
    return {
      ...state,
      threadsByProject: {
        ...state.threadsByProject,
        [action.projectId]: [...action.threads].sort((a, b) => b.updatedAt - a.updatedAt),
      },
    };
  }

  if (action.type === "setThreadDetail") {
    const existing = state.threadDetailsById[action.detail.threadId];
    const mergedDetail =
      existing === undefined
        ? {
            ...action.detail,
            items: dedupeItemsByIdentity(action.detail.items),
          }
        : {
            ...action.detail,
            turns: mergeThreadDetailTurns(existing.turns, action.detail.turns),
            items: mergeThreadDetailItems(existing.items, action.detail.items),
          };

    const existingSummary = (state.threadsByProject[action.detail.projectId] ?? []).find(
      (thread) => thread.threadId === action.detail.threadId,
    );
    const incomingHasInProgressTurn = mergedDetail.turns.some((turn) => turn.status === "inProgress");
    const existingHasInProgressTurn = existing?.turns.some((turn) => turn.status === "inProgress") ?? false;
    const incomingSettlesKnownInProgressTurn = doesIncomingDetailSettleKnownInProgressTurn(
      existing?.turns,
      action.detail.turns,
    );
    const shouldPreserveActiveStatus =
      !incomingHasInProgressTurn &&
      mergedDetail.statusType !== "active" &&
      !incomingSettlesKnownInProgressTurn &&
      (
        existingSummary?.statusType === "active" ||
        existing?.statusType === "active" ||
        existingHasInProgressTurn
      );

    const detail = shouldPreserveActiveStatus
      ? {
          ...mergedDetail,
          statusType: "active" as const,
          statusActiveFlags: existingSummary?.statusActiveFlags ?? existing?.statusActiveFlags ?? mergedDetail.statusActiveFlags,
        }
      : mergedDetail;
    const detailTargetKey = getThreadStartProgressTargetKey(detail.projectId, detail.cardId);
    const nextThreadStartProgressByTarget = { ...state.threadStartProgressByTarget };
    delete nextThreadStartProgressByTarget[detailTargetKey];

    return syncPlanImplementationQueueForThread({
      ...state,
      threadDetailsById: {
        ...state.threadDetailsById,
        [action.detail.threadId]: detail,
      },
      threadStartProgressByTarget: nextThreadStartProgressByTarget,
      threadsByProject: updateThreadLists(
        state.threadsByProject,
        {
          threadId: detail.threadId,
          projectId: detail.projectId,
          cardId: detail.cardId,
          threadName: detail.threadName,
          threadPreview: detail.threadPreview,
          modelProvider: detail.modelProvider,
          cwd: detail.cwd,
          statusType: detail.statusType,
          statusActiveFlags: detail.statusActiveFlags,
          archived: detail.archived,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          linkedAt: detail.linkedAt,
        },
      ),
    }, action.detail.threadId);
  }

  if (action.type === "optimisticItemUpsert") {
    return withThreadDetail(state, action.item.threadId, (detail) => upsertOptimisticThreadItem(detail, action.item));
  }

  if (action.type === "removeThreadItem") {
    return withThreadDetail(
      state,
      action.threadId,
      (detail) => removeThreadItem(detail, action.turnId, action.itemId),
    );
  }

  if (action.type === "setPermissionMode") {
    return {
      ...state,
      permissionModeByProject: {
        ...state.permissionModeByProject,
        [action.projectId]: action.mode,
      },
    };
  }

  if (action.type === "resolvePlanImplementation") {
    return {
      ...state,
      planImplementationQueue: state.planImplementationQueue.filter((request) =>
        !(request.threadId === action.threadId && request.turnId === action.turnId)
      ),
      dismissedPlanImplementationTurnIdByThread: {
        ...state.dismissedPlanImplementationTurnIdByThread,
        [action.threadId]: action.turnId,
      },
    };
  }

  return state;
}
