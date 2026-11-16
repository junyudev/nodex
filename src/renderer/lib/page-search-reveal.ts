import type { PageSearchMatch } from "../../shared/types";

export interface PageSearchReveal {
  readonly kind: "page-search";
  readonly blockId: string;
  readonly text: string;
}

/** Core returns excerpts with original text. Use a contiguous highlight as the Find query. */
export function pageSearchReveal(
  matches: readonly PageSearchMatch[],
): PageSearchReveal | undefined {
  for (const match of matches) {
    if (match.source !== "body" || !match.blockId) continue;

    const text = match.parts.find((part) => part.highlighted && part.text.trim())?.text.trim();
    if (text) return { kind: "page-search", blockId: match.blockId, text };
  }
  return undefined;
}
