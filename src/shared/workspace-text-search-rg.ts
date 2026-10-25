import { posix, win32 } from "node:path";
import type { WorkspaceTextSearchMatch } from "./workspace-text-search";

type SearchPathPlatform = "posix" | "win32";
const MAX_PREVIEW_LENGTH = 512;
const MAX_MATCH_RANGES = 32;
const utf8 = new TextEncoder();
const decodeUtf8 = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByteRange(value: unknown): value is { start: number; end: number } {
  return (
    isRecord(value) &&
    typeof value.start === "number" &&
    Number.isSafeInteger(value.start) &&
    value.start >= 0 &&
    typeof value.end === "number" &&
    Number.isSafeInteger(value.end) &&
    value.end >= value.start
  );
}

/** Convert one ripgrep JSON line into a bounded UTF-16 preview suitable for renderer highlighting. */
export function parseWorkspaceTextSearchMatch(
  line: string,
  root: string,
  platform: SearchPathPlatform,
): WorkspaceTextSearchMatch | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== "match" || !isRecord(event.data)) return null;
  const data = event.data;
  if (
    !isRecord(data.path) ||
    typeof data.path.text !== "string" ||
    !isRecord(data.lines) ||
    typeof data.lines.text !== "string" ||
    typeof data.line_number !== "number" ||
    !Number.isSafeInteger(data.line_number) ||
    data.line_number <= 0 ||
    !Array.isArray(data.submatches) ||
    !data.submatches.every(isByteRange)
  ) {
    return null;
  }
  const content = data.lines.text.replace(/\r?\n$/u, "");
  const bytes = utf8.encode(content);
  const ranges: { start: number; end: number }[] = [];
  let byteOffset = 0;
  let textOffset = 0;
  for (const range of data.submatches.slice(0, MAX_MATCH_RANGES)) {
    if (range.start < byteOffset || range.end > bytes.length) return null;
    const start = textOffset + decodeUtf8.decode(bytes.subarray(byteOffset, range.start)).length;
    const end = start + decodeUtf8.decode(bytes.subarray(range.start, range.end)).length;
    ranges.push({ start, end });
    byteOffset = range.end;
    textOffset = end;
  }
  const first = ranges[0];
  if (!first) return null;
  let start = content.length <= MAX_PREVIEW_LENGTH ? 0 : Math.max(0, first.start - 24);
  if (/[\uDC00-\uDFFF]/u.test(content.charAt(start))) start -= 1;
  const prefix = start > 0 ? "…" : "";
  let end = Math.min(content.length, start + MAX_PREVIEW_LENGTH - prefix.length);
  if (end < content.length) end -= 1;
  if (/[\uD800-\uDBFF]/u.test(content.charAt(end - 1))) end -= 1;
  const paths = platform === "win32" ? win32 : posix;
  return {
    path: paths.resolve(root, data.path.text),
    root,
    relativePath: data.path.text.split(paths.sep).join("/").replace(/^\.\//u, ""),
    line: data.line_number,
    column: first.start + 1,
    preview: `${prefix}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
    matchRanges: ranges
      .filter((range) => range.start < end)
      .map((range) => ({
        start: range.start - start + prefix.length,
        end: Math.min(range.end, end) - start + prefix.length,
      })),
  };
}

/** Priority paths are contained, non-overlapping relative directories, preserving first-seen order. */
export function workspaceTextSearchPriorityPaths(
  root: string,
  priorityFolders: readonly string[],
  platform: SearchPathPlatform,
): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const candidates = [
    ...new Set(
      priorityFolders
        .filter((folder) => paths.isAbsolute(folder))
        .map((folder) => paths.relative(root, folder).split(paths.sep).join("/")),
    ),
  ].filter(
    (folder) =>
      folder !== "" && folder !== ".." && !folder.startsWith("../") && !paths.isAbsolute(folder),
  );
  return candidates.filter(
    (folder) => !candidates.some((parent) => folder !== parent && folder.startsWith(`${parent}/`)),
  );
}

export function escapeWorkspaceTextSearchGlob(path: string): string {
  return path.replace(/[\\*?[\]{}!]/gu, "\\$&");
}
