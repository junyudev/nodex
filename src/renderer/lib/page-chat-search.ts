import { searchKernel, type SearchField } from "@nodex/search-kernel";

export type { SearchField };

/** Literal find-in-document ranges, folded for case, width and accents. */
export const findLiteralRanges = (query: string, text: string) =>
  searchKernel.findLiteralRanges(query, text);
export const foldText = (text: string) => searchKernel.foldText(text);

export const metadata = (text: string): SearchField => [text, "metadata"];
export const longText = (text: string): SearchField => [text, "long_text"];

/** Keep the collection's presentation order unless it is a ranked picker. */
export function searchPageChatRows<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => readonly SearchField[],
  ranked = false,
): readonly T[] {
  if (!query.trim() || rows.length === 0) return rows;
  const hits = searchKernel.matchTextRows(query, rows.map(fields));
  if (ranked) return hits.map(({ index }) => rows[index]);
  const matched = new Set(hits.map(({ index }) => index));
  return rows.filter((_, index) => matched.has(index));
}
