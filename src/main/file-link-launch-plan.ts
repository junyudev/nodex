import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileLinkTarget } from "../shared/file-link-openers";

export interface NormalizedFileLinkPosition {
  line: number;
  column: number;
}

export function normalizeFileLinkPosition(
  target: FileLinkTarget,
): NormalizedFileLinkPosition | null {
  if (!Number.isSafeInteger(target.line) || (target.line ?? 0) <= 0) {
    return null;
  }

  const column = Number.isSafeInteger(target.column) && (target.column ?? 0) > 0
    ? target.column!
    : 1;

  return {
    line: target.line!,
    column,
  };
}

export function formatOpenFileLocation(
  path: string,
  position: NormalizedFileLinkPosition | null,
): string {
  if (!position) return path;
  return `${path}:${position.line}:${position.column}`;
}

export function resolveDirectoryOpenPath(path: string): string {
  return dirname(path);
}

export function buildTextMateUrl(
  path: string,
  position: NormalizedFileLinkPosition | null,
): string {
  const baseUrl = new URL("txmt://open/");
  baseUrl.searchParams.set("url", pathToFileURL(path).toString());
  if (position) {
    baseUrl.searchParams.set("line", String(position.line));
    baseUrl.searchParams.set("column", String(position.column));
  }
  return baseUrl.toString();
}
