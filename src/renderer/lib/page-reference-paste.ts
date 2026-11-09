import { rendererSpaceId } from "./renderer-space";
import { buildPageDeepLink, parsePageDeepLink } from "../../shared/nodex-deeplink";

export type PageDeepLinkPasteIntent =
  | { readonly kind: "link"; readonly href: string; readonly pageId: string }
  | { readonly kind: "mention"; readonly pageId: string }
  | { readonly kind: "reference_block"; readonly pageId: string };

export function resolvePageDeepLinkPasteIntent(input: {
  readonly plainText: string;
  readonly hasStructuredClipboard: boolean;
  readonly hasFiles: boolean;
  readonly hasTextSelection: boolean;
  readonly currentBlockType: string;
  readonly currentBlockIsEmpty: boolean;
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
  if (input.currentBlockType === "paragraph" && input.currentBlockIsEmpty) {
    return { kind: "reference_block", pageId: target.pageId };
  }
  return { kind: "mention", pageId: target.pageId };
}
