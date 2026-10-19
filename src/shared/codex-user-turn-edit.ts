import type { CodexConversationSnapshot, CodexConversationTurn } from "./types";

/** The Turn facts that decide whether its user message can be rewritten. */
export interface EditableUserTurnCandidate {
  readonly turnId: string | null;
  readonly status: CodexConversationTurn["status"];
  readonly hasUserMessage: boolean;
}

const NO_EDITABLE_TURNS: ReadonlySet<string> = new Set();

export function codexConversationTurnHasUserMessage(
  turn: Pick<CodexConversationTurn, "items">,
): boolean {
  return turn.items.some(
    (item) => item.kind === "userMessage" || item.semanticKind === "userMessage",
  );
}

/**
 * Editing a user message rewinds the conversation to just before its Turn and sends the
 * rewritten message as a new Turn, so any Turn that carries a user message can be edited. The
 * rewind also discards every later Turn, so nothing is editable while any Turn still runs.
 */
export function resolveEditableUserTurnIds(
  turns: readonly EditableUserTurnCandidate[],
): ReadonlySet<string> {
  if (turns.some((turn) => turn.status === "inProgress")) return NO_EDITABLE_TURNS;
  const editable = new Set<string>();
  for (const turn of turns)
    if (turn.turnId !== null && turn.hasUserMessage) editable.add(turn.turnId);
  return editable.size === 0 ? NO_EDITABLE_TURNS : editable;
}

/**
 * Whether a native conversation can rewrite its sent messages now. The rewind needs persistent
 * paginated history, and a pending request means a Turn is still waiting on the user.
 */
export function canEditCodexConversationUserTurns(
  conversation: Pick<
    CodexConversationSnapshot,
    "archived" | "statusType" | "canonicalState" | "source" | "turns"
  >,
  requests: readonly unknown[],
): boolean {
  if (conversation.source?.sideConversation === true) return false;
  if (conversation.archived || conversation.statusType === "systemError") return false;
  if (conversation.canonicalState?.historyMode !== "paginated") return false;
  if (conversation.canonicalState.ephemeral || requests.length > 0) return false;
  return (
    resolveEditableUserTurnIds(
      conversation.turns.map((turn) => ({
        turnId: turn.turnId,
        status: turn.status,
        hasUserMessage: codexConversationTurnHasUserMessage(turn),
      })),
    ).size > 0
  );
}
