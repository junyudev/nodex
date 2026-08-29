import { selectedFragmentToHTML, type BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { hasTypedOwnerBlock } from "@/lib/typed-owner-blocks";
import { blockHasSelectableTextContent } from "./block-content-capabilities";
import { getNfmBlockSelectionIds } from "./nfm-block-selection";
import {
  createCopiedBlockPayload,
  createCopiedSelectionPayloadFromSelection,
  rewriteCopiedSelectionAssetSourcesSync,
  type CopiedSelectionPayload,
  type SelectionBlockLike,
  type SelectionEditorLike,
} from "./special-block-copy";

export type NfmClipboardSelection =
  | {
      readonly kind: "block-roots";
      readonly rootBlockIds: readonly string[];
      readonly blocks: readonly SelectionBlockLike[];
      readonly containsTypedOwner: boolean;
      readonly payload: CopiedSelectionPayload | null;
      readonly portableCut: "selection" | "current-block";
    }
  | {
      readonly kind: "inline-range";
      readonly intersectsTypedOwner: boolean;
      readonly payload: CopiedSelectionPayload | null;
    };

function topLevelBlocks(
  editor: BlockNoteEditor,
  blocks: readonly SelectionBlockLike[],
): readonly SelectionBlockLike[] {
  const selectedIds = new Set(blocks.map((block) => block.id));
  return blocks.filter((block) => {
    let parent = editor.getParentBlock(block.id) as SelectionBlockLike | undefined;
    while (parent) {
      if (selectedIds.has(parent.id)) return false;
      parent = editor.getParentBlock(parent.id) as SelectionBlockLike | undefined;
    }
    return true;
  });
}

function selectedRangeBlocks(
  view: EditorView,
  editor: BlockNoteEditor,
): {
  readonly blockSelection: boolean;
  readonly blocks: readonly SelectionBlockLike[];
  readonly containsTypedOwner: boolean;
} {
  const blockSelectionIds = getNfmBlockSelectionIds(view.state.selection);
  if (blockSelectionIds.length === 0) {
    const blocks = (editor.getSelection()?.blocks ?? []) as readonly SelectionBlockLike[];
    return {
      blockSelection: false,
      blocks: topLevelBlocks(editor, blocks),
      containsTypedOwner: hasTypedOwnerBlock(blocks),
    };
  }

  const selectedBlocks = blockSelectionIds
    .map((blockId) => editor.getBlock(blockId) as SelectionBlockLike | undefined)
    .filter((block): block is SelectionBlockLike => Boolean(block));
  return {
    blockSelection: true,
    blocks: topLevelBlocks(editor, selectedBlocks),
    containsTypedOwner:
      selectedBlocks.length !== blockSelectionIds.length || hasTypedOwnerBlock(selectedBlocks),
  };
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (typeof Node === "undefined" || !(target instanceof Node)) return null;
  return target instanceof Element ? target : target.parentElement;
}

function isCollapsedCaretEvent(view: EditorView, eventTarget: EventTarget | null): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;

  const target = eventTargetElement(eventTarget);
  if (!target || !view.dom.contains(target)) return false;

  // Embedded controls own their native clipboard behavior even while the host
  // editor retains a collapsed ProseMirror selection behind them.
  const nonEditableIsland = target.closest('[contenteditable="false"]');
  return !nonEditableIsland || nonEditableIsland === view.dom;
}

function createSelectedRangePayload(
  view: EditorView,
  editor: BlockNoteEditor,
): CopiedSelectionPayload | null {
  try {
    return rewriteCopiedSelectionAssetSourcesSync(
      createCopiedSelectionPayloadFromSelection(
        editor as unknown as SelectionEditorLike,
        selectedFragmentToHTML(view, editor),
      ),
    );
  } catch (error) {
    console.error("Failed structured plain-text serialization", error);
    return null;
  }
}

function createCurrentBlockPayload(
  editor: BlockNoteEditor,
  block: SelectionBlockLike,
): CopiedSelectionPayload | null {
  try {
    return rewriteCopiedSelectionAssetSourcesSync(
      createCopiedBlockPayload(editor as unknown as SelectionEditorLike, [block]),
    );
  } catch (error) {
    console.error("Failed current Block clipboard serialization", error);
    return null;
  }
}

/**
 * Resolves clipboard authority without changing editor selection presentation.
 * A real range wins; only a collapsed caret inside the host editor falls back
 * to its complete current Block subtree.
 */
export function resolveNfmClipboardSelection(
  view: EditorView,
  editor: BlockNoteEditor,
  eventTarget: EventTarget | null,
): NfmClipboardSelection | null {
  if (!view.state.selection.empty) {
    const selected = selectedRangeBlocks(view, editor);
    if (selected.blockSelection || selected.containsTypedOwner) {
      return {
        kind: "block-roots",
        rootBlockIds: selected.blocks.map((block) => block.id),
        blocks: selected.blocks,
        containsTypedOwner: selected.containsTypedOwner,
        payload: createSelectedRangePayload(view, editor),
        portableCut: "selection",
      };
    }
    return {
      kind: "inline-range",
      intersectsTypedOwner: false,
      payload: createSelectedRangePayload(view, editor),
    };
  }
  if (!isCollapsedCaretEvent(view, eventTarget)) return null;

  try {
    const block = editor.getTextCursorPosition().block as SelectionBlockLike;
    return {
      kind: "block-roots",
      rootBlockIds: [block.id],
      blocks: [block],
      containsTypedOwner: hasTypedOwnerBlock([block]),
      payload: createCurrentBlockPayload(editor, block),
      portableCut: "current-block",
    };
  } catch {
    return null;
  }
}

function setCursorIfPresent(
  editor: BlockNoteEditor,
  blockId: string | undefined,
  placement: "start" | "end",
): boolean {
  if (!blockId || !editor.getBlock(blockId)) return false;
  editor.setTextCursorPosition(blockId, placement);
  return true;
}

function cutCurrentOrdinaryBlock(editor: BlockNoteEditor, blockId: string): void {
  const cursor = editor.getTextCursorPosition();
  const siblings = cursor.parentBlock?.children ?? editor.document;
  const currentIndex = siblings.findIndex((block) => block.id === blockId);
  const previousEditableBlock = siblings
    .slice(0, currentIndex < 0 ? 0 : currentIndex)
    .findLast((block) => blockHasSelectableTextContent(editor.schema, block.type));
  const nextEditableBlock = siblings
    .slice(currentIndex < 0 ? siblings.length : currentIndex + 1)
    .find((block) => blockHasSelectableTextContent(editor.schema, block.type));
  const editableParent =
    cursor.parentBlock && blockHasSelectableTextContent(editor.schema, cursor.parentBlock.type)
      ? cursor.parentBlock
      : undefined;
  const isOnlyRoot =
    editor.getParentBlock(blockId) === undefined &&
    editor.document.length === 1 &&
    editor.document[0]?.id === blockId;

  editor.transact((transaction) => {
    if (isOnlyRoot) {
      const replacement = editor.replaceBlocks([blockId], [{ type: "paragraph" }]);
      const replacementId = replacement.insertedBlocks[0]?.id;
      if (replacementId) editor.setTextCursorPosition(replacementId, "start");
    } else {
      editor.removeBlocks([blockId]);
      if (!setCursorIfPresent(editor, previousEditableBlock?.id, "end")) {
        if (!setCursorIfPresent(editor, nextEditableBlock?.id, "start")) {
          if (!setCursorIfPresent(editor, editableParent?.id, "end")) {
            setCursorIfPresent(editor, editor.document[0]?.id, "start");
          }
        }
      }
    }
    transaction.setMeta("uiEvent", "cut").scrollIntoView();
  });
}

/** Deletes the already-copied ordinary target in one local undo step. */
export function cutOrdinaryNfmClipboardSelection(
  view: EditorView,
  editor: BlockNoteEditor,
  selection: NfmClipboardSelection,
): void {
  if (!view.editable) return;
  if (selection.kind === "inline-range" || selection.portableCut === "selection") {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
    return;
  }

  try {
    const blockId = selection.rootBlockIds[0];
    if (blockId) cutCurrentOrdinaryBlock(editor, blockId);
  } catch (error) {
    console.error("Failed to cut current Block", error);
  }
}
