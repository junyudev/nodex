import type { Element, ElementContent, Root as HastRoot, RootContent as HastContent } from "hast";
import type { Root as MdastRoot, RootContent as MdastContent } from "mdast";
import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import type { MarkdownBlock } from "../nodex-markdown";
import { htmlMdastToBlocks } from "./html-blocks";
import { normalizeRichHtmlBlocks } from "./rich-html-blocks";

/**
 * HTML, as another app puts it on the clipboard, read as Blocks by way of Markdown: the
 * structure HTML shares with Markdown keeps its meaning, and every line the source shows stays
 * a line. A run of `<div>` lines, as Notes and mail write text, is one paragraph broken where
 * each line ends; an empty line between them ends the paragraph.
 */
export function htmlToBlocks(html: string): MarkdownBlock[] {
  const tree = fromHtml(html, { fragment: true });
  normalizeClipboardHtml(tree);
  const mdast = toMdast(tree);
  const root: MdastRoot =
    mdast.type === "root" ? mdast : { type: "root", children: [mdast as MdastContent] };
  const phrasing = new Set([
    "text",
    "break",
    "inlineCode",
    "strong",
    "emphasis",
    "delete",
    "link",
    "image",
  ]);
  const children: MdastContent[] = [];
  let run: MdastContent[] = [];
  const flush = () => {
    if (!run.length) return;
    children.push({ type: "paragraph", children: run as import("mdast").PhrasingContent[] });
    run = [];
  };
  for (const child of root.children) {
    if (phrasing.has(child.type)) {
      run.push(child);
      continue;
    }
    flush();
    children.push(child);
  }
  flush();
  return normalizeRichHtmlBlocks(htmlMdastToBlocks({ type: "root", children }));
}

/** Elements that only style text; anything else starts or holds a Block. */
const PHRASING = new Set(
  "a abbr b bdi bdo br cite code data del dfn em font i img ins kbd mark q s samp small span strike strong sub sup time u var wbr".split(
    " ",
  ),
);

const isPhrasing = (node: ElementContent): boolean =>
  node.type === "text" ||
  node.type === "comment" ||
  (node.type === "element" && PHRASING.has(node.tagName) && node.children.every(isPhrasing));

const isLineDiv = (node: HastContent): boolean =>
  node.type === "element" && node.tagName === "div" && node.children.every(isPhrasing);

const lineBreak = (): Element => ({ type: "element", tagName: "br", properties: {}, children: [] });

/** A line with no text, such as `<div><br></div>`, is the empty line between paragraphs. */
const isBlankLine = (node: Element): boolean =>
  node.children.every(
    (child) =>
      (child.type === "text" && child.value.trim() === "") ||
      child.type === "comment" ||
      (child.type === "element" &&
        (child.tagName === "br" ||
          (PHRASING.has(child.tagName) && isBlankLine(child) && child.tagName !== "img"))),
  );

/** Trim each div line before joining it, so source edge breaks do not become interior breaks. */
function trimDivLineBreaks(line: Element): void {
  const leaves = (node: Element): ElementContent[] =>
    node.children.flatMap((child): ElementContent[] =>
      child.type === "element" &&
      PHRASING.has(child.tagName) &&
      child.tagName !== "br" &&
      child.tagName !== "img"
        ? leaves(child)
        : [child],
    );
  const content = leaves(line);
  const isContent = (child: ElementContent) =>
    child.type === "text"
      ? child.value.trim() !== ""
      : child.type === "element" && child.tagName !== "br";
  const first = content.findIndex(isContent);
  const last = content.findLastIndex(isContent);
  const edgeBreaks = new Set(
    content.filter(
      (child, index) =>
        child.type === "element" && child.tagName === "br" && (index < first || index > last),
    ),
  );
  const strip = (node: Element): void => {
    node.children = node.children.filter((child) => !edgeBreaks.has(child));
    node.children.forEach((child) => {
      if (child.type === "element") strip(child);
    });
  };
  strip(line);
}

/**
 * Styles a document writes in CSS, as Google Docs does, read as the marks they show: bold,
 * italic and struck-through text. A wrapper that only resets the weight of what it holds, as
 * Google Docs puts around a copy, is not bold.
 */
function styledAsMarked(element: Element): Element {
  const style = String(element.properties.style ?? "").toLowerCase();
  if (
    (element.tagName === "b" || element.tagName === "strong") &&
    /font-weight:\s*(?:normal|[1-5]00)\b/u.test(style)
  )
    return { ...element, tagName: "span" };
  if (element.tagName !== "span" || !style) return element;
  const marks = [
    /font-weight:\s*(?:bold|[6-9]00)\b/u.test(style) ? "strong" : null,
    /font-style:\s*italic\b/u.test(style) ? "em" : null,
    /text-decoration(?:-line)?:[^;]*line-through/u.test(style) ? "s" : null,
  ].filter((mark): mark is string => mark !== null);
  return marks.reduceRight<Element>(
    (inner, tagName) => ({ type: "element", tagName, properties: {}, children: [inner] }),
    element,
  );
}

function normalizeClipboardHtml(node: HastRoot | Element): void {
  const children: HastContent[] = [];
  let lines: Element[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    children.push({
      type: "element",
      tagName: "p",
      properties: {},
      children: lines.flatMap((line, index): ElementContent[] => [
        ...(index > 0 ? [lineBreak()] : []),
        ...line.children,
      ]),
    });
    lines = [];
  };
  for (const child of node.children as HastContent[]) {
    if (child.type === "element") normalizeClipboardHtml(child);
    if (isLineDiv(child)) {
      if (isBlankLine(child as Element)) flush();
      else {
        trimDivLineBreaks(child as Element);
        lines.push(child as Element);
      }
      continue;
    }
    flush();
    children.push(child.type === "element" ? styledAsMarked(child) : child);
  }
  flush();
  node.children = children as typeof node.children;
}
