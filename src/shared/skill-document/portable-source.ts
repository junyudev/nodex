import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { RootContent } from "mdast";
import type { MarkdownSourceSpan } from "../nodex-markdown";

// Check the portable grammar separately from the Nodex projection. The latter intentionally
// drops link titles and comments, expands references, and interprets Nodex extensions.
export function inspectPortableSource(body: string): {
  opaque: MarkdownSourceSpan[];
  reason?: string;
} {
  const root = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const opaque: MarkdownSourceSpan[] = [];
  function inspect(node: RootContent, top: boolean): string | undefined {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    if (node.type === "html" || node.type === "definition") {
      const comment = node.type === "html" && /^(?:<!--[\s\S]*?-->\s*)+$/.test(node.value);
      if (top && (comment || node.type === "definition")) {
        opaque.push({ start, end });
        return;
      }
      return comment
        ? "A comment is embedded inside an editable block."
        : node.type === "definition"
          ? "A reference definition is embedded inside an editable block."
          : "The body contains raw HTML.";
    }
    if (node.type === "linkReference" || node.type === "imageReference") {
      return "The body uses reference-style links or images.";
    }
    if (node.type === "link" && node.title != null) return "The body contains a link title.";
    if (node.type === "image") return "The body contains an image.";
    if (node.type === "footnoteDefinition" || node.type === "footnoteReference") {
      return "The body contains a footnote.";
    }
    if (node.type === "heading" && node.depth > 4)
      return "The body contains a level 5 or 6 heading.";
    if (
      node.type === "text" &&
      /::+[\w:]|:{3,}(?:\s|$)|:(?:span|date|attachment|agent-config)[\[{]|\{(?:[#.]|[\w-]+\s*=)|\$\$|\\\[/.test(
        body.slice(start, end),
      )
    ) {
      return "The body contains text that looks like a Nodex Markdown extension.";
    }
    if ("children" in node) {
      for (const child of node.children) {
        const reason = inspect(child, false);
        if (reason) return reason;
      }
    }
  }
  for (const node of root.children) {
    const reason = inspect(node, true);
    if (reason) return { opaque, reason };
  }
  return { opaque };
}
