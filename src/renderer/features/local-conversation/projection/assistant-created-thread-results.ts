import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Nodes } from "mdast";
import {
  decodeCreatedThreadResult,
  type CodexCreatedThreadResult,
} from "../../../../shared/codex-created-thread-result";

const EMPTY_RESULTS: readonly CodexCreatedThreadResult[] = Object.freeze([]);

/** Authored creation declarations are line metadata, independent of their display preparation. */
export function readAssistantCreatedThreadResults(input: {
  readonly source: string;
  readonly completed: boolean;
  readonly aeon: boolean;
}): readonly CodexCreatedThreadResult[] {
  if (!input.completed || input.aeon || !input.source.includes(":created-thread"))
    return EMPTY_RESULTS;
  const lines = input.source.split("\n").flatMap((line) => {
    const candidate = line.replace(/^[ \t]+/, "");
    const marker = /^(:{1,3})created-thread(?![A-Za-z\d_-])/.exec(candidate);
    if (!marker) return [];
    return marker[1]!.length === 3 ? [candidate, ":::"] : [candidate];
  });
  if (lines.length === 0) return EMPTY_RESULTS;
  const root = fromMarkdown(lines.join("\n") + "\n", {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  });
  const results: CodexCreatedThreadResult[] = [];
  const visit = (node: Nodes): void => {
    if (
      (node.type === "textDirective" ||
        node.type === "leafDirective" ||
        node.type === "containerDirective") &&
      node.name === "created-thread"
    ) {
      const result = decodeCreatedThreadResult(node.attributes);
      if (result) results.push(result);
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(root);
  return results.length === 0 ? EMPTY_RESULTS : results;
}
