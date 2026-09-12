import type { CodexHistoryTurnItemsPagination } from "./codex-history-topology";
import type { ThreadItem, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalItem,
  CodexCanonicalTurnState,
  CodexCanonicalSteeringUserMessageItem,
  CodexCanonicalSteeredItem,
} from "./codex-conversation-state";
import { buildCodexSteeringCompareKey } from "./codex-steering-compare";
import { upsertCodexCanonicalItemById } from "./codex-turn-mutation";
import { areStructurallyEqual } from "../structural-equality";
function isMatchingPendingSteer(
  item: CodexCanonicalItem,
  clientUserMessageId: string | null,
  content: readonly UserInput[],
  turn: CodexCanonicalTurnState,
): item is CodexCanonicalSteeringUserMessageItem {
  if (item.type !== "steeringUserMessage" || item.serverUserMessageId != null) {
    return false;
  }

  const matchesTurn =
    item.targetTurnId === null
      ? item.targetTurnStartedAtMs !== null && item.targetTurnStartedAtMs === turn.turnStartedAtMs
      : item.targetTurnId === turn.turnId ||
        /^(.*)-berry-display-\d+$/.exec(turn.turnId ?? "")?.[1] === item.targetTurnId;
  if (!matchesTurn) {
    return false;
  }

  if (clientUserMessageId !== null && item.clientUserMessageId !== null) {
    return item.clientUserMessageId === clientUserMessageId;
  }

  const compareKey = buildCodexSteeringCompareKey(
    content,
    item.restoreMessage.context.commentAttachments,
  );
  return (
    item.compareKey.rawText === compareKey.rawText &&
    item.compareKey.imageCount === compareKey.imageCount
  );
}

export function findMatchingPendingSteerIndex(
  items: readonly CodexCanonicalItem[],
  clientUserMessageId: string | null,
  content: readonly UserInput[],
  turn: CodexCanonicalTurnState,
): number {
  if (clientUserMessageId !== null) {
    const exactIndex = items.findIndex(
      (item) =>
        item.type === "steeringUserMessage" &&
        item.clientUserMessageId === clientUserMessageId &&
        isMatchingPendingSteer(item, clientUserMessageId, content, turn),
    );
    if (exactIndex >= 0) return exactIndex;
  }
  return items.findIndex((item) =>
    isMatchingPendingSteer(item, clientUserMessageId, content, turn),
  );
}

export function acceptPendingSteer(
  turn: CodexCanonicalTurnState,
  pendingIndex: number,
  completedItemId: string,
): CodexCanonicalTurnState {
  const pending = turn.items[pendingIndex];
  if (pending?.type !== "steeringUserMessage") {
    return turn;
  }

  const itemsWithAcceptedSteer = [...turn.items];
  itemsWithAcceptedSteer[pendingIndex] = {
    ...pending,
    status: "accepted",
    serverUserMessageId: completedItemId,
  } satisfies CodexCanonicalSteeringUserMessageItem;
  const steeredItem = {
    type: "steered",
    id: completedItemId,
  } satisfies CodexCanonicalSteeredItem;

  const echoIndex = itemsWithAcceptedSteer.findIndex((item) => item.id === completedItemId);
  if (echoIndex >= 0 && pendingIndex > echoIndex) {
    itemsWithAcceptedSteer.splice(echoIndex, 0, ...itemsWithAcceptedSteer.splice(pendingIndex, 1));
  }
  return { ...turn, items: upsertCodexCanonicalItemById(itemsWithAcceptedSteer, steeredItem) };
}

const openingPrefixTypes = new Set([
  "automaticApprovalReview",
  "contextCompaction",
  "forkedFromConversation",
  "modelChanged",
  "modelRerouted",
  "personalityChanged",
  "remoteTaskCreated",
  "steeringUserMessage",
  "worktreeInit",
]);

function isOpeningMessage(
  turn: CodexCanonicalTurnState,
  message: Extract<
    ThreadItem,
    {
      type: "userMessage";
    }
  >,
  pagination?: CodexHistoryTurnItemsPagination,
): boolean {
  if (pagination?.openingUserMessageId !== undefined)
    return message.id === pagination.openingUserMessageId;
  const clientId = turn.params.clientUserMessageId;
  if (message.clientId !== null && clientId != null) return message.clientId === clientId;
  if (
    pagination?.hasLoadedOldest === false ||
    !areStructurallyEqual(message.content, turn.params.input)
  )
    return false;
  const index = turn.items.findIndex((item) => item.id === message.id);
  return turn.items.slice(0, index).every((item) => openingPrefixTypes.has(item.type));
}

/** Reconciles persisted echoes after merging a Turn that still contains local steering rows. */
export function reconcileCodexHydratedSteering(
  turn: CodexCanonicalTurnState,
  pagination?: CodexHistoryTurnItemsPagination,
): CodexCanonicalTurnState {
  const pending = turn.items.filter(
    (item): item is CodexCanonicalSteeringUserMessageItem =>
      item.type === "steeringUserMessage" && item.serverUserMessageId == null,
  );
  if (pending.length === 0) return turn;
  let result = turn;
  for (const item of turn.items) {
    if (item.type !== "userMessage" || item.clientId === null) continue;
    if (!pending.some((steer) => steer.clientUserMessageId === item.clientId)) continue;
    if (
      result.items.some(
        (steer) => steer.type === "steeringUserMessage" && steer.serverUserMessageId === item.id,
      )
    )
      continue;
    if (isOpeningMessage(result, item, pagination)) continue;
    const index = findMatchingPendingSteerIndex(result.items, item.clientId, item.content, result);
    if (index >= 0) result = acceptPendingSteer(result, index, item.id);
  }
  return result;
}

/** Moves steering rows to a newly resident target before reconciling that target's echoes. */
export function relocateCodexHydratedSteering(
  turns: readonly CodexCanonicalTurnState[],
  getPagination?: (turnId: string | null) => CodexHistoryTurnItemsPagination | undefined,
): CodexCanonicalTurnState[] {
  const result = turns.map((turn) => ({ ...turn }));
  const byId = new Map(result.map((turn) => [turn.turnId, turn]));
  const targets = new Set<CodexCanonicalTurnState>();
  for (const turn of result) {
    const items = turn.items.filter((item) => {
      if (item.type !== "steeringUserMessage" || item.targetTurnId === null) return true;
      const target = byId.get(item.targetTurnId);
      if (!target || target === turn) return true;
      target.items = upsertCodexCanonicalItemById(target.items, item);
      targets.add(target);
      return false;
    });
    if (items.length !== turn.items.length) turn.items = items;
  }
  return result.map((turn, index) => {
    const reconciled = targets.has(turn)
      ? reconcileCodexHydratedSteering(turn, getPagination?.(turn.turnId))
      : turn;
    return reconciled.items === turns[index]!.items ? turns[index]! : reconciled;
  });
}
