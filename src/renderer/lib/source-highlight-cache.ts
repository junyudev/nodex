import type { SupportedLanguages } from "@pierre/diffs";
import { getSourceContentDigest } from "./source-content-version";

/**
 * A highlighted AST holds about twenty times its text in memory, so a few huge
 * files, not the entry count, decide the cache's footprint. Beyond this much
 * source text the oldest highlights are dropped; the newest always stays.
 */
export const SOURCE_HIGHLIGHT_CACHE_TEXT_BUDGET = 16 * 1024 * 1024;

/**
 * The same source, language, and text always name the same highlight. Keys lead
 * with the amount of text they cover so the cache can be bounded by it.
 */
export function sourceHighlightCacheKey(
  sourceIdentity: string,
  language: SupportedLanguages | null | undefined,
  contents: string,
  contentDigest = getSourceContentDigest(contents),
): string {
  return [contents.length, sourceIdentity, language ?? "", contentDigest].join("\0");
}

/** Names a comparison of a source against a base text. */
export function sourceComparisonHighlightCacheKey(
  sourceIdentity: string,
  language: SupportedLanguages | null | undefined,
  contents: string,
  base: { readonly path: string; readonly contents: string },
): string {
  return [
    contents.length + base.contents.length,
    sourceIdentity,
    language ?? "",
    getSourceContentDigest(contents),
    base.path,
    getSourceContentDigest(base.contents),
  ].join("\0");
}

/**
 * The window thread may tokenize this much text without a visible stall. Larger
 * text shows plain wherever no working highlight worker can take it.
 */
export const MAIN_THREAD_HIGHLIGHT_MAX_CHARACTERS = 64 * 1024;

/** The language to render with when highlighting would run on the window thread. */
export function mainThreadSourceLanguage<Language extends string>(
  language: Language | null | undefined,
  textLength: number,
): Language | "text" | null | undefined {
  return textLength > MAIN_THREAD_HIGHLIGHT_MAX_CHARACTERS ? "text" : language;
}

/** Given keys from oldest to newest, the oldest ones that exceed the text budget. */
export function sourceHighlightKeysOverBudget(
  keys: readonly string[],
  budget = SOURCE_HIGHLIGHT_CACHE_TEXT_BUDGET,
): string[] {
  let total = keys.reduce((sum, key) => sum + cachedTextLength(key), 0);
  const evicted: string[] = [];
  for (const key of keys.slice(0, -1)) {
    if (total <= budget) break;
    evicted.push(key);
    total -= cachedTextLength(key);
  }
  return evicted;
}

function cachedTextLength(key: string): number {
  return Number.parseInt(key, 10) || 0;
}
