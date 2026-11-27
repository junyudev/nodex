import {
  escapeAttributeValue,
  findBlockElementById,
} from "@/components/board/editor/block-dom-selectors";
import type { DiscussionAnchorView } from "./discussion-view-model";

/** Where a Visual reports its data points, keyed by code block id. */
export interface DatumGeometrySource {
  readonly datumTop: (
    blockId: string,
    datum: { readonly source: string; readonly key: unknown; readonly field?: string | null },
  ) => number | null;
}

/**
 * The top of a Discussion's anchor relative to `origin`, or null when the anchor is not
 * rendered. Text anchors use the first marked span; block anchors the first Block; data points
 * the Visual's reported geometry, falling back to the Visual itself; a Page anchor sits at the top.
 */
export function measureAnchorTop(input: {
  readonly discussionId: string;
  readonly anchor: DiscussionAnchorView;
  readonly editorRoot: ParentNode;
  readonly origin: Element;
  readonly datums?: DatumGeometrySource | null;
}): number | null {
  const originTop = input.origin.getBoundingClientRect().top;
  const top = (element: Element | null) =>
    element ? element.getBoundingClientRect().top - originTop : null;
  switch (input.anchor.kind) {
    case "page":
      return 0;
    case "text":
      return top(
        input.editorRoot.querySelector(
          `[data-bn-thread-id="${escapeAttributeValue(input.discussionId)}"]`,
        ),
      );
    case "blocks":
      return top(findBlockElementById(input.editorRoot, input.anchor.blockIds[0] ?? ""));
    case "datum": {
      const reported = input.datums?.datumTop(input.anchor.blockId, input.anchor);
      if (reported !== null && reported !== undefined) return reported - originTop;
      return top(findBlockElementById(input.editorRoot, input.anchor.blockId));
    }
  }
}

/** Margin presentation: cards beside the column when there is room, compact markers otherwise. */
export type MarginMode = "cards" | "markers";

export const MARGIN_CARD_WIDTH = 248;
export const MARGIN_CARD_GAP = 24;
const MARGIN_TRAILING_SPACE = 16;

/** Chooses cards only when a full card fits between the content column and the scrollport edge. */
export function marginModeForSpace(freeSpaceRight: number): MarginMode {
  return freeSpaceRight >= MARGIN_CARD_GAP + MARGIN_CARD_WIDTH + MARGIN_TRAILING_SPACE
    ? "cards"
    : "markers";
}
