import { createExtension } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export type MentionChipArrowDirection = "left" | "right";

export interface MentionChipTokenRange {
  readonly from: number;
  readonly to: number;
}

interface SelectionWithAdjacentNodes {
  readonly empty: boolean;
  readonly from: number;
  readonly $from: {
    readonly nodeBefore: ProsemirrorNode | null;
    readonly nodeAfter: ProsemirrorNode | null;
  };
}

interface EditorWithProsemirrorView {
  readonly prosemirrorView?: EditorView;
}

const MENTION_NODE_TYPES = new Set(["pageMention", "threadMention"]);
const PAGE_MENTION_ANCHOR_SELECTOR = '[data-page-mention-inline-anchor="true"]';
const MENTION_INLINE_CHIP_SELECTOR = '[data-mention-inline-chip="true"]';
export const MENTION_TOKEN_SELECTED_CLASS = "nodex-mention-token-selected";

function isMentionNode(node: ProsemirrorNode | null | undefined): node is ProsemirrorNode {
  return Boolean(node && MENTION_NODE_TYPES.has(node.type.name));
}

/**
 * Treat page and chat mentions as one editor-owned atom. The browser keeps
 * focus in ProseMirror while the chip renders the selected state itself, so
 * Arrow navigation and Enter work without painting native text selection.
 */
export function getAdjacentMentionTokenRange(
  selection: SelectionWithAdjacentNodes,
  direction: MentionChipArrowDirection,
): MentionChipTokenRange | null {
  if (!selection.empty) return null;

  const adjacentNode =
    direction === "left" ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  if (!isMentionNode(adjacentNode)) return null;

  if (direction === "left") {
    return {
      from: selection.from - adjacentNode.nodeSize,
      to: selection.from,
    };
  }

  return {
    from: selection.from,
    to: selection.from + adjacentNode.nodeSize,
  };
}

export function getSelectedMentionTokenRange(
  state: Pick<EditorView["state"], "doc" | "selection">,
): MentionChipTokenRange | null {
  const { selection } = state;
  if (selection.empty || selection.to <= selection.from) return null;

  const node = state.doc.nodeAt(selection.from);
  if (!isMentionNode(node)) return null;
  if (selection.to !== selection.from + node.nodeSize) return null;

  return {
    from: selection.from,
    to: selection.to,
  };
}

export function selectAdjacentMention(
  editor: EditorWithProsemirrorView,
  direction: MentionChipArrowDirection,
): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;

  const { state, dispatch } = view;
  const range = getAdjacentMentionTokenRange(
    state.selection as SelectionWithAdjacentNodes,
    direction,
  );
  if (!range) return false;

  const selection = TextSelection.create(state.doc, range.from, range.to);
  selection.visible = false;
  dispatch(state.tr.setSelection(selection));
  return true;
}

function findElement(dom: Node | null, selector: string): HTMLElement | null {
  if (!(dom instanceof Element)) return null;
  if (dom.matches(selector)) return dom as HTMLElement;
  return dom.querySelector<HTMLElement>(selector);
}

function findMentionHighlightTarget(
  view: EditorView,
  range: MentionChipTokenRange,
): HTMLElement | null {
  return findElement(view.nodeDOM(range.from), MENTION_INLINE_CHIP_SELECTOR);
}

function findMentionActivationTarget(
  view: EditorView,
  range: MentionChipTokenRange,
): HTMLElement | null {
  const node = view.state.doc.nodeAt(range.from);
  if (!node) return null;

  return findElement(
    view.nodeDOM(range.from),
    node.type.name === "pageMention" ? PAGE_MENTION_ANCHOR_SELECTOR : MENTION_INLINE_CHIP_SELECTOR,
  );
}

export function activateSelectedMention(editor: EditorWithProsemirrorView): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;

  const range = getSelectedMentionTokenRange(view.state);
  if (!range) return false;

  const target = findMentionActivationTarget(view, range);
  if (!target) return false;

  target.click();
  return true;
}

export const mentionChipKeyboardNavigationExtension = createExtension(() => ({
  key: "mention-chip-keyboard-navigation",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleKeyDown(view: EditorView, event: KeyboardEvent) {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            if (
              event.isComposing ||
              event.shiftKey ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey
            ) {
              return false;
            }
            const direction = event.key === "ArrowLeft" ? "left" : "right";
            return selectAdjacentMention({ prosemirrorView: view }, direction);
          }

          if (
            event.key !== "Enter" ||
            event.isComposing ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          ) {
            return false;
          }

          return activateSelectedMention({ prosemirrorView: view });
        },
      },
      view(view) {
        let selectedNodeDOM: HTMLElement | null = null;

        const clearSelectedNode = () => {
          if (!selectedNodeDOM) return;
          selectedNodeDOM.classList.remove(MENTION_TOKEN_SELECTED_CLASS);
          delete selectedNodeDOM.dataset.mentionTokenSelected;
          selectedNodeDOM = null;
        };

        const syncSelectedNode = (nextView: EditorView) => {
          clearSelectedNode();
          const range = getSelectedMentionTokenRange(nextView.state);
          if (!range) return;

          const nodeDOM = findMentionHighlightTarget(nextView, range);
          if (!nodeDOM) return;

          nodeDOM.classList.add(MENTION_TOKEN_SELECTED_CLASS);
          nodeDOM.dataset.mentionTokenSelected = "true";
          selectedNodeDOM = nodeDOM;
        };

        syncSelectedNode(view);
        return {
          update: syncSelectedNode,
          destroy: clearSelectedNode,
        };
      },
    }),
  ],
}));
