import type { CodexItemView, CodexTurnSummary } from "../../../lib/types";

interface ThreadRoundActionVisibility {
  assistantMessageActionItemIds: Set<string>;
}

function isTranscriptMessage(item: CodexItemView): boolean {
  return item.normalizedKind === "userMessage" || item.normalizedKind === "assistantMessage";
}

function isTerminalTurn(turn: CodexTurnSummary | undefined): boolean {
  return turn !== undefined && turn.status !== "inProgress";
}

export function resolveThreadRoundActionVisibility(
  orderedItems: CodexItemView[],
  turns: CodexTurnSummary[],
): ThreadRoundActionVisibility {
  const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const finalTranscriptItemByTurn = new Map<string, CodexItemView>();

  for (const item of orderedItems) {
    if (!isTranscriptMessage(item)) continue;
    finalTranscriptItemByTurn.set(item.turnId, item);
  }

  const assistantMessageActionItemIds = new Set<string>();

  for (const [turnId, item] of finalTranscriptItemByTurn) {
    if (!isTerminalTurn(turnById.get(turnId))) continue;
    if (item.normalizedKind !== "assistantMessage") continue;

    assistantMessageActionItemIds.add(item.itemId);
  }

  return {
    assistantMessageActionItemIds,
  };
}
