import { messageMatcher, messageSearchTokens } from "@t3tools/shared/paletteSearch";

const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Snippets show visible message text around the strongest group of query words. */
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

/** Index terms are only a candidate filter; the same pure matcher validates every complete body. */
export const prepareMessageSearch = (query: string) => {
  const { long, short } = messageSearchTokens(query);
  if (long.length === 0 && !short.some((token) => /^[\p{L}\p{N}]{2}$/u.test(token))) return null;
  const indexed = long.filter((token) => Array.from(token).length >= 3);
  const match = messageMatcher(query);
  return {
    indexedQuery:
      indexed.length === 0
        ? null
        : indexed.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND "),
    match: (body: string): { readonly quality: number; readonly snippet: string } | null => {
      const text = body.replace(MARKDOWN_LINK, "$1").normalize("NFC");
      const result = match(text);
      return result === null
        ? null
        : { quality: result.quality, snippet: messageSearchSnippet(text, result.offset) };
    },
  };
};
