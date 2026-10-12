import { produce, type Draft } from "immer";
import type { CodexHistoryViewportBoundary } from "../codex-history-policy";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";

export const CODEX_ACTIVE_HISTORY_EVICTION_TRIGGER_ITEMS = 1_000;
export const CODEX_ACTIVE_HISTORY_EVICTION_TARGET_ITEMS = 500;
export const CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "todo-list",
  "plan",
  "planImplementation",
  "error",
  "automaticApprovalReview",
  "strictReviewNotice",
  "remoteTaskCreated",
  "personalityChanged",
  "forkedFromConversation",
  "worktreeInit",
  "modelChanged",
  "modelRerouted",
  "mcpServerElicitation",
  "userInputResponse",
  "permissionRequest",
  "steered",
  "steeringUserMessage",
]);

export interface CodexActiveHistoryEvictionOptions {
  readonly viewports: readonly (CodexHistoryViewportBoundary | null)[];
  readonly supportsThreadItemAnchors: boolean;
  readonly supportsPaginatedThreadHistory: boolean;
  readonly isFollower: boolean;
  readonly hasFollowersOrPendingReconnect: boolean;
  readonly readEnabled: () => boolean | null | undefined;
}
export interface CodexActiveHistoryEvictionCut {
  readonly entityKey: string;
  readonly count: number;
}

function isEligible(
  state: CodexCanonicalConversationState | null,
): state is CodexCanonicalConversationState & {
  readonly turnHistory: NonNullable<CodexCanonicalConversationState["turnHistory"]>;
} {
  if (!state || !state.rolloutPath || state.ephemeral || state.resumeState !== "resumed")
    return false;
  const history = state.turnHistory;
  if (!history || history.history.islands.length !== 1 || state.turns.length !== 0) return false;
  if (
    (state as CodexCanonicalConversationState & { readonly itemTimeline?: unknown }).itemTimeline !=
      null ||
    (state.turnsPagination?.source as string | undefined) === "timeline" ||
    state.turnsPagination?.isLoadingOlder
  )
    return false;
  if (state.requests.some((request) => !("completed" in request && request.completed)))
    return false;
  return Object.values(history.history.entitiesByKey).every(
    (turn) =>
      !turn.itemsPagination?.isLoadingOlder &&
      turn.itemsPagination?.summaryItemIds == null &&
      turn.itemsPagination?.reconnect == null,
  );
}

export function isCodexActiveHistoryItemEvictable(
  turn: CodexCanonicalTurnState,
  index: number,
): boolean {
  const item = turn.items[index];
  if (
    !item ||
    CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES.has(item.type) ||
    item.type === "autoReviewInterruptionWarning"
  )
    return false;
  if (
    ("status" in item && item.status === "inProgress") ||
    ("completed" in item && item.completed === false)
  )
    return false;
  return turn.status !== "inProgress" || turn.completedItemIds?.[item.id] === true;
}

/** Selects one safe oldest prefix. It never skips an unsafe item to reclaim a later one. */
export function planCodexActiveHistoryEviction(
  state: CodexCanonicalConversationState | null,
  options: CodexActiveHistoryEvictionOptions,
): readonly CodexActiveHistoryEvictionCut[] | null {
  if (
    options.isFollower ||
    options.hasFollowersOrPendingReconnect ||
    options.viewports.length === 0 ||
    options.viewports.includes(null) ||
    !options.supportsThreadItemAnchors ||
    !options.supportsPaginatedThreadHistory ||
    !isEligible(state)
  )
    return null;
  const history = state.turnHistory.history;
  const entries = history.islands[0]!.entries;
  const turns = entries.map(({ value }) => history.entitiesByKey[value]);
  if (turns.some((turn) => !turn)) return null;
  let itemCount = turns.reduce((count, turn) => count + turn!.items.length, 0);
  if (
    itemCount <= CODEX_ACTIVE_HISTORY_EVICTION_TRIGGER_ITEMS ||
    !options.viewports.every((boundary) =>
      turns.some((turn) => turn!.turnId === boundary?.oldestRenderedTurnId),
    )
  )
    return null;
  const cuts: CodexActiveHistoryEvictionCut[] = [];
  for (const { value: entityKey } of entries) {
    const turn = history.entitiesByKey[entityKey]!;
    if (turn.turnId === null) break;
    const boundaries = options.viewports.filter(
      (boundary) => boundary?.oldestRenderedTurnId === turn.turnId,
    );
    const protectedTurn = boundaries.length > 0;
    const protectedIndex = Math.min(
      turn.items.length,
      ...boundaries.map((boundary) =>
        boundary!.firstProtectedItemId === null
          ? 0
          : turn.items.findIndex((item) => item?.id === boundary!.firstProtectedItemId),
      ),
    );
    if (protectedIndex < 0) break;
    let count = 0;
    while (
      count < protectedIndex &&
      itemCount > CODEX_ACTIVE_HISTORY_EVICTION_TARGET_ITEMS &&
      isCodexActiveHistoryItemEvictable(turn, count)
    ) {
      count += 1;
      itemCount -= 1;
    }
    // Keep the context item immediately preceding an unsafe item.
    if (count > 0 && turn.items[count] != null && !isCodexActiveHistoryItemEvictable(turn, count)) {
      count -= 1;
      itemCount += 1;
    }
    if (count > 0) cuts.push({ entityKey, count });
    if (count < turn.items.length || protectedTurn) break;
  }
  return cuts.length > 0 && options.readEnabled() === true ? cuts : null;
}

/** Applies retention to the same canonical recipe as completion and hydration mutations. */
export function mutateCodexActiveHistoryEviction(
  state: Draft<CodexCanonicalConversationState>,
  options: CodexActiveHistoryEvictionOptions,
): readonly CodexActiveHistoryEvictionCut[] {
  const cuts = planCodexActiveHistoryEviction(state, options);
  if (!cuts || !state.turnHistory) return [];
  for (const { entityKey, count } of cuts) {
    const turn = state.turnHistory.history.entitiesByKey[entityKey]!;
    const removed = turn.items.splice(0, count);
    for (const item of removed) if (item) delete turn.completedItemIds?.[item.id];
    turn.itemsPagination = {
      ...turn.itemsPagination,
      itemsView: turn.itemsPagination?.itemsView ?? turn.itemsView,
      olderCursor: null,
      olderItemId: turn.items[0]?.id,
      evicted: true,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      summaryItemIds: undefined,
      reconnect: undefined,
    } as Draft<NonNullable<CodexCanonicalTurnState["itemsPagination"]>> & {
      olderItemId: string | undefined;
      evicted: boolean;
    };
  }
  return cuts;
}

export function evictCodexActiveHistory(
  state: CodexCanonicalConversationState,
  options: CodexActiveHistoryEvictionOptions,
): CodexCanonicalConversationState {
  return produce(state, (draft) => {
    mutateCodexActiveHistoryEviction(draft, options);
  });
}
