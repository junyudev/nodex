import type { EditorState } from "@tiptap/pm/state";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";

/** A selection inside one Block's inline text, in the offsets Core marks. */
export interface BlockTextRange {
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
  readonly expectedText: string;
}

/** Inline atoms such as mentions occupy one offset but contribute no text; line breaks are "\n". */
const leafText = (node: ProsemirrorNode): string => (node.type.name === "hardBreak" ? "\n" : "");

/**
 * Converts a document selection into a range Core can mark itself: UTF-16 offsets within one
 * Block's inline content, each inline atom counting as one. Selections that cross Blocks have no
 * such range.
 */
export function blockTextRange(
  state: EditorState,
  from: number,
  to: number,
): BlockTextRange | null {
  if (from >= to) return null;
  const start = state.doc.resolve(from);
  const end = state.doc.resolve(to);
  if (!start.sameParent(end) || !start.parent.isTextblock || start.depth < 1) return null;
  const container = start.node(start.depth - 1);
  const blockId = typeof container.attrs.id === "string" ? container.attrs.id : null;
  if (!blockId) return null;
  const expectedText = state.doc.textBetween(from, to, "", leafText);
  if (!expectedText) return null;
  const contentStart = start.start();
  return { blockId, from: from - contentStart, to: to - contentStart, expectedText };
}
