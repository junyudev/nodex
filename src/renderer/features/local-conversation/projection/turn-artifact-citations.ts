import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Nodes } from "mdast";

export interface TurnArtifactCitation {
  readonly path: string;
  readonly purpose: string | undefined;
  readonly mode: "live" | undefined;
  readonly label: string | undefined;
}

export interface TurnArtifactReferences {
  readonly citations: readonly TurnArtifactCitation[];
  readonly visualizationPaths: readonly string[];
}

const PAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const extensions = [directive()];
const mdastExtensions = [directiveFromMarkdown()];

/** Syntax nodes keep examples, HTML, images and link destinations out of artifact discovery. */
export function readTurnArtifactReferences(text: string): TurnArtifactReferences {
  const citations: TurnArtifactCitation[] = [];
  const visualizationPaths: string[] = [];
  if (!text.includes("codex-file-citation") && !text.includes("codex-inline-vis"))
    return { citations, visualizationPaths };
  const root = fromMarkdown(text, { extensions, mdastExtensions });
  const visit = (node: Nodes): void => {
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "html" ||
      node.type === "image" ||
      node.type === "imageReference" ||
      node.type === "definition"
    )
      return;
    if (node.type === "leafDirective" && node.name === "codex-inline-vis") {
      const path = node.attributes?.file ?? node.attributes?.path;
      if (path) visualizationPaths.push(path);
      return;
    }
    if (node.type === "textDirective" && node.name === "codex-file-citation") {
      const attributes = node.attributes;
      const path = attributes?.path?.trim();
      if (!path) return;
      const pageId = attributes?.page_id;
      if (pageId != null && !PAGE_ID_PATTERN.test(pageId.trim())) return;
      const mode = attributes?.mode;
      if (attributes && "mode" in attributes && mode == null) return;
      if (mode != null && mode !== "live") return;
      if (attributes && "purpose" in attributes && attributes.purpose == null) return;
      if (
        mode === "live" &&
        (/^https?:\/\//iu.test(path) ||
          (attributes?.artifact_kind !== "workbook" &&
            attributes?.artifact_kind !== "presentation"))
      )
        return;
      citations.push({
        path,
        purpose: attributes?.purpose ?? undefined,
        mode: mode ?? undefined,
        label: attributes?.label?.trim() || attributes?.title?.trim() || undefined,
      });
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return { citations, visualizationPaths };
}
