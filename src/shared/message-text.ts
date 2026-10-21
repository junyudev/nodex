import { parseNfm } from "./nfm/parser";
import { serializePlainNfm } from "./nfm/plain-source";
import type { NfmBlock, NfmInlineContent } from "./nfm/types";

/**
 * Message text is Nested Markdown as people write a message: a blank line separates Blocks,
 * while a single line break stays inside its paragraph or quote, and a bare `http://` or
 * `https://` URL is a link. Core reads message bodies the same way (`parse_message_text` in
 * `nodex-core`); `crates/nodex-core/tests/fixtures/nfm/markdown-input.json` holds both to it.
 */
export function parseMessageText(text: string): NfmBlock[] {
  return autolinkBlocks(parseNfm(text.replace(/\r\n?/g, "\n"), { joinLines: true }));
}

const SCHEMES = ["https://", "http://"] as const;
const TRAILING_PUNCTUATION = new Set([".", ",", ":", ";", "!", "?", "'", '"', "*", "_", "~"]);
const isAsciiAlphanumeric = (char: string | undefined) =>
  char !== undefined && /^[A-Za-z0-9]$/.test(char);

const count = (text: string, char: string) => text.split(char).length - 1;

/** The URL starting at `start`, without trailing punctuation or an unmatched closing bracket. */
function urlAt(text: string, start: number): string | null {
  let end = start;
  while (end < text.length && !/\s/.test(text[end]!) && text[end] !== "<") end += 1;
  let url = text.slice(start, end);
  for (;;) {
    const last = url.at(-1)!;
    if (TRAILING_PUNCTUATION.has(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (last === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else break;
  }
  const scheme = SCHEMES.find((prefix) => url.startsWith(prefix))!;
  return url.length > scheme.length ? url : null;
}

/** Splits bare URLs out of plain text as links with the text's own styles. */
function autolinkText(item: Extract<NfmInlineContent, { type: "text" }>): NfmInlineContent[] {
  if (item.styles.code) return [item];
  const parts: NfmInlineContent[] = [];
  let cursor = 0;
  let searchFrom = 0;
  for (;;) {
    const starts = SCHEMES.map((scheme) => item.text.indexOf(scheme, searchFrom)).filter(
      (index) => index !== -1,
    );
    if (starts.length === 0) break;
    const start = Math.min(...starts);
    const url = isAsciiAlphanumeric(item.text[start - 1]) ? null : urlAt(item.text, start);
    if (!url) {
      searchFrom = start + 1;
      continue;
    }
    if (start > cursor)
      parts.push({ type: "text", text: item.text.slice(cursor, start), styles: item.styles });
    parts.push({ type: "link", text: url, href: url, styles: item.styles });
    cursor = start + url.length;
    searchFrom = cursor;
  }
  if (cursor === 0) return [item];
  if (cursor < item.text.length)
    parts.push({ type: "text", text: item.text.slice(cursor), styles: item.styles });
  return parts;
}

const autolinkInline = (items: NfmInlineContent[]): NfmInlineContent[] =>
  items.flatMap((item) => (item.type === "text" ? autolinkText(item) : [item]));

function autolinkBlocks(blocks: NfmBlock[]): NfmBlock[] {
  return blocks.map((block) => {
    const children = autolinkBlocks(block.children);
    if (block.type === "table")
      return {
        ...block,
        children,
        rows: block.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({ ...cell, content: autolinkInline(cell.content) })),
        })),
      };
    if (block.type === "image") return { ...block, children };
    if ("content" in block) return { ...block, children, content: autolinkInline(block.content) };
    return { ...block, children };
  });
}

/** A private-use character marks where a blank line goes; no one writes it in a message. */
const BLANK_LINE = "\uE000";

/** A link that message text would write back as the bare URL it reads as a link. */
function bareUrl(item: NfmInlineContent, previous: NfmInlineContent | undefined): string | null {
  if (item.type !== "link" || item.text !== item.href) return null;
  if (previous?.type === "text" && isAsciiAlphanumeric(previous.text.at(-1))) return null;
  const relinked = autolinkText({ type: "text", text: item.href, styles: item.styles });
  return relinked.length === 1 && relinked[0]!.type === "link" ? item.href : null;
}

const unlinkBareUrls = (items: NfmInlineContent[]): NfmInlineContent[] =>
  items.map((item, index) => {
    const url = bareUrl(item, items[index - 1]);
    return url === null || item.type !== "link"
      ? item
      : { type: "text", text: url, styles: item.styles };
  });

/** Splits a paragraph or quote at its line breaks, one Block per written line. */
function splitAtLineBreaks(block: Extract<NfmBlock, { type: "paragraph" | "blockquote" }>) {
  const lines: NfmInlineContent[][] = [[]];
  for (const item of block.content) {
    if (item.type === "linebreak") lines.push([]);
    else lines.at(-1)!.push(item);
  }
  return lines.map((content, index) => ({
    ...block,
    content,
    children: index === lines.length - 1 ? writtenLines(block.children) : [],
  }));
}

const isProse = (block: NfmBlock | undefined) =>
  block?.type === "paragraph" || block?.type === "blockquote";

/** The Blocks as written lines: one per line of a paragraph or quote, a blank line between them. */
function writtenLines(blocks: readonly NfmBlock[]): NfmBlock[] {
  const lines: NfmBlock[] = [];
  let previous: NfmBlock | undefined;
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "blockquote") {
      if (isProse(previous))
        lines.push({
          type: "paragraph",
          content: [{ type: "text", text: BLANK_LINE, styles: {} }],
          children: [],
        });
      lines.push(...splitAtLineBreaks({ ...block, content: unlinkBareUrls(block.content) }));
    } else {
      lines.push({ ...block, children: writtenLines(block.children) });
    }
    previous = block;
  }
  return lines;
}

/**
 * Writes Blocks back as the message text a person reads and edits, with each escape only where
 * it is needed. Returns null when message text cannot say exactly what the Blocks say, such as
 * a paragraph with an empty line inside it; such a message is edited as its Page.
 */
export function serializeMessageText(blocks: readonly NfmBlock[]): string | null {
  const lines = serializePlainNfm(writtenLines(blocks))
    .split("\n")
    .map((line) => (line.replace(/^\t*/, "") === BLANK_LINE ? "" : line));
  // Nesting is written with two spaces a level, which a text field can type: everywhere it
  // reads back the same, else for list items only, else with tabs.
  const spaced = (line: string) => line.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length));
  const listItem = /^\t+(?:[-*+] |\d+[.)]\s)/;
  const expected = JSON.stringify(autolinkBlocks([...blocks]));
  return (
    [lines.map(spaced), lines.map((line) => (listItem.test(line) ? spaced(line) : line)), lines]
      .map((candidate) => candidate.join("\n"))
      .find((text) => JSON.stringify(parseMessageText(text)) === expected) ?? null
  );
}
