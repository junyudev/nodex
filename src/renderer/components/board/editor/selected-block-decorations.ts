import { createExtension } from "@blocknote/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { registerEditorSelectionSurface } from "@/lib/editor-selection-presentation";
import { resolveTopLevelDraggedBlocks } from "./dragged-block-roots";

const BLOCK_CONTAINER_TYPE = "blockContainer";
const pluginKey = new PluginKey<DecorationSet>("nodex-selected-blocks");

export const SELECTED_BLOCK_CLASS = "nodex-selected-block";
export const SELECTED_BLOCK_CONTENT_ATTRIBUTE = "data-nodex-selected-block-content";
export const SELECTED_BLOCK_SCOPE_ATTRIBUTE = "data-nodex-selected-block-scope";
export const BLOCK_SELECTION_PRESENTATION_ATTRIBUTE = "data-nodex-block-selection-presentation";
export const BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE = "data-nodex-block-action-selection";

export type SelectedBlockDecorationKind = "structural" | "atomic-range" | "block-action";

export interface SelectedBlockDecorationRange {
  readonly from: number;
  readonly to: number;
  readonly kind: SelectedBlockDecorationKind;
}

type SelectionWithNodes = Selection & {
  readonly node?: Node;
  readonly nodes?: readonly Node[];
};

function getStructurallySelectedNodes(selection: Selection): ReadonlySet<Node> {
  const selectionWithNodes = selection as SelectionWithNodes;
  if (Array.isArray(selectionWithNodes.nodes)) {
    return new Set(selectionWithNodes.nodes);
  }
  if (selectionWithNodes.node) {
    return new Set([selectionWithNodes.node]);
  }
  return new Set();
}

/** Projects the authoritative ProseMirror selection onto stable Block containers. */
export function collectSelectedBlockDecorationRanges(
  doc: Node,
  selection: Selection,
  blockActionIds: ReadonlySet<string> = new Set(),
): SelectedBlockDecorationRange[] {
  if (blockActionIds.size > 0) {
    const ranges: SelectedBlockDecorationRange[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== BLOCK_CONTAINER_TYPE) return true;
      const blockId = node.attrs.id;
      if (typeof blockId !== "string" || !blockActionIds.has(blockId)) return true;

      ranges.push({
        from: pos,
        to: pos + node.nodeSize,
        kind: "block-action",
      });
      return false;
    });
    return ranges;
  }

  if (selection.empty) return [];

  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (from >= to) return [];

  const structurallySelectedNodes = getStructurallySelectedNodes(selection);
  const ranges: SelectedBlockDecorationRange[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== BLOCK_CONTAINER_TYPE) return;

    const content = node.firstChild;
    if (!content) return;

    const structurallySelected =
      structurallySelectedNodes.has(node) || structurallySelectedNodes.has(content);
    const contentFrom = pos + 1;
    const contentTo = contentFrom + content.nodeSize;
    const fullyCoveredAtomicContent = content.isAtom && from <= contentFrom && to >= contentTo;

    if (!structurallySelected && !fullyCoveredAtomicContent) return;

    ranges.push({
      from: pos,
      to: pos + node.nodeSize,
      kind: structurallySelected ? "structural" : "atomic-range",
    });
    return false;
  });

  return ranges;
}

function buildSelectedBlockDecorationSet(
  doc: Node,
  selection: Selection,
  blockActionIds: ReadonlySet<string>,
): DecorationSet {
  const ranges = collectSelectedBlockDecorationRanges(doc, selection, blockActionIds);
  if (ranges.length === 0) return DecorationSet.empty;

  return DecorationSet.create(
    doc,
    ranges.flatMap((range) => {
      const blockContainer = doc.nodeAt(range.from);
      const blockContent = blockContainer?.firstChild;
      const scope =
        range.kind !== "atomic-range" && blockContainer?.lastChild?.type.name === "blockGroup"
          ? "subtree"
          : "content";
      const blockDecoration = Decoration.node(
        range.from,
        range.to,
        {
          class: SELECTED_BLOCK_CLASS,
          "data-nodex-selection-kind": range.kind,
          [SELECTED_BLOCK_SCOPE_ATTRIBUTE]: scope,
        },
        { key: `block:${range.kind}:${range.from}:${range.to}` },
      );
      if (!blockContent || scope === "subtree") return [blockDecoration];

      const contentFrom = range.from + 1;
      return [
        blockDecoration,
        Decoration.node(
          contentFrom,
          contentFrom + blockContent.nodeSize,
          { [SELECTED_BLOCK_CONTENT_ATTRIBUTE]: "" },
          { key: `content:${range.kind}:${contentFrom}` },
        ),
      ];
    }),
  );
}

export const SelectedBlockDecorationsExtension = createExtension(({ editor }) => {
  const blockActionIdsByOwner = new Map<string, readonly string[]>();
  const mountedEditorDoms = new Set<HTMLElement>();

  const getBlockActionIds = (): ReadonlySet<string> => {
    const candidateIds = Array.from(new Set(Array.from(blockActionIdsByOwner.values()).flat()));
    return new Set(resolveTopLevelDraggedBlocks(editor, candidateIds).map((block) => block.id));
  };

  const syncMountedPresentation = () => {
    const active = getBlockActionIds().size > 0;
    for (const dom of mountedEditorDoms) {
      dom.toggleAttribute(BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE, active);
    }
  };

  const refreshDecorations = () => {
    syncMountedPresentation();
    editor.transact((transaction) => transaction.setMeta(pluginKey, {}));
  };

  return {
    key: "selected-block-decorations",
    mount({ dom }) {
      mountedEditorDoms.add(dom);
      dom.setAttribute(BLOCK_SELECTION_PRESENTATION_ATTRIBUTE, "");
      syncMountedPresentation();
      const unregisterSelectionSurface = registerEditorSelectionSurface(dom);

      return () => {
        mountedEditorDoms.delete(dom);
        unregisterSelectionSurface();
        dom.removeAttribute(BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE);
        dom.removeAttribute(BLOCK_SELECTION_PRESENTATION_ATTRIBUTE);
      };
    },
    prosemirrorPlugins: [
      new Plugin({
        key: pluginKey,
        state: {
          init: (_config, state) =>
            buildSelectedBlockDecorationSet(state.doc, state.selection, getBlockActionIds()),
          apply: (transaction, previousDecorations, _oldState, newState) => {
            if (
              !transaction.docChanged &&
              !transaction.selectionSet &&
              transaction.getMeta(pluginKey) === undefined
            ) {
              return previousDecorations;
            }
            return buildSelectedBlockDecorationSet(
              newState.doc,
              newState.selection,
              getBlockActionIds(),
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
    /**
     * Retains the current command target as whole Blocks without changing the
     * underlying text range used by the open formatting-toolbar workflow.
     */
    showSelectionAsBlocks(
      shouldShow: boolean,
      owner: string,
      selectedBlockIds?: readonly string[],
    ) {
      if (!shouldShow) {
        if (!blockActionIdsByOwner.delete(owner)) return;
        refreshDecorations();
        return;
      }

      const candidateIds =
        selectedBlockIds ??
        editor
          .getSelection()
          ?.blocks.map((block) => block.id)
          .filter((blockId): blockId is string => typeof blockId === "string") ??
        [];
      const nextIds = resolveTopLevelDraggedBlocks(editor, candidateIds).map((block) => block.id);
      if (nextIds.length === 0) {
        if (!blockActionIdsByOwner.delete(owner)) return;
        refreshDecorations();
        return;
      }

      const previousIds = blockActionIdsByOwner.get(owner);
      if (
        previousIds?.length === nextIds.length &&
        previousIds.every((blockId, index) => blockId === nextIds[index])
      ) {
        return;
      }

      blockActionIdsByOwner.set(owner, nextIds);
      refreshDecorations();
    },
  } as const;
});

export const selectedBlockDecorationsExtension = SelectedBlockDecorationsExtension;
