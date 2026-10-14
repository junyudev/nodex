import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes } from "mdast";
import { readConversationDirectiveHeader } from "../../lib/markdown/conversation-directives";
import {
  CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES,
  prepareConversationVisualizationMarkers,
  readConversationMarkdownFence,
  type ConversationMarkdownFence,
} from "../../../shared/conversation-markdown-display";
import {
  isResourceInsideProjectlessOutputDirectory,
  type ProjectlessOutputScope,
} from "./projection/projectless-output-scope";

interface SourceRange {
  readonly start: number;
  readonly end: number;
}
interface CopyRootToken {
  readonly kind: "source" | "space" | "visualization";
  readonly raw: string;
}
const visualizationName = /^::(codex-inline-vis|codex-live-vis)(?![\w-])/;
const blockDeclaration = /^::((?:[a-zA-Z][\w-]*|[\{\[].*?[\}\]])+)/;
const hiddenDirectiveNames = new Set<string>(CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES);

function parseSource(source: string) {
  return fromMarkdown(source, {
    extensions: [gfm({ singleTilde: false }), directive()],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
  });
}
function sourceRange(node: Nodes): SourceRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/** Action metadata never enters whole-response Copy; authored examples stay literal. */
function omitHiddenDirectiveLines(source: string): string {
  if (!source.includes("::")) return source;
  const root = parseSource(source);
  const declarations = [...source.matchAll(/^ {0,3}::(?!:)[^\r\n]*/gm)].flatMap((line) => {
    const content = line[0].trimStart().slice(2);
    const header = readConversationDirectiveHeader(content);
    if (!header || !hiddenDirectiveNames.has(header.name) || content.slice(header.cursor).trim())
      return [];
    return [{ start: line.index, end: line.index + line[0].length }];
  });
  if (declarations.length === 0) return source;
  const protectedRanges = [
    ...mathSourceRanges(source, root),
    ...root.children.flatMap((node) => {
      if (node.type === "paragraph" || node.type === "leafDirective") return [];
      const range = sourceRange(node);
      return range ? [range] : [];
    }),
  ];
  const protectInlineCode = (node: Nodes): void => {
    if (node.type === "code") return;
    if (node.type === "inlineCode") {
      const range = sourceRange(node);
      if (range) protectedRanges.push(range);
      return;
    }
    if ("children" in node) node.children.forEach(protectInlineCode);
  };
  // Action block syntax can interrupt multiline code spans. Copy protects the
  // authored code before admitting that syntax, independently of body rendering.
  if (source.includes("`")) protectInlineCode(fromMarkdown(source));
  const isProtected = (offset: number) =>
    protectedRanges.some((range) => range.start <= offset && offset < range.end);
  // Raw conversation headers can admit escaped attributes that the document
  // parser does not recognize. Their container bodies remain authored examples.
  for (const opening of source.matchAll(/^ {0,3}:::[A-Za-z][^\r\n]*/gm)) {
    if (isProtected(opening.index)) continue;
    if (!readConversationDirectiveHeader(opening[0].trimStart().slice(3))) continue;
    const bodyStart = opening.index + opening[0].length;
    const closing = [
      ...source.slice(bodyStart).matchAll(/(?:\r\n?|\n)[ \t]*:::[ \t]*(?=\r\n?|\n|$)/g),
    ].find((candidate) => !isProtected(bodyStart + candidate.index));
    if (!closing) continue;
    protectedRanges.push({
      start: opening.index,
      end: bodyStart + closing.index + closing[0].length,
    });
  }
  let cursor = 0;
  const retained: string[] = [];
  for (const declaration of declarations) {
    if (isProtected(declaration.start)) continue;
    const start =
      Math.max(
        source.lastIndexOf("\n", declaration.start - 1),
        source.lastIndexOf("\r", declaration.start - 1),
      ) + 1;
    let end = declaration.end;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
    if (source[end] === "\r" && source[end + 1] === "\n") end += 2;
    else if (end < source.length) end += 1;
    retained.push(source.slice(cursor, start));
    cursor = end;
  }
  retained.push(source.slice(cursor));
  return retained.join("").trim();
}

/** Math tokens have no recursively parsed directive labels. */
function mathSourceRanges(source: string, root: Nodes): SourceRange[] {
  const ranges: SourceRange[] = [];
  const code: SourceRange[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const range = sourceRange(node);
      if (range) code.push(range);
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  const isUnavailable = (offset: number) =>
    [...code, ...ranges].some((range) => range.start <= offset && offset < range.end);
  for (const opener of source.matchAll(/^ {0,3}(\\\[|\${2,})(.*)$/gm)) {
    if (isUnavailable(opener.index)) continue;
    const marker = opener[1]!;
    if (opener[2]!.includes(marker === "\\[" ? "]" : "$")) continue;
    let end = source.length;
    for (const closer of source
      .slice(opener.index + opener[0].length)
      .matchAll(/\n( {0,3})(\\\]|\${2,})[ \t]*(?=\n|$)/g)) {
      if (marker === "\\[" ? closer[2] !== "\\]" : closer[2]!.length < marker.length) continue;
      end = opener.index + opener[0].length + closer.index + closer[0].length;
      break;
    }
    ranges.push({ start: opener.index, end });
  }
  const openers = /\\\(|\\\[|\${2,}/g;
  for (let opener = openers.exec(source); opener; opener = openers.exec(source)) {
    if (isUnavailable(opener.index)) continue;
    let escape = opener.index;
    while (escape > 0 && source[escape - 1] === "\\") escape -= 1;
    if ((opener.index - escape) % 2 === 1) continue;
    const marker = opener[0];
    const closing = marker === "\\(" ? "\\)" : marker === "\\[" ? "\\]" : marker;
    let end = source.indexOf(closing, opener.index + marker.length);
    if (marker.startsWith("$") && end !== -1) {
      const suffix = source.slice(opener.index + marker.length);
      const match = [...suffix.matchAll(/\$+/g)].find((match) => match[0].length === marker.length);
      end = match ? opener.index + marker.length + match.index : -1;
    }
    if (end === -1) continue;
    ranges.push({ start: opener.index, end: end + closing.length });
    openers.lastIndex = end + closing.length;
  }
  return ranges;
}

/** Only root visualization tokens are omitted; nested blocks retain their authored source. */
function omitRootVisualizations(authored: string): string {
  if (!authored.includes("::codex-inline-vis") && !authored.includes("::codex-live-vis"))
    return authored;
  const source = authored.replace(/\r\n?/g, "\n");
  const root = parseSource(source);
  const paragraphStarts = new Set(
    root.children.flatMap((node) =>
      node.type === "paragraph" && node.position?.start.offset !== undefined
        ? [node.position.start.offset]
        : [],
    ),
  );
  const protectedRanges = [
    ...mathSourceRanges(source, root),
    ...root.children.flatMap((node) => {
      if (node.type === "paragraph" || node.type === "leafDirective") return [];
      const range = sourceRange(node);
      if (node.type === "table" && range && visualizationName.test(source.slice(range.start))) {
        const declaration = blockDeclaration.exec(source.slice(range.start))?.[0];
        if (declaration) return [{ start: range.start + declaration.length, end: range.end }];
      }
      return range ? [range] : [];
    }),
  ];
  const isProtected = (offset: number) =>
    protectedRanges.some((range) => range.start <= offset && offset < range.end);
  const removed: SourceRange[] = [];
  // Registered block tokens can interrupt a paragraph at a new line. A leading
  // code-span delimiter or escape is a separate root text token, not a block fence.
  for (const line of source.matchAll(/(?:^|\n)( {0,3}|`|\\)(::[^\n]*)/g)) {
    const lineStart = line.index + (line[0].startsWith("\n") ? 1 : 0);
    if ((line[1] === "`" || line[1] === "\\") && !paragraphStarts.has(lineStart)) continue;
    const start = lineStart + line[1]!.length;
    if (isProtected(start) || !visualizationName.test(line[2]!)) continue;
    const declaration = blockDeclaration.exec(line[2]!)?.[0];
    if (!declaration) continue;
    let end = start + declaration.length;
    if (source[end] === "\n" && source[end + 1] !== "\n") end += 1;
    removed.push({ start, end });
  }
  if (removed.length === 0) return authored;

  const tokens: CopyRootToken[] = [];
  const appendSource = (start: number, end: number) => {
    let cursor = start;
    for (const gap of source.slice(start, end).matchAll(/\n{2,}/g)) {
      const gapStart = start + gap.index;
      if (isProtected(gapStart)) continue;
      if (cursor < gapStart) tokens.push({ kind: "source", raw: source.slice(cursor, gapStart) });
      tokens.push({ kind: "space", raw: gap[0] });
      cursor = gapStart + gap[0].length;
    }
    if (cursor < end) tokens.push({ kind: "source", raw: source.slice(cursor, end) });
  };
  let cursor = 0;
  for (const range of removed) {
    appendSource(cursor, range.start);
    tokens.push({ kind: "visualization", raw: source.slice(range.start, range.end) });
    cursor = range.end;
  }
  appendSource(cursor, source.length);
  const retained = tokens.filter((token) => token.kind !== "visualization");
  return retained
    .filter(
      (token, index) =>
        token.kind !== "space" ||
        (index > 0 && index < retained.length - 1 && retained[index - 1]?.kind !== "space"),
    )
    .map((token) => token.raw)
    .join("");
}

function readableCitationPath(raw: string): string | null {
  const prefixed = raw.startsWith("F:");
  const path = prefixed ? raw.slice(2).trim() : raw;
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // Malformed escapes remain readable without a second decoding pass.
  }
  if (prefixed) return decoded.length > 0 ? decoded : null;
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/.test(decoded)
    ? decoded
    : null;
}
function prepareFileCitations(source: string, scope: ProjectlessOutputScope): string {
  return source.replace(
    /【([^†】\n]+)†L(\d+)(?:-L(\d+))?】/g,
    (raw, path: string, start: string, end?: string) => {
      const readable = readableCitationPath(path.trim());
      if (readable === null) return raw;
      if (
        !isResourceInsideProjectlessOutputDirectory({
          ...scope,
          cwd: scope.cwd,
          projectlessOutputDirectory: scope.projectlessOutputDirectory,
          resourcePath: readable,
        })
      )
        return "";
      const first = Number.parseInt(start, 10);
      const last = end === undefined ? first : Number.parseInt(end, 10);
      if (last !== first) return `${readable}:${first}-${last}`;
      return first === 1 ? readable : `${readable}:${first}`;
    },
  );
}

function prepareFollowUpLabels(source: string): string {
  if (!source.includes(":codex-followup[")) return source;
  const root = parseSource(source);
  const protectedRanges: SourceRange[] = mathSourceRanges(source, root);
  const headings: SourceRange[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const range = sourceRange(node);
      if (range) protectedRanges.push(range);
      return;
    }
    if (node.type === "heading") {
      const range = sourceRange(node);
      if (range) headings.push(range);
    }
    if (node.type === "definition") {
      const range = sourceRange(node);
      if (range) protectedRanges.push(range);
      return;
    }
    if (node.type === "link" || node.type === "image") {
      const range = sourceRange(node);
      if (range) {
        const destination = source.slice(range.start, range.end).indexOf("](");
        if (destination >= 0)
          protectedRanges.push({ start: range.start + destination + 2, end: range.end });
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  let cursor = 0;
  const result: string[] = [];
  const candidates = /:{1,2}codex-followup(?![\w-])\[/g;
  for (let candidate = candidates.exec(source); candidate; candidate = candidates.exec(source)) {
    let start = candidate.index;
    if (protectedRanges.some((range) => range.start <= start && start < range.end)) continue;
    let escape = start;
    while (escape > 0 && source[escape - 1] === "\\") escape -= 1;
    if ((start - escape) % 2 === 1) continue;
    if (
      source.startsWith("::", start) &&
      headings.some((range) => range.start <= start && start < range.end)
    )
      start += 1;
    // Clipboard labels use the registered directive token's authored text rather
    // than rendered descendants; a nested bracket may terminate that raw token.
    const token = /^:{1,2}codex-followup((?:[a-zA-Z][\w-]*|\{.*?\}+|\[.*?\])+)/.exec(
      source.slice(start),
    );
    const rawLabel = token?.[1] ? /^(?:\[.*?\])+/.exec(token[1])?.[0] : undefined;
    const label = rawLabel?.slice(1, -1);
    if (!token || label === undefined) continue;
    const end = start + token[0].length;
    result.push(source.slice(cursor, start), label);
    cursor = end;
    candidates.lastIndex = end;
  }
  result.push(source.slice(cursor));
  return result.join("");
}

function unwrapWritingBlocks(source: string): string {
  if (!source.includes(":::writing")) return source;
  let fence: ConversationMarkdownFence | null = null;
  let writing = false;
  return source
    .split("\n")
    .filter((line) => {
      const previous = fence;
      fence = readConversationMarkdownFence(fence, line);
      if (previous || fence) return true;
      if (/^ {0,3}:::writing(?:\{.*)?\s*$/.test(line)) {
        writing = true;
        return false;
      }
      if (writing && /^ {0,3}:::\s*$/.test(line)) {
        writing = false;
        return false;
      }
      return true;
    })
    .join("\n");
}

/** Whole-message Copy consumes projected Markdown, independently of display and code Copy. */
export function normalizeMessageCopyText(
  markdown: string,
  scope: ProjectlessOutputScope = {},
): string {
  const source = omitRootVisualizations(
    omitHiddenDirectiveLines(prepareConversationVisualizationMarkers(markdown.trim())),
  );
  const citations = source.replace(/\uE200[^\uE201]*\uE201/g, "");
  return unwrapWritingBlocks(prepareFollowUpLabels(prepareFileCitations(citations, scope)));
}
