import { fromMarkdown } from "mdast-util-from-markdown";

export type MarkdownDisplayDialect = "conversation" | "document";

/** Display preparation never replaces the canonical assistant source. */
export interface ConversationMarkdownDisplayOptions {
  readonly streaming: boolean;
  readonly inlineVisualizations: boolean;
  readonly registeredDirectiveNames?: readonly string[];
}

export interface ConversationMarkdownDisplaySource {
  readonly source: string;
  readonly openCodeFence: boolean | null;
}

export const CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES = [
  "inbox-item",
  "archive-thread",
  "thread-purpose-changed",
  "created-thread",
  "code-comment",
  "git-stage",
  "git-commit",
  "git-create-branch",
  "git-push",
  "git-create-pr",
  "pr-auto-fix-progress",
  "codex-realtime-inline",
] as const;

/** Names affect unfinished display tails, independently of their domain action owners. */
export const CONVERSATION_MARKDOWN_DIRECTIVES: readonly string[] = [
  "artifact-template",
  "codex-file-citation",
  "task-stub",
  "page-preview",
  "github-details",
  ...CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES,
  "codex-inline-vis",
  "codex-live-vis",
  "writing",
  "codex-followup",
  "codex-resource",
];

const hiddenNames = new Set<string>(CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES);
const visualizationNames = ["::codex-inline-vis", "::codex-live-vis"];
const visualizationHeader =
  /^::codex-(?:inline-vis|live-vis)\{(?:file|path)="[^"]+"(?:\s+(?:title="[^"]*"|mode="wide"|expandable="(?:true|false)"))*\}\s*$/;
const visualizationMarker = "\uE200visualize\uE202";
const visualizationMarkerEnd = "\uE201";

function isAbsolutePath(path: string): boolean {
  return (
    (path.startsWith("/") && !path.startsWith("//")) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^\\\\[^\\]+\\[^\\]+/.test(path) ||
    /^\/\/[^/]+\/[^/]+/.test(path)
  );
}

function visualizationDeclaration(marker: string): string | null {
  const json = marker.startsWith("{");
  let value: unknown = { path: marker };
  if (json) {
    try {
      value = JSON.parse(marker);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.path !== null && typeof record.path !== "string") return null;
  if (record.title !== undefined && typeof record.title !== "string") return null;
  if (record.type !== undefined && record.type !== "inline" && record.type !== "live") return null;
  if (record.mode !== undefined && record.mode !== "wide") return null;
  if (record.wide !== undefined && typeof record.wide !== "boolean") return null;
  if (record.path === null) return record.type === "live" ? "::codex-live-vis{}" : null;
  const path = record.path;
  const basename = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const absolute = isAbsolutePath(path);
  if (
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path) ||
    /["\n\r]/.test(path) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(basename) ||
    (!absolute && (json || path !== basename))
  )
    return null;
  const title =
    typeof record.title === "string" && !/["\n\r]/.test(record.title)
      ? ` title="${record.title}"`
      : "";
  const live = record.type === "live";
  const mode = !live && record.mode === "wide" ? ' mode="wide"' : "";
  return `::codex-${live ? "live" : "inline"}-vis{${absolute ? "path" : "file"}="${path}"${title}${mode}}`;
}

export function prepareConversationVisualizationMarkers(source: string): string {
  if (!source.includes(visualizationMarker)) return source;
  // Marker conversion is rare; public authored root nodes identify block-code exclusion.
  const code = fromMarkdown(source).children.flatMap((node) =>
    node.type === "code" && node.position
      ? [{ start: node.position.start.offset!, end: node.position.end.offset! }]
      : [],
  );
  return source.replace(
    /\uE200visualize\uE202([^\uE201]+)\uE201/g,
    (raw, marker: string, offset: number) => {
      if (code.some((range) => range.start <= offset && offset < range.end)) return raw;
      return visualizationDeclaration(marker) ?? raw;
    },
  );
}

function guardVisualizationTail(source: string, streaming: boolean): string {
  const start = source.lastIndexOf("\n") + 1;
  const tail = source.slice(start).trimStart();
  if (!tail) return source;
  const incompleteHeader = visualizationNames.some(
    (name) =>
      (streaming && name.startsWith(tail)) ||
      (tail.startsWith(name) && !visualizationHeader.test(tail)),
  );
  const incompleteMarker =
    (streaming && visualizationMarker.startsWith(tail)) ||
    (tail.startsWith(visualizationMarker) && !tail.endsWith(visualizationMarkerEnd));
  return incompleteHeader || incompleteMarker ? source.slice(0, start) : source;
}

function hideStreamingMetadata(source: string): string {
  if (!source.includes("::")) return source;
  const lines = source.split("\n");
  return lines
    .filter((line, index) => {
      const text = line.trimStart();
      if (!text.startsWith("::") || text.startsWith(":::")) return true;
      const name = /^::([A-Za-z\d_-]*)/.exec(text)![1]!;
      if (index === lines.length - 1 && text.length === name.length + 2)
        return !CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES.some((candidate) =>
          candidate.startsWith(name),
        );
      return !hiddenNames.has(name);
    })
    .join("\n");
}

export interface ConversationMarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

export function readConversationMarkdownFence(
  previous: ConversationMarkdownFence | null,
  line: string,
): ConversationMarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return previous;
  const marker = match[1]![0] as ConversationMarkdownFence["marker"];
  if (previous)
    return marker === previous.marker && match[1]!.length >= previous.length && !match[2]!.trim()
      ? null
      : previous;
  if (marker === "`" && match[2]!.includes("`")) return null;
  return { marker, length: match[1]!.length };
}

function isEscaped(source: string, offset: number): boolean {
  let count = 0;
  for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) count += 1;
  return count % 2 === 1;
}

function hasOpenFence(source: string): boolean {
  let fence: ConversationMarkdownFence | null = null;
  for (const line of source.split("\n"))
    fence = readConversationMarkdownFence(fence, line.trimStart());
  return fence !== null;
}

function scanCodeSpans(source: string, cursor: number, limit: number, span: number | null) {
  while (cursor < limit) {
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (source[end] === "`") end += 1;
    const length = end - cursor;
    if (span === length) span = null;
    else if (span === null && !isEscaped(source, cursor)) span = length;
    cursor = end;
  }
  return { cursor, span };
}

function readOpenCodeSpan(source: string): number | null {
  let fence: ConversationMarkdownFence | null = null;
  let span: number | null = null;
  for (const line of source.split("\n")) {
    const inside = fence !== null;
    fence = readConversationMarkdownFence(fence, line.trimStart());
    if (inside || fence !== null) continue;
    span = scanCodeSpans(line, 0, line.length, span).span;
  }
  return span;
}

function directiveAttributesStart(source: string, offset: number): number | null {
  if (source[offset] !== ":") return null;
  let index = offset;
  while (source[index] === ":" && index - offset < 3) index += 1;
  if (!/[A-Za-z]/.test(source[index] ?? "")) return null;
  index += 1;
  while (/[A-Za-z\d_-]/.test(source[index] ?? "")) index += 1;
  if (source[index] === "[") {
    index += 1;
    while (index < source.length && source[index] !== "]" && source[index] !== "\n") index += 1;
    if (source[index] !== "]") return null;
    index += 1;
  }
  return source[index] === "{" ? index : null;
}

/** A complete quoted attribute group may contain a nested directive. */
function hasCompleteDirective(source: string, offset: number): boolean {
  const start = directiveAttributesStart(source, offset);
  if (start === null) return false;
  let quote: string | null = null;
  const nestedQuotes: string[] = [];
  for (let index = start + 1; index < source.length; index += 1) {
    const value = source[index]!;
    if (value === "\n") return false;
    if (quote === null) {
      const previous = nestedQuotes.at(-1);
      if (previous && value === "\\" && source[index + 1] === previous) {
        nestedQuotes.pop();
        quote = previous;
        continue;
      }
      if (value === '"' || value === "'") quote = value;
      else if (value === "}") {
        const previous = nestedQuotes.pop();
        if (previous === undefined) return true;
        quote = previous;
      }
      continue;
    }
    if (value === ":" && directiveAttributesStart(source, index) !== null) {
      nestedQuotes.push(quote);
      quote = null;
      continue;
    }
    if (value === "\\" && source[index + 1] === quote) {
      index += 1;
      continue;
    }
    if (value === quote) quote = null;
  }
  return false;
}

function hideIncompleteDirective(source: string, names: readonly string[]): string {
  const lastLine = source.slice(source.lastIndexOf("\n") + 1);
  if (/^(?: {4}|\t)/.test(lastLine)) return source;
  for (const name of names) {
    let offset = source.lastIndexOf(`:${name}`);
    if (offset < 0 || source[offset + name.length + 1] !== "{") continue;
    while (offset > 0 && source[offset - 1] === ":") offset -= 1;
    if (
      source.slice(offset).includes("\n") ||
      isEscaped(source, offset) ||
      hasCompleteDirective(source, offset) ||
      readOpenCodeSpan(source.slice(0, offset)) !== null
    )
      continue;
    return source.slice(0, offset);
  }
  return source;
}

function findBalancedEnd(
  source: string,
  start: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let quote: string | null = null;
  let span: number | null = null;
  for (let index = start; index < source.length; index += 1) {
    const value = source[index]!;
    if (open === "[" && value === "`") {
      let end = index + 1;
      while (source[end] === "`") end += 1;
      const length = end - index;
      if (span === length) span = null;
      else span ??= length;
      index = end - 1;
      continue;
    }
    if (span !== null) continue;
    if (value === "\\") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (value === quote) quote = null;
      continue;
    }
    if (
      open === "(" &&
      (index === start + 1 || /\s/.test(source[index - 1] ?? "")) &&
      (value === "<" || value === '"' || value === "'")
    ) {
      quote = value === "<" ? ">" : value;
      continue;
    }
    if (value === open) depth += 1;
    else if (value === close && --depth === 0) return index;
  }
  return null;
}

function hideIncompleteLink(source: string): string {
  const lineStart = source.lastIndexOf("\n") + 1;
  const first = source.indexOf("[", lineStart);
  if (
    first < 0 ||
    /^(?: {4}|\t)/.test(source.slice(lineStart)) ||
    hasOpenFence(source.slice(0, lineStart))
  )
    return source;
  const listPrefix = /^\s*(?:[-+*]|\d+[.)])\s+/.exec(source.slice(lineStart))?.[0];
  let span = readOpenCodeSpan(source.slice(0, first));
  let cursor = first;
  const fence = readConversationMarkdownFence(null, source.slice(lineStart, first).trimStart());
  const closeFence = fence?.marker === "`" ? source.indexOf("`", first) : -1;
  let insideFence = fence !== null;
  for (let offset = first; offset !== -1; offset = source.indexOf("[", offset + 1)) {
    if (insideFence && closeFence !== -1 && offset > closeFence) {
      span = readOpenCodeSpan(source.slice(0, offset));
      cursor = offset;
      insideFence = false;
    }
    if (!insideFence) ({ cursor, span } = scanCodeSpans(source, cursor, offset, span));
    if (span !== null || isEscaped(source, offset) || source[offset - 1] === "!") continue;
    let nameStart = offset;
    while (nameStart > lineStart && /[\w-]/.test(source[nameStart - 1] ?? "")) nameStart -= 1;
    if (nameStart < offset && source[nameStart - 1] === ":") continue;
    const end = findBalancedEnd(source, offset, "[", "]");
    if (
      end !== null &&
      listPrefix !== undefined &&
      offset === lineStart + listPrefix.length &&
      /^\[[ xX]\]$/.test(source.slice(offset, end + 1))
    ) {
      offset = end;
      continue;
    }
    if (end === null || end === source.length - 1) return source.slice(0, offset);
    const next = source[end + 1];
    if (next !== "(" && next !== "[") {
      offset = end;
      continue;
    }
    const targetEnd = findBalancedEnd(source, end + 1, next, next === "(" ? ")" : "]");
    if (targetEnd === null) return source.slice(0, offset);
    offset = targetEnd;
  }
  return source;
}

function isAdjacentDelimiter(source: string, offset: number, marker: string): boolean {
  return marker.length === 1 && (source[offset - 1] === marker || source[offset + 1] === marker);
}

function readDelimiterState(source: string, marker: string): { count: number; last: number } {
  let count = 0;
  let last = -1;
  for (let offset = 0; offset <= source.length - marker.length;) {
    if (
      !source.startsWith(marker, offset) ||
      isEscaped(source, offset) ||
      isAdjacentDelimiter(source, offset, marker)
    ) {
      offset += 1;
      continue;
    }
    count += 1;
    offset += marker.length;
  }
  for (let offset = source.length - marker.length; offset >= 0; offset -= 1) {
    if (
      !source.startsWith(marker, offset) ||
      isEscaped(source, offset) ||
      isAdjacentDelimiter(source, offset, marker)
    )
      continue;
    last = offset;
    break;
  }
  return { count, last };
}

function closeStreamingEmphasis(source: string, marker: "*" | "**"): string {
  if (!source.includes(marker)) return source;
  const state = readDelimiterState(source, marker);
  if (state.count % 2 === 0 || state.last < 0) return source;
  const tail = source.slice(state.last + marker.length);
  if (!tail || /^\s/.test(tail) || tail.includes("\n") || readOpenCodeSpan(tail) !== null)
    return source;
  const trimmed = source.trimEnd();
  const closer =
    marker === "**" &&
    trimmed.endsWith("*") &&
    !isEscaped(trimmed, trimmed.length - 1) &&
    readDelimiterState(trimmed, "*").count % 2 === 1
      ? "*"
      : marker;
  return trimmed + closer + source.slice(trimmed.length);
}

function prepareStreamingTail(
  source: string,
  names: readonly string[],
): ConversationMarkdownDisplaySource {
  let prepared = source.replace(/\uE200[^\uE201]*$/, "");
  if (!prepared || (prepared.includes("`") && readOpenCodeSpan(prepared) !== null))
    return { source: hideIncompleteLink(prepared), openCodeFence: false };
  if ((prepared.includes("```") || prepared.includes("~~~")) && hasOpenFence(prepared))
    return { source: prepared, openCodeFence: true };
  const followup = prepared.lastIndexOf(":codex-followup[");
  if (
    followup >= prepared.lastIndexOf("\n") + 1 &&
    !hasCompleteDirective(prepared, followup) &&
    !isEscaped(prepared, followup) &&
    readOpenCodeSpan(prepared.slice(0, followup)) === null
  )
    prepared = prepared.slice(0, followup);
  prepared = hideIncompleteDirective(prepared, names);
  if (prepared.includes("!["))
    prepared = prepared.replace(/(^|\n)[^\S\n]*!\[[^\]\n]*(?:\](?:\([^\)\n]*)?)?\s*$/, "$1");
  prepared = hideIncompleteLink(prepared);
  prepared = closeStreamingEmphasis(closeStreamingEmphasis(prepared, "*"), "**");
  return { source: prepared, openCodeFence: false };
}

/** Front metadata stays visible; its closing rule cannot turn a metadata value into a heading. */
function prepareMetadataBoundary(source: string): string {
  const first = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const openingEnd = source.indexOf("\n", first);
  if (openingEnd < 0 || !/^-{3,}$/.test(source.slice(first, openingEnd).trim())) return source;
  let start = openingEnd + 1;
  let metadata = false;
  while (start < source.length) {
    const end = source.indexOf("\n", start);
    const line = source.slice(start, end < 0 ? undefined : end);
    if (/^-{3,}$/.test(line.trim()))
      return metadata ? source.slice(0, start) + "\n" + source.slice(start) : source;
    if (line.trim() && !line.trim().startsWith("#") && !/^[ \t]/.test(line)) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon).trim();
      if (colon > 0 && key && !key.startsWith("-")) metadata = true;
    }
    if (end < 0) return source;
    start = end + 1;
  }
  return source;
}

export function prepareConversationMarkdownDisplay(
  source: string,
  options: ConversationMarkdownDisplayOptions,
): ConversationMarkdownDisplaySource {
  let prepared = source.replace(/\r\n?/g, "\n");
  if (options.inlineVisualizations)
    prepared = guardVisualizationTail(
      prepareConversationVisualizationMarkers(prepared),
      options.streaming,
    );
  const result = options.streaming
    ? prepareStreamingTail(
        hideStreamingMetadata(prepared),
        options.registeredDirectiveNames ??
          (options.inlineVisualizations
            ? CONVERSATION_MARKDOWN_DIRECTIVES
            : CONVERSATION_MARKDOWN_DIRECTIVES.filter(
                (name) => name !== "codex-inline-vis" && name !== "codex-live-vis",
              )),
      )
    : { source: prepared, openCodeFence: null };
  return { ...result, source: prepareMetadataBoundary(result.source) };
}
