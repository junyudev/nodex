import {
  isSupportedComposerImageMetadata,
  normalizeComposerImageFilenameCandidate,
} from "../../../../../../shared/composer-image-input";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { readComposerPaste, type CopiedLibraryImage } from "../../../../../../shared/markdown";

export {
  COMPOSER_IMAGE_MIME_TYPES,
  isSupportedComposerImageMetadata,
} from "../../../../../../shared/composer-image-input";
const MEDIA_ONLY_HTML_LIMIT = 100_000;
const MEDIA_ELEMENT_NAMES = new Set(["img", "svg", "canvas", "video"]);
const IGNORED_ELEMENT_NAMES = new Set([
  "head",
  "script",
  "style",
  "template",
  "noscript",
  "title",
  "meta",
  "link",
]);

type ParsedHtmlNode = DefaultTreeAdapterMap["node"];
type ParsedHtmlElement = DefaultTreeAdapterMap["element"];

export interface ComposerPastedFiles {
  readonly imageFiles: readonly File[];
  readonly otherFiles: readonly File[];
  /** Images a copy from Nodex carries as the Library Files they show. */
  readonly libraryImages: readonly CopiedLibraryImage[];
  readonly source: "paste";
}

export interface ComposerDataTransferClassification {
  readonly imageFiles: readonly File[];
  readonly otherFiles: readonly File[];
  readonly plainText: string;
  readonly html: string;
  readonly isMediaOnlyHtml: boolean;
  readonly hasMeaningfulText: boolean;
  readonly disposition: "consume-files" | "pass-through";
}

export function isSupportedComposerImageFile(file: File): boolean {
  return isSupportedComposerImageMetadata({
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  });
}

function collectTransferFiles(dataTransfer: DataTransfer): readonly File[] {
  const fileList = Array.from(dataTransfer.files ?? []);
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (itemFiles.length > fileList.length) return itemFiles;
  if (fileList.length > 0) return fileList;
  return itemFiles;
}

function isParsedHtmlElement(node: ParsedHtmlNode): node is ParsedHtmlElement {
  return "tagName" in node;
}

function readParsedHtmlAttribute(element: ParsedHtmlElement, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value ?? null;
}

function isHiddenElement(element: ParsedHtmlElement): boolean {
  if (IGNORED_ELEMENT_NAMES.has(element.tagName)) return true;
  if (readParsedHtmlAttribute(element, "hidden") !== null) return true;
  if (readParsedHtmlAttribute(element, "aria-hidden")?.toLowerCase() === "true") return true;
  if (
    element.tagName === "input" &&
    readParsedHtmlAttribute(element, "type")?.toLowerCase() === "hidden"
  )
    return true;

  const style = readParsedHtmlAttribute(element, "style")?.toLowerCase() ?? "";
  return (
    /(?:^|;)\s*display\s*:\s*none\b/.test(style) ||
    /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style)
  );
}

interface HtmlMediaSummary {
  hasMeaningfulText: boolean;
  hasVisibleMedia: boolean;
}

interface HtmlTraversalEntry {
  readonly node: ParsedHtmlNode;
  readonly hidden: boolean;
  readonly insideMedia: boolean;
}

function summarizeParsedHtml(root: ParsedHtmlNode): HtmlMediaSummary {
  const summary: HtmlMediaSummary = { hasMeaningfulText: false, hasVisibleMedia: false };
  const pending: HtmlTraversalEntry[] = [{ node: root, hidden: false, insideMedia: false }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const { node, hidden, insideMedia } = current;
    if (node.nodeName === "#text" && "value" in node) {
      if (!hidden && !insideMedia && node.value.trim().length > 0) summary.hasMeaningfulText = true;
      continue;
    }

    const element = isParsedHtmlElement(node) ? node : null;
    const nextHidden = hidden || (element !== null && isHiddenElement(element));
    const isMedia = element !== null && MEDIA_ELEMENT_NAMES.has(element.tagName);
    if (isMedia && !nextHidden) summary.hasVisibleMedia = true;

    if (!("childNodes" in node)) continue;
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (!child) continue;
      pending.push({ node: child, hidden: nextHidden, insideMedia: insideMedia || isMedia });
    }
  }

  return summary;
}

export function isComposerMediaOnlyHtml(html: string): boolean {
  if (!html || html.length > MEDIA_ONLY_HTML_LIMIT) return false;

  const summary = summarizeParsedHtml(parseFragment(html));
  return summary.hasVisibleMedia && !summary.hasMeaningfulText;
}

function hasMeaningfulClipboardText(plainText: string, files: readonly File[]): boolean {
  const filenames = new Set(
    files.map((file) => normalizeComposerImageFilenameCandidate(file.name)),
  );
  const lines = plainText
    .split(/\r?\n/)
    .map(normalizeComposerImageFilenameCandidate)
    .filter(Boolean);
  return lines.some((line) => !filenames.has(line));
}

export function classifyComposerDataTransfer(
  dataTransfer: DataTransfer,
): ComposerDataTransferClassification {
  const files = collectTransferFiles(dataTransfer).filter((file) => file.size > 0);
  const imageFiles = files.filter(isSupportedComposerImageFile);
  const otherFiles = files.filter((file) => !isSupportedComposerImageFile(file));
  const plainText = dataTransfer.getData("text/plain");
  const html = dataTransfer.getData("text/html");
  const isMediaOnlyHtml = isComposerMediaOnlyHtml(html);
  const hasMeaningfulText = hasMeaningfulClipboardText(plainText, files);
  const hasConsumableFiles =
    otherFiles.length > 0 || (imageFiles.length > 0 && (!hasMeaningfulText || isMediaOnlyHtml));

  return {
    imageFiles,
    otherFiles,
    plainText,
    html,
    isMediaOnlyHtml,
    hasMeaningfulText,
    disposition: hasConsumableFiles ? "consume-files" : "pass-through",
  };
}

export function handleComposerFilePaste(
  event: ClipboardEvent,
  onPasteFiles: ((payload: ComposerPastedFiles) => boolean) | undefined,
): boolean {
  if (event.defaultPrevented) return true;
  const clipboard = event.clipboardData;
  if (!clipboard) return false;

  const classification = classifyComposerDataTransfer(clipboard);
  if (classification.disposition !== "consume-files") return false;
  if (
    onPasteFiles?.({
      imageFiles: classification.imageFiles,
      otherFiles: classification.otherFiles,
      libraryImages: [],
      source: "paste",
    }) !== true
  )
    return false;

  event.preventDefault();
  return true;
}

/**
 * A paste of Nodex's own copy whose images are Library Files: the Composer takes those images into
 * its attachment row, as it takes image files, and the paste inserts the rest of the copy as text.
 * Returns the text still to insert, or undefined when the paste is not such a copy or the Composer
 * takes none of it.
 */
export function takeComposerLibraryImagePaste(
  event: ClipboardEvent,
  onPasteFiles: ((payload: ComposerPastedFiles) => boolean) | undefined,
): { readonly text: string | null } | undefined {
  const clipboard = event.clipboardData;
  if (event.defaultPrevented || !clipboard || !onPasteFiles) return undefined;
  const paste = readComposerPaste({
    types: Array.from(clipboard.types ?? []),
    getData: (format) => clipboard.getData(format),
  });
  if (
    paste.images.length === 0 ||
    !onPasteFiles({ imageFiles: [], otherFiles: [], libraryImages: paste.images, source: "paste" })
  )
    return undefined;
  return { text: paste.text };
}
