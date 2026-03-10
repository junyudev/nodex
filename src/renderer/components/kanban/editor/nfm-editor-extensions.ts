import { createExtension, getBlockInfo, getNodeById, selectedFragmentToHTML } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "prosemirror-view";
import { handleNotionPasteFromClipboard } from "./notion-paste";
import { getNfmSearchState, nfmSearchExtension } from "./search-extension";
import { selectCurrentBlockContent } from "./select-block-shortcut";
import { selectedImageBlockDecorationsExtension } from "./selected-image-block-decorations";
import {
  handleChildGroupEmptyEnter,
  handleParentEnterSplitToFirstChild,
  handleToggleEnterToChild,
} from "./child-group-enter";
import { handleChildGroupBackspace } from "./child-group-backspace";
import { toggleCurrentToggleBlock } from "./toggle-shortcut";
import {
  createCopiedSelectionPayloadFromSelection,
  createStructuredPlainTextPayload,
  rewriteCopiedSelectionAssetSourcesSync,
  type SelectionEditorLike,
} from "./special-block-copy";

const toggleInputRule = createExtension({
  key: "toggle-input-rule",
  inputRules: [
    {
      find: /^>\s$/,
      replace() {
        return { type: "toggleListItem", props: {} };
      },
    },
  ],
});

const quoteInputRule = createExtension({
  key: "quote-input-rule",
  inputRules: [
    {
      find: /^\|\s$/,
      replace() {
        return { type: "quote", props: {} };
      },
    },
  ],
});

const HEADING_LEVELS = [1, 2, 3, 4] as const;

const headingToggleAware = createExtension({
  key: "heading-toggle-aware-shortcuts",
  inputRules: HEADING_LEVELS.map((level) => ({
    find: new RegExp(`^(#{${level}})\\s$`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replace({ editor }: { editor: any }) {
      const isToggle = editor.getTextCursorPosition().block.type === "toggleListItem";
      return {
        type: "heading",
        props: { level, ...(isToggle ? { isToggleable: true } : {}) },
      };
    },
  })),
  keyboardShortcuts: Object.fromEntries(
    HEADING_LEVELS.map((level) => [
      `Mod-Alt-${level}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ editor }: { editor: any }) => {
        const cursor = editor.getTextCursorPosition();
        if (editor.schema.blockSchema[cursor.block.type]?.content !== "inline") return false;
        const isToggle = cursor.block.type === "toggleListItem";
        editor.updateBlock(cursor.block, {
          type: "heading",
          props: { level, ...(isToggle ? { isToggleable: true } : {}) },
        });
        return true;
      },
    ]),
  ),
});

const toggleShortcut = createExtension({
  key: "toggle-cmd-enter-shortcut",
  keyboardShortcuts: {
    "Meta-Enter": ({ editor }) => toggleCurrentToggleBlock(editor),
  },
});

const selectBlockShortcut = createExtension({
  key: "select-current-block-shortcut",
  keyboardShortcuts: {
    "Mod-a": ({ editor }) => selectCurrentBlockContent(editor),
  },
});

function writeStructuredSelectionToClipboard(
  view: EditorView,
  clipboardEvent: ClipboardEvent,
  editor: BlockNoteEditor,
): boolean {
  if (!clipboardEvent.clipboardData) return false;
  if (view.state.selection.empty) return false;

  let payload: ReturnType<typeof createStructuredPlainTextPayload>;
  try {
    payload = rewriteCopiedSelectionAssetSourcesSync(
      createCopiedSelectionPayloadFromSelection(
        editor as unknown as SelectionEditorLike,
        selectedFragmentToHTML(view, editor),
      ),
    );
  } catch (error) {
    console.error("Failed structured plain-text serialization", error);
    return false;
  }

  let wroteClipboardData = false;
  try {
    clipboardEvent.clipboardData.setData("blocknote/html", payload.clipboardHTML);
    wroteClipboardData = true;
  } catch (error) {
    console.warn("Failed to write blocknote/html clipboard payload", error);
  }
  try {
    clipboardEvent.clipboardData.setData("text/html", payload.externalHTML);
    wroteClipboardData = true;
  } catch (error) {
    console.warn("Failed to write text/html clipboard payload", error);
  }
  try {
    clipboardEvent.clipboardData.setData("text/plain", payload.structuredText);
    wroteClipboardData = true;
  } catch (error) {
    console.warn("Failed to write text/plain clipboard payload", error);
  }

  if (!wroteClipboardData) {
    console.error("Failed structured plain-text clipboard payload");
    return false;
  }

  clipboardEvent.preventDefault();
  return true;
}

const structuredPlainTextCopyExt = createExtension(({ editor }) => ({
  key: "structured-plain-text-copy",
  runsBefore: ["copyToClipboard"],
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleDOMEvents: {
          copy(view, event) {
            return writeStructuredSelectionToClipboard(
              view,
              event as ClipboardEvent,
              editor,
            );
          },
          cut(view, event) {
            const clipboardEvent = event as ClipboardEvent;
            if (!writeStructuredSelectionToClipboard(view, clipboardEvent, editor)) {
              return false;
            }

            if (view.editable) {
              view.dispatch(view.state.tr.deleteSelection());
            }
            return true;
          },
        },
      },
    }),
  ],
}));

/**
 * ProseMirror-level operation:
 * Split parent block content at cursor and insert a new paragraph as the
 * first child with the trailing inline content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitParentIntoFirstChild(editor: any, parentId: string): boolean {
  const view = editor.prosemirrorView;
  const { state } = view;
  const { doc, selection } = state;
  if (!selection.empty) return false;

  const parentPosInfo = getNodeById(parentId, doc);
  if (!parentPosInfo) return false;

  const parentInfo = getBlockInfo(parentPosInfo);
  if (!parentInfo.isBlockContainer) return false;
  if (!parentInfo.childContainer) return false;

  const blockContentStart = parentInfo.blockContent.beforePos + 1;
  const blockContentEnd = parentInfo.blockContent.afterPos - 1;
  const splitPos = selection.from;
  if (splitPos <= blockContentStart) return false;
  if (splitPos > blockContentEnd) return false;

  const paragraphNodeType = state.schema.nodes["paragraph"];
  const blockContainerNodeType = state.schema.nodes["blockContainer"];
  if (!paragraphNodeType || !blockContainerNodeType) return false;

  const trailingContent = doc.slice(splitPos, blockContentEnd).content;

  let tr = state.tr;
  if (splitPos < blockContentEnd) {
    tr = tr.delete(splitPos, blockContentEnd);
  }

  const firstChildInsertPos = tr.mapping.map(parentInfo.childContainer.beforePos + 1);
  const paragraphNode = paragraphNodeType.createChecked({}, trailingContent);
  const newChildBlock = blockContainerNodeType.createAndFill(undefined, [paragraphNode]);
  if (!newChildBlock) return false;

  tr = tr.insert(firstChildInsertPos, newChildBlock);
  tr = tr.setSelection(TextSelection.create(tr.doc, firstChildInsertPos + 2));

  view.dispatch(tr);
  return true;
}

const childGroupEnterExt = createExtension({
  key: "child-group-enter",
  runsBefore: [
    "toggle-list-item-shortcuts",
    "bullet-list-item-shortcuts",
    "check-list-item-shortcuts",
    "numbered-list-item-shortcuts",
  ],
  keyboardShortcuts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Enter: ({ editor }: { editor: any }) => {
      const wrapped = Object.create(editor);
      wrapped.splitParentIntoFirstChild = (parentId: string) =>
        splitParentIntoFirstChild(editor, parentId);
      return handleChildGroupEmptyEnter(wrapped)
        || handleParentEnterSplitToFirstChild(wrapped)
        || handleToggleEnterToChild(wrapped);
    },
  },
});

/**
 * ProseMirror-level merge: append source block's inline content into target
 * block, delete source (and its empty blockGroup if it was the only child),
 * and place cursor at the join point.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeIntoBlock(editor: any, targetId: string, sourceId: string): void {
  const view = editor.prosemirrorView;
  const { state } = view;
  const { doc } = state;

  const targetPosInfo = getNodeById(targetId, doc);
  const sourcePosInfo = getNodeById(sourceId, doc);
  if (!targetPosInfo || !sourcePosInfo) return;

  const targetInfo = getBlockInfo(targetPosInfo);
  const sourceInfo = getBlockInfo(sourcePosInfo);
  if (!targetInfo.isBlockContainer || !sourceInfo.isBlockContainer) return;

  // Join position = end of target's existing content
  const joinPos = targetInfo.blockContent.afterPos - 1;
  const sourceContent = sourceInfo.blockContent.node.content;

  // Determine delete range: just the bnBlockOuter, or entire blockGroup if
  // the source is the only child in its group.
  const bnOuterBefore = sourceInfo.bnBlock.beforePos - 1;
  const bnOuterAfter = sourceInfo.bnBlock.afterPos + 1;
  let deleteFrom = bnOuterBefore;
  let deleteTo = bnOuterAfter;

  const $outer = doc.resolve(bnOuterBefore);
  if ($outer.parent.type.name === "blockGroup" && $outer.parent.childCount === 1) {
    deleteFrom = $outer.before($outer.depth);
    deleteTo = $outer.after($outer.depth);
  }

  let tr = state.tr;

  // 1. Delete source block (source is always after target in document order,
  //    so target positions are unaffected).
  tr = tr.delete(deleteFrom, deleteTo);

  // 2. Map join position through the deletion and insert source content.
  const mappedJoinPos = tr.mapping.map(joinPos);
  if (sourceContent.size > 0) {
    tr = tr.insert(mappedJoinPos, sourceContent);
  }

  // 3. Set cursor at the join point.
  tr = tr.setSelection(TextSelection.create(tr.doc, mappedJoinPos));

  view.dispatch(tr);
}

const childGroupBackspaceExt = createExtension({
  key: "child-group-backspace",
  keyboardShortcuts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Backspace: ({ editor }: { editor: any }) => {
      const wrapped = Object.create(editor);
      wrapped.mergeIntoBlock = (targetId: string, sourceId: string) =>
        mergeIntoBlock(editor, targetId, sourceId);
      return handleChildGroupBackspace(wrapped);
    },
  },
});

export const NFM_DISABLED_EXTENSIONS = ["quote-block-shortcuts", "heading-shortcuts"] as const;

export type NfmPasteHandler = (context: {
  event: ClipboardEvent;
  editor: BlockNoteEditor;
  defaultPasteHandler: (context?: {
    prioritizeMarkdownOverHTML?: boolean;
    plainTextAsMarkdown?: boolean;
  }) => boolean | undefined;
}) => boolean | undefined;

export function createNfmEditorExtensions() {
  return [
    nfmSearchExtension(),
    structuredPlainTextCopyExt(),
    headingToggleAware,
    toggleInputRule,
    quoteInputRule,
    toggleShortcut,
    selectBlockShortcut,
    selectedImageBlockDecorationsExtension(),
    childGroupEnterExt,
    childGroupBackspaceExt,
  ];
}

export function createNfmPasteHandler(): NfmPasteHandler {
  return ({ event, editor, defaultPasteHandler }) => {
    const handled = handleNotionPasteFromClipboard(
      editor as Parameters<typeof handleNotionPasteFromClipboard>[0],
      event.clipboardData,
    );
    if (handled) return true;
    return defaultPasteHandler();
  };
}

export { getNfmSearchState };
