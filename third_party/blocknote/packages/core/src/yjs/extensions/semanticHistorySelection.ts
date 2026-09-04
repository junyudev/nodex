import type { ResolvedPos } from "prosemirror-model";
import { NodeSelection, TextSelection, type EditorState, type Selection } from "prosemirror-state";

interface BlockPoint {
  readonly blockId: string;
  readonly offset: number;
}

/** Stable surface coordinates; these never grant content or ownership authority. */
export type SurfaceHistorySelection =
  | { readonly kind: "text"; readonly anchor: BlockPoint; readonly head: BlockPoint }
  | { readonly kind: "node"; readonly point: BlockPoint };

export interface SurfaceHistorySelectionPair {
  readonly before: SurfaceHistorySelection | undefined;
  readonly after: SurfaceHistorySelection | undefined;
}

const pointAt = (position: ResolvedPos, nodeSelection = false): BlockPoint | undefined => {
  for (let depth = position.depth; depth > 0; depth--) {
    const node = position.node(depth);
    if (node.type.name !== "blockContainer" || typeof node.attrs.id !== "string") continue;
    return {
      blockId: node.attrs.id,
      offset: position.pos - position.start(depth) - (nodeSelection ? 0 : 1),
    };
  }
  const next = position.nodeAfter;
  if (next?.type.name === "blockContainer" && typeof next.attrs.id === "string")
    return { blockId: next.attrs.id, offset: nodeSelection ? -1 : 0 };
  return undefined;
};

export const captureSurfaceHistorySelection = (
  state: EditorState,
): SurfaceHistorySelection | undefined => {
  const { selection } = state;
  const anchor = pointAt(selection.$anchor, selection instanceof NodeSelection);
  if (!anchor) return undefined;
  if (selection instanceof NodeSelection) return { kind: "node", point: anchor };
  const head = pointAt(selection.$head);
  return head ? { kind: "text", anchor, head } : undefined;
};

/** Resolves against the current tree, clamping only within the addressed Block. */
export const resolveSurfaceHistorySelection = (
  state: EditorState,
  bookmark: SurfaceHistorySelection,
): Selection | undefined => {
  const wanted = new Set(
    bookmark.kind === "node"
      ? [bookmark.point.blockId]
      : [bookmark.anchor.blockId, bookmark.head.blockId],
  );
  const positions = new Map<string, { start: number; size: number; nodePosition: number }>();
  state.doc.descendants((node, position) => {
    if (node.type.name !== "blockContainer" || !wanted.has(node.attrs.id)) return true;
    const content = node.firstChild;
    if (content)
      positions.set(node.attrs.id, {
        start: position + 2,
        size: content.content.size,
        nodePosition: position + 1,
      });
    return true;
  });
  const resolve = (point: BlockPoint): ResolvedPos | undefined => {
    const block = positions.get(point.blockId);
    return block
      ? state.doc.resolve(
          Math.min(
            state.doc.content.size,
            block.start + Math.max(0, Math.min(point.offset, block.size)),
          ),
        )
      : undefined;
  };
  if (bookmark.kind === "node") {
    const block = positions.get(bookmark.point.blockId);
    if (!block) return undefined;
    const nodePosition = Math.max(
      block.nodePosition - 1,
      Math.min(block.nodePosition + bookmark.point.offset, block.start + block.size),
    );
    const node = state.doc.nodeAt(nodePosition);
    if (node && NodeSelection.isSelectable(node))
      return NodeSelection.create(state.doc, nodePosition);
    const point = resolve(bookmark.point);
    return point ? TextSelection.near(point) : undefined;
  }
  const anchor = resolve(bookmark.anchor);
  const head = resolve(bookmark.head);
  return anchor && head ? TextSelection.between(anchor, head) : undefined;
};
