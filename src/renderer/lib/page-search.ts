import { matchPageKeySearchQuery, parsePageKeySearchQuery } from "./page-key";
import { foldText, longText, metadata, searchPageChatRows } from "./page-chat-search";
import type { SearchField } from "./page-chat-search";

/** Historical key aliases remain part of the authorized Library search. */
export function filterPageCollectionRows<T>(
  rows: readonly T[],
  query: string,
  pageKey: (row: T) => string | null | undefined,
  fields: (row: T) => readonly SearchField[],
): readonly T[] {
  if (!query.trim()) return rows;

  const keyQuery = parsePageKeySearchQuery(foldText(query));
  const matchesKey = (row: T) => matchPageKeySearchQuery(pageKey(row), keyQuery) !== null;
  if (keyQuery.explicit) return rows.filter(matchesKey);

  const matched = new Set(
    searchPageChatRows(rows, query, (row) => [metadata(pageKey(row) ?? ""), ...fields(row)]),
  );
  return rows.filter((row) => matched.has(row) || matchesKey(row));
}

/** Board and both List projections search the same loaded fields. */
export function filterDatabasePageRows<T>(
  rows: readonly T[],
  query: string,
  page: (row: T) => {
    readonly pageKey: string | null;
    readonly title: string;
    readonly preview: string;
    readonly plainText: string;
  },
  propertyText: (row: T) => string,
): readonly T[] {
  return filterPageCollectionRows(
    rows,
    query,
    (row) => page(row).pageKey,
    (row) => {
      const { title, preview, plainText } = page(row);
      return [metadata(title), metadata(propertyText(row)), longText(preview), longText(plainText)];
    },
  );
}
