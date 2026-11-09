import { pageAssigneeName, type Member } from "../../shared/work-graph";
import type { DatabasePageSummary } from "./types";
import {
  matchPageKeySearchQuery,
  parsePageKeySearchQuery,
  type PageKeySearchQuery,
} from "./page-key";
import { matchesSearchTokens, normalizeSearchText, tokenizeSearchQuery } from "./search-text";

export { matchesSearchTokens, tokenizeSearchQuery } from "./search-text";

export interface PageCollectionSearchQuery {
  readonly normalizedQuery: string;
  readonly pageKey: PageKeySearchQuery;
  readonly textTokens: readonly string[];
}

/**
 * Compiles one local Page-collection query for reuse across every loaded row.
 * Historical aliases deliberately remain a Core-authorized global-search concern.
 */
export function compilePageCollectionSearchQuery(query: string): PageCollectionSearchQuery {
  const pageKey = parsePageKeySearchQuery(query);
  return {
    normalizedQuery: pageKey.normalizedQuery,
    pageKey,
    textTokens: pageKey.explicit ? [] : tokenizeSearchQuery(query),
  };
}

export function matchesPageCollectionSearchQuery(
  pageKey: string | null | undefined,
  text: string,
  query: PageCollectionSearchQuery,
): boolean {
  if (!query.normalizedQuery) return true;
  if (matchPageKeySearchQuery(pageKey, query.pageKey)) return true;
  if (query.pageKey.explicit) return false;
  return matchesSearchTokens(text, query.textTokens);
}

export function buildPageSearchText(
  card: Pick<DatabasePageSummary, "id" | "pageKey" | "title" | "descriptionPreview" | "assignee">,
  tagLabels: readonly string[] = [],
  members: readonly Member[] = [],
): string {
  return normalizeSearchText(
    [
      card.id,
      card.title,
      card.descriptionPreview,
      tagLabels.join(" "),
      pageAssigneeName(card.assignee, members),
    ].join(" "),
  );
}
