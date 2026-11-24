/**
 * The inline Markdown a changelog entry may use, read the same way by the desktop's release notes
 * and the website's changelog page: code spans and `**strong**` runs. Anything else, including an
 * unmatched marker, stays text.
 */

export type ChangelogInlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string };

function backtickRunLength(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end += 1;
  return end - start;
}

/** Where a code span opened at `start` closes, as the index of its closing run; -1 when it doesn't. */
function closingBacktickRun(text: string, start: number, length: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const next = text.indexOf("`", cursor);
    if (next === -1) return -1;
    const run = backtickRunLength(text, next);
    if (run === length) return next;
    cursor = next + run;
  }
  return -1;
}

/** Splits a changelog entry's inline Markdown into the parts a reader styles. */
export function changelogInlineTokens(markdown: string): readonly ChangelogInlineToken[] {
  const tokens: ChangelogInlineToken[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", text });
    text = "";
  };
  let cursor = 0;
  while (cursor < markdown.length) {
    if (markdown[cursor] === "`") {
      const length = backtickRunLength(markdown, cursor);
      const close = closingBacktickRun(markdown, cursor + length, length);
      if (close !== -1) {
        flush();
        tokens.push({ kind: "code", text: markdown.slice(cursor + length, close).trim() });
        cursor = close + length;
        continue;
      }
      text += markdown.slice(cursor, cursor + length);
      cursor += length;
      continue;
    }
    if (markdown.startsWith("**", cursor)) {
      const close = markdown.indexOf("**", cursor + 2);
      const inner = close === -1 ? "" : markdown.slice(cursor + 2, close);
      if (inner.trim() && !inner.includes("`")) {
        flush();
        tokens.push({ kind: "strong", text: inner });
        cursor = close + 2;
        continue;
      }
    }
    text += markdown[cursor];
    cursor += 1;
  }
  flush();
  return tokens;
}
