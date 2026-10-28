import type { Element, Root, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import {
  NODEX_CLIPBOARD_FRAGMENT_ATTRIBUTE,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../clipboard-paste";
import type { MarkdownBlock, MarkdownInline } from "../nodex-markdown";
import { writePortableMarkdown } from "../nodex-markdown";
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

function withoutInlineImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return (content as MarkdownInline[]).flatMap((item): MarkdownInline[] => {
    if (item.type === "inlineImage") return [];
    if (!Array.isArray(item.content)) return [item];
    const children = withoutInlineImages(item.content) as MarkdownInline[];
    return children.length ? [{ ...item, content: children }] : [];
  });
}

function withoutImages(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  return blocks.flatMap((block) => {
    if (block.type === "image") return [];
    const content =
      block.type === "table" && block.content && typeof block.content === "object"
        ? {
            ...block.content,
            rows: (block.content as { rows: { cells: { content?: unknown }[] }[] }).rows.map(
              (row) => ({
                ...row,
                cells: row.cells.map((cell) => ({
                  ...cell,
                  content: withoutInlineImages(cell.content),
                })),
              }),
            ),
          }
        : withoutInlineImages(block.content);
    return [
      {
        ...block,
        ...(content !== undefined ? { content } : {}),
        children: withoutImages(block.children ?? []),
      },
    ];
  });
}

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
