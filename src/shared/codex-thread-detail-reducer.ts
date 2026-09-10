import {
  canMergeSyntheticTranscriptDuplicate,
  isSyntheticCodexTranscriptEntryId,
  mergeCodexTranscriptEntry,
  resolveCodexTranscriptPrimaryIdentityKey,
  resolveCodexTranscriptTextIdentityKey,
} from "./codex-transcript-identity";
import { mergeOrderedStringIds } from "./codex-turn-order";
import type { CodexTranscriptEntry, CodexTurnSummary } from "./types";
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
      incoming.finalAssistantStartedAtMs ?? existing.finalAssistantStartedAtMs,
    startedAt: incoming.startedAt ?? existing.startedAt,
    completedAt: incoming.completedAt ?? existing.completedAt,
    durationMs: incoming.durationMs ?? existing.durationMs,
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

function normalizeTranscriptSequence(entries: CodexTranscriptEntry[]): CodexTranscriptEntry[] {
  return [...entries]
    .sort(
      (left, right) =>
        (left.sequence ?? 0) - (right.sequence ?? 0) ||
        left.createdAt - right.createdAt ||
        left.updatedAt - right.updatedAt ||
        (left.entryId ?? left.itemId).localeCompare(right.entryId ?? right.itemId),
    )
    .map((entry, index) => ({
      ...entry,
      sequence: index,
    }));
}

export function dedupeCodexTranscriptEntries(
  entries: CodexTranscriptEntry[],
): CodexTranscriptEntry[] {
  if (entries.length < 2) return normalizeTranscriptSequence(entries);

  const dedupedByPrimaryKey = new Map<string, CodexTranscriptEntry>();
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

  const registerTextKey = (entry: CodexTranscriptEntry, primaryKey: string): void => {
    const textKey = resolveCodexTranscriptTextIdentityKey(entry);
    if (!textKey) return;
    if (isSyntheticCodexTranscriptEntryId(entry.entryId ?? entry.itemId)) {
      if (!syntheticByTextKey.has(textKey)) syntheticByTextKey.set(textKey, primaryKey);
      return;
    }
    nonSyntheticByTextKey.set(textKey, primaryKey);
  };

  for (const entry of entries) {
    const primaryKey = resolveCodexTranscriptPrimaryIdentityKey(entry);
    const existingPrimary = dedupedByPrimaryKey.get(primaryKey);
    if (existingPrimary) {
      dedupedByPrimaryKey.set(primaryKey, mergeCodexTranscriptEntry(existingPrimary, entry));
      registerTextKey(entry, primaryKey);
      continue;
    }

    const textKey = resolveCodexTranscriptTextIdentityKey(entry);
    const fallbackPrimaryKey = textKey
      ? isSyntheticCodexTranscriptEntryId(entry.entryId ?? entry.itemId)
        ? nonSyntheticByTextKey.get(textKey)
        : syntheticByTextKey.get(textKey)
      : undefined;

    if (!fallbackPrimaryKey) {
      dedupedByPrimaryKey.set(primaryKey, entry);
      registerTextKey(entry, primaryKey);
      continue;
    }

    const fallback = dedupedByPrimaryKey.get(fallbackPrimaryKey);
    if (!fallback || !canMergeSyntheticTranscriptDuplicate(fallback, entry)) {
      dedupedByPrimaryKey.set(primaryKey, entry);
      registerTextKey(entry, primaryKey);
      continue;
    }

    const merged = mergeCodexTranscriptEntry(fallback, entry);
    const fallbackIsSynthetic = isSyntheticCodexTranscriptEntryId(
      fallback.entryId ?? fallback.itemId,
    );
    const incomingIsSynthetic = isSyntheticCodexTranscriptEntryId(entry.entryId ?? entry.itemId);
    const keepPrimaryKey =
      fallbackIsSynthetic && !incomingIsSynthetic ? primaryKey : fallbackPrimaryKey;

    if (keepPrimaryKey !== fallbackPrimaryKey) {
      dedupedByPrimaryKey.delete(fallbackPrimaryKey);
      remapTextIndexes(fallbackPrimaryKey, keepPrimaryKey);
    }
    dedupedByPrimaryKey.set(keepPrimaryKey, merged);
    registerTextKey(merged, keepPrimaryKey);
  }

  return normalizeTranscriptSequence(Array.from(dedupedByPrimaryKey.values()));
}

export function upsertCodexTranscriptEntry(
  transcript: CodexTranscriptEntry[],
  entry: CodexTranscriptEntry,
): CodexTranscriptEntry[] {
  const existingIndex = transcript.findIndex((candidate) =>
    canMergeSyntheticTranscriptDuplicate(candidate, entry),
  );
  if (existingIndex < 0) {
    return dedupeCodexTranscriptEntries([...transcript, entry]);
  }

  const merged = [...transcript];
  merged[existingIndex] = mergeCodexTranscriptEntry(transcript[existingIndex], entry);
  return dedupeCodexTranscriptEntries(merged);
}

export function mergeCodexTranscriptSnapshots(
  existingTranscript: CodexTranscriptEntry[],
  incomingTranscript: CodexTranscriptEntry[],
): CodexTranscriptEntry[] {
  return dedupeCodexTranscriptEntries([...existingTranscript, ...incomingTranscript]);
}

export function applyCodexTranscriptDelta(
  transcript: CodexTranscriptEntry[],
  input: {
    threadId: string;
    turnId: string;
    entryId: string;
    delta: string;
    updatedAt?: number;
  },
): CodexTranscriptEntry[] {
  return normalizeTranscriptSequence(
    transcript.map((entry) =>
      entry.threadId === input.threadId &&
      entry.turnId === input.turnId &&
      (entry.entryId ?? entry.itemId) === input.entryId
        ? {
            ...entry,
            markdownText: `${entry.markdownText ?? ""}${input.delta}`,
            updatedAt: input.updatedAt ?? Date.now(),
          }
        : entry,
    ),
  );
}
