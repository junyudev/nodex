import { Marked, Tokenizer, type MarkedToken, type Token, type Tokens } from "marked";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { prepareConversationMarkdownDisplay } from "../../../shared/conversation-markdown-display";
import { conversationMathExtension, type ConversationMathToken } from "./conversation-math";
import {
  conversationDirectiveExtension,
  prepareConversationDirectiveClosings,
  type ConversationDirectiveToken,
} from "./conversation-directives";
import {
  createMarkdownCache,
  type ImmutableMarkdown,
  MARKDOWN_SYNTAX_CACHE_MAX_KEYS,
  MARKDOWN_SYNTAX_CACHE_MAX_KEY_UNITS,
  MARKDOWN_SYNTAX_CACHE_MAX_SOURCE_UNITS,
} from "./markdown-cache";
import { findMarkdownStablePrefix } from "./markdown-prefix";
import {
  normalizeConversationTargetTokens,
  tokenizeConversationFileCitation,
} from "./conversation-target-grammar";

export type ConversationToken = ImmutableMarkdown<
  MarkedToken | ConversationMathToken | ConversationDirectiveToken
>;
export interface ConversationTokenDocument {
  readonly source: string;
  readonly tokens: readonly ConversationToken[];
  readonly fullDocument: boolean;
}

export function decodeConversationText(source: string): string {
  return source.replace(/&(#(?:x[\da-f]+|\d+)|[\da-z]+);/giu, (raw, entity: string) => {
    if (entity[0] !== "#") return decodeNamedCharacterReference(entity) || raw;
    const hex = entity[1]?.toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (
      !Number.isFinite(code) ||
      code <= 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return "\ufffd";
    return String.fromCodePoint(code);
  });
}

export function conversationTokenChildren(token: ConversationToken): readonly ConversationToken[] {
  if ("tokens" in token && Array.isArray(token.tokens))
    return token.tokens as readonly ConversationToken[];
  return [];
}

function needsBoundaryNormalization(
  before: readonly ConversationToken[],
  after: readonly ConversationToken[],
): boolean {
  const preceding = before.findLast((token) => token.type !== "space");
  const following = after.find((token) => token.type !== "space");
  const images = (token: ConversationToken | undefined) =>
    token?.type === "paragraph" &&
    token.tokens.length > 0 &&
    token.tokens.every((child) => child.type === "image");
  return (
    (images(preceding) && images(following)) ||
    (preceding?.type === "list" && following?.type === "list")
  );
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function normalizeLists(tokens: Token[]): void {
  const next = (index: number) => {
    while (tokens[index]?.type === "space") index += 1;
    return index;
  };
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const ordered = tokens[index];
    if (ordered?.type !== "list" || !ordered.ordered) continue;
    const first = ordered as Tokens.List;
    const unorderedIndex = next(index + 1);
    const unordered = tokens[unorderedIndex];
    if (unordered?.type !== "list" || unordered.ordered) continue;
    const nested = unordered as Tokens.List;
    const continuationIndex = next(unorderedIndex + 1);
    const continuation = tokens[continuationIndex];
    const last = first.items.at(-1);
    if (!last) continue;
    if (continuation?.type === "list" && continuation.ordered) {
      last.tokens.push(nested);
      first.items.push(...(continuation as Tokens.List).items);
      tokens.splice(unorderedIndex, continuationIndex - unorderedIndex + 1);
      index -= 1;
      continue;
    }
    if (nested.items.length >= 2 || last.text.trim().endsWith(":")) {
      last.tokens.push(nested);
      tokens.splice(unorderedIndex, 1);
      index -= 1;
    }
  }
  for (const token of tokens) {
    if ("tokens" in token && token.tokens) normalizeLists(token.tokens);
    if (token.type !== "list") continue;
    for (const item of (token as Tokens.List).items) {
      const first = item.tokens[0];
      const prefix =
        first?.type === "heading" ? /^#{1,6}\s+/u.exec(first.raw.trimEnd())?.[0] : undefined;
      if (prefix && first?.type === "heading")
        item.tokens[0] = {
          type: "paragraph",
          raw: first.raw,
          text: first.raw.trimEnd(),
          tokens: [{ type: "text", raw: prefix, text: prefix }, ...(first.tokens ?? [])],
        };
      normalizeLists(item.tokens);
    }
  }
}

function mergeImages(tokens: Token[]): void {
  const imageParagraph = (token: Token | undefined): token is Tokens.Paragraph =>
    token?.type === "paragraph" && token.tokens?.length === 1 && token.tokens[0]?.type === "image";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if ("tokens" in token && token.tokens) mergeImages(token.tokens);
    if (token.type === "list")
      for (const item of (token as Tokens.List).items) mergeImages(item.tokens);
    if (!imageParagraph(token)) continue;
    let cursor = index + 1;
    let end = cursor;
    const images = [...token.tokens];
    while (cursor < tokens.length) {
      while (tokens[cursor]?.type === "space") cursor += 1;
      const following = tokens[cursor];
      if (!imageParagraph(following)) break;
      images.push(...following.tokens);
      end = ++cursor;
    }
    if (end === index + 1) continue;
    token.tokens = images;
    token.text = images.map((image) => image.raw).join("\n");
    token.raw = tokens
      .slice(index, end)
      .map((part) => part.raw)
      .join("");
    tokens.splice(index + 1, end - index - 1);
  }
}

function createLexer() {
  return new Marked(conversationDirectiveExtension, conversationMathExtension, {
    breaks: true,
    gfm: true,
    tokenizer: {
      del(source) {
        return source.startsWith("~~") ? false : undefined;
      },
    },
    extensions: [
      {
        name: "codexDirective",
        level: "inline",
        start(source) {
          let index = source.indexOf("【");
          while (index >= 0) {
            if (tokenizeConversationFileCitation(source.slice(index))) return index;
            index = source.indexOf("【", index + 1);
          }
          return undefined;
        },
        tokenizer(source) {
          return tokenizeConversationFileCitation(source);
        },
      },
      {
        name: "skillMention",
        level: "inline",
        start(source) {
          const index = source.indexOf("$");
          return index < 0 ? undefined : index;
        },
        tokenizer(source) {
          const raw = /^\$[\w-]+:[\w-]+/u.exec(source)?.[0];
          return raw ? { type: "text", raw, text: raw } : undefined;
        },
      },
      {
        name: "codexAutolink",
        level: "inline",
        start(source) {
          const index = source.search(/\bcodex:\/\//iu);
          return index < 0 ? undefined : index;
        },
        tokenizer(source) {
          const tokenizer = this.lexer.options.tokenizer;
          if (
            !/^codex:\/\//iu.test(source) ||
            this.lexer.state.inLink ||
            this.lexer.state.inRawBlock ||
            !tokenizer
          )
            return undefined;
          const parsed = Tokenizer.prototype.url.call(tokenizer, `https://${source.slice(8)}`);
          if (!parsed) return undefined;
          const raw = source.slice(0, parsed.raw.length);
          return {
            type: "link",
            raw,
            href: raw,
            text: raw,
            tokens: [{ type: "text", raw, text: raw }],
          };
        },
      },
    ],
  });
}

/** Parsed values are immutable and bounded; neither callbacks nor source authority enter this cache. */
export function createConversationTokenEngine() {
  const lexer = createLexer();
  const caches = [false, true].map(() =>
    createMarkdownCache<ConversationTokenDocument>({
      maxKeys: MARKDOWN_SYNTAX_CACHE_MAX_KEYS,
      maxKeyUnits: MARKDOWN_SYNTAX_CACHE_MAX_KEY_UNITS,
      refreshOnRead: true,
    }),
  );
  let parsedUnits = 0;
  let parseCalls = 0;
  const readPrepared = (source: string, streaming: boolean): ConversationTokenDocument => {
    const cache = caches[streaming ? 1 : 0]!;
    const previous = cache.get(source);
    if (previous) return previous;
    const tokens = lexer.lexer(prepareConversationDirectiveClosings(source));
    parsedUnits += source.length;
    parseCalls += 1;
    void lexer.walkTokens(tokens, (token) => {
      // A code block's trailing line separator is not part of its displayed/copied payload.
      if (token.type === "code" && token.codeBlockStyle === "indented") {
        token.text = token.text.replace(/\n+$/u, "");
      }
      if (
        token.type === "link" &&
        token.raw === token.text &&
        /^mailto:.*@[1-9]\d*x\.(?:png|jpe?g|gif|webp|avif|heic)$/iu.test(token.href)
      )
        Object.assign(token, { type: "text", tokens: undefined });
    });
    if (source.includes("](")) normalizeConversationTargetTokens(tokens);
    normalizeLists(tokens);
    mergeImages(tokens);
    const value = freeze({
      source,
      tokens: tokens as ConversationToken[],
      fullDocument: Object.keys(tokens.links).length > 0,
    });
    if (source.length <= MARKDOWN_SYNTAX_CACHE_MAX_SOURCE_UNITS) cache.set(source, value);
    return value;
  };
  return {
    read(source: string, streaming: boolean): ConversationTokenDocument {
      return readPrepared(
        prepareConversationMarkdownDisplay(source, { streaming, inlineVisualizations: true })
          .source,
        streaming,
      );
    },
    readStreaming(
      source: string,
      prefix: { source: string; length: number; document: ConversationTokenDocument | null },
    ): ConversationTokenDocument {
      const prepared = prepareConversationMarkdownDisplay(source, {
        streaming: true,
        inlineVisualizations: true,
      }).source;
      if (/(?:^|\n) {0,3}(?:\[[^\n]+\]:|<[A-Za-z!/])/u.test(prepared))
        return readPrepared(prepared, true);
      const length = findMarkdownStablePrefix(prepared);
      if (length === 0) return readPrepared(prepared, true);
      const stable = prepared.slice(0, length);
      if (prefix.source !== stable || prefix.length !== length || !prefix.document) {
        const extension =
          prefix.document && stable.startsWith(prefix.source)
            ? readPrepared(stable.slice(prefix.length), true)
            : null;
        if (prefix.document?.fullDocument || extension?.fullDocument)
          return readPrepared(prepared, true);
        const document =
          extension &&
          prefix.document &&
          !needsBoundaryNormalization(prefix.document.tokens, extension.tokens)
            ? freeze({
                source: stable,
                tokens: [...prefix.document.tokens, ...extension.tokens],
                fullDocument: false,
              })
            : readPrepared(stable, true);
        prefix.source = stable;
        prefix.length = length;
        prefix.document = document;
      }
      const tail = readPrepared(prepared.slice(length), true);
      // References can be declared inside containers; lexer metadata is authoritative.
      if (prefix.document.fullDocument || tail.fullDocument) return readPrepared(prepared, true);
      // Adjacent media and continued lists may not straddle the committed prefix.
      if (needsBoundaryNormalization(prefix.document.tokens, tail.tokens))
        return readPrepared(prepared, true);
      return {
        source: prepared,
        tokens: [...prefix.document.tokens, ...tail.tokens],
        fullDocument: false,
      };
    },
    getMeasurements() {
      return { parsedUnits, parseCalls };
    },
  };
}

export const conversationTokenEngine = createConversationTokenEngine();
