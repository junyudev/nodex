import type {
  CodexCanonicalConversationState,
  CodexCanonicalSteeringUserMessageItem,
} from "./codex-conversation-state";
import { upsertCodexCanonicalItemById } from "./codex-turn-mutation";

export function upsertCodexCanonicalSteeringItem(
  state: CodexCanonicalConversationState,
  turnId: string,
  item: CodexCanonicalSteeringUserMessageItem,
): CodexCanonicalConversationState {
  const turnIndex = state.turns.findIndex((turn) => turn.protocol.id === turnId);
  const turn = state.turns[turnIndex];
  if (!turn) return state;

  const items = upsertCodexCanonicalItemById(turn.items, item);
  if (items === turn.items) return state;

  const turns = [...state.turns];
  turns[turnIndex] = { ...turn, items };
  return { ...state, turns };
}

export function removeCodexCanonicalSteeringItem(
  state: CodexCanonicalConversationState,
  turnId: string,
  itemId: string,
): CodexCanonicalConversationState {
  const turnIndex = state.turns.findIndex(
    (turn) =>
      turn.items.some((item) => item.id === itemId && item.type === "steeringUserMessage") &&
      (turn.protocol.id === turnId ||
        turn.sidecar.entityKey === turnId ||
        turn.items.some(
          (item) =>
            item.id === itemId &&
            item.type === "steeringUserMessage" &&
            item.targetTurnId === turnId,
        )),
  );
  const turn = state.turns[turnIndex];
  if (!turn) return state;

  const items = turn.items.filter((item) => item.id !== itemId);
  if (items.length === turn.items.length) return state;

  const turns = [...state.turns];
  turns[turnIndex] = { ...turn, items };
  return { ...state, turns };
}

export function retargetCodexCanonicalSteeringItem(
  state: CodexCanonicalConversationState,
  fromTurnId: string,
  toTurnId: string,
  itemId: string,
): CodexCanonicalConversationState {
  if (fromTurnId === toTurnId) return state;

  const sourceTurnIndex = state.turns.findIndex((turn) => turn.protocol.id === fromTurnId);
  const sourceTurn = state.turns[sourceTurnIndex];
  if (!sourceTurn) return state;

  const item = sourceTurn.items.find(
    (candidate): candidate is CodexCanonicalSteeringUserMessageItem =>
      candidate.type === "steeringUserMessage" && candidate.id === itemId,
  );
  if (!item) return state;

  const targetTurnIndex = state.turns.findIndex((turn) => turn.protocol.id === toTurnId);
  const targetTurn = state.turns[targetTurnIndex];
  if (!targetTurn) {
    // The server can correct the ID of the active Turn before any history hydration does.
    // Keep its questions and local state on the same Turn rather than dropping the pending reply.
    const retainsDisplayId = /^(.*)-berry-display-\d+$/.exec(fromTurnId)?.[1] === toTurnId;
    const protocol =
      sourceTurn.protocol.status === "inProgress" && !retainsDisplayId
        ? { ...sourceTurn.protocol, id: toTurnId }
        : sourceTurn.protocol;
    const sourceItems = sourceTurn.items.map((candidate) =>
      candidate.type === "steeringUserMessage" && candidate.targetTurnId === fromTurnId
        ? { ...candidate, targetTurnId: toTurnId }
        : candidate,
    );
    const turns = [...state.turns];
    turns[sourceTurnIndex] = {
      ...sourceTurn,
      protocol,
      items: sourceItems,
      sidecar: { ...sourceTurn.sidecar, entityKey: sourceTurn.sidecar.entityKey ?? fromTurnId },
    };
    return { ...state, turns };
  }

  const sourceItems = sourceTurn.items.filter((candidate) => candidate.id !== itemId);
  const retargetedItem: CodexCanonicalSteeringUserMessageItem = {
    ...item,
    targetTurnId: toTurnId,
    targetTurnStartedAtMs: targetTurn.sidecar.turnStartedAtMs,
  };
  const targetItems = upsertCodexCanonicalItemById(targetTurn.items, retargetedItem);
  const turns = [...state.turns];
  turns[sourceTurnIndex] = { ...sourceTurn, items: sourceItems };
  turns[targetTurnIndex] = { ...targetTurn, items: targetItems };
  return { ...state, turns };
}

/** A command ACK accepts the row; a completed server echo binds its separate server identity. */
export function acknowledgeCodexCanonicalSteeringItem(
  state: CodexCanonicalConversationState,
  itemId: string,
): CodexCanonicalConversationState {
  const turnIndex = state.turns.findIndex((turn) =>
    turn.items.some(
      (item) =>
        item.type === "steeringUserMessage" && item.id === itemId && item.status !== "accepted",
    ),
  );
  const turn = state.turns[turnIndex];
  if (!turn) return state;
  const items = turn.items.map((item) =>
    item.type === "steeringUserMessage" && item.id === itemId
      ? { ...item, status: "accepted" as const }
      : item,
  );
  const turns = [...state.turns];
  turns[turnIndex] = { ...turn, items };
  return { ...state, turns };
}
