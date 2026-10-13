import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Nodes, Root, RootContent, PhrasingContent } from "mdast";
import type { Plugin } from "unified";
import "remark-parse";

interface ConversationGrammarOptions {
  readonly renderedDirectiveNames: readonly string[];
  readonly nullDirectiveNames: readonly string[];
}

function authoredNodeText(node: Nodes, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (
    start === undefined ||
    end === undefined ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length
  )
    throw new Error("Conversation display nodes require authored source positions");
  return source.slice(start, end);
}

function textNode(node: Nodes, value: string): PhrasingContent {
  return { type: "text", value, ...(node.position ? { position: node.position } : {}) };
}

function isNamespacedSkill(node: Nodes, source: string): boolean {
  if (node.type !== "textDirective") return false;
  const start = node.position?.start.offset;
  if (start === undefined) return false;
  // A colon remains authored text in a namespaced skill candidate.
  let prefix = start;
  while (prefix > 0 && /[\w-]/.test(source[prefix - 1]!)) prefix -= 1;
  return prefix < start && source[prefix - 1] === "$";
}

function mergeTextNodes(nodes: Nodes[]): Nodes[] {
  const result: Nodes[] = [];
  for (const node of nodes) {
    const previous = result.at(-1);
    if (previous?.type !== "text" || node.type !== "text") {
      result.push(node);
      continue;
    }
    previous.value += node.value;
    if (previous.position && node.position) previous.position.end = node.position.end;
  }
  return result;
}

/** Public extension data owns parsing; unknown nodes remain authored, visible text. */
export const remarkConversationMarkdown: Plugin<[ConversationGrammarOptions], Root> = function (
  options,
) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(gfm({ singleTilde: false }), directive());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown(), directiveFromMarkdown());
  const rendered = new Set(options.renderedDirectiveNames);
  const hidden = new Set(options.nullDirectiveNames);
  return (root, file) => {
    const source = String(file);
    const convert = (node: Nodes, block: boolean): Nodes[] => {
      if (node.type === "code" || node.type === "inlineCode") return [node];
      if (node.type === "html") {
        const raw = node.value;
        if (/^<br\s*\/?>$/i.test(raw.trim())) {
          const line: PhrasingContent = {
            type: "break",
            ...(node.position ? { position: node.position } : {}),
          };
          return block
            ? [{ type: "paragraph", children: [line], position: node.position }]
            : [line];
        }
        const literal = textNode(node, raw);
        return block
          ? [{ type: "paragraph", children: [literal], position: node.position }]
          : [literal];
      }
      if (
        node.type === "leafDirective" ||
        node.type === "containerDirective" ||
        node.type === "textDirective"
      ) {
        if (isNamespacedSkill(node, source))
          return [textNode(node, authoredNodeText(node, source))];
        if (hidden.has(node.name)) return [];
        if (!rendered.has(node.name)) {
          const literal = textNode(node, authoredNodeText(node, source));
          return node.type === "textDirective"
            ? [literal]
            : [{ type: "paragraph", children: [literal], position: node.position }];
        }
      }
      if (!("children" in node)) return [node];
      const childrenAreBlocks =
        node.type === "root" ||
        node.type === "blockquote" ||
        node.type === "listItem" ||
        node.type === "containerDirective";
      // Replacement preserves the existing tree family rather than reparsing raw descendants.
      node.children = mergeTextNodes(
        node.children.flatMap((child) => convert(child, childrenAreBlocks)),
      ) as typeof node.children;
      return [node];
    };
    root.children = root.children.flatMap((node) => convert(node, true)) as RootContent[];
  };
};
