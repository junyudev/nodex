import * as fs from "node:fs";
import * as path from "node:path";

import { parseLocalFileLinkHref } from "../shared/file-link-openers";
import { inspectNodexClipboardHtml, readNodexClipboardFragment } from "../shared/clipboard-paste";
import type {
  ClipboardPastePayload,
  ClipboardPasteInspectionItem,
  ClipboardPasteInspectionResult,
} from "../shared/types";
import type { NativeClipboardSnapshot } from "./platform/electron/native-clipboard";

const CLIPBOARD_TEXT_FORMATS = ["text/uri-list", "public.file-url"] as const;

export const CLIPBOARD_INSPECTION_MAX_FORMAT_BYTES = 256 * 1024;
export const CLIPBOARD_INSPECTION_MAX_LINES = 128;
export const CLIPBOARD_INSPECTION_MAX_ITEMS = 64;
export const CLIPBOARD_INSPECTION_MAX_PATH_LENGTH = 16 * 1024;

export function truncateClipboardUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  const minimumEnd = Math.max(0, maxBytes - 3);
  for (let end = maxBytes; end >= minimumEnd; end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 code point may span at most four bytes; trim to its boundary.
    }
  }
  return "";
}

function normalizeClipboardLines(value: string, remainingLines: number): string[] {
  return truncateClipboardUtf8(value, CLIPBOARD_INSPECTION_MAX_FORMAT_BYTES)
    .split(/\r?\n|\0/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"))
    .slice(0, remainingLines);
}

function parseAbsoluteClipboardPath(value: string): string | null {
  const fileLink = parseLocalFileLinkHref(value);
  if (fileLink?.path) return path.resolve(fileLink.path);
  if (path.isAbsolute(value)) return path.resolve(value);
  return null;
}

export function inspectClipboardPasteItemsFromStrings(
  values: string[],
): ClipboardPasteInspectionResult {
  const seenPaths = new Set<string>();
  const items: ClipboardPasteInspectionItem[] = [];
  let remainingLines = CLIPBOARD_INSPECTION_MAX_LINES;

  for (const rawValue of values.slice(0, CLIPBOARD_TEXT_FORMATS.length)) {
    if (remainingLines <= 0 || items.length >= CLIPBOARD_INSPECTION_MAX_ITEMS) break;
    const lines = normalizeClipboardLines(rawValue, remainingLines);
    remainingLines -= lines.length;

    for (const line of lines) {
      if (items.length >= CLIPBOARD_INSPECTION_MAX_ITEMS) break;
      if (line.length > CLIPBOARD_INSPECTION_MAX_PATH_LENGTH) continue;
      const absolutePath = parseAbsoluteClipboardPath(line);
      if (!absolutePath || seenPaths.has(absolutePath)) continue;
      try {
        const stats = fs.lstatSync(absolutePath);
        if (stats.isSymbolicLink()) continue;
        if (!stats.isDirectory() && !stats.isFile()) continue;
        const kind = stats.isDirectory() ? "folder" : "file";
        items.push({
          path: absolutePath,
          kind,
          name: path.basename(absolutePath),
          ...(kind === "file" ? { bytes: stats.size } : {}),
        });
        seenPaths.add(absolutePath);
      } catch {
        // Clipboard paths are advisory and may disappear between copy and paste.
      }
    }
  }

  return { items };
}

/** Decodes one materialized native observation; never reads the clipboard again. */
export function readClipboardPastePayload(
  snapshot: NativeClipboardSnapshot,
): ClipboardPastePayload {
  const payload: ClipboardPastePayload = {
    ...(snapshot.text !== undefined ? { text: snapshot.text } : {}),
    ...(snapshot.markdown !== undefined ? { markdown: snapshot.markdown } : {}),
  };
  const items = inspectClipboardPasteItemsFromStrings([snapshot.fileUrls.join("\n")]).items;
  if (items.length > 0) payload.items = items;
  if (!snapshot.html) return payload;
  const inspected = inspectNodexClipboardHtml(snapshot.html);
  payload.html = inspected.fallbackHtml;
  const fragment = readNodexClipboardFragment(snapshot.html);
  if (fragment) payload.blocknoteHtml = fragment;
  if (inspected.envelope) payload.structuralEnvelope = inspected.envelope;
  if (inspected.hasStructuralFallback && inspected.writeClaim) {
    payload.structuralWriteClaim = inspected.writeClaim;
  }
  return payload;
}
