import type { MarkdownInline } from "../nodex-markdown";

const inlineText = (item: MarkdownInline): string => {
  if (item.type === "text") return item.text ?? "";
  if (item.type === "link" && Array.isArray(item.content))
    return item.content.map(inlineText).join("");
  return "\ufffc";
};

/** Slice text across marks and links without treating inline atoms as whitespace. */
function sliceInline(
  content: readonly MarkdownInline[],
  start: number,
  end: number,
): MarkdownInline[] {
  let offset = 0;
  return content.flatMap((item): MarkdownInline[] => {
    const size = inlineText(item).length;
    const from = Math.max(0, start - offset);
    const to = Math.min(size, end - offset);
    offset += size;
    if (from >= to) return [];
    if (from === 0 && to === size) return [item];
    if (item.type === "text") return [{ ...item, text: item.text!.slice(from, to) }];
    if (item.type === "link" && Array.isArray(item.content))
      return [{ ...item, content: sliceInline(item.content, from, to) }];
    return [item];
  });
}

/**
 * External rich HTML uses empty paragraphs and edge breaks for spacing. They separate
 * content rather than becoming Blocks; internal clipboard fragments bypass this rule.
 */
export function normalizeRichHtmlBlocks<
  T extends { readonly type: string; readonly content?: unknown; readonly children?: readonly T[] },
>(blocks: readonly T[]): T[] {
  return blocks.flatMap((block): T[] => {
    const children = block.children ? normalizeRichHtmlBlocks(block.children) : undefined;
    const childrenChanged =
      children?.some((child, index) => child !== block.children?.[index]) ||
      children?.length !== block.children?.length;
    const normalized = childrenChanged ? { ...block, children } : block;
    if (block.type !== "paragraph" || !Array.isArray(block.content)) return [normalized];

    const content = block.content as MarkdownInline[];
    const text = content.map(inlineText).join("");
    if (!text.trim()) return children ?? [];
    const start = text.match(/^(?:[^\S\n]*\n)+/u)?.[0].length ?? 0;
    const end = text.length - (text.match(/(?:\n[^\S\n]*)+$/u)?.[0].length ?? 0);
    if (start === 0 && end === text.length) return [normalized];
    return [{ ...normalized, content: sliceInline(content, start, end) }];
  });
}
