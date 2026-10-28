import type { Root, RootContent, PhrasingContent } from "mdast";
import type { MarkdownBlock, MarkdownInline } from "../nodex-markdown";
import { normalizeCodeLanguageId } from "../code-languages/code-language-catalog";

/** Only the structure carried by rich clipboard HTML crosses this adapter. Markdown itself is read by Rust. */
export function htmlMdastToBlocks(root: Root): MarkdownBlock[] {
  const inline = (
    nodes: readonly PhrasingContent[],
    styles: Record<string, boolean> = {},
  ): MarkdownInline[] =>
    nodes.flatMap((node): MarkdownInline[] => {
      if (node.type === "text") return [{ type: "text", text: node.value, styles }];
      if (node.type === "break") return [{ type: "text", text: "\n", styles: {} }];
      if (node.type === "inlineCode")
        return [{ type: "text", text: node.value, styles: { ...styles, code: true } }];
      if (node.type === "strong" || node.type === "emphasis" || node.type === "delete")
        return inline(node.children, {
          ...styles,
          [node.type === "strong" ? "bold" : node.type === "emphasis" ? "italic" : "strike"]: true,
        });
      if (node.type === "link")
        return [{ type: "link", href: node.url, content: inline(node.children, styles) }];
      if (node.type === "image")
        return [{ type: "inlineImage", props: { url: node.url, alt: node.alt ?? "" } }];
      if ("children" in node) return inline(node.children as PhrasingContent[], styles);
      return "value" in node ? [{ type: "text", text: String(node.value), styles }] : [];
    });
  const visit = (nodes: readonly RootContent[]): MarkdownBlock[] =>
    nodes.flatMap((node): MarkdownBlock[] => {
      if (node.type === "paragraph" || node.type === "heading") {
        const content = inline(node.children);
        if (node.type === "paragraph" && content.length === 1 && content[0]?.type === "inlineImage")
          return [
            {
              type: "image",
              props: { url: content[0].props?.url ?? "", caption: content[0].props?.alt ?? "" },
            },
          ];
        return [
          {
            type: node.type,
            ...(node.type === "heading" ? { props: { level: Math.min(4, node.depth) } } : {}),
            content,
          },
        ];
      }
      if (node.type === "code")
        return [
          {
            type: "codeBlock",
            props: { language: normalizeCodeLanguageId(node.lang ?? "text") },
            content: [{ type: "text", text: node.value, styles: {} }],
          },
        ];
      if (node.type === "thematicBreak") return [{ type: "divider" }];
      if (node.type === "blockquote") {
        const children = visit(node.children);
        const first = children[0];
        return [
          {
            type: "quote",
            ...(first?.type === "paragraph"
              ? { content: first.content, children: children.slice(1) }
              : { children }),
          },
        ];
      }
      if (node.type === "list")
        return node.children.map((item, index) => {
          const children = visit(item.children);
          const first = children[0];
          return {
            type:
              item.checked != null
                ? "checkListItem"
                : node.ordered
                  ? "numberedListItem"
                  : "bulletListItem",
            props:
              item.checked != null
                ? { checked: item.checked }
                : node.ordered && index === 0
                  ? { start: node.start ?? 1 }
                  : {},
            ...(first?.type === "paragraph"
              ? { content: first.content, children: children.slice(1) }
              : { children }),
          };
        });
      if (node.type === "table")
        return [
          {
            type: "table",
            content: {
              type: "tableContent",
              headerRows: 1,
              headerCols: 0,
              rows: node.children.map((row) => ({
                cells: row.children.map((cell, index) => ({
                  type: "tableCell",
                  props: { textAlignment: node.align?.[index] ?? "left" },
                  content: inline(cell.children),
                })),
              })),
            },
          },
        ];
      if ("children" in node) return visit(node.children as RootContent[]);
      return [];
    });
  return visit(root.children);
}
