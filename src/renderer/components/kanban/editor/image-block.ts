import { createImageBlockSpec } from "@blocknote/core";
import { resolveAssetSourceToHttpUrl } from "../../../lib/assets";

const baseImageBlockSpec = createImageBlockSpec();

export function resolveExternalImageSource(source: string): string {
  return resolveAssetSourceToHttpUrl(source);
}

function resolveExternalImageBlockUrl<TBlock extends { props?: { url?: string } }>(
  block: TBlock,
): TBlock {
  const rawUrl = block.props?.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return block;

  const resolvedUrl = resolveExternalImageSource(rawUrl);
  if (resolvedUrl === rawUrl) return block;

  return {
    ...block,
    props: {
      ...block.props,
      url: resolvedUrl,
    },
  };
}

function rewriteExternalImageNodeSources(root: Element): void {
  const nodes = [root, ...Array.from(root.querySelectorAll("img, a"))];

  for (const node of nodes) {
    if (node.tagName === "IMG") {
      const rawSrc = node.getAttribute("src");
      if (!rawSrc) continue;

      const resolvedSrc = resolveExternalImageSource(rawSrc);
      if (resolvedSrc === rawSrc) continue;
      node.setAttribute("src", resolvedSrc);
      continue;
    }

    if (node.tagName !== "A") continue;
    const rawHref = node.getAttribute("href");
    if (!rawHref) continue;

    const resolvedHref = resolveExternalImageSource(rawHref);
    if (resolvedHref === rawHref) continue;
    node.setAttribute("href", resolvedHref);
    if ((node.textContent ?? "") === rawHref) {
      node.textContent = resolvedHref;
    }
  }
}

function hasDomNode(value: unknown): value is { dom: Node } {
  if (!value || typeof value !== "object") return false;
  return "dom" in value;
}

function createResolvedImageBlockSpec() {
  const spec = createImageBlockSpec();
  const baseToExternalHTML = spec.implementation.toExternalHTML;
  if (!baseToExternalHTML) return spec;

  spec.implementation = {
    ...spec.implementation,
    toExternalHTML(block, editor, context) {
      const external = baseToExternalHTML.call(
        {},
        resolveExternalImageBlockUrl(block),
        editor,
        context,
      );
      if (!hasDomNode(external)) return external;
      if (typeof Element === "undefined") return external;
      if (!(external.dom instanceof Element)) return external;

      rewriteExternalImageNodeSources(external.dom);
      return external;
    },
  };

  return spec;
}

export const imageBlockSpec = {
  ...baseImageBlockSpec,
  ...createResolvedImageBlockSpec(),
};
