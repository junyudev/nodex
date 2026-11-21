import type { FileSearchResult } from "../../shared/file-search";
import { createFuzzyQueryScorer, matchFuzzyQueryFragments } from "../../shared/fuzzy-query-match";
import type { IndexedPath } from "./workspace-file-index";

export const FILE_SEARCH_MATCH_LIMIT = 50;

interface RankedPath extends IndexedPath {
  readonly root: string;
  readonly score: number;
  readonly matchedText: string;
  readonly matchesName: boolean;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const compareMatches = (left: RankedPath, right: RankedPath) =>
  Number(right.matchesName) - Number(left.matchesName) ||
  right.score - left.score ||
  compareText(left.file_name, right.file_name) ||
  compareText(left.path, right.path) ||
  compareText(left.root, right.root);

function toResult(match: RankedPath, query: string): FileSearchResult {
  const { matchedText, matchesName, ...file } = match;
  const pathOffset = matchesName ? file.path.length - matchedText.length : 0;
  const fragments = matchFuzzyQueryFragments(matchedText, query);
  return {
    ...file,
    indices:
      fragments?.flatMap(({ startOffset, endOffset }) =>
        Array.from(
          { length: endOffset - startOffset },
          (_, index) => pathOffset + startOffset + index,
        ),
      ) ?? null,
  };
}

/**
 * The best matches for one query. Name matches rank above path matches; ties order by name,
 * path, then root, so the result does not depend on listing order.
 */
export class FileSearchRanking {
  private readonly score: (candidate: string) => number;
  private readonly pathQuery: boolean;
  private readonly top: RankedPath[] = [];
  /** The best matches changed since they were last read. */
  dirty = true;

  constructor(readonly query: string) {
    this.score = createFuzzyQueryScorer(query);
    this.pathQuery = /[/\\]/u.test(query);
  }

  get size(): number {
    return this.top.length;
  }

  scan(root: string, entries: readonly IndexedPath[], from: number, to: number): void {
    const { score, pathQuery, top } = this;
    for (let offset = from; offset < to; offset++) {
      const entry = entries[offset]!;
      const nameScore = pathQuery ? 0 : score(entry.file_name);
      const lowest = top.length === FILE_SEARCH_MATCH_LIMIT ? top.at(-1) : undefined;
      if (!pathQuery && !nameScore && (lowest?.matchesName || entry.path === entry.file_name))
        continue;
      const matchedText = nameScore ? entry.file_name : entry.path;
      const value = nameScore || score(matchedText);
      if (!value) continue;
      const match = { ...entry, root, score: value, matchedText, matchesName: nameScore > 0 };
      if (lowest && compareMatches(match, lowest) >= 0) continue;
      let position = top.length;
      while (position > 0 && compareMatches(match, top[position - 1]!) < 0) position--;
      top.splice(position, 0, match);
      if (top.length > FILE_SEARCH_MATCH_LIMIT) top.pop();
      this.dirty = true;
    }
  }

  results(): FileSearchResult[] {
    this.dirty = false;
    return this.top.map((match) => toResult(match, this.query));
  }
}
