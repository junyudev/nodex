import type { ThreadSearchOccurrence } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexPersistedHistoryOccurrenceHydrateInput,
  CodexPersistedHistorySearchPage,
} from "../../../../shared/codex-persisted-history-search";
import type {
  ContentSearchLocalMatch,
  ContentSearchLocalResult,
} from "../../content-search/content-search-context";
import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadSearchUnitModel } from "../thread-stage-types";

export interface LocalConversationPersistedSearchMatchMeta extends CodexPersistedHistoryOccurrenceHydrateInput {
  readonly kind: "persisted";
  readonly query: string;
  readonly itemOccurrenceIndex: number;
}

export interface LocalConversationSearchTarget {
  readonly turnKey: string;
  readonly unitKey: string;
  readonly occurrenceIndex: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function isLocalConversationPersistedSearchMatchMeta(
  value: unknown,
): value is LocalConversationPersistedSearchMatchMeta {
  if (!isRecord(value) || value.kind !== "persisted") return false;
  const occurrence = value.occurrence;
  return (
    typeof value.threadId === "string" &&
    typeof value.hostId === "string" &&
    typeof value.query === "string" &&
    Number.isSafeInteger(value.itemOccurrenceIndex) &&
    (value.itemOccurrenceIndex as number) >= 0 &&
    typeof value.hostGeneration === "number" &&
    typeof value.topologyGeneration === "number" &&
    isRecord(occurrence) &&
    typeof occurrence.turnId === "string" &&
    typeof occurrence.itemId === "string" &&
    typeof occurrence.snippet === "string" &&
    typeof occurrence.turnCursor === "string"
  );
}

export function projectLocalConversationPersistedSearchResult(input: {
  readonly page: CodexPersistedHistorySearchPage;
  readonly contextId: string;
  readonly limit: number;
}): ContentSearchLocalResult {
  const occurrences = input.page.occurrences.slice(0, Math.max(0, input.limit));
  const itemOccurrenceCounts = new Map<string, number>();
  const matches: ContentSearchLocalMatch[] = occurrences.map((occurrence, ordinal) => {
    const itemKey = JSON.stringify([occurrence.turnId, occurrence.itemId]);
    const itemOccurrenceIndex = itemOccurrenceCounts.get(itemKey) ?? 0;
    itemOccurrenceCounts.set(itemKey, itemOccurrenceIndex + 1);
    return {
      id: `conversation:persisted:${JSON.stringify([
        input.page.hostId,
        input.page.hostGeneration,
        occurrence.turnId,
        occurrence.itemId,
        itemOccurrenceIndex,
        occurrence.snippetMatchRange.start,
        occurrence.snippetMatchRange.end,
      ])}`,
      domain: "conversation",
      contextId: input.contextId,
      ordinal,
      label: occurrence.snippet,
      meta: {
        kind: "persisted",
        query: input.page.query,
        itemOccurrenceIndex,
        threadId: input.page.threadId,
        hostId: input.page.hostId,
        hostGeneration: input.page.hostGeneration,
        topologyGeneration: input.page.topologyGeneration,
        occurrence,
      } satisfies LocalConversationPersistedSearchMatchMeta,
    };
  });
  return {
    query: input.page.query,
    matches,
    totalMatches: matches.length,
    capped: input.page.capped || input.page.occurrences.length > occurrences.length,
  };
}

const isUserMessageItem = (item: VisibleConversationTurnEntry["turn"]["items"][number]): boolean =>
  item.role === "user" || item.kind === "userMessage" || item.semanticKind === "userMessage";

const countOccurrencesBefore = (text: string, query: string, endOffset: number): number => {
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < Math.min(endOffset, haystack.length)) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1 || index >= endOffset) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
};

const matchingOffsets = (text: string, needle: string): number[] => {
  const haystack = text.toLocaleLowerCase();
  const normalizedNeedle = needle.toLocaleLowerCase();
  if (!normalizedNeedle) return [];
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - normalizedNeedle.length) {
    const offset = haystack.indexOf(normalizedNeedle, cursor);
    if (offset === -1) break;
    offsets.push(offset);
    cursor = offset + normalizedNeedle.length;
  }
  return offsets;
};

const sharedContextLength = (left: string, right: string, fromEnd: boolean): number => {
  const normalizedLeft = left.toLocaleLowerCase();
  const normalizedRight = right.toLocaleLowerCase();
  const limit = Math.min(normalizedLeft.length, normalizedRight.length);
  let count = 0;
  while (count < limit) {
    const leftIndex = fromEnd ? normalizedLeft.length - count - 1 : count;
    const rightIndex = fromEnd ? normalizedRight.length - count - 1 : count;
    if (normalizedLeft[leftIndex] !== normalizedRight[rightIndex]) break;
    count += 1;
  }
  return count;
};

const targetOffset = (
  unitText: string,
  occurrence: ThreadSearchOccurrence,
  itemOccurrenceIndex: number,
): number | null => {
  const normalizedUnit = unitText.toLocaleLowerCase();
  const normalizedSnippet = occurrence.snippet.toLocaleLowerCase();
  const snippetOffsets = matchingOffsets(normalizedUnit, normalizedSnippet);
  if (snippetOffsets.length > 0) {
    const snippetOffset = snippetOffsets[itemOccurrenceIndex] ?? snippetOffsets[0]!;
    return snippetOffset + occurrence.snippetMatchRange.start;
  }

  const matchedText = occurrence.snippet.slice(
    occurrence.snippetMatchRange.start,
    occurrence.snippetMatchRange.end,
  );
  const offsets = matchingOffsets(unitText, matchedText);
  if (offsets.length === 0) return null;
  if (offsets.length === 1) return offsets[0]!;

  const snippetPrefix = occurrence.snippet.slice(0, occurrence.snippetMatchRange.start);
  const snippetSuffix = occurrence.snippet.slice(occurrence.snippetMatchRange.end);
  const scored = offsets.map((offset) => {
    const prefix = unitText.slice(0, offset);
    const suffix = unitText.slice(offset + matchedText.length);
    const score =
      sharedContextLength(prefix, snippetPrefix, true) +
      sharedContextLength(suffix, snippetSuffix, false);
    return { offset, score };
  });
  const bestScore = Math.max(...scored.map(({ score }) => score));
  const best = scored.filter(({ score }) => score === bestScore);
  return (best[itemOccurrenceIndex] ?? best[0])?.offset ?? null;
};

/** Resolves the exact hydrated item to the renderer's grouped search unit and mark ordinal. */
export function resolveLocalConversationPersistedSearchTarget(input: {
  readonly entry: VisibleConversationTurnEntry;
  readonly occurrence: ThreadSearchOccurrence;
  readonly itemOccurrenceIndex: number;
  readonly query: string;
  readonly units: readonly ThreadSearchUnitModel[];
}): LocalConversationSearchTarget | null {
  const itemIndex = input.entry.turn.items.findIndex(
    (item) => item.itemId === input.occurrence.itemId || item.rawItemId === input.occurrence.itemId,
  );
  if (itemIndex === -1) return null;
  const item = input.entry.turn.items[itemIndex]!;
  const blockType = isUserMessageItem(item) ? "userMessage" : "assistantMessage";
  const candidates = input.units.filter((unit) => unit.blockType === blockType);
  if (candidates.length === 0) return null;
  let unit = candidates[0]!;
  if (blockType === "userMessage") {
    const userOrdinal = input.entry.turn.items.slice(0, itemIndex).filter(isUserMessageItem).length;
    unit = candidates[userOrdinal] ?? unit;
  }
  const offset = targetOffset(unit.text, input.occurrence, input.itemOccurrenceIndex);
  const occurrenceIndex =
    offset === null
      ? countOccurrencesBefore(
          input.occurrence.snippet,
          input.query,
          input.occurrence.snippetMatchRange.start,
        )
      : countOccurrencesBefore(unit.text, input.query, offset);
  return {
    turnKey: input.entry.turnKey,
    unitKey: unit.key,
    occurrenceIndex,
  };
}
