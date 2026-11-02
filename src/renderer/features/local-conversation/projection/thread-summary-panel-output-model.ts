import type { WorkspacePathState } from "../../../../shared/types";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { getCodexFileChangeEntries } from "../../../../shared/codex-file-change";
import {
  isResourceInsideProjectlessOutputDirectory,
  normalizePathSegments,
  resolveOutputPath,
} from "./projectless-output-scope";
import { readTurnArtifactReferences } from "./turn-artifact-citations";

type ProtocolImageGenerationItem = Extract<ThreadItem, { type: "imageGeneration" }>;
type ProtocolImageViewItem = Extract<ThreadItem, { type: "imageView" }>;

type ThreadSummaryPanelPathOutputKind = "file" | "generated-image" | "image";
type GoogleDriveResourceKind = "document" | "spreadsheet" | "presentation" | "drive";

interface ThreadSummaryPanelPathOutputDraft {
  kind: ThreadSummaryPanelPathOutputKind;
  path: string;
}

interface ThreadSummaryPanelWebsiteOutputDraft {
  kind: "website";
  target: string;
}

interface ThreadSummaryPanelGoogleDriveOutputDraft {
  kind: "google-drive";
  url: string;
  title: string;
  resourceKind: GoogleDriveResourceKind;
}

interface ThreadSummaryPanelAppgenOutputDraft {
  kind: "appgen-app";
  projectId: string;
  url: string;
  title: string | null;
}

type ThreadSummaryPanelOutputDraft =
  | ThreadSummaryPanelPathOutputDraft
  | ThreadSummaryPanelWebsiteOutputDraft
  | ThreadSummaryPanelGoogleDriveOutputDraft
  | ThreadSummaryPanelAppgenOutputDraft;

interface ThreadSummaryPanelOutputRowBase {
  id: string;
  label: string;
  title: string;
}

export interface ThreadSummaryPanelPathOutputRow extends ThreadSummaryPanelOutputRowBase {
  kind: ThreadSummaryPanelPathOutputKind;
  path: string;
}

export interface ThreadSummaryPanelWebsiteOutputRow extends ThreadSummaryPanelOutputRowBase {
  kind: "website";
  target: string;
}

export interface ThreadSummaryPanelGoogleDriveOutputRow extends ThreadSummaryPanelOutputRowBase {
  kind: "google-drive";
  url: string;
  resourceKind: GoogleDriveResourceKind;
}

export interface ThreadSummaryPanelAppgenOutputRow extends ThreadSummaryPanelOutputRowBase {
  kind: "appgen-app";
  projectId: string;
  url: string;
}

export type ThreadSummaryPanelOutputRow =
  | ThreadSummaryPanelPathOutputRow
  | ThreadSummaryPanelWebsiteOutputRow
  | ThreadSummaryPanelGoogleDriveOutputRow
  | ThreadSummaryPanelAppgenOutputRow;

export type ThreadSummaryPanelOutputOpenTarget =
  | { type: "file"; path: string }
  | { type: "url"; url: string };

export interface TurnOutputOptions {
  cwd?: string | null;
  projectlessOutputDirectory?: string | null;
  pathStates?: ReadonlyMap<string, WorkspacePathState | null>;
}

interface MarkdownLink {
  label: string;
  destination: string;
}

interface MarkdownParseResult {
  value: string;
  nextIndex: number;
}

interface MarkdownLinkParseResult {
  label: string;
  destination: string;
  nextIndex: number;
}

interface AppgenArtifactCandidate {
  projectId: string;
  url: string;
  title: string | null;
}

interface GoogleDriveResource {
  kind: GoogleDriveResourceKind;
  key: string;
}

interface ThreadSummaryPanelTurnArtifacts {
  editedFilePaths: string[];
  outputFilePaths: string[];
  referencedFilePaths: string[];
}

export const MAX_SUMMARY_PANEL_OUTPUT_ROWS = 5;
const IMAGE_EXTENSION_PATTERN = /\.(?:apng|avif|gif|jpe?g|png|svg|webp)$/iu;
const FILE_REFERENCE_PATTERN = /\u3010([^\u2020\u3011\n]+)\u2020L\d+(?:-L\d+)?\u3011/gu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>)"'`]+/giu;
const URL_TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/u;
const LOCAL_URL_UNSAFE_PATH_PATTERN = /[()[\]]/u;
const APPGEN_MCP_SERVER = "codex_apps";
const APPGEN_MCP_TOOL_PATTERN = /^sites[._]/u;
const MARKDOWN_LINK_ESCAPABLE_CHARACTERS = new Set(" !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
const OUTPUT_FILE_EXTENSIONS = new Set([
  "avif",
  "csv",
  "doc",
  "docx",
  "gif",
  "htm",
  "html",
  "xhtml",
  "jpeg",
  "jpg",
  "md",
  "mdx",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "tsv",
  "webp",
  "xls",
  "xlsm",
  "xlsx",
]);
const LINK_OUTPUT_EXTENSIONS = new Set(["docx", "pdf", "tex", "pptx", "xlsx"]);
const OUTPUT_KIND_PRIORITY: Record<ThreadSummaryPanelPathOutputKind | "website", number> = {
  file: 0,
  image: 1,
  website: 2,
  "generated-image": 3,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readTrimmedString(record: Record<string, unknown> | null, key: string): string | null {
  const value = readString(record, key)?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const name = normalized.split("/").filter(Boolean).at(-1);
  return name ?? path;
}

function normalizePath(value: string | null): string | null {
  const path = value?.trim();
  return path ? path : null;
}

function decodePath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function decodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeArtifactPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.startsWith("F:") ? trimmed.slice(2).trim() : trimmed;
  const decoded = normalizePath(decodePath(withoutPrefix));
  if (!decoded) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded) && !/^[A-Za-z]:[\\/]/u.test(decoded)) return null;

  return normalizePathSegments(decoded);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value.trim();
  }
}

function normalizeUrlForComparison(value: string): string {
  return normalizeUrl(value).toLowerCase();
}

function stripUrlTrailingPunctuation(value: string): string {
  return value.replace(URL_TRAILING_PUNCTUATION_PATTERN, "");
}

function normalizeOutputExtension(path: string): string | null {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return null;
  return name.slice(index + 1);
}

function hasDeliverableExtension(path: string): boolean {
  const extension = normalizeOutputExtension(path);
  return extension !== null && OUTPUT_FILE_EXTENSIONS.has(extension);
}

function normalizeMarkdownOutputPath(
  rawDestination: string,
  cwd: string | null | undefined,
): string | null {
  const destination = decodePath(rawDestination.trim());
  if (!destination || destination.startsWith("#")) return null;

  if (destination.startsWith("file://")) {
    try {
      const url = new URL(destination);
      const filePath = decodeUriComponent(url.pathname);
      return normalizePath(filePath);
    } catch {
      return null;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/iu.test(destination) && !/^[A-Za-z]:[\\/]/u.test(destination)) {
    return null;
  }

  const path = normalizePath(destination.split(/[?#]/u)[0] ?? "");
  if (!path) return null;
  return resolveOutputPath(path, cwd);
}

function getGoogleDriveResource(url: URL): GoogleDriveResource | null {
  const kind =
    url.hostname === "docs.google.com"
      ? url.pathname.startsWith("/document/")
        ? "document"
        : url.pathname.startsWith("/spreadsheets/")
          ? "spreadsheet"
          : url.pathname.startsWith("/presentation/")
            ? "presentation"
            : null
      : url.hostname === "sheets.google.com"
        ? "spreadsheet"
        : url.hostname === "slides.google.com"
          ? "presentation"
          : url.hostname === "drive.google.com"
            ? "drive"
            : null;

  if (!kind) return null;

  const id =
    url.pathname.match(/\/(?:d|folders)\/(?:e\/)?([^/]+)/u)?.[1] ??
    url.searchParams.get("id") ??
    url.href;
  return {
    kind,
    key: `${kind}:${id}`,
  };
}

function resolveGoogleDriveResource(value: string): GoogleDriveResource | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return getGoogleDriveResource(url);
  } catch {
    return null;
  }
}

function collectGoogleDriveTitleMap(turn: CodexConversationTurn): Map<string, string> {
  const titles = new Map<string, string>();

  for (const item of turn.items) {
    const result = item.mcpToolCall?.result;
    if (result?.type !== "success") continue;

    const structuredContent = asRecord(result.structuredContent);
    const title =
      readTrimmedString(structuredContent, "title") ??
      readTrimmedString(structuredContent, "display_title") ??
      readTrimmedString(structuredContent, "name") ??
      readTrimmedString(asRecord(structuredContent?.properties), "title");
    if (!title) continue;

    for (const key of GOOGLE_DRIVE_RESULT_URL_KEYS) {
      const url = readTrimmedString(structuredContent, key);
      if (!url) continue;
      const resource = resolveGoogleDriveResource(url);
      if (resource) titles.set(resource.key, title);
    }
  }

  return titles;
}

const GOOGLE_DRIVE_RESULT_URL_KEYS = [
  "documentUrl",
  "document_url",
  "fileUrl",
  "file_url",
  "presentationUrl",
  "presentation_url",
  "spreadsheetUrl",
  "spreadsheet_url",
  "display_url",
  "url",
  "webViewLink",
  "web_view_link",
];
const GOOGLE_DRIVE_READ_TOOLS = new Set(
  "export_file.fetch.find_document_text_range.get_document.get_document_comments.get_document_paragraph_range.get_document_tables.get_document_text.get_file_metadata.get_presentation.get_presentation_comments.get_presentation_outline.get_presentation_tables.get_presentation_text.get_profile.get_slide.get_slide_thumbnail.get_spreadsheet_cells.get_spreadsheet_comments.get_spreadsheet_metadata.get_spreadsheet_range.list_drives.list_folder.recent_documents.search.search_spreadsheet_rows".split(
    ".",
  ),
);
const GOOGLE_DRIVE_WRITE_TOOLS = new Set([
  "batch_update_document",
  "batch_update_presentation",
  "batch_update_spreadsheet",
  "copy_file",
  "create_file",
  "create_folder",
  "create_presentation_from_template",
  "delete_file",
  "duplicate_sheet_in_new_spreadsheet",
  "import_document",
  "import_presentation",
  "import_spreadsheet",
  "share_file",
]);

function collectGoogleDriveReadPolicy(turn: CodexConversationTurn): {
  readResourceKeys: ReadonlySet<string>;
  suppressUnmatchedReadResources: boolean;
} {
  const readResourceKeys = new Set<string>();
  const writtenResourceKeys = new Set<string>();
  let hasRead = false;
  let hasWrite = false;
  let hasUnknown = false;
  const isDrive = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .includes("google-drive");
  for (const item of turn.items) {
    const call = item.mcpToolCall;
    if (call?.result?.type !== "success") continue;
    const original = call.invocation.tool.trim();
    const tool = original
      .replace(/^google[\s_-]+drive(?:[\s_-]+app)?[.\s_-]+/iu, "")
      .replace(/^(.+)\.([^.]*)$/u, (match, prefix: string, suffix: string) =>
        isDrive(prefix) ? suffix : match,
      );
    if (!isDrive(call.invocation.server) && !isDrive(call.pluginId ?? "") && tool === original)
      continue;
    if (!GOOGLE_DRIVE_READ_TOOLS.has(tool) && !GOOGLE_DRIVE_WRITE_TOOLS.has(tool)) {
      hasUnknown = true;
      continue;
    }
    const write = GOOGLE_DRIVE_WRITE_TOOLS.has(tool) && tool !== "delete_file";
    if (write) hasWrite = true;
    else hasRead = true;
    const result = asRecord(call.result.structuredContent);
    for (const key of GOOGLE_DRIVE_RESULT_URL_KEYS) {
      const url = readTrimmedString(result, key);
      const resource = url ? resolveGoogleDriveResource(url) : null;
      if (resource) (write ? writtenResourceKeys : readResourceKeys).add(resource.key);
    }
  }
  for (const key of writtenResourceKeys) readResourceKeys.delete(key);
  return { readResourceKeys, suppressUnmatchedReadResources: hasRead && !hasWrite && !hasUnknown };
}

function countRepeatedCharacter(value: string, index: number, character: string): number {
  let count = 0;
  while (value[index + count] === character) count += 1;
  return count;
}

function parseMarkdownCodeSpan(value: string, index: number): MarkdownParseResult | null {
  const tickCount = countRepeatedCharacter(value, index, "`");
  const fence = "`".repeat(tickCount);
  const endIndex = value.indexOf(fence, index + tickCount);
  if (endIndex === -1) return null;

  return {
    value: value.slice(index + tickCount, endIndex),
    nextIndex: endIndex + tickCount,
  };
}

function parseMarkdownLinkLabel(value: string, index: number): MarkdownParseResult | null {
  const label: string[] = [];
  let depth = 0;
  let cursor = index;

  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\n" || character === "\r") return null;

    if (character === "\\") {
      const next = value[cursor + 1];
      label.push(next ?? character);
      cursor += next == null ? 1 : 2;
      continue;
    }

    if (character === "[") {
      depth += 1;
      label.push(character);
      cursor += 1;
      continue;
    }

    if (character === "]") {
      if (depth === 0) {
        return {
          value: label.join("").trim(),
          nextIndex: cursor + 1,
        };
      }
      depth -= 1;
      label.push(character);
      cursor += 1;
      continue;
    }

    label.push(character ?? "");
    cursor += 1;
  }

  return null;
}

function skipMarkdownSpaces(value: string, index: number): number {
  let cursor = index;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  return cursor;
}

function parseMarkdownLinkEnd(
  value: string,
  index: number,
  destination: string,
): MarkdownParseResult | null {
  let cursor = skipMarkdownSpaces(value, index);
  if (value[cursor] === ")") {
    return {
      value: destination,
      nextIndex: cursor + 1,
    };
  }

  const titleStart = value[cursor];
  const titleEnd =
    titleStart === "(" ? ")" : titleStart === '"' || titleStart === "'" ? titleStart : null;
  if (!titleEnd) return null;

  cursor += 1;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\n" || character === "\r") return null;
    if (character === "\\") {
      cursor += value[cursor + 1] == null ? 1 : 2;
      continue;
    }
    if (character === titleEnd) {
      const end = skipMarkdownSpaces(value, cursor + 1);
      if (value[end] !== ")") return null;
      return {
        value: destination,
        nextIndex: end + 1,
      };
    }
    cursor += 1;
  }

  return null;
}

function parseMarkdownLinkDestination(value: string, index: number): MarkdownParseResult | null {
  let cursor = skipMarkdownSpaces(value, index);

  if (value[cursor] === "<") {
    const destination: string[] = [];
    cursor += 1;
    while (cursor < value.length) {
      const character = value[cursor];
      if (character === "\n" || character === "\r") return null;
      if (character === "\\" && MARKDOWN_LINK_ESCAPABLE_CHARACTERS.has(value[cursor + 1] ?? "")) {
        destination.push(value[cursor + 1] ?? character);
        cursor += 2;
        continue;
      }
      if (character === ">")
        return parseMarkdownLinkEnd(value, cursor + 1, destination.join("").trim());
      destination.push(character ?? "");
      cursor += 1;
    }
    return null;
  }

  const destination: string[] = [];
  let parenDepth = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\n" || character === "\r") return null;
    if (character === "\\" && MARKDOWN_LINK_ESCAPABLE_CHARACTERS.has(value[cursor + 1] ?? "")) {
      destination.push(value[cursor + 1] ?? character);
      cursor += 2;
      continue;
    }
    if (character === "(") {
      parenDepth += 1;
      destination.push(character);
      cursor += 1;
      continue;
    }
    if (character === ")") {
      if (parenDepth === 0) {
        return {
          value: destination.join("").trim(),
          nextIndex: cursor + 1,
        };
      }
      parenDepth -= 1;
      destination.push(character);
      cursor += 1;
      continue;
    }
    if ((character === " " || character === "\t") && parenDepth === 0) {
      return parseMarkdownLinkEnd(value, cursor, destination.join("").trim());
    }
    destination.push(character ?? "");
    cursor += 1;
  }

  return null;
}

function parseMarkdownLinkAt(value: string, index: number): MarkdownLinkParseResult | null {
  if (value[index] !== "[") return null;

  const label = parseMarkdownLinkLabel(value, index + 1);
  if (!label || value[label.nextIndex] !== "(") return null;

  const destination = parseMarkdownLinkDestination(value, label.nextIndex + 1);
  if (!destination) return null;

  return {
    label: label.value,
    destination: destination.value,
    nextIndex: destination.nextIndex,
  };
}

function pushMarkdownLinksFromLine(links: MarkdownLink[], line: string) {
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const code = parseMarkdownCodeSpan(line, cursor);
      if (code) {
        const trimmed = code.value.trim();
        const link = parseMarkdownLinkAt(trimmed, 0);
        if (link && link.nextIndex === trimmed.length) {
          links.push({ label: link.label, destination: link.destination });
        }
        cursor = code.nextIndex;
        continue;
      }
    }

    const linkIndex = line.indexOf("[", cursor);
    if (linkIndex === -1) return;
    const link = parseMarkdownLinkAt(line, linkIndex);
    if (link) {
      links.push({ label: link.label, destination: link.destination });
      cursor = link.nextIndex;
      continue;
    }
    cursor = linkIndex + 1;
  }
}

function extractMarkdownLinks(value: string | null): MarkdownLink[] {
  if (!value?.includes("](")) return [];

  const links: MarkdownLink[] = [];
  let fenced = false;
  for (const line of value.split(/\r?\n/u)) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) pushMarkdownLinksFromLine(links, line);
  }

  return links;
}

function collectMarkdownLinkedOutputs(
  text: string | null,
  cwd: string | null | undefined,
  googleDriveTitles: ReadonlyMap<string, string>,
  projectlessOutputDirectory: string | null | undefined,
  policy: {
    readonly referencedPaths: readonly string[];
    readonly hasCitations: boolean;
    readonly readResourceKeys: ReadonlySet<string>;
    readonly suppressUnmatchedReadResources: boolean;
  },
): ThreadSummaryPanelOutputDraft[] {
  return extractMarkdownLinks(text).flatMap<ThreadSummaryPanelOutputDraft>((link) => {
    const normalizedUrl = normalizeUrl(link.destination);
    const googleDrive = resolveGoogleDriveResource(normalizedUrl);
    if (googleDrive) {
      if (
        policy.hasCitations ||
        policy.suppressUnmatchedReadResources ||
        policy.readResourceKeys.has(googleDrive.key)
      )
        return [];
      const title = googleDriveTitles.get(googleDrive.key) ?? link.label;
      return title.trim().length > 0
        ? [
            {
              kind: "google-drive",
              url: normalizedUrl,
              title,
              resourceKind: googleDrive.kind,
            },
          ]
        : [];
    }

    const path = normalizeMarkdownOutputPath(link.destination, cwd);
    if (!path || !LINK_OUTPUT_EXTENSIONS.has(normalizeOutputExtension(path) ?? "")) return [];
    if (isScratchOutputPath(path, cwd)) return [];
    if (
      policy.referencedPaths.some(
        (reference) =>
          normalizeOutputIdentity(reference, cwd) === normalizeOutputIdentity(path, cwd),
      )
    )
      return [];
    if (
      !isResourceInsideProjectlessOutputDirectory({
        cwd,
        projectlessOutputDirectory,
        resourcePath: path,
      })
    )
      return [];
    return [{ kind: "file", path }];
  });
}

function resolveSingleLocalWebsiteUrl(text: string | null): string | null {
  if (!text) return null;

  const matches = new Map<string, string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const value = stripUrlTrailingPunctuation(match[0] ?? "");
    if (!isLocalHttpUrl(value)) continue;

    try {
      const url = new URL(value);
      if (
        url.port.length === 0 ||
        LOCAL_URL_UNSAFE_PATH_PATTERN.test(`${url.pathname}${url.search}${url.hash}`)
      ) {
        continue;
      }
      matches.set(url.href, url.href);
    } catch {
      continue;
    }
  }

  if (matches.size !== 1) return null;
  return matches.values().next().value ?? null;
}

function resolvePublicHttpUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return isLocalHttpUrl(url.href) ? null : url.href;
  } catch {
    return null;
  }
}

function resolveAppgenProjectId(
  item: CodexConversationItem,
  structuredContent: Record<string, unknown>,
): string | null {
  const argumentsRecord = asRecord(item.mcpToolCall?.invocation.arguments);
  return (
    readTrimmedString(structuredContent, "project_id") ??
    readTrimmedString(argumentsRecord, "project_id")
  );
}

function resolveAppgenArtifact(item: CodexConversationItem): AppgenArtifactCandidate | null {
  const mcpToolCall = item.mcpToolCall;
  if (!mcpToolCall) return null;
  if (mcpToolCall.invocation.server !== APPGEN_MCP_SERVER) return null;
  if (!APPGEN_MCP_TOOL_PATTERN.test(mcpToolCall.invocation.tool)) return null;
  if (mcpToolCall.result?.type !== "success") return null;

  const structuredContent = asRecord(mcpToolCall.result.structuredContent);
  if (!structuredContent) return null;

  const url = resolvePublicHttpUrl(
    readTrimmedString(structuredContent, "current_live_url") ??
      readTrimmedString(structuredContent, "deployment_url") ??
      readTrimmedString(structuredContent, "url"),
  );
  if (!url) return null;

  const projectId = resolveAppgenProjectId(item, structuredContent);
  if (!projectId) return null;

  return {
    projectId,
    url,
    title: readTrimmedString(structuredContent, "title"),
  };
}

function collectAppgenArtifacts(
  turn: CodexConversationTurn,
): ThreadSummaryPanelAppgenOutputDraft[] {
  const artifacts: ThreadSummaryPanelAppgenOutputDraft[] = [];
  const seenProjectIds = new Set<string>();

  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (!item) continue;

    const artifact = resolveAppgenArtifact(item);
    if (!artifact || seenProjectIds.has(artifact.projectId)) continue;

    seenProjectIds.add(artifact.projectId);
    artifacts.push({
      kind: "appgen-app",
      projectId: artifact.projectId,
      url: artifact.url,
      title: artifact.title,
    });
  }

  return artifacts.reverse();
}

function resolveImageGenerationPath(item: CodexConversationItem): string | null {
  const rawItem = asRecord(item.rawItem);
  const protocolItem = item.rawItem as Partial<ProtocolImageGenerationItem> | null | undefined;
  return normalizePath(
    readString(rawItem, "savedPath") ??
      readString(rawItem, "src") ??
      readString(rawItem, "path") ??
      protocolItem?.savedPath ??
      null,
  );
}

function resolveImageViewPath(item: CodexConversationItem): string | null {
  const rawItem = asRecord(item.rawItem);
  const protocolItem = item.rawItem as Partial<ProtocolImageViewItem> | null | undefined;
  return normalizePath(readString(rawItem, "path") ?? protocolItem?.path ?? null);
}

function resolveAssistantText(item: CodexConversationItem): string | null {
  if (
    item.type !== "agentMessage" &&
    item.kind !== "assistantMessage" &&
    item.semanticKind !== "assistantMessage"
  ) {
    return null;
  }

  const rawItem = asRecord(item.rawItem);
  return item.markdownText ?? readString(rawItem, "text");
}

function addArtifactPath(seen: Set<string>, paths: string[], rawPath: string) {
  const path = normalizeArtifactPath(rawPath);
  if (!path) return;

  const key = normalizePathSegments(path).toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  paths.push(path);
}

function collectReferencedArtifactPaths(item: CodexConversationItem): string[] {
  const text = resolveAssistantText(item);
  if (!text) return [];

  return [...text.matchAll(FILE_REFERENCE_PATTERN)].flatMap((match) => {
    const path = normalizeArtifactPath(match[1] ?? "");
    return path ? [path] : [];
  });
}

function collectEditedArtifactPaths(item: CodexConversationItem): string[] {
  if ((asRecord(item.rawItem)?.status ?? item.status) !== "completed") return [];
  const entries = getCodexFileChangeEntries(item.fileChange?.changes);
  return entries.flatMap(([path, patch]) => {
    if (
      patch.type === "delete" ||
      (patch.type === "nonRenderable" && patch.originalType === "delete")
    )
      return [];
    const outputPath =
      (patch.type === "update" || patch.type === "nonRenderable") && patch.movePath
        ? patch.movePath
        : path;
    const normalized = normalizeArtifactPath(outputPath);
    return normalized ? [normalized] : [];
  });
}

function collectTurnArtifacts(
  turn: CodexConversationTurn,
  cwd: string | null | undefined,
): ThreadSummaryPanelTurnArtifacts {
  const editedFilePaths: string[] = [];
  const outputFilePaths: string[] = [];
  const referencedFilePaths: string[] = [];
  const editedSeen = new Set<string>();
  const outputSeen = new Set<string>();
  const referencedSeen = new Set<string>();
  const visualizationPaths = new Set<string>();

  for (const item of turn.items) {
    for (const path of collectEditedArtifactPaths(item)) {
      addArtifactPath(editedSeen, editedFilePaths, path);
    }

    for (const path of collectReferencedArtifactPaths(item)) {
      addArtifactPath(referencedSeen, referencedFilePaths, path);
    }
    const text = resolveAssistantText(item);
    if (!text) continue;
    const references = readTurnArtifactReferences(text);
    for (const path of references.visualizationPaths) {
      const normalized = normalizeArtifactPath(path);
      if (normalized) {
        visualizationPaths.add(normalizeOutputIdentity(normalized, cwd));
        addArtifactPath(referencedSeen, referencedFilePaths, normalized);
      }
    }
    for (const citation of references.citations) {
      if (citation.mode === "live" || isHttpUrl(citation.path)) continue;
      if ((citation.purpose ?? "output") === "output")
        addArtifactPath(outputSeen, outputFilePaths, citation.path);
      else if (citation.purpose === "source")
        addArtifactPath(referencedSeen, referencedFilePaths, citation.path);
    }
  }

  return {
    editedFilePaths: editedFilePaths.filter(
      (path) => !visualizationPaths.has(normalizeOutputIdentity(path, cwd)),
    ),
    outputFilePaths: outputFilePaths.filter(
      (path) => !visualizationPaths.has(normalizeOutputIdentity(path, cwd)),
    ),
    referencedFilePaths,
  };
}

function normalizeOutputIdentity(path: string, cwd: string | null | undefined): string {
  return normalizePathSegments(resolveOutputPath(path, cwd)).toLowerCase();
}

function isScratchOutputPath(path: string, cwd: string | null | undefined): boolean {
  const identity = normalizeOutputIdentity(path, cwd);
  return ["work", ".codex_scratch"].some((root) => {
    const scratch = normalizeOutputIdentity(root, cwd);
    return identity === scratch || identity.startsWith(`${scratch}/`);
  });
}

function isPathOutputDraft(
  output: ThreadSummaryPanelOutputDraft,
): output is ThreadSummaryPanelPathOutputDraft {
  return output.kind === "file" || output.kind === "generated-image" || output.kind === "image";
}

function isPathOutputRow(row: ThreadSummaryPanelOutputRow): row is ThreadSummaryPanelPathOutputRow {
  return row.kind === "file" || row.kind === "generated-image" || row.kind === "image";
}

function getOutputKey(output: ThreadSummaryPanelOutputDraft): string {
  switch (output.kind) {
    case "file":
    case "generated-image":
    case "image":
      return `path:${normalizePathSegments(output.path).toLowerCase()}`;

    case "google-drive":
      return `google-drive:${normalizeUrlForComparison(output.url)}`;

    case "appgen-app":
      return `appgen-app:${output.projectId}`;

    case "website":
      return isHttpUrl(output.target)
        ? `website:${normalizeUrlForComparison(output.target)}`
        : `path:${normalizePathSegments(output.target).toLowerCase()}`;
  }
}

function getOutputPriority(output: ThreadSummaryPanelOutputDraft): number {
  if (isPathOutputDraft(output) || output.kind === "website")
    return OUTPUT_KIND_PRIORITY[output.kind];
  return 0;
}

function addOutput(
  outputs: Map<string, ThreadSummaryPanelOutputDraft>,
  output: ThreadSummaryPanelOutputDraft,
) {
  const key = getOutputKey(output);
  const existing = outputs.get(key);
  if (!existing) {
    outputs.set(key, output);
    return;
  }

  if (getOutputPriority(output) > getOutputPriority(existing)) {
    outputs.set(key, output);
  }
}

function isCompletedTurn(turn: CodexConversationTurn): boolean {
  return turn.status === "completed" || String(turn.status) === "complete";
}

export function collectTurnEndResourcePaths(
  turn: CodexConversationTurn,
  options: TurnOutputOptions = {},
): string[] {
  return getTurnEndResourcePaths(collectTurnEndResources(turn, options));
}

export interface TurnOutputCandidate {
  readonly resource: ThreadSummaryPanelOutputRow;
  readonly requiresNonSourcePath: boolean;
  /** A local preview URL yields to confirmed edited-file deliverables from its own turn. */
  readonly websiteFallbackPaths?: readonly string[];
}

/** The shared per-turn classifier; path-state confirmation is applied by both consumers. */
export function collectTurnOutputCandidates(
  turn: CodexConversationTurn,
  options: TurnOutputOptions = {},
): TurnOutputCandidate[] {
  if (!isCompletedTurn(turn)) return [];
  const cwd = options.cwd ?? null;
  const directory = options.projectlessOutputDirectory;
  const artifacts = collectTurnArtifacts(turn, cwd);
  const assistantText = turn.items.findLast((item) => resolveAssistantText(item) !== null);
  const text = assistantText ? resolveAssistantText(assistantText) : null;
  const citations = readTurnArtifactReferences(text ?? "").citations;
  const titles = collectGoogleDriveTitleMap(turn);
  const outputs = new Map<string, ThreadSummaryPanelOutputDraft>();
  const editedKeys = new Set<string>();
  for (const path of artifacts.editedFilePaths) {
    if (!hasDeliverableExtension(path) || isScratchOutputPath(path, cwd)) continue;
    if (
      !isResourceInsideProjectlessOutputDirectory({
        cwd,
        projectlessOutputDirectory: directory,
        resourcePath: path,
      })
    )
      continue;
    if (
      artifacts.referencedFilePaths.some(
        (reference) =>
          normalizeOutputIdentity(reference, cwd) === normalizeOutputIdentity(path, cwd),
      )
    )
      continue;
    const output = { kind: "file", path: resolveOutputPath(path, cwd) } as const;
    addOutput(outputs, output);
    if (!directory) editedKeys.add(getOutputKey(output));
  }
  const addExplicitOutput = (output: ThreadSummaryPanelOutputDraft) => {
    editedKeys.delete(getOutputKey(output));
    addOutput(outputs, output);
  };
  for (const item of turn.items) {
    const kind =
      item.type === "imageGeneration"
        ? "generated-image"
        : item.type === "imageView"
          ? "image"
          : null;
    if (!kind) continue;
    const rawPath =
      kind === "generated-image" ? resolveImageGenerationPath(item) : resolveImageViewPath(item);
    const path = rawPath ? normalizeArtifactPath(rawPath) : null;
    if (!path || isScratchOutputPath(path, cwd)) continue;
    if (
      !isResourceInsideProjectlessOutputDirectory({
        cwd,
        projectlessOutputDirectory: directory,
        resourcePath: path,
      })
    )
      continue;
    addExplicitOutput({ kind, path: resolveOutputPath(path, cwd) });
  }
  for (const path of artifacts.outputFilePaths) {
    if (!hasDeliverableExtension(path) || isScratchOutputPath(path, cwd)) continue;
    if (
      !isResourceInsideProjectlessOutputDirectory({
        cwd,
        projectlessOutputDirectory: directory,
        resourcePath: path,
      })
    )
      continue;
    addExplicitOutput({ kind: "file", path: resolveOutputPath(path, cwd) });
  }
  for (const citation of citations) {
    if ((citation.purpose ?? "output") !== "output" || citation.mode === "live") continue;
    const drive = resolveGoogleDriveResource(citation.path);
    if (!drive) continue;
    addExplicitOutput({
      kind: "google-drive",
      url: normalizeUrl(citation.path),
      resourceKind: drive.kind,
      title: titles.get(drive.key) ?? citation.label ?? citation.path,
    });
  }
  for (const output of collectMarkdownLinkedOutputs(text, cwd, titles, directory, {
    referencedPaths: artifacts.referencedFilePaths,
    hasCitations: citations.length > 0,
    ...collectGoogleDriveReadPolicy(turn),
  }))
    addExplicitOutput(output);
  const appgenOutputs = collectAppgenArtifacts(turn);
  for (const output of appgenOutputs) addOutput(outputs, output);
  if (
    appgenOutputs.length === 0 &&
    ![...outputs.values()].some(
      (output) => output.kind === "file" && !editedKeys.has(getOutputKey(output)),
    ) &&
    !citations.some(
      (citation) => citation.mode === "live" && (citation.purpose ?? "output") === "output",
    )
  ) {
    const website = resolveSingleLocalWebsiteUrl(text);
    if (website) addOutput(outputs, { kind: "website", target: website });
  }
  const drafts = [...outputs.values()];
  const imagePaths = drafts
    .filter(isPathOutputDraft)
    .filter(
      (output) => output.kind === "generated-image" || IMAGE_EXTENSION_PATTERN.test(output.path),
    )
    .map((output) => output.path);
  const imageNumbers = drafts.some((output) => output.kind === "generated-image")
    ? new Map(imagePaths.map((path, index) => [path, imagePaths.length - index]))
    : new Map<string, number>();
  return drafts.map((output) => ({
    resource: buildOutputRow(output, imageNumbers),
    requiresNonSourcePath: editedKeys.has(getOutputKey(output)),
    ...(output.kind === "website"
      ? {
          websiteFallbackPaths: drafts.flatMap((draft) =>
            draft.kind === "file" ? [draft.path] : [],
          ),
        }
      : {}),
  }));
}

/** Missing entries are loading; null entries or an absent map represent failed queries. */
export function filterTurnOutputCandidates(
  candidates: readonly TurnOutputCandidate[],
  pathStates: ReadonlyMap<string, WorkspacePathState | null> | undefined,
  cwd?: string | null,
): ThreadSummaryPanelOutputRow[] {
  const states =
    pathStates &&
    new Map([...pathStates].map(([path, state]) => [normalizeOutputIdentity(path, cwd), state]));
  return candidates.flatMap<ThreadSummaryPanelOutputRow>(
    ({ resource, requiresNonSourcePath, websiteFallbackPaths }) => {
      if (
        websiteFallbackPaths?.some((path) => {
          const state = states?.get(normalizeOutputIdentity(path, cwd));
          return state?.exists && state.isGitSourcePath === false;
        })
      )
        return [];
      if (!isPathOutputRow(resource)) return [resource];
      const state = states?.get(normalizeOutputIdentity(resource.path, cwd));
      if (states && state !== null && !state?.exists) return [];
      // A failed query retains explicit outputs, but unknown Git state never promotes edited Project files.
      if (requiresNonSourcePath && state?.isGitSourcePath !== false) return [];
      return [resource];
    },
  );
}

/** Protocol image resources already have an inline transcript gallery. Authored image files stay here. */
export function projectTurnEndOutputCandidates(
  candidates: readonly TurnOutputCandidate[],
): TurnOutputCandidate[] {
  return candidates.filter(
    ({ resource }) => resource.kind !== "generated-image" && resource.kind !== "image",
  );
}

export function collectTurnEndResources(
  turn: CodexConversationTurn,
  options: TurnOutputOptions = {},
): ThreadSummaryPanelOutputRow[] {
  return filterTurnOutputCandidates(
    projectTurnEndOutputCandidates(collectTurnOutputCandidates(turn, options)),
    options.pathStates,
    options.cwd,
  );
}

/** Newest turns first; path-state filtering must precede identity deduplication. */
export function collectThreadOutputCandidates(
  turns: readonly CodexConversationTurn[],
  options: TurnOutputOptions = {},
): TurnOutputCandidate[] {
  return [...turns].reverse().flatMap((turn) => collectTurnOutputCandidates(turn, options));
}

export function selectThreadSummaryOutputRows(
  resources: readonly ThreadSummaryPanelOutputRow[],
): ThreadSummaryPanelOutputRow[] {
  const outputs = new Map<string, ThreadSummaryPanelOutputRow>();
  for (const resource of resources) {
    const key = getOutputKey(resource);
    if (outputs.has(key)) continue;
    outputs.set(key, resource);
    if (outputs.size === MAX_SUMMARY_PANEL_OUTPUT_ROWS) break;
  }
  const rows = [...outputs.values()];
  // Turns number their own images; across the Chat the list counts down from its newest turn.
  let generatedImageNumber = rows.filter((row) => row.kind === "generated-image").length;
  return rows.map((row) =>
    row.kind === "generated-image"
      ? { ...row, label: `Generated image ${generatedImageNumber--}` }
      : row,
  );
}

export function getTurnEndResourcePaths(
  resources: readonly ThreadSummaryPanelOutputRow[],
): string[] {
  return resources.flatMap((resource) => {
    if (resource.kind === "file") return [resource.path];
    return resource.kind === "website" && !isHttpUrl(resource.target) ? [resource.target] : [];
  });
}

function formatWebsiteOutputLabel(target: string): string {
  try {
    const url = new URL(target);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  } catch {
    const name = basename(target);
    return name.length > 0 ? name : target;
  }
}

function formatAppgenOutputLabel(output: ThreadSummaryPanelAppgenOutputDraft): string {
  if (output.title) return output.title;

  try {
    return new URL(output.url).hostname;
  } catch {
    return output.url;
  }
}

function buildOutputRow(
  output: ThreadSummaryPanelOutputDraft,
  generatedImageNumbers: ReadonlyMap<string, number>,
): ThreadSummaryPanelOutputRow {
  switch (output.kind) {
    case "file":
    case "generated-image":
    case "image": {
      const imageNumber = generatedImageNumbers.get(output.path);
      const label = imageNumber == null ? basename(output.path) : `Generated image ${imageNumber}`;
      return {
        id: `${output.kind}:${output.path}`,
        kind: output.kind,
        path: output.path,
        label,
        title: output.path,
      };
    }

    case "website":
      return {
        id: `website:${output.target}`,
        kind: "website",
        target: output.target,
        label: formatWebsiteOutputLabel(output.target),
        title: output.target,
      };

    case "google-drive":
      return {
        id: `google-drive:${output.url}`,
        kind: "google-drive",
        url: output.url,
        resourceKind: output.resourceKind,
        label: output.title,
        title: output.url,
      };

    case "appgen-app":
      return {
        id: `appgen-app:${output.projectId}`,
        kind: "appgen-app",
        projectId: output.projectId,
        url: output.url,
        label: formatAppgenOutputLabel(output),
        title: output.url,
      };
  }
}

export function buildThreadSummaryPanelOutputRows(
  turns: readonly CodexConversationTurn[],
  options: TurnOutputOptions = {},
): ThreadSummaryPanelOutputRow[] {
  return selectThreadSummaryOutputRows(
    filterTurnOutputCandidates(
      collectThreadOutputCandidates(turns, options),
      options.pathStates,
      options.cwd,
    ),
  );
}

export function isThreadSummaryPanelImagePreviewableOutput(
  row: ThreadSummaryPanelOutputRow,
): boolean {
  return (
    isPathOutputRow(row) &&
    (row.kind === "generated-image" ||
      row.kind === "image" ||
      IMAGE_EXTENSION_PATTERN.test(row.path))
  );
}

export function resolveThreadSummaryPanelOutputOpenTarget(
  row: ThreadSummaryPanelOutputRow,
): ThreadSummaryPanelOutputOpenTarget {
  switch (row.kind) {
    case "google-drive":
    case "appgen-app":
      return { type: "url", url: row.url };

    case "website":
      return isHttpUrl(row.target)
        ? { type: "url", url: row.target }
        : { type: "file", path: row.target };

    case "file":
    case "generated-image":
    case "image":
      return { type: "file", path: row.path };
  }
}
