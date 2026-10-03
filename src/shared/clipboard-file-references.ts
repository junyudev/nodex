import { parseFileSource } from "./file-resources";
import { formatClipboardMarkdownDestination } from "./clipboard-markdown";

export const MAX_CLIPBOARD_EXPORT_FILES = 128;
const FILE_LOCATOR = /nodex:\/\/files\/[A-Za-z0-9._~-]+/gu;
const FILE_REFERENCE = /nodex:\/\/(?:assets\/[A-Za-z0-9._%-]+|files\/[A-Za-z0-9._~-]+)/gu;

export const clipboardFileReferenceSources = (text: string): readonly string[] => [
  ...new Set(text.match(FILE_REFERENCE) ?? []),
];

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
): string =>
  text.replace(FILE_REFERENCE, (source: string, offset: number) => {
    const path = paths.get(source);
    if (!path) return source;
    // Portable attachments and images already carry bare Markdown destinations.
    if (text.slice(offset - 2, offset) === "](" && text[offset + source.length] === ")") {
      return formatClipboardMarkdownDestination(path);
    }
    return path;
  });
