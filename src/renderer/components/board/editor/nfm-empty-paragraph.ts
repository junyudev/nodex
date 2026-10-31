interface ParagraphCandidate {
  readonly type?: string;
  readonly content?: unknown;
  readonly children?: readonly unknown[];
}

/** A paragraph with no inline content and no children: a line that is ready to type into. */
export function isEmptyParagraphBlock(block: ParagraphCandidate | null | undefined): boolean {
  if (!block || block.type !== "paragraph") return false;
  if ((block.children?.length ?? 0) > 0) return false;
  return !Array.isArray(block.content) || block.content.length === 0;
}
