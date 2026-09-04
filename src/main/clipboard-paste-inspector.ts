import * as fs from "node:fs";
import * as path from "node:path";

import { parseLocalFileLinkHref } from "../shared/file-link-openers";
import {
  decodeNodexStructuralClipboardDescriptor,
  inspectNodexClipboardHtml,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
  readNodexClipboardFragment,
} from "../shared/clipboard-paste";
import type {
  ClipboardPastePayload,
  ClipboardPasteInspectionItem,
  ClipboardPasteInspectionResult,
} from "../shared/types";
import type { ElectronClipboardPort } from "./platform/electron/ElectronClipboard";

const CLIPBOARD_TEXT_FORMATS = ["text/uri-list", "public.file-url"] as const;

export const CLIPBOARD_INSPECTION_MAX_FORMAT_BYTES = 256 * 1024;
export const CLIPBOARD_INSPECTION_MAX_LINES = 128;
export const CLIPBOARD_INSPECTION_MAX_ITEMS = 64;
export const CLIPBOARD_INSPECTION_MAX_PATH_LENGTH = 16 * 1024;
export const CLIPBOARD_PASTE_FORMAT_MAX_BYTES = 8 * 1024 * 1024;
export const CLIPBOARD_PASTE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

export type ClipboardPasteTarget = Pick<
  ElectronClipboardPort,
  "availableFormats" | "readFormat" | "readHtml" | "readText"
>;

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

export function inspectClipboardPasteItems(
  clipboard: ClipboardPasteTarget,
): ClipboardPasteInspectionResult {
  const values: string[] = [];
  const availableFormats = new Set(clipboard.availableFormats());

  for (const format of CLIPBOARD_TEXT_FORMATS) {
    if (!availableFormats.has(format)) continue;
    try {
      const value = clipboard.readFormat(format);
      if (value.trim().length > 0) {
        values.push(value);
      }
    } catch {
      // Ignore unreadable clipboard formats and continue.
    }
  }

  const result = inspectClipboardPasteItemsFromStrings(values);
  const descriptor = availableFormats.has(NODEX_STRUCTURAL_CLIPBOARD_MIME)
    ? decodeNodexStructuralClipboardDescriptor(
        readClipboardFormat(clipboard, NODEX_STRUCTURAL_CLIPBOARD_MIME) ?? "",
      )
    : null;
  const html = readClipboardHtml(clipboard);
  if (!html) {
    return {
      ...result,
      ...(descriptor ? { structuralDescriptor: descriptor } : {}),
    };
  }
  const inspected = inspectNodexClipboardHtml(html);
  return {
    ...result,
    ...(descriptor ? { structuralDescriptor: descriptor } : {}),
    ...(inspected.envelope ? { structuralEnvelope: inspected.envelope } : {}),
    ...(inspected.hasStructuralFallback && inspected.writeClaim
      ? { structuralWriteClaim: inspected.writeClaim }
      : {}),
  };
}

function readClipboardFormat(clipboard: ClipboardPasteTarget, format: string): string | undefined {
  try {
    const value = clipboard.readFormat(format);
    return value.trim().length > 0
      ? truncateClipboardUtf8(value, CLIPBOARD_PASTE_FORMAT_MAX_BYTES)
      : undefined;
  } catch {
    return undefined;
  }
}

function readClipboardHtml(clipboard: ClipboardPasteTarget): string | undefined {
  try {
    const value = clipboard.readHtml();
    return value.trim().length > 0
      ? truncateClipboardUtf8(value, CLIPBOARD_PASTE_FORMAT_MAX_BYTES)
      : undefined;
  } catch {
    return undefined;
  }
}

function readClipboardText(clipboard: ClipboardPasteTarget): string | undefined {
  try {
    const value = clipboard.readText();
    return value.length > 0
      ? truncateClipboardUtf8(value, CLIPBOARD_PASTE_FORMAT_MAX_BYTES)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readClipboardPastePayload(clipboard: ClipboardPasteTarget): ClipboardPastePayload {
  const availableFormats = new Set(clipboard.availableFormats());
  const payload: ClipboardPastePayload = {};

  if (availableFormats.has(NODEX_STRUCTURAL_CLIPBOARD_MIME)) {
    const descriptor = decodeNodexStructuralClipboardDescriptor(
      readClipboardFormat(clipboard, NODEX_STRUCTURAL_CLIPBOARD_MIME) ?? "",
    );
    if (descriptor) payload.structuralDescriptor = descriptor;
  }

  let remainingBytes = CLIPBOARD_PASTE_TOTAL_MAX_BYTES;
  const assignWithinBudget = <
    Key extends Exclude<
      keyof ClipboardPastePayload,
      "structuralDescriptor" | "structuralEnvelope" | "structuralWriteClaim"
    >,
  >(
    key: Key,
    value: ClipboardPastePayload[Key],
  ) => {
    if (typeof value !== "string" || remainingBytes <= 0) return;
    const bounded = truncateClipboardUtf8(value, remainingBytes);
    if (!bounded) return;
    payload[key] = bounded;
    remainingBytes -= Buffer.byteLength(bounded, "utf8");
  };

  if (availableFormats.has("blocknote/html")) {
    assignWithinBudget("blocknoteHtml", readClipboardFormat(clipboard, "blocknote/html"));
  }

  if (availableFormats.has("text/markdown")) {
    assignWithinBudget("markdown", readClipboardFormat(clipboard, "text/markdown"));
  }

  const html = readClipboardHtml(clipboard);
  if (html) {
    const inspected = inspectNodexClipboardHtml(html);
    if (!payload.blocknoteHtml) {
      assignWithinBudget("blocknoteHtml", readNodexClipboardFragment(html) ?? undefined);
    }
    assignWithinBudget("html", inspected.fallbackHtml);
    if (inspected.envelope) payload.structuralEnvelope = inspected.envelope;
    if (inspected.hasStructuralFallback && inspected.writeClaim) {
      payload.structuralWriteClaim = inspected.writeClaim;
    }
  }
  assignWithinBudget("text", readClipboardText(clipboard));

  return payload;
}
