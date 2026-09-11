import { createFuzzyQueryScorer } from "@/lib/settings-search-score";

export type ComposerContextSuggestionSection =
  | "Add"
  | "Apps"
  | "Chats"
  | "ChatGPT conversations"
  | "Files and chats"
  | "Plugins"
  | "Sites"
  | "Skills";

export interface ComposerContextSuggestionCandidate<T = unknown> {
  readonly id: string;
  readonly section: ComposerContextSuggestionSection;
  readonly label: string;
  readonly description: string | null;
  readonly searchTerms: readonly string[];
  readonly sourceRanked?: boolean;
  readonly value: T;
}

export interface ComposerContextSuggestionSectionModel<T = unknown> {
  readonly id: ComposerContextSuggestionSection | "search-results";
  readonly label: ComposerContextSuggestionSection | null;
  readonly items: readonly ComposerContextSuggestionCandidate<T>[];
  readonly emptyMessage?: string;
}

const EMPTY_SECTION_LIMITS: Partial<Record<ComposerContextSuggestionSection, number>> = {
  Apps: 3,
  "ChatGPT conversations": 5,
  Sites: 2,
  Skills: 2,
};

export function shouldDismissComposerSuggestionMenu(input: {
  readonly loading: boolean;
  readonly query: string;
  readonly resultCount: number;
}): boolean {
  return (
    input.query.trim().length > 0 &&
    /\s/u.test(input.query) &&
    !input.loading &&
    input.resultCount === 0
  );
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function scoreCandidate(
  candidate: ComposerContextSuggestionCandidate,
  score: (value: string) => number,
): number {
  if (candidate.sourceRanked) return 1;
  let best = score(candidate.label);
  for (const term of candidate.searchTerms) best = Math.max(best, score(term));
  return best;
}

function resolveSearchPriority(
  candidate: ComposerContextSuggestionCandidate,
  query: string,
): number {
  const startsWithQuery = [candidate.label, ...candidate.searchTerms].some((term) =>
    normalizeSearchText(term).startsWith(query),
  );
  if (startsWithQuery) {
    if (candidate.section === "Plugins") return 0;
    if (candidate.section === "Apps") return 1;
  }
  if (
    candidate.section === "Files and chats" ||
    candidate.section === "Chats" ||
    candidate.section === "ChatGPT conversations" ||
    candidate.section === "Sites"
  ) {
    return 3;
  }
  return 2;
}

export function rankComposerContextSuggestionCandidates<T>(input: {
  readonly candidates: readonly ComposerContextSuggestionCandidate<T>[];
  readonly query: string;
  readonly maxResults?: number;
  readonly useProviderPriority?: boolean;
  readonly tieBreakByLabel?: boolean;
}): ComposerContextSuggestionCandidate<T>[] {
  const normalizedQuery = input.query.trim();
  const maxResults = Math.max(0, Math.floor(input.maxResults ?? input.candidates.length));
  if (maxResults === 0) return [];
  if (!normalizedQuery) {
    return input.candidates.slice(0, maxResults);
  }

  type RankedCandidate = {
    candidate: ComposerContextSuggestionCandidate<T>;
    index: number;
    score: number;
    priority: number;
  };
  const score = createFuzzyQueryScorer(normalizedQuery);
  const prefixQuery = normalizeSearchText(normalizedQuery);
  const compare = (left: RankedCandidate, right: RankedCandidate): number => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (right.score !== left.score) return right.score - left.score;
    if (input.tieBreakByLabel && left.candidate.label !== right.candidate.label) {
      return left.candidate.label < right.candidate.label ? -1 : 1;
    }
    return left.index - right.index;
  };
  const ranked: RankedCandidate[] = [];
  const bounded = maxResults < input.candidates.length;
  for (const [index, candidate] of input.candidates.entries()) {
    const candidateScore = scoreCandidate(candidate, score);
    if (candidateScore <= 0) continue;
    const entry: RankedCandidate = {
      candidate,
      index,
      score: candidateScore,
      priority:
        input.useProviderPriority === false ? 0 : resolveSearchPriority(candidate, prefixQuery),
    };
    if (!bounded) {
      ranked.push(entry);
      continue;
    }
    // Root suggestions retain only the best eight entries while scanning every
    // provider. The complete skill picker still sorts its full result set.
    const insertionIndex = ranked.findIndex((current) => compare(entry, current) < 0);
    if (insertionIndex < 0 && ranked.length >= maxResults) continue;
    ranked.splice(insertionIndex < 0 ? ranked.length : insertionIndex, 0, entry);
    if (ranked.length > maxResults) ranked.pop();
  }
  if (!bounded) ranked.sort(compare);
  return ranked.map((entry) => entry.candidate);
}

export function buildComposerContextSuggestionSections<T>(input: {
  readonly candidates: readonly ComposerContextSuggestionCandidate<T>[];
  readonly query: string;
  readonly sectionOrder?: readonly ComposerContextSuggestionSection[];
  readonly maxSearchResults?: number;
  readonly loadingSectionMessages?: Partial<Record<ComposerContextSuggestionSection, string>>;
}): ComposerContextSuggestionSectionModel<T>[] {
  const normalizedQuery = input.query.trim();
  if (normalizedQuery) {
    const ranked = rankComposerContextSuggestionCandidates({
      candidates: input.candidates,
      query: normalizedQuery,
      maxResults: input.maxSearchResults ?? 8,
    });
    return [
      {
        id: "search-results",
        label: null,
        items: ranked,
        ...(ranked.length === 0 ? { emptyMessage: "No results" } : {}),
      },
    ];
  }

  const sectionOrder = input.sectionOrder ?? [
    "Add",
    "Plugins",
    "Apps",
    "Sites",
    "ChatGPT conversations",
    "Chats",
    "Skills",
    "Files and chats",
  ];
  return sectionOrder.flatMap((section) => {
    const items = input.candidates.filter((candidate) => candidate.section === section);
    const limit = EMPTY_SECTION_LIMITS[section];
    const visibleItems = limit === undefined ? items : items.slice(0, limit);
    if (visibleItems.length > 0) {
      return [
        {
          id: section,
          label: section,
          items: visibleItems,
        },
      ];
    }
    const loadingMessage = input.loadingSectionMessages?.[section];
    if (loadingMessage) {
      return [
        {
          id: section,
          label: section,
          items: [],
          emptyMessage: loadingMessage,
        },
      ];
    }
    if (section !== "Files and chats") return [];
    return [
      {
        id: section,
        label: section,
        items: [],
        emptyMessage: "Type to search files or chats",
      },
    ];
  });
}
