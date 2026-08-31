import { TextSelection, type Selection } from "prosemirror-state";

import { getNearestBlockPos } from "../../api/getBlockInfoFromPos.js";
import type { BlockNoteEditor } from "../../editor/BlockNoteEditor";
import {
  createExtension,
  createStore,
} from "../../editor/BlockNoteExtension.js";
import { Block } from "../../blocks/index.js";

interface BlockNodeSelectionLike {
  readonly node?: {
    readonly attrs?: { readonly id?: unknown };
    readonly type?: { isInGroup(group: string): boolean };
  };
  readonly nodes?: ReadonlyArray<{
    readonly attrs?: { readonly id?: unknown };
  }>;
}

export function selectionIncludesBlock(selection: Selection, blockId: string): boolean {
  const blockSelection = selection as Selection & BlockNodeSelectionLike;
  if (Array.isArray(blockSelection.nodes)) {
    return blockSelection.nodes.some((node) => node.attrs?.id === blockId);
  }
  if (blockSelection.node?.attrs?.id === blockId) return true;
  if (!blockSelection.node?.type?.isInGroup("blockContent")) return false;

  try {
    return getNearestBlockPos(selection.$from.doc, selection.from).node.attrs.id === blockId;
  } catch {
    return false;
  }
}

/** Moves selection into a preview block and selects its complete editable source. */
export function selectSourceBlockContent(
  editor: BlockNoteEditor<any, any, any>,
  blockId: string,
): boolean {
  editor.setTextCursorPosition(blockId, "end");
  const block = editor.getBlock(blockId);
  const view = editor.prosemirrorView;
  if (!block || !view) return false;

  const { $from } = view.state.selection;
  if ($from.parent.type.name !== block.type) return false;

  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, $from.start(), $from.end()),
    ),
  );
  return true;
}

/**
 * A single editor-wide extension that drives the source popup for blocks that
 * render a preview. Which blocks it activates on is decided by each spec's
 * `meta.hasPreview` flag, so individual blocks opt in rather than the extension
 * being configured with a block type.
 *
 * The extension is registered once (it's a default extension) and is a no-op
 * when no block declares `meta.hasPreview`.
 */
export const SourceBlockWithPreviewExtension = createExtension(
  ({ editor }: { editor: BlockNoteEditor<any> }) => {
    const store = createStore<{
      popupOpen: string | undefined;
      selected: string | undefined;
    }>({
      popupOpen: undefined,
      selected: undefined,
    });

    // A block has a preview iff its spec's implementation declares
    // `meta.hasPreview` (read from the spec, like the syntax-highlighting
    // extension reads `meta.highlight`).
    const blockHasPreview = (block: Block<any, any, any>) =>
      !!editor.schema.blockSpecs[block.type]?.implementation?.meta?.hasPreview;

    const handleArrow =
      (direction: "prev" | "next") =>
      ({ editor }: { editor: BlockNoteEditor<any> }) => {
        const { block, prevBlock, nextBlock } = editor.getTextCursorPosition();
        if (!blockHasPreview(block) || store.state.popupOpen === block.id) {
          return false;
        }

        const targetBlock = direction === "prev" ? prevBlock : nextBlock;
        if (!targetBlock) {
          return false;
        }

        editor.setTextCursorPosition(
          targetBlock.id,
          direction === "prev" ? "end" : "start",
        );

        return true;
      };

    return {
      key: "sourceBlockWithPreview",
      store,
      keyboardShortcuts: {
        // Toggles the popup. This may be overridden by `hardBreakShortcut`.
        Enter: ({ editor }) => {
          const { block } = editor.getTextCursorPosition();
          if (!blockHasPreview(block)) {
            return false;
          }

          if (
            store.state.popupOpen === block.id &&
            editor.schema.blockSpecs[block.type]?.implementation?.meta
              ?.hardBreakShortcut === "enter"
          ) {
            const view = editor.prosemirrorView!;
            view.dispatch(view.state.tr.insertText("\n"));

            return true;
          }

          if (store.state.popupOpen === block.id) {
            editor.setTextCursorPosition(block.id, "end");
            store.setState((state) => ({ ...state, popupOpen: undefined }));
            return true;
          }

          store.setState((state) => ({ ...state, popupOpen: block.id }));
          selectSourceBlockContent(editor, block.id);

          return true;
        },
        // Closes the popup.
        Escape: ({ editor }) => {
          const { block } = editor.getTextCursorPosition();
          if (!blockHasPreview(block) || store.state.popupOpen !== block.id) {
            return false;
          }

          editor.setTextCursorPosition(block.id, "end");

          store.setState((state) => ({ ...state, popupOpen: undefined }));

          return true;
        },
        // While the popup is open, selects the whole source instead of the
        // whole document.
        "Mod-a": ({ editor }) => {
          const { block } = editor.getTextCursorPosition();
          if (!blockHasPreview(block) || store.state.popupOpen !== block.id) {
            return false;
          }

          return selectSourceBlockContent(editor, block.id);
        },
        // While the popup is closed, moves the selection straight to the previous/next block
        // instead of into the (hidden) source.
        ArrowUp: handleArrow("prev"),
        ArrowLeft: handleArrow("prev"),
        ArrowDown: handleArrow("next"),
        ArrowRight: handleArrow("next"),
      },
      mount: ({ dom, signal }) => {
        // Closes the popup when the selection leaves the block that owns it and tracks which block
        // the selection is in.
        const unsubscribeSelectionChange = editor.onSelectionChange(() => {
          const { block } = editor.getTextCursorPosition();

          const selected = blockHasPreview(block) ? block.id : undefined;
          const popupOpen =
            store.state.popupOpen && store.state.popupOpen !== block.id
              ? undefined
              : store.state.popupOpen;

          if (
            selected === store.state.selected &&
            popupOpen === store.state.popupOpen
          ) {
            return;
          }

          store.setState((state) => ({ ...state, selected, popupOpen }));
        });
        signal.addEventListener("abort", unsubscribeSelectionChange);

        // While the popup is closed, prevents editing of the (hidden) source. Handled here rather
        // than in `keyboardShortcuts` as it needs to match any text-input key, which a keymap
        // can't express.
        const handleKeyDown = (event: KeyboardEvent) => {
          if (!editor.isEditable) {
            return;
          }

          const { block } = editor.getTextCursorPosition();
          if (!blockHasPreview(block) || store.state.popupOpen === block.id) {
            return;
          }

          if (event.key === "Backspace") {
            // A closed preview protects its hidden source caret, but an explicit
            // block selection still owns normal block-level deletion semantics.
            if (selectionIncludesBlock(editor.prosemirrorState.selection, block.id)) {
              return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }

          if (event.key === "Delete") {
            event.preventDefault();
            event.stopImmediatePropagation();
            editor.removeBlocks([block.id]);

            return;
          }

          if (
            (event.key.length === 1 && !event.ctrlKey && !event.metaKey) ||
            event.key === "Tab"
          ) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        };
        dom.addEventListener("keydown", handleKeyDown, {
          capture: true,
          signal,
        });

        const handleBlur = () =>
          store.setState((state) => ({ ...state, popupOpen: undefined }));
        dom.addEventListener("blur", handleBlur, { capture: true, signal });
      },
    };
  },
);
