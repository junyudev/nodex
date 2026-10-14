import type { MarkedExtension, Token, TokenizerThis } from "marked";
import { readConversationDirectiveAttributesEnd } from "../../../shared/conversation-markdown-display";
import type { ImmutableMarkdown } from "./markdown-cache";

export type ConversationDirectiveToken = ImmutableMarkdown<{
  readonly type: "codexDirective";
  readonly raw: string;
  readonly name: string;
  readonly attributes: Readonly<Record<string, string | boolean>>;
  readonly block: boolean;
  readonly text: string;
  readonly tokens: readonly Token[];
}>;

/** Only a container's standalone closing line is dedented; code scopes keep their authored lines. */
export function prepareConversationDirectiveClosings(source: string): string {
  if (!source.includes(":::")) return source;
  let container = false;
  let fence: string | null = null;
  let length = 0;
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/^[ \t]+/u, "");
      const marker = /^(`{3,}|~{3,})/u.exec(trimmed)?.[1];
      if (fence !== null) {
        if (
          marker?.startsWith(fence) &&
          marker.length >= length &&
          !trimmed.slice(marker.length).trim()
        )
          fence = null;
        return line;
      }
      if (marker && (marker[0] !== "`" || !trimmed.slice(marker.length).includes("`"))) {
        fence = marker[0]!;
        length = marker.length;
        return line;
      }
      if (container && /^:::[ \t]*$/u.test(trimmed)) {
        container = false;
        return ":::";
      }
      if (!container && /^:::[A-Za-z]/u.test(trimmed)) container = true;
      return line;
    })
    .join("\n");
}

function attributes(source: string): Record<string, string | boolean> | null {
  const result: Record<string, string | boolean> = {};
  const classes: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const remaining = source.slice(cursor);
    const whitespace = /^[\t\v\f\ufeff ]+/u.exec(remaining)?.[0];
    if (whitespace) {
      cursor += whitespace.length;
      continue;
    }
    const shorthand = /^[.#][A-Za-z_\u00a0-\uffff][\w\u00a0-\uffff-]*/u.exec(remaining)?.[0];
    if (shorthand) {
      if (shorthand[0] === ".") classes.push(shorthand.slice(1));
      else result.id = shorthand.slice(1);
      cursor += shorthand.length;
      continue;
    }
    const name = /^[^\s\u0000-\u001f\u007f-\u009f"'>/=]+/u.exec(remaining)?.[0];
    if (!name) return null;
    cursor += name.length;
    result[name] = true;
    if (source[cursor] !== "=") continue;
    cursor += 1;
    const quote = source[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      let value = "";
      let closed = false;
      while (cursor < source.length) {
        const character = source[cursor++]!;
        if (character === ":") {
          const nested = /^:{1,3}[A-Za-z][\w-]*(?:\[[^\n]*?\])?\{/u.exec(source.slice(cursor - 1));
          const start = nested ? cursor - 1 + nested[0].length - 1 : null;
          const end = start === null ? null : readConversationDirectiveAttributesEnd(source, start);
          if (end !== null) {
            value += source.slice(cursor - 1, end);
            cursor = end;
            continue;
          }
        }
        if (character === "\\" && source[cursor] === quote) {
          value += source[cursor++]!;
          continue;
        }
        if (character === quote) {
          closed = true;
          break;
        }
        value += character;
      }
      if (!closed) return null;
      result[name] = value;
      continue;
    }
    const value = /^[^\s"'`=<>]+/u.exec(source.slice(cursor))?.[0];
    if (!value) return null;
    cursor += value.length;
    // Explicit numeric and boolean literals become strings; valueless flags remain booleans.
    const numeric = Number(value.replace(/_|n$/gu, ""));
    result[name] = value !== "" && Number.isFinite(numeric) ? String(numeric) : value;
  }
  if (classes.length > 0) result.class = classes.join(" ");
  return result;
}

/** Raw header recognition is shared by rendering and source-preserving projections. */
export function readConversationDirectiveHeader(content: string) {
  const name = /^[A-Za-z][\w-]*/u.exec(content)?.[0];
  if (!name) return null;
  let cursor = name.length;
  let text = "";
  if (content[cursor] === "[") {
    const end = content.indexOf("]", cursor + 1);
    if (end < 0 || content.slice(cursor, end).includes("\n")) return null;
    text = content.slice(cursor + 1, end);
    cursor = end + 1;
  }
  let attrs: Record<string, string | boolean> = {};
  if (content[cursor] === "{") {
    const end = readConversationDirectiveAttributesEnd(content, cursor);
    if (end !== null) {
      const decoded = attributes(content.slice(cursor + 1, end - 1));
      if (!decoded) return null;
      attrs = decoded;
      cursor = end;
    }
  }

  return { name, attributes: attrs, text, cursor };
}

function blockStart(source: string, marker: string): number | undefined {
  let index = source.indexOf(marker);
  while (index >= 0) {
    const name = /^[A-Za-z][\w-]*/u.exec(source.slice(index + marker.length))?.[0];
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    const atStart = /^[ \t]*$/u.test(source.slice(lineStart, index));
    if (
      name &&
      atStart &&
      !(index === 0 && (name === "artifact-template" || name === "codex-file-citation"))
    )
      return index;
    index = source.indexOf(marker, index + 1);
  }
  return undefined;
}

function directive(this: TokenizerThis, source: string, marker: ":" | "::" | ":::") {
  if (!source.startsWith(marker)) return undefined;
  const closing = marker === ":::" ? source.indexOf("\n:::") : -1;
  if (marker === ":::" && closing < 0) return undefined;
  const content = source.slice(marker.length, closing < 0 ? undefined : closing);
  const header = readConversationDirectiveHeader(content);
  if (!header) return undefined;
  const container = marker === ":::";
  const text = container ? content.slice(header.cursor) : header.text;
  const raw = container
    ? source.slice(0, closing + 4)
    : source.slice(0, marker.length + header.cursor);
  return {
    type: "codexDirective",
    raw,
    name: header.name,
    attributes: header.attributes,
    block: marker !== ":",
    text,
    tokens: container ? this.lexer.blockTokens(text) : this.lexer.inlineTokens(text),
  };
}

/** These typed nodes carry data only; action authority belongs to mounted domain leaves. */
export const conversationDirectiveExtension: MarkedExtension = {
  extensions: [
    ...([":::", "::"] as const).map((marker) => ({
      name: "codexDirective",
      level: "block" as const,
      start(source: string) {
        return blockStart(source, marker);
      },
      tokenizer(this: TokenizerThis, source: string) {
        return directive.call(this, source, marker);
      },
    })),
    {
      name: "codexDirective",
      level: "inline",
      start(source) {
        const index = source.indexOf(":");
        return index < 0 ? undefined : index;
      },
      tokenizer(source) {
        return directive.call(this, source, ":");
      },
    },
  ],
};
