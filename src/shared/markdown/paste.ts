import type { Element, Root, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import {
  NODEX_CLIPBOARD_FRAGMENT_ATTRIBUTE,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../clipboard-paste";
import { parseFileSource } from "../file-resources";
import type { MarkdownBlock, MarkdownInline } from "../nodex-markdown";
import { readMarkdown, writeMarkdown, writePortableMarkdown } from "../nodex-markdown";
import { htmlToBlocks } from "./html";

/** The parts of a clipboard payload a paste reads. */
export interface ClipboardPayload {
  readonly types: readonly string[];
  getData(format: string): string;
}

/**
 * What pasting into a place that holds Markdown text, such as a Composer, inserts: the Markdown
 * source of what was copied, with every line it shows. A copy that is already Markdown, Nodex's
 * own, or code stays as written; rich text from other apps becomes its Markdown, unless that
 * would lose words the copy's plain text has. Images in rich text are left out: a Composer
 * takes images as attachments, from the files a copy carries. Null when the copy holds no text.
 */
export function readMarkdownPaste(clipboard: ClipboardPayload): string | null {
  const plain = clipboard.getData("text/plain");
  const markdown = clipboard.getData("text/markdown");
  if (markdown) return markdown;
  const html = clipboard.getData("text/html");
  if (!html || isNodexCopy(clipboard, html) || isCodeCopy(clipboard, html)) return plain || null;
  const converted = writePortableMarkdown(withoutImages(htmlToBlocks(html))).markdown;
  if (!converted.trim()) return plain || null;
  return !plain || keepsWords(plain, converted) ? converted : plain;
}

/** An image a copy from Nodex carries as the Library File it shows. */
export interface CopiedLibraryImage {
  readonly fileId: string;
  readonly caption: string;
}

/**
 * What pasting into a Composer takes: the Markdown text a paste inserts (`readMarkdownPaste`) and
 * the Library images a copy from Nodex carries, which join the attachment row as image files do.
 * The text keeps everything else as written; images that are not Library Files stay in it.
 */
export function readComposerPaste(clipboard: ClipboardPayload): {
  readonly text: string | null;
  readonly images: readonly CopiedLibraryImage[];
} {
  const html = clipboard.getData("text/html");
  const plain = clipboard.getData("text/plain");
  if (!html || !plain || clipboard.getData("text/markdown") || !isNodexCopy(clipboard, html))
    return { text: readMarkdownPaste(clipboard), images: [] };
  // The rich form names each image's File; its plain Markdown may name an exported copy instead.
  const copied = htmlImageSources(fromHtml(html, { fragment: true }));
  const images: CopiedLibraryImage[] = [];
  let index = 0;
  const text = withoutImagesWhere(readMarkdown(plain, "boundary"), (_url, caption) => {
    const fileId = parseFileSource(copied[index++] ?? "");
    if (fileId) images.push({ fileId, caption });
    return fileId !== null;
  });
  if (index !== copied.length || images.length === 0) return { text: plain, images: [] };
  return { text: writeMarkdown(text).trim() || null, images };
}

function htmlImageSources(node: Root | Element): string[] {
  return node.children.flatMap((child) =>
    child.type !== "element"
      ? []
      : child.tagName === "img"
        ? [String(child.properties.src ?? "")]
        : htmlImageSources(child),
  );
}

/**
 * The Blocks the text of a copy pasted into a Page becomes; none when the copy's rich form
 * decides. Code from an editor and Nodex's own copies keep their rich form. Markdown a source
 * provides reads as Markdown, and plain text alone reads by `readPlainTextBlocks`. Beside rich
 * text, plain text counts only when it writes a table, which the rich form shows as text.
 */
export function readPageTextPaste(clipboard: ClipboardPayload): MarkdownBlock[] {
  const { types } = clipboard;
  if (types.includes("vscode-editor-data") || types.includes("blocknote/html")) return [];
  const markdown = types.includes("text/markdown") ? clipboard.getData("text/markdown") : "";
  if (markdown) return readMarkdown(markdown, "boundary");
  const plain = types.includes("text/plain") ? clipboard.getData("text/plain") : "";
  if (!types.includes("text/html")) return readPlainTextBlocks(plain);
  const blocks = readMarkdown(plain, "boundary");
  return blocks.some((block) => block.type === "table") ? blocks : [];
}

/**
 * The Blocks plain text pasted into a Page becomes. Text written in Markdown reads by the Markdown
 * rules: a newline breaks a line and a blank line separates Blocks. Other text means its lines:
 * each line becomes a paragraph with exactly its text, and blank lines only separate them.
 */
export function readPlainTextBlocks(text: string): MarkdownBlock[] {
  const markdown = readMarkdown(text, "boundary");
  if (markdown.some((block) => writesMarkdown(block, text))) return markdown;
  return text
    .split(/\r\n?|\n/u)
    .filter((line) => line.trim())
    .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
}

/** A fence opens written code. An indented line alone also reads as code, but plain text indents. */
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/mu;

/**
 * Whether a Block read from text holds what only Markdown writes. Plain text has lines,
 * indentation and web addresses of its own, so those alone are not Markdown.
 */
function writesMarkdown(block: MarkdownBlock, text: string): boolean {
  if (block.type === "codeBlock") return FENCE.test(text);
  return (
    block.type !== "paragraph" ||
    Boolean(block.children?.length) ||
    Object.keys(block.props ?? {}).length > 0 ||
    inlineWritesMarkdown(block.content)
  );
}

function inlineWritesMarkdown(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    (content as MarkdownInline[]).some((item) =>
      item.type === "text" ? isStyled(item) : item.type !== "link" || !isAddress(item),
    )
  );
}

const isStyled = (item: MarkdownInline) => Object.keys(item.styles ?? {}).length > 0;

/** A web or mail address in text reads as a link to itself. */
function isAddress(link: MarkdownInline): boolean {
  const [only, ...rest] = Array.isArray(link.content) ? link.content : [];
  if (!only || rest.length > 0 || only.type !== "text" || isStyled(only)) return false;
  return [only.text, `http://${only.text}`, `mailto:${only.text}`].includes(link.href);
}

type ImageFilter = (url: string, caption: string) => boolean;

/** Blocks without the images, in reading order, that `drop` picks. */
function withoutImagesWhere(blocks: readonly MarkdownBlock[], drop: ImageFilter): MarkdownBlock[] {
  return blocks.flatMap((block) => {
    if (
      block.type === "image" &&
      drop(String(block.props?.url ?? ""), String(block.props?.caption ?? ""))
    )
      return [];
    const content =
      block.type === "table" && block.content && typeof block.content === "object"
        ? {
            ...block.content,
            rows: (block.content as { rows: { cells: { content?: unknown }[] }[] }).rows.map(
              (row) => ({
                ...row,
                cells: row.cells.map((cell) => ({
                  ...cell,
                  content: withoutInlineImagesWhere(cell.content, drop),
                })),
              }),
            ),
          }
        : withoutInlineImagesWhere(block.content, drop);
    // A paragraph that only held images goes with them.
    if (
      block.type === "paragraph" &&
      Array.isArray(block.content) &&
      block.content.length > 0 &&
      Array.isArray(content) &&
      content.length === 0 &&
      !block.children?.length
    )
      return [];
    return [
      {
        ...block,
        ...(content !== undefined ? { content } : {}),
        children: withoutImagesWhere(block.children ?? [], drop),
      },
    ];
  });
}

function withoutInlineImagesWhere(content: unknown, drop: ImageFilter): unknown {
  if (!Array.isArray(content)) return content;
  const kept: MarkdownInline[] = [];
  let dropped = false;
  for (const item of content as MarkdownInline[]) {
    if (
      item.type === "inlineImage" &&
      drop(String(item.props?.url ?? ""), String(item.props?.alt ?? ""))
    ) {
      dropped = true;
      continue;
    }
    const previous = kept.at(-1);
    // Words that stood either side of an image keep one space between them.
    const next =
      dropped &&
      item.type === "text" &&
      previous?.type === "text" &&
      /\s$/u.test(previous.text ?? "")
        ? { ...item, text: (item.text ?? "").replace(/^\s+/u, "") }
        : item;
    dropped = false;
    if (!Array.isArray(next.content)) {
      kept.push(next);
      continue;
    }
    const children = withoutInlineImagesWhere(next.content, drop) as MarkdownInline[];
    if (children.length) kept.push({ ...next, content: children });
  }
  return kept;
}

const withoutImages = (blocks: readonly MarkdownBlock[]) => withoutImagesWhere(blocks, () => true);

/** Nodex writes its own copies' plain text as Markdown already. */
function isNodexCopy(clipboard: ClipboardPayload, html: string): boolean {
  return (
    clipboard.types.includes("blocknote/html") ||
    clipboard.types.includes(NODEX_STRUCTURAL_CLIPBOARD_MIME) ||
    html.includes(NODEX_CLIPBOARD_FRAGMENT_ATTRIBUTE)
  );
}

const MONOSPACE = /font-family:[^;"]*(?:mono|menlo|consolas|courier|sf mono|fira code)/iu;

/**
 * Code copied from an editor or a code block keeps its exact text: the editor says so, or the
 * copy is one preformatted or monospace block.
 */
function isCodeCopy(clipboard: ClipboardPayload, html: string): boolean {
  if (clipboard.types.includes("vscode-editor-data")) return true;
  const content = meaningful(fromHtml(html, { fragment: true }));
  if (content.length !== 1 || content[0]!.type !== "element") return false;
  const element = content[0] as Element;
  const style = String(element.properties.style ?? "");
  return element.tagName === "pre" || /white-space:\s*pre\b/iu.test(style) || MONOSPACE.test(style);
}

/** The copy's content, without the document furniture and whitespace around it. */
function meaningful(node: Root | Element): RootContent[] {
  return node.children.flatMap((child): RootContent[] => {
    if (child.type === "text") return child.value.trim() ? [child] : [];
    if (child.type !== "element") return [];
    if (["meta", "style", "script", "title", "link"].includes(child.tagName)) return [];
    if (["html", "head", "body"].includes(child.tagName)) return meaningful(child);
    return [child];
  });
}

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

/** Every word of the plain text appears, in order, in the Markdown. */
function keepsWords(plain: string, markdown: string): boolean {
  const target = words(markdown);
  let cursor = 0;
  for (const word of words(plain)) {
    while (cursor < target.length && target[cursor] !== word) cursor += 1;
    if (cursor === target.length) return false;
    cursor += 1;
  }
  return true;
}
