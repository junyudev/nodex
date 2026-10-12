import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Nodes, Root } from "mdast";
import type { Plugin } from "unified";
import {
  resolveInlineVisualizationMode,
  type InlineVisualizationMode,
} from "./inline-visualization-presentation";

interface InlineVisualizationDirective {
  readonly file: string;
  readonly sourceThreadId: string | null;
  readonly mode: InlineVisualizationMode;
}

function readDirectiveAttributes(
  attributes: Record<string, string | null | undefined> | null | undefined,
): InlineVisualizationDirective | null {
  const file = attributes?.file ?? attributes?.path;
  if (!file) return null;
  return {
    file,
    sourceThreadId: attributes?.threadId || null,
    mode: resolveInlineVisualizationMode(attributes?.mode),
  };
}

declare module "unified" {
  interface Data {
    micromarkExtensions?: ReturnType<typeof directive>[];
    fromMarkdownExtensions?: ReturnType<typeof directiveFromMarkdown>[];
  }
}

/** Real directive nodes exclude fenced/inline code and permit normal attribute ordering. */
export const remarkInlineVisualizations: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(directive());
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown());
  const visit = (node: Nodes) => {
    if (node.type === "leafDirective" && node.name === "codex-inline-vis") {
      const presentation = readDirectiveAttributes(node.attributes);
      if (!presentation) return;
      node.data = {
        ...node.data,
        hName: "nodex-visualization",
        hProperties: {
          file: presentation.file,
          threadid: presentation.sourceThreadId ?? "",
          mode: presentation.mode,
        },
      };
      return;
    }
    if (!("children" in node)) return;
    node.children.forEach(visit);
  };
  return visit;
};

export function resolveInlineVisualizationSourceThreadId(input: {
  readonly file: string;
  readonly declaredSourceThreadId?: string | null;
  readonly threadId: string;
  readonly changedFilePaths: readonly string[];
}): string {
  if (input.declaredSourceThreadId) return input.declaredSourceThreadId;
  const basename = input.file.replaceAll("\\", "/").split("/").at(-1);
  const changedPath = input.changedFilePaths.find(
    (path) => path.replaceAll("\\", "/").split("/").at(-1) === basename,
  );
  const sourceThreadId = changedPath
    ?.replaceAll("\\", "/")
    .match(/\/visualizations\/\d{4}\/\d{2}\/\d{2}\/([A-Za-z0-9_-]+)\//)?.[1];
  return sourceThreadId ?? input.threadId;
}
