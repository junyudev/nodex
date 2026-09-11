import { parseFileSource } from "./file-resources";

export const MAX_CLIPBOARD_EXPORT_FILES = 128;
const FILE_LOCATOR = /nodex:\/\/files\/[A-Za-z0-9._~-]+/gu;

/** Candidates narrow a capture; only Core's selected occurrences authorize bytes. */
export const clipboardFileReferences = (
  text: string,
): readonly { source: string; fileId: string }[] | null => {
  if (text.includes("nodex://assets/")) return null;
  const sources = new Set(text.match(FILE_LOCATOR) ?? []);
  if (sources.size > MAX_CLIPBOARD_EXPORT_FILES) return null;
  const references = [];
  for (const source of sources) {
    const fileId = parseFileSource(source);
    if (!fileId) return null;
    references.push({ source, fileId });
  }
  return references;
};

export const replaceClipboardFileReferences = (
  text: string,
  paths: ReadonlyMap<string, string>,
): string => text.replace(FILE_LOCATOR, (source) => paths.get(source) ?? source);
