import type { Token, Tokens } from "marked";
import {
  interpretConversationFilePath,
  readConversationFileCitation,
} from "./conversation-markdown-targets";
type FileCitationToken = Tokens.Generic & {
  type: "codexDirective";
  name: "codex-file-citation";
  attributes: Record<string, string>;
  block: false;
  text: string;
  tokens: Token[];
};

function destinationEnd(source: string, start: number): number | null {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n") return null;
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    if (depth === 0) return index;
    depth -= 1;
  }
  return null;
}
const rawText = (raw: string): Tokens.Text => ({ type: "text", raw, text: raw });

function recoverText(token: Tokens.Text): Token[] {
  let cursor = 0;
  const recovered: Token[] = [];
  for (const match of token.raw.matchAll(/!?\[([^\]\n]+)\]\(/gu)) {
    const label = match[1]!.trim();
    const start = match.index + match[0].length;
    const end = destinationEnd(token.raw, start);
    const authored = end === null ? "" : token.raw.slice(start, end).trim().replaceAll("\\", "/");
    const href = authored ? interpretConversationFilePath(authored) : null;
    if (!label || end === null || href === null || match.index < cursor) continue;
    if (match.index > cursor) recovered.push(rawText(token.raw.slice(cursor, match.index)));
    const raw = token.raw.slice(match.index, end + 1);
    recovered.push(
      match[0].startsWith("!")
        ? { type: "image", raw, href, title: null, text: label }
        : { type: "link", raw, href, title: null, text: label, tokens: [rawText(label)] },
    );
    cursor = end + 1;
  }
  if (cursor === 0) return [token];
  if (cursor < token.raw.length) recovered.push(rawText(token.raw.slice(cursor)));
  return recovered;
}

/** Mutable lexer tokens are normalized once before entering the immutable document cache. */
export function normalizeConversationTargetTokens(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type === "link") {
      const start = token.raw.indexOf("](") + 2;
      const end = destinationEnd(token.raw, start);
      const authored = start > 1 && end !== null ? token.raw.slice(start, end).trim() : null;
      if (authored && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/u.test(authored))
        token.href = authored.replaceAll("\\", "/");
    }
    if ("tokens" in token && Array.isArray(token.tokens)) {
      token.tokens = token.tokens.flatMap((child) =>
        child.type === "text" ? recoverText(child as Tokens.Text) : [child],
      );
      normalizeConversationTargetTokens(token.tokens);
    }
  }
}

export function tokenizeConversationFileCitation(source: string): FileCitationToken | undefined {
  const citation = readConversationFileCitation(source);
  if (!citation) return undefined;
  const range = /†L(\d+)(?:-L(\d+))?】$/u.exec(citation.raw)!;
  return {
    type: "codexDirective",
    raw: citation.raw,
    name: "codex-file-citation",
    block: false,
    text: "",
    tokens: [],
    attributes: {
      path: citation.reference.path,
      line_range_start: range[1]!,
      ...(range[2] === undefined ? {} : { line_range_end: range[2] }),
    },
  };
}
