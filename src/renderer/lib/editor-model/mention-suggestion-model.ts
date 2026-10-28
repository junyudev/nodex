export type MentionSuggestionFamily = "page" | "chat" | "temporal";

export type MentionSuggestionMatch =
  | "temporal_intent"
  | "exact_title"
  | "page_key"
  | "prefix_title"
  | "title"
  | "content"
  | "recent";

export interface MentionSuggestionRank {
  readonly family: MentionSuggestionFamily;
  readonly match: MentionSuggestionMatch;
  readonly activeContext: boolean;
  readonly sourceOrder: number;
}

export interface RankedMentionSuggestion<Value> {
  readonly rank: MentionSuggestionRank;
  readonly value: Value;
}

export interface MentionSuggestionSection<Value> {
  readonly family: MentionSuggestionFamily;
  readonly label: "Mention a page" | "Mention a chat" | "Date";
  readonly items: readonly Value[];
  readonly hiddenItemCount: number;
}

const MATCH_SCORE: Readonly<Record<MentionSuggestionMatch, number>> = {
  temporal_intent: 1_000,
  exact_title: 900,
  page_key: 850,
  prefix_title: 800,
  title: 700,
  content: 600,
  recent: 400,
};

const EMPTY_QUERY_LIMITS: Readonly<Record<MentionSuggestionFamily, number>> = {
  temporal: 2,
  page: 5,
  chat: 3,
};

const QUERY_LIMITS: Readonly<Record<MentionSuggestionFamily, number>> = {
  temporal: 3,
  page: 5,
  chat: 4,
};

const SECTION_LABELS: Readonly<
  Record<MentionSuggestionFamily, MentionSuggestionSection<never>["label"]>
> = {
  page: "Mention a page",
  chat: "Mention a chat",
  temporal: "Date",
};

const EMPTY_QUERY_SECTION_ORDER: readonly MentionSuggestionFamily[] = ["temporal", "page", "chat"];

const QUERY_TIE_BREAK: Readonly<Record<MentionSuggestionFamily, number>> = {
  temporal: 0,
  page: 1,
  chat: 2,
};

function mentionSuggestionScore(rank: MentionSuggestionRank): number {
  return MATCH_SCORE[rank.match] + (rank.activeContext ? 25 : 0);
}

function compareWithinSection<Value>(
  left: RankedMentionSuggestion<Value>,
  right: RankedMentionSuggestion<Value>,
): number {
  if (left.rank.family === "page") {
    return left.rank.sourceOrder - right.rank.sourceOrder;
  }
  const scoreDifference = mentionSuggestionScore(right.rank) - mentionSuggestionScore(left.rank);
  if (scoreDifference !== 0) return scoreDifference;
  return left.rank.sourceOrder - right.rank.sourceOrder;
}

/**
 * Produces bounded semantic sections from independently ranked providers.
 * Empty mentions advertise Date first; queried sections follow their strongest
 * result. Page rows retain Core order; local providers use their own relevance
 * class and source order.
 */
export function selectMentionSuggestionSections<Value>(input: {
  readonly query: string;
  readonly candidates: readonly RankedMentionSuggestion<Value>[];
  readonly expandedFamilies?: ReadonlySet<MentionSuggestionFamily>;
}): MentionSuggestionSection<Value>[] {
  const hasQuery = input.query.trim().length > 0;
  const limits = hasQuery ? QUERY_LIMITS : EMPTY_QUERY_LIMITS;
  const byFamily: Record<MentionSuggestionFamily, RankedMentionSuggestion<Value>[]> = {
    page: [],
    chat: [],
    temporal: [],
  };

  for (const candidate of input.candidates) {
    byFamily[candidate.rank.family].push(candidate);
  }
  for (const family of Object.keys(byFamily) as MentionSuggestionFamily[]) {
    byFamily[family].sort(compareWithinSection);
  }

  const families = (Object.keys(byFamily) as MentionSuggestionFamily[])
    .filter((family) => byFamily[family].length > 0)
    .sort((left, right) => {
      if (!hasQuery) {
        return EMPTY_QUERY_SECTION_ORDER.indexOf(left) - EMPTY_QUERY_SECTION_ORDER.indexOf(right);
      }
      const scoreDifference =
        mentionSuggestionScore(byFamily[right][0]!.rank) -
        mentionSuggestionScore(byFamily[left][0]!.rank);
      if (scoreDifference !== 0) return scoreDifference;
      return QUERY_TIE_BREAK[left] - QUERY_TIE_BREAK[right];
    });

  return families.map((family) => {
    const candidates = byFamily[family];
    const visibleLimit = input.expandedFamilies?.has(family) ? candidates.length : limits[family];
    const items = candidates.slice(0, visibleLimit).map(({ value }) => value);
    return {
      family,
      label: SECTION_LABELS[family],
      items,
      hiddenItemCount: candidates.length - items.length,
    };
  });
}
