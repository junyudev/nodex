import type { MarkedExtension } from "marked";

/** Display and inline fences deliberately use different closing-dollar rules. */
export function readConversationMathFence(previous: string | null, line: string): string | null {
  if (previous === null) {
    const opening = /^ {0,3}(\\\[|\${2,})(.*)$/u.exec(line);
    if (!opening || opening[2]!.includes(opening[1] === "\\[" ? "]" : "$")) return null;
    return opening[1] === "\\[" ? "\\]" : opening[1]!;
  }
  const closing = /^ {0,3}(\\\]|\${2,})[ \t]*$/u.exec(line)?.[1];
  return closing &&
    (previous === "\\]"
      ? closing === previous
      : closing[0] === "$" && closing.length >= previous.length)
    ? null
    : previous;
}

export interface ConversationMathToken {
  readonly type: "math";
  readonly raw: string;
  readonly text: string;
  readonly display: boolean;
}

function displayStart(source: string): number | undefined {
  for (const match of source.matchAll(/\n( {0,3}(?:\\\[|\${2,})[^\n]*)/gu)) {
    if (readConversationMathFence(null, match[1]!) !== null) return match.index + 1;
  }
  return undefined;
}

function readDisplayMath(source: string): ConversationMathToken | undefined {
  const opening = source.split("\n", 1)[0]!;
  const fence = readConversationMathFence(null, opening);
  if (fence === null) return undefined;
  let contentEnd = source.length;
  let rawEnd = source.length;
  for (const match of source.matchAll(/\n([^\n]*)/gu)) {
    if (readConversationMathFence(fence, match[1]!) !== null) continue;
    contentEnd = match.index;
    rawEnd = match.index + match[0].length;
    break;
  }
  const indent = opening.length - opening.trimStart().length;
  const payload = source.slice(opening.length + 1, contentEnd);
  return {
    type: "math",
    raw: source.slice(0, rawEnd),
    text: indent === 0 ? payload : payload.replace(new RegExp(`^ {0,${indent}}`, "gm"), ""),
    display: true,
  };
}

function readInlineMath(source: string): ConversationMathToken | undefined {
  const opening = /^(?:\\\(|\\\[|\${2,})/u.exec(source)?.[0];
  if (!opening) return undefined;
  const closing = opening === "\\(" ? "\\)" : opening === "\\[" ? "\\]" : opening;
  const end = opening.startsWith("$")
    ? [...source.matchAll(/\$+/gu)].find(
        (match) => match.index > 0 && match[0].length === opening.length,
      )?.index
    : source.indexOf(closing, opening.length);
  if (end === undefined || end < 0) return undefined;
  return {
    type: "math",
    raw: source.slice(0, end + closing.length),
    text: source.slice(opening.length, end).trim(),
    display: false,
  };
}

export const conversationMathExtension: MarkedExtension = {
  tokenizer: {
    lheading(source) {
      const match = this.rules.block.lheading.exec(source);
      return match === null || displayStart(match[0]) !== undefined ? undefined : false;
    },
  },
  extensions: [
    {
      name: "math",
      level: "block",
      start: displayStart,
      tokenizer(source) {
        const fence = this.lexer.options.tokenizer?.fences(source);
        if (fence?.lang?.split(/\s/u, 1)[0] === "math")
          return { type: "math", raw: fence.raw, text: fence.text, display: true };
        return readDisplayMath(source);
      },
    },
    {
      name: "math",
      level: "inline",
      start(source) {
        const index = source.search(/\\(?:\(|\[)|\${2,}/u);
        return index < 0 ? undefined : index;
      },
      tokenizer(source, tokens) {
        const previous = tokens.at(-1);
        if (source.startsWith("$") && previous?.raw.endsWith("$") && previous.type !== "escape")
          return undefined;
        return readInlineMath(source);
      },
    },
  ],
};
