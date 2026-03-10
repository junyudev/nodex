import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { parseLocalFileLinkHref } from "../shared/file-link-openers";
import type {
  ClipboardPasteInspectionItem,
  ClipboardPasteInspectionResult,
} from "../shared/types";

const CLIPBOARD_TEXT_FORMATS = [
  "text/uri-list",
  "public.file-url",
] as const;

const require = createRequire(import.meta.url);

function normalizeClipboardLines(value: string): string[] {
  return value
    .split(/\r?\n|\0/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));
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

  for (const rawValue of values) {
    for (const line of normalizeClipboardLines(rawValue)) {
      const absolutePath = parseAbsoluteClipboardPath(line);
      if (!absolutePath || seenPaths.has(absolutePath)) continue;
      if (!fs.existsSync(absolutePath)) continue;

      const stats = fs.statSync(absolutePath);
      const kind = stats.isDirectory() ? "folder" : "file";
      items.push({
        path: absolutePath,
        kind,
        name: path.basename(absolutePath),
        ...(kind === "file" ? { bytes: stats.size } : {}),
      });
      seenPaths.add(absolutePath);
    }
  }

  return { items };
}

export function inspectClipboardPasteItems(): ClipboardPasteInspectionResult {
  const electron = require("electron") as typeof import("electron");
  const clipboard = electron.clipboard;
  const values: string[] = [];
  const availableFormats = new Set(clipboard.availableFormats());

  for (const format of CLIPBOARD_TEXT_FORMATS) {
    if (!availableFormats.has(format)) continue;
    try {
      const value = clipboard.read(format);
      if (value.trim().length > 0) {
        values.push(value);
      }
    } catch {
      // Ignore unreadable clipboard formats and continue.
    }
  }

  return inspectClipboardPasteItemsFromStrings(values);
}
