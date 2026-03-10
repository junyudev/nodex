import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

interface SelectionLike {
  empty: boolean;
  from: number;
  to: number;
}

interface NodeLike {
  nodeSize?: number;
  firstChild?: {
    type?: {
      name?: string;
    };
  };
  type?: {
    name?: string;
  };
}

interface DocLike {
  nodesBetween: (
    from: number,
    to: number,
    callback: (node: NodeLike, pos: number) => void,
  ) => void;
}

interface DecorationRange {
  from: number;
  to: number;
}

const IMAGE_BLOCK_CONTAINER_TYPE = "blockContainer";
const IMAGE_BLOCK_TYPE = "image";
const pluginKey = new PluginKey<DecorationSet>("nodex-selected-image-blocks");

export const SELECTED_IMAGE_BLOCK_CLASS = "nodex-selected-image-block";

export function collectSelectedImageBlockDecorationRanges(
  doc: DocLike,
  selection: SelectionLike,
): DecorationRange[] {
  if (selection.empty) return [];

  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (from >= to) return [];

  const ranges: DecorationRange[] = [];
  const seen = new Set<number>();

  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type?.name !== IMAGE_BLOCK_CONTAINER_TYPE) return;
    if (node.firstChild?.type?.name !== IMAGE_BLOCK_TYPE) return;
    if (typeof node.nodeSize !== "number" || node.nodeSize <= 0) return;
    if (seen.has(pos)) return;

    seen.add(pos);
    ranges.push({
      from: pos,
      to: pos + node.nodeSize,
    });
  });

  return ranges;
}

function buildSelectedImageDecorationSet(
  doc: DocLike,
  selection: SelectionLike,
): DecorationSet {
  const ranges = collectSelectedImageBlockDecorationRanges(doc, selection);
  if (ranges.length === 0) return DecorationSet.empty;

  const decorations = ranges.map((range) =>
    Decoration.node(
      range.from,
      range.to,
      { class: SELECTED_IMAGE_BLOCK_CLASS },
      { key: `${range.from}:${range.to}` },
    ),
  );
  return DecorationSet.create(doc as Parameters<typeof DecorationSet.create>[0], decorations);
}

export function selectedImageBlockDecorationsExtension() {
  return createExtension({
    key: "selected-image-block-decorations",
    prosemirrorPlugins: [
      new Plugin({
        key: pluginKey,
        state: {
          init: (_config, state) =>
            buildSelectedImageDecorationSet(
              state.doc as unknown as DocLike,
              state.selection as unknown as SelectionLike,
            ),
          apply: (transaction, previousDecorations, _oldState, newState) => {
            if (!transaction.docChanged && !transaction.selectionSet) {
              return previousDecorations;
            }
            return buildSelectedImageDecorationSet(
              newState.doc as unknown as DocLike,
              newState.selection as unknown as SelectionLike,
            );
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ],
  });
}
