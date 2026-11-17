import {
  type SearchMatchQuality,
  type SearchTextKind,
  type SearchTextMatch,
} from "@nodex/search-kernel";
import { searchKernel, type SearchTextQuery } from "@nodex/search-kernel/node";
import { searchableMessageText } from "@nodex/runtime-shared/searchableMessageText";
import type { SearchRange } from "@nodex/runtime-shared/paletteSearch";

export const SEARCH_FIELD = { title: 0, metadata: 1, message: 2, action: 3 } as const;
export type SearchField = keyof typeof SEARCH_FIELD;
const FIELD_COUNT = Object.keys(SEARCH_FIELD).length;
const MATCH_CLASSES = ["exact", "prefix", "joined", "stem", "typo", "infix"] as const;
const ranks = new Map<SearchField, Map<SearchMatchQuality, number>>();
export const fieldRank = (quality: SearchMatchQuality, field: SearchField): number => {
  let rank = ranks.get(field);
  if (!rank) {
    rank = new Map(
      MATCH_CLASSES.map((kind) => [
        kind,
        searchKernel().rankMatch(kind, SEARCH_FIELD[field], FIELD_COUNT),
      ]),
    );
    ranks.set(field, rank);
  }
  return rank.get(quality)!;
};
export const STRONG_RANK_LIMIT = FIELD_COUNT * 4;
export const strongRank = (rank: number) => rank < STRONG_RANK_LIMIT;
// Keep the existing higher-is-better score representation on the two application wires.
export const rankQuality = (rank: number) => 1 - rank / 32;
export const phraseBonus = 0.25;

export { searchableMessageText };

export function matchedRanges(evidence: readonly (SearchTextMatch | null)[]): SearchRange[] {
  const ranges = evidence
    .flatMap((match) => {
      let start = 0;
      return (match?.parts ?? []).flatMap((part) => {
        const offset = start;
        start += part.text.length;
        return part.highlighted ? [{ start: offset, end: start }] : [];
      });
    })
    .sort((a, b) => a.start - b.start);
  return ranges.reduce<SearchRange[]>((merged, range) => {
    const last = merged.at(-1);
    if (last && last.end >= range.start) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
    return merged;
  }, []);
}

export function corpusHighlights(
  query: SearchTextQuery,
  text: string,
  kind: SearchTextKind,
  strongWords: readonly boolean[],
): SearchRange[] {
  const plain = query.evidence(text, kind, false).words;
  if (strongWords.every(Boolean)) return matchedRanges(plain);
  const loose = query.evidence(text, kind, true).words;
  return matchedRanges(
    plain.map((word, index) => (strongWords[index] ? word : (loose[index] ?? word))),
  );
}

const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Readable excerpt centered on the original source range returned by the kernel. */
export const messageSearchSnippet = (text: string, matchStart: number): string => {
  let start = Math.max(0, matchStart - 24);
  const wordStart = text.slice(start, matchStart).search(/\s/);
  if (start > 0 && wordStart !== -1) start += wordStart + 1;
  if (lowSurrogate(text.charCodeAt(start))) start++;
  const rawEnd = Math.min(text.length, start + 480);
  const shown = text
    .slice(start, rawEnd)
    .replace(/\*\*|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let end = Math.min(shown.length, 238);
  if (lowSurrogate(shown.charCodeAt(end))) end--;
  return `${start > 0 ? "…" : ""}${shown.slice(0, end)}${end < shown.length || rawEnd < text.length ? "…" : ""}`;
};

export function searchEvidenceExcerpt(
  text: string,
  ranges: readonly SearchRange[],
  ordered: boolean,
) {
  const first = ranges[0];
  if (!first) return null;
  const last = ranges.at(-1)!;
  const nearby = last.end - first.start <= 200;
  const focus = nearby ? first : last;
  const end = ordered && nearby ? last.end : focus.end;
  return {
    snippet: messageSearchSnippet(text, focus.start),
    matchedText: text.slice(focus.start, end),
  };
}

/** Used for passive native item reads and the catalog opening prompt. */
export function matchHistoryText(query: SearchTextQuery, text: string, allowTypo = false) {
  const field = query.evidence(text, "long_text", allowTypo);
  if (!field.words.length || field.words.some((word) => word === null)) return null;
  const rank = Math.max(...field.words.map((word) => fieldRank(word!.quality, "message")));
  const ranges = field.orderedRange ? [field.orderedRange] : matchedRanges(field.words);
  const excerpt = searchEvidenceExcerpt(text, ranges, field.ordered);
  if (!excerpt) return null;
  const wordQuality = rankQuality(rank);
  return {
    ...excerpt,
    wordQuality,
    quality: wordQuality + (field.ordered ? phraseBonus : 0),
  };
}
