import { readConversationMathFence } from "./conversation-math";

interface Fence {
  readonly marker: string;
  readonly length: number;
}

function nextCodeFence(previous: Fence | null, line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/su.exec(line);
  if (!match) return previous;
  const marker = match[1]!;
  if (!previous)
    return marker[0] === "`" && match[2]!.includes("`")
      ? null
      : { marker: marker[0]!, length: marker.length };
  return marker[0] === previous.marker &&
    marker.length >= previous.length &&
    /^[\t ]*$/u.test(match[2]!)
    ? null
    : previous;
}

function beginsIndependentBlock(line: string): boolean {
  return (
    !/^[\t ]/u.test(line) &&
    !/^[-+*](?:[\t ]|$)/u.test(line) &&
    !/^\d+(?:[.)](?:[\t ]|$)|$)/u.test(line) &&
    !line.startsWith(">")
  );
}

/** A blank line is stable only after a following independent block leaves all scopes. */
export function findMarkdownStablePrefix(source: string): number {
  if (!/(?:\r\n|[\r\n])[\t ]*(?:\r\n|[\r\n])/u.test(source)) return 0;
  let stable = 0;
  let candidate: number | null = null;
  let codeFence: Fence | null = null;
  let mathFence: string | null = null;
  let directives = 0;
  let offset = 0;
  const newlines = /\r\n|[\r\n]/gu;
  while (offset <= source.length) {
    const match = newlines.exec(source);
    const newline = match?.index ?? -1;
    const end = newline === -1 ? source.length : newline;
    const next = newline === -1 ? source.length : newline + match![0].length;
    const line = source.slice(offset, end);
    const trimmed = line.replace(/^[\t ]+/u, "");
    if (candidate !== null && trimmed.length > 0 && beginsIndependentBlock(line)) {
      stable = candidate;
      candidate = null;
    } else if (trimmed.length > 0) {
      candidate = null;
    }
    if (!mathFence) codeFence = nextCodeFence(codeFence, line);
    if (!codeFence) mathFence = readConversationMathFence(mathFence, line);
    if (!codeFence && !mathFence) {
      if (/^:::[a-zA-Z]/u.test(trimmed)) directives += 1;
      else if (directives > 0 && /^:::[\t ]*$/u.test(trimmed)) directives -= 1;
    }
    if (!codeFence && !mathFence && directives === 0 && !trimmed && newline !== -1)
      candidate = next;
    if (newline === -1) break;
    offset = next;
  }
  return stable;
}

/** Incomplete-fence state is read from authored text, before repair inserts delimiters. */
export function findMarkdownOpenCodeFence(source: string): boolean {
  let fence: Fence | null = null;
  for (const line of source.split(/\r\n|[\r\n]/u)) fence = nextCodeFence(fence, line);
  return fence !== null;
}
