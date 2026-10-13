import type { Root as HtmlRoot, RootContent } from "hast";
import { markdownSyntaxEngine, type ImmutableMarkdown } from "./markdown-syntax";
import { readMarkdownSyntaxPolicy } from "./markdown-policy";

const BLOCK_TAGS = new Set([
  "p",
  "blockquote",
  "li",
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
]);

function isBlock(node: ImmutableMarkdown<RootContent>): boolean {
  return node.type === "element" && BLOCK_TAGS.has(node.tagName);
}

function displayText(node: ImmutableMarkdown<HtmlRoot | RootContent>): string {
  if (node.type === "text") return node.value;
  if (node.type !== "root" && node.type !== "element") return "";
  if (node.type === "element") {
    if (node.tagName === "nodex-visualization") return "";
    if (node.tagName === "img") return "";
    if (node.tagName === "br") return " ";
  }
  let text = "";
  let previous: ImmutableMarkdown<RootContent> | null = null;
  for (const child of node.children) {
    const content = displayText(child);
    if (!content) continue;
    if (text && (isBlock(child) || (previous !== null && isBlock(previous)))) text += " ";
    text += content;
    previous = child;
  }
  return text;
}

/** Find reads the same immutable display tree as the mounted assistant document. */
export function projectConversationMarkdownDisplayText(source: string, streaming: boolean): string {
  const policy = readMarkdownSyntaxPolicy({
    dialect: "conversation",
    preserveLineBreaks: true,
    visualizations: true,
    fileMedia: false,
    repairIncomplete: streaming,
  });
  const snapshot = markdownSyntaxEngine.readFull(source, policy, "terminal");
  return snapshot.blocks
    .map((block) => displayText(block.html))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
