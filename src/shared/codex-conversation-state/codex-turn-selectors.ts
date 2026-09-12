import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";

type ConversationTurns = Pick<CodexCanonicalConversationState, "turns" | "turnHistory">;

function findLatestConversationTurn(
  conversation: ConversationTurns | null | undefined,
  matches: (turn: CodexCanonicalTurnState) => boolean,
): CodexCanonicalTurnState | null {
  if (!conversation) return null;
  const history = conversation.turnHistory?.history;
  if (!history) return conversation.turns.findLast(matches) ?? null;

  const tail = history.islands.at(-1);
  const findInEntries = (entries: readonly { value: string }[]) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const turn = history.entitiesByKey[entries[index]!.value];
      if (turn && matches(turn)) return turn;
    }
    return null;
  };
  if (tail?.newerBoundary.status === "exhausted") {
    const latest = findInEntries(tail.entries);
    if (latest) return latest;
  }
  for (let index = history.islands.length - 1; index >= 0; index--) {
    const latest = findInEntries(history.islands[index]!.entries);
    if (latest) return latest;
  }
  return null;
}

/** Completed local markers do not replace the latest execution Turn. */
export function latestConversationTurn(
  conversation: ConversationTurns | null | undefined,
): CodexCanonicalTurnState | null {
  return findLatestConversationTurn(
    conversation,
    (turn) => turn.turnId !== null || turn.status !== "completed",
  );
}

/** Latest resident Turn, including completed local marker Turns. */
export function latestResidentConversationTurn(
  conversation: ConversationTurns | null | undefined,
): CodexCanonicalTurnState | null {
  return findLatestConversationTurn(conversation, () => true);
}

/** Resume settings come from a resident native Turn, excluding unassigned submissions. */
export function latestAssignedConversationTurn(
  conversation: ConversationTurns | null | undefined,
): CodexCanonicalTurnState | null {
  return findLatestConversationTurn(conversation, (turn) => turn.turnId !== null);
}

export function hasPendingConversationTurnStart(
  conversation:
    | (ConversationTurns & Pick<CodexCanonicalConversationState, "unconfirmedTurnSubmissions">)
    | null
    | undefined,
): boolean {
  if (!conversation) return false;
  const turn = latestConversationTurn(conversation);
  return (
    (turn?.status === "inProgress" && turn.turnId === null) ||
    (conversation.unconfirmedTurnSubmissions?.length ?? 0) > 0
  );
}
