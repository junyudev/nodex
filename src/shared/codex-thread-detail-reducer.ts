import { mergeOrderedStringIds } from "./codex-turn-order";
import type { CodexTurnSummary } from "./types";
import { buildCodexTurnOccurrenceKey } from "./codex-turn-identity";

export function mergeCodexTurnSummary(
  existing: CodexTurnSummary,
  incoming: CodexTurnSummary,
): CodexTurnSummary {
  return {
    ...existing,
    ...incoming,
    errorMessage: incoming.errorMessage ?? existing.errorMessage,
    turnStartedAtMs: incoming.turnStartedAtMs ?? existing.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs:
      incoming.firstTurnWorkItemStartedAtMs ?? existing.firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs:
      incoming.finalAssistantStartedAtMs === undefined
        ? existing.finalAssistantStartedAtMs
        : incoming.finalAssistantStartedAtMs,
    assistantResponseWorkDurationMs:
      incoming.assistantResponseWorkDurationMs === undefined
        ? existing.assistantResponseWorkDurationMs
        : incoming.assistantResponseWorkDurationMs,
    startedAt: incoming.startedAt ?? existing.startedAt,
    completedAt: incoming.completedAt ?? existing.completedAt,
    durationMs: incoming.durationMs ?? existing.durationMs,
    assistantMessageStartedAtMsById:
      existing.assistantMessageStartedAtMsById === undefined
        ? incoming.assistantMessageStartedAtMsById
        : incoming.assistantMessageStartedAtMsById === undefined
          ? existing.assistantMessageStartedAtMsById
          : {
              ...incoming.assistantMessageStartedAtMsById,
              ...existing.assistantMessageStartedAtMsById,
            },
    commandExecutionStartedAtMsById:
      existing.commandExecutionStartedAtMsById ?? incoming.commandExecutionStartedAtMsById,
    itemIds: mergeOrderedStringIds(existing.itemIds, incoming.itemIds),
    interruptedCommandExecutionItemIds: mergeOrderedStringIds(
      existing.interruptedCommandExecutionItemIds ?? [],
      incoming.interruptedCommandExecutionItemIds ?? [],
    ),
    entityKey: incoming.entityKey ?? existing.entityKey,
    tokenUsage: incoming.tokenUsage ?? existing.tokenUsage,
  };
}

export function mergeCodexTurnSummaries(
  incomingTurns: CodexTurnSummary[],
  cachedTurns: CodexTurnSummary[],
): CodexTurnSummary[] {
  if (cachedTurns.length === 0) return incomingTurns;
  if (incomingTurns.length === 0) return cachedTurns;

  const cachedByTurnId = new Map(
    cachedTurns.map((turn, turnIndex) => [
      buildCodexTurnOccurrenceKey(turn.turnId, turnIndex, turn.entityKey),
      turn,
    ]),
  );
  const seen = new Set<string>();

  const merged = incomingTurns.map((turn, turnIndex) => {
    const turnKey = buildCodexTurnOccurrenceKey(turn.turnId, turnIndex, turn.entityKey);
    seen.add(turnKey);
    const cached = cachedByTurnId.get(turnKey);
    if (!cached) return turn;
    return mergeCodexTurnSummary(cached, turn);
  });

  for (const [turnIndex, cached] of cachedTurns.entries()) {
    if (seen.has(buildCodexTurnOccurrenceKey(cached.turnId, turnIndex, cached.entityKey))) continue;
    merged.push(cached);
  }

  return merged;
}
