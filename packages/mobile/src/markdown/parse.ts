const readAttributes = (source: string): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)="((?:[^"\\]|\\.)*)"/gu)) {
    const [, name, value] = match;
    if (name) attributes[name] = (value ?? "").replace(/\\(.)/gu, "$1");
  }
  return attributes;
};

const rewriteDirectives = (line: string): string =>
  line
    .replace(/:attachment\{([^}]*)\}/gu, (_, body: string) => {
      const { name, source } = readAttributes(body);
      if (!source) return name ?? "";
      return `[${(name ?? "Attachment").replace(/[[\]]/gu, "\\$&")}](${source})`;
    })
    .replace(/:date\{([^}]*)\}/gu, (_, body: string) => {
      const { start, end } = readAttributes(body);
      return end ? `${start ?? ""} – ${end}` : (start ?? "");
    })
    .replace(/:agent-config\{[^}]*\}/gu, "")
    .replace(/:span\[([^\]]*)\]\{[^}]*\}/gu, "$1")
    .replace(/<nodex:\/\/pages\/([^>\s]+)>/gu, "[Page](nodex://pages/$1)")
    .replace(/<nodex:\/\/sessions\/([^>\s]+)>/gu, "[Chat](nodex://sessions/$1)");

const runLength = (text: string, start: number): number => {
  let end = start;
  while (text[end] === text[start]) end += 1;
  return end - start;
};

const TICKS = /`+/gu;
/** Where a code span opened by `ticks` backticks ends, or null when nothing closes it. */
const codeSpanEnd = (text: string, from: number, ticks: number): number | null => {
  TICKS.lastIndex = from;
  for (let match = TICKS.exec(text); match; match = TICKS.exec(text))
    if (match[0].length === ticks) return match.index + ticks;
  return null;
};

/** An autolink or a bare web address, whose text is its destination. */
const ADDRESS = /<[A-Za-z][\w+.-]{1,31}:[^\s<>]*>|(?:https?:\/\/|www\.)\S+/uy;
const addressAt = (text: string, index: number): string | null => {
  ADDRESS.lastIndex = index;
  return ADDRESS.exec(text)?.[0] ?? null;
};

/**
 * Nodex reads math only between two or more dollars, so a single dollar is text, as in `$HOME`,
 * `$i` or `$5`. The phone's renderer would also read math between single dollars, so each one
 * outside code is escaped. Code spans and addresses keep their text exactly.
 */
const escapeSingleDollars = (prose: string): string => {
  let out = "";
  let index = 0;
  while (index < prose.length) {
    const char = prose[index];
    let end = index + 1;
    if (char === "\\") end = index + 2;
    else if (char === "`") {
      const ticks = runLength(prose, index);
      end = codeSpanEnd(prose, index + ticks, ticks) ?? index + ticks;
    } else if (char === "$") {
      end = index + runLength(prose, index);
      if (end === index + 1) {
        out += "\\$";
        index = end;
        continue;
      }
    } else if (char === "<" || char === "h" || char === "w") {
      end = index + (addressAt(prose, index)?.length ?? 1);
    }
    out += prose.slice(index, end);
    index = end;
  }
  return out;
};

/** A Markdown picture, with its alt text and address. */
export const MARKDOWN_IMAGE =
  /!\[([^\]\n]*)\]\(\s*<?([^\s<>()]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gu;

/** The pictures of a line that holds nothing else, or none when the line has text too. */
const linePictures = (line: string): readonly string[] =>
  /^ {0,3}!\[/u.exec(line) && line.replace(MARKDOWN_IMAGE, "").trim() === ""
    ? (line.match(MARKDOWN_IMAGE) ?? [])
    : [];

/**
 * Reduces Nodex Markdown to the plain Markdown a phone shows. Containers such as Prompts and
 * toggles keep their title and body, a single dollar stays text, and code is left exactly as
 * written. A picture on a line of its own is a paragraph of its own, so it shows across the reply
 * instead of as a glyph in the text beside it.
 */
export const flattenNodexMarkdown = (text: string): string => {
  const out: string[] = [];
  // A paragraph's lines are escaped together, since a code span can continue onto the next line.
  let prose: string[] = [];
  const settle = () => {
    if (prose.length > 0) out.push(escapeSingleDollars(prose.join("\n")));
    prose = [];
  };
  const literal = (line: string) => {
    settle();
    out.push(line);
  };
  // Whatever follows a picture's paragraph starts after a blank line, as a block of its own.
  let afterPicture = false;
  let fence: string | null = null;
  let indentedCode = false;
  let containerDepth = 0;
  for (const line of text.split("\n")) {
    const closesContainer = containerDepth > 0 && /^\s*:::\s*$/u.test(line);
    if (afterPicture && !closesContainer) {
      if (line.trim() !== "") out.push("");
      afterPicture = false;
    }
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.startsWith(fence)) fence = null;
      literal(line);
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      literal(line);
      continue;
    }
    const open = /^\s*:::[\w-]+(?:\[(.*)\])?(?:\{.*\})?\s*$/u.exec(line);
    if (open) {
      containerDepth += 1;
      if (open[1]) {
        prose.push(`**${open[1]}**`);
        literal("");
      }
      continue;
    }
    if (closesContainer) {
      containerDepth -= 1;
      continue;
    }
    const dedented = containerDepth > 0 ? line.replace(/^ {1,2}/u, "") : line;
    const pictures = linePictures(dedented);
    if (pictures.length > 0) {
      settle();
      for (const picture of pictures) {
        if (out.length > 0 && out.at(-1)?.trim() !== "") out.push("");
        out.push(escapeSingleDollars(picture));
      }
      afterPicture = true;
      continue;
    }
    if (dedented.trim() === "") {
      literal(dedented);
      continue;
    }
    // Indented code cannot interrupt a paragraph; it lasts while its lines stay indented.
    indentedCode =
      /^(?: {4}|\t)/u.test(dedented) &&
      prose.length === 0 &&
      (indentedCode || out.length === 0 || out.at(-1)?.trim() === "");
    if (indentedCode) literal(dedented);
    else prose.push(rewriteDirectives(dedented));
  }
  settle();
  return out.join("\n");
};

// An escaped mark is set aside as a private character, so no rule below reads it as a mark.
const ESCAPED = 0xe000;
/** Words outside code: a picture or link reads as its text, emphasis loses its marks. */
const plainProse = (prose: string): string =>
  prose
    .replace(/\\([!-/:-@[-`{-~])/gu, (_, mark: string) =>
      String.fromCharCode(ESCAPED + mark.charCodeAt(0)),
    )
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
    .replace(/\[([^\]\n]*)\](?:\([^)\n]*\)|\[[^\]\n]*\])/gu, "$1")
    .replace(/<((?:https?|mailto):[^\s<>]*)>/giu, "$1")
    .replace(/<\/?[A-Za-z][^<>\n]*>/gu, "")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/gu, "$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/[\ue000-\ue07f]/gu, (mark) => String.fromCharCode(mark.charCodeAt(0) - ESCAPED));

/**
 * Markdown read as one line of the words it shows, for a place that shows plain text: headings,
 * quotes, list marks and emphasis lose their marks, code keeps its text and a link or picture
 * reads as its text.
 */
export const plainMarkdownText = (markdown: string): string => {
  const lines = markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .split(/\r\n|\r|\n|[\u2028\u2029\u0085]/u)
    .filter((line) => !/^\s*(?:`{3,}|~{3,})/u.test(line))
    .map((line) =>
      line.replace(/^\s*(?:>\s?)*\s*(?:#{1,6}\s+|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)?/u, ""),
    );
  // Code spans keep their text exactly; only the words around them lose their marks.
  const text = lines.join("\n");
  let plain = "";
  let index = 0;
  for (const code of text.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/gu)) {
    plain += plainProse(text.slice(index, code.index)) + (code[2] ?? "").trim();
    index = code.index + code[0].length;
  }
  plain += plainProse(text.slice(index));
  return plain.replace(/\s+/gu, " ").trim();
};

/** The part of a body a stream row shows, cut at a line so Markdown stays well formed. */
export const previewMarkdown = (
  text: string,
  maxChars = 560,
): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= maxChars) return { text, cut: false };
  const head = text.slice(0, maxChars);
  const lineEnd = head.lastIndexOf("\n");
  const cut = lineEnd > maxChars / 2 ? head.slice(0, lineEnd) : head;
  const fences = cut.match(/^\s*(```|~~~)/gmu)?.length ?? 0;
  return { text: fences % 2 === 1 ? `${cut}\n\`\`\`` : cut, cut: true };
};
