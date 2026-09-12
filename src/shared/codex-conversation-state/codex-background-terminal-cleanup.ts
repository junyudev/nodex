import { produce, type Draft } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";

export function listCodexBackgroundTerminalTurnIds(
  state: CodexCanonicalConversationState,
): readonly string[] {
  const latestTurnIndex = residentConversationTurns(state).length - 1;
  return [
    ...new Set(
      residentConversationTurns(state).flatMap((turn, index) =>
        !(index === latestTurnIndex && turn.status === "inProgress") &&
        turn.turnId !== null &&
        turn.items.some(
          (item) =>
            item.type === "commandExecution" &&
            item.status === "inProgress" &&
            !(turn.interruptedCommandExecutionItemIds ?? []).includes(item.id),
        )
          ? [turn.turnId]
          : [],
      ),
    ),
  ];
}

export function mutateCodexBackgroundTerminalCleanup(
  state: Draft<CodexCanonicalConversationState>,
): void {
  const entries = residentConversationTurnEntries(state);
  for (const entry of entries) {
    const turn = conversationTurnDraft(state, entry.address)!;
    const running = turn.items.filter(
      (item) => item.type === "commandExecution" && item.status === "inProgress",
    );
    for (const item of running) {
      turn.interruptedCommandExecutionItemIds ??= [];
      if (!turn.interruptedCommandExecutionItemIds.includes(item.id))
        turn.interruptedCommandExecutionItemIds.push(item.id);
    }
  }
}
export function reduceCodexBackgroundTerminalCleanup(
  state: CodexCanonicalConversationState,
): CodexCanonicalConversationState {
  return produce(state, mutateCodexBackgroundTerminalCleanup);
}
