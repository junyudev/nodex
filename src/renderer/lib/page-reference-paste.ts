import { rendererSpaceId } from "./renderer-space";
import { buildPageDeepLink, parsePageDeepLink } from "../../shared/nodex-deeplink";

export type PageDeepLinkPasteIntent =
  | { readonly kind: "link"; readonly href: string; readonly pageId: string }
  | { readonly kind: "mention"; readonly pageId: string };

/**
 * A pasted Page link becomes the lightest Page occurrence that fits the caret: a link over
 * selected text, otherwise a Page Mention. Embedding is an explicit later choice.
 */
export function resolvePageDeepLinkPasteIntent(input: {
  readonly plainText: string;
  readonly hasStructuredClipboard: boolean;
  readonly hasFiles: boolean;
  readonly hasTextSelection: boolean;
  readonly currentBlockType: string;
}): PageDeepLinkPasteIntent | null {
  if (input.hasStructuredClipboard || input.hasFiles) return null;

  const target = parsePageDeepLink(input.plainText);
  if (!target || (target.spaceId && target.spaceId !== rendererSpaceId())) return null;
  const href = buildPageDeepLink(target);
  if (href !== input.plainText) return null;

  if (input.currentBlockType === "codeBlock") return null;
  if (input.hasTextSelection) {
    return { kind: "link", href, pageId: target.pageId };
  }
  return { kind: "mention", pageId: target.pageId };
}
