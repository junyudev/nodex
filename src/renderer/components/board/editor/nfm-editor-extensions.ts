import { createExtension, getBlockInfo, getNodeById, type ExtensionOptions } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "prosemirror-view";
import {
  extractNotionNfmBlocksFromClipboardData,
  handleNotionPasteFromClipboard,
} from "./notion-paste";
import { splitGfmTableRow } from "@/lib/nfm/table";
import { nfmToBlockNote } from "@/lib/nfm";
import { getNfmSearchState, nfmSearchExtension } from "./search-extension";
import { selectCurrentBlockContent } from "./select-block-shortcut";
import { selectedBlockDecorationsExtension } from "./selected-block-decorations";
import {
  handleChildGroupEmptyEnter,
  handleParentEnterSplitToFirstChild,
  handleToggleEnterToChild,
} from "./child-group-enter";
import { handleChildGroupBackspace } from "./child-group-backspace";
import {
  cutOrdinaryNfmClipboardSelection,
  resolveNfmClipboardSelection,
} from "./nfm-clipboard-selection";
import type { CopiedSelectionPayload } from "./special-block-copy";
import { createEmptyThreadSectionBlock } from "./thread-section";
import { canvasCreatePendingExtension } from "./canvas-create-pending-extension";
import { mentionChipKeyboardNavigationExtension } from "./mention-chip-keyboard-navigation";
import { nfmTaskShorthandPreviewExtension } from "./nfm-task-shorthand-preview-extension";
import {
  attachNodexStructuralClipboardWriteClaim,
  hasUntrustedTypedOwnerHtml,
  inspectNodexClipboardHtml,
  sanitizeUntrustedTypedOwnerHtml,
  type NodexClipboardEnvelopeV1,
} from "../../../../shared/clipboard-paste";
import type {
  NfmStructuralClipboardPresentation,
  NfmStructuralReplacementBlockLike,
} from "./nfm-structural-editing-extension";
import { nfmSyntaxHighlighter } from "@/lib/syntax-highlighting";
import {
  planBackspaceAcrossAtomicBlocks,
  type AtomicBackspaceEditor,
} from "./atomic-block-backspace";

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

export const THREAD_SECTION_SHORTCUT_PATTERN = /^---$/;

export const threadSectionInputRule = createExtension({
  key: "thread-section-input-rule",
  inputRules: [
    {
      find: THREAD_SECTION_SHORTCUT_PATTERN,
      replace() {
        return createEmptyThreadSectionBlock();
      },
    },
  ],
});

const HEADING_LEVELS = [1, 2, 3, 4] as const;

const headingToggleAware = createExtension({
  key: "heading-toggle-aware-shortcuts",
  inputRules: HEADING_LEVELS.map((level) => ({
    find: new RegExp(`^(#{${level}})\\s$`),
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

const selectBlockShortcut = createExtension({
  key: "select-current-block-shortcut",
  keyboardShortcuts: {
    "Mod-a": ({ editor }) => selectCurrentBlockContent(editor),
  },
});

function writeStructuredSelectionToClipboard(
  clipboardEvent: ClipboardEvent,
  payload: CopiedSelectionPayload,
): boolean {
  if (!clipboardEvent.clipboardData) return false;

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

function writeStructuralSelectionClaimToClipboard(
  clipboardEvent: ClipboardEvent,
  payload: CopiedSelectionPayload,
  writeClaim: string,
): void {
  const clipboardData = clipboardEvent.clipboardData;
  if (clipboardData) {
    try {
      clipboardData.setData(
        "blocknote/html",
        sanitizeUntrustedTypedOwnerHtml(payload.clipboardHTML),
      );
      clipboardData.setData(
        "text/html",
        attachNodexStructuralClipboardWriteClaim(payload.externalHTML, writeClaim),
      );
      clipboardData.setData("text/plain", payload.structuredText);
    } catch (error) {
      console.warn("Failed to claim the clipboard while structural content was prepared", error);
    }
  }
  clipboardEvent.preventDefault();
}

function blockUnavailableStructuralClipboard(
  clipboardEvent: ClipboardEvent,
  onUnavailable: (() => void) | undefined,
): void {
  clipboardEvent.preventDefault();
  onUnavailable?.();
}

export type NfmClipboardCommand = "copy" | "cut";

function handleNfmClipboardCommand(
  command: NfmClipboardCommand,
  view: EditorView,
  editor: BlockNoteEditor,
  options: NfmEditorExtensionOptions,
  clipboardEvent: ClipboardEvent,
): boolean {
  const selection = resolveNfmClipboardSelection(view, editor, clipboardEvent.target);
  if (!selection) return false;

  const { payload } = selection;
  if (!payload) {
    if (selection.kind === "inline-range" && !selection.intersectsTypedOwner) return false;
    blockUnavailableStructuralClipboard(clipboardEvent, options.onStructuralClipboardUnavailable);
    return true;
  }

  if (selection.kind === "block-roots" && options.onStructuralClipboard) {
    const writeClaim = options.onStructuralClipboard(command, {
      rootBlockIds: selection.rootBlockIds,
      presentation: {
        html: payload.externalHTML,
        text: payload.structuredText,
      },
    });
    if (writeClaim) {
      writeStructuralSelectionClaimToClipboard(clipboardEvent, payload, writeClaim);
      return true;
    }

    blockUnavailableStructuralClipboard(clipboardEvent, options.onStructuralClipboardUnavailable);
    return true;
  }

  const containsTypedOwner =
    selection.kind === "block-roots"
      ? selection.containsTypedOwner
      : selection.intersectsTypedOwner;
  if (
    containsTypedOwner ||
    hasUntrustedTypedOwnerHtml(payload.clipboardHTML) ||
    hasUntrustedTypedOwnerHtml(payload.externalHTML)
  ) {
    blockUnavailableStructuralClipboard(clipboardEvent, options.onStructuralClipboardUnavailable);
    return true;
  }
  if (!writeStructuredSelectionToClipboard(clipboardEvent, payload)) return false;

  if (command === "cut" && view.editable) {
    cutOrdinaryNfmClipboardSelection(view, editor, selection);
  }
  return true;
}

export const NfmStructuredClipboardExtension = createExtension(
  ({ editor, options }: ExtensionOptions<NfmEditorExtensionOptions | undefined>) => {
    const clipboardOptions = options ?? {};
    const execute = (
      command: NfmClipboardCommand,
      clipboardEvent: ClipboardEvent,
      view = editor.prosemirrorView,
    ): boolean => {
      if (!view) return false;
      return handleNfmClipboardCommand(command, view, editor, clipboardOptions, clipboardEvent);
    };

    return {
      key: "nfm-structured-clipboard",
      runsBefore: ["copyToClipboard"],
      prosemirrorPlugins: [
        new Plugin({
          props: {
            handleDOMEvents: {
              copy(view, event) {
                return execute("copy", event as ClipboardEvent, view);
              },
              cut(view, event) {
                return execute("cut", event as ClipboardEvent, view);
              },
            },
          },
        }),
      ],
      /** Runs the editor-owned clipboard command while a contextual surface owns DOM focus. */
      executeClipboardCommand(command: NfmClipboardCommand, clipboardEvent: ClipboardEvent) {
        return execute(command, clipboardEvent);
      },
    } as const;
  },
);

/**
 * ProseMirror-level operation:
 * Split parent block content at cursor and insert a new paragraph as the
 * first child with the trailing inline content.
 */
function splitParentIntoFirstChild(editor: any, parentId: string): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;

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
    Enter: ({ editor }: { editor: any }) => {
      const wrapped = Object.create(editor);
      wrapped.splitParentIntoFirstChild = (parentId: string) =>
        splitParentIntoFirstChild(editor, parentId);
      return (
        handleChildGroupEmptyEnter(wrapped) ||
        handleParentEnterSplitToFirstChild(wrapped) ||
        handleToggleEnterToChild(wrapped)
      );
    },
  },
});

/**
 * ProseMirror-level merge: append source block's inline content into target
 * block, delete source (and its empty blockGroup if it was the only child),
 * and place cursor at the join point.
 */
function mergeIntoBlock(editor: any, targetId: string, sourceId: string): void {
  const view = editor.prosemirrorView;
  if (!view) return;

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
    Backspace: ({ editor }: { editor: any }) => {
      const wrapped = Object.create(editor);
      wrapped.mergeIntoBlock = (targetId: string, sourceId: string) =>
        mergeIntoBlock(editor, targetId, sourceId);
      return handleChildGroupBackspace(wrapped);
    },
  },
});

const atomicBoundaryBackspaceExt = createExtension({
  key: "atomic-boundary-backspace",
  keyboardShortcuts: {
    Backspace: ({ editor }: { editor: BlockNoteEditor }) => {
      const plan = planBackspaceAcrossAtomicBlocks(editor as unknown as AtomicBackspaceEditor);
      return plan?.kind === "protect_boundary";
    },
  },
});

export const NFM_DISABLED_EXTENSIONS = [
  "quote-block-shortcuts",
  "heading-shortcuts",
  "divider-block-shortcuts",
] as const;

export type NfmPasteHandler = (context: {
  event: ClipboardEvent;
  editor: BlockNoteEditor;
  defaultPasteHandler: (context?: {
    prioritizeMarkdownOverHTML?: boolean;
    plainTextAsMarkdown?: boolean;
  }) => boolean | undefined;
}) => boolean | undefined;

export interface NfmEditorExtensionOptions {
  readonly onStructuralClipboardUnavailable?: () => void;
  readonly onStructuralClipboard?: (
    action: NfmClipboardCommand,
    request: {
      readonly rootBlockIds: readonly string[];
      readonly presentation: NfmStructuralClipboardPresentation;
    },
  ) => string | null;
}

export function createNfmEditorExtensions(options: NfmEditorExtensionOptions = {}) {
  return [
    nfmSyntaxHighlighter,
    nfmSearchExtension(),
    canvasCreatePendingExtension(),
    nfmTaskShorthandPreviewExtension(),
    NfmStructuredClipboardExtension(options),
    headingToggleAware,
    toggleInputRule,
    quoteInputRule,
    threadSectionInputRule,
    mentionChipKeyboardNavigationExtension(),
    selectBlockShortcut,
    selectedBlockDecorationsExtension(),
    childGroupEnterExt,
    childGroupBackspaceExt,
    atomicBoundaryBackspaceExt,
  ];
}

export interface NfmPasteHandlerOptions {
  readonly onPendingStructuralPaste?: (writeClaim: string | null) => boolean;
  readonly onStructuralPaste?: (
    envelope: NonNullable<ReturnType<typeof inspectNodexClipboardHtml>["envelope"]>,
  ) => boolean;
  readonly onStructuralBlockPaste?: (
    blocks: readonly NfmStructuralReplacementBlockLike[],
  ) => boolean;
  readonly shouldHandleStructuralBlockPaste?: () => boolean;
  readonly readNativeStructuralEnvelope?: () => NodexClipboardEnvelopeV1 | undefined;
}

const readPortableClipboardBlocks = (
  editor: BlockNoteEditor,
  clipboardData: DataTransfer | null,
): readonly NfmStructuralReplacementBlockLike[] | null => {
  if (!clipboardData) return null;
  const notionBlocks = extractNotionNfmBlocksFromClipboardData(clipboardData);
  if (notionBlocks?.length) {
    return nfmToBlockNote(notionBlocks) as readonly NfmStructuralReplacementBlockLike[];
  }
  const types = Array.from(clipboardData.types);
  if (types.includes("blocknote/html")) {
    return editor.tryParseHTMLToBlocks(
      sanitizeUntrustedTypedOwnerHtml(clipboardData.getData("blocknote/html")),
    ) as readonly NfmStructuralReplacementBlockLike[];
  }
  if (types.includes("text/markdown")) {
    return editor.tryParseMarkdownToBlocks(
      clipboardData.getData("text/markdown"),
    ) as readonly NfmStructuralReplacementBlockLike[];
  }
  if (types.includes("text/html")) {
    return editor.tryParseHTMLToBlocks(
      sanitizeUntrustedTypedOwnerHtml(clipboardData.getData("text/html")),
    ) as readonly NfmStructuralReplacementBlockLike[];
  }
  if (!types.includes("text/plain")) return null;
  return editor.tryParseMarkdownToBlocks(
    clipboardData.getData("text/plain"),
  ) as readonly NfmStructuralReplacementBlockLike[];
};

export function createNfmPasteHandler(options: NfmPasteHandlerOptions = {}): NfmPasteHandler {
  return ({ event, editor, defaultPasteHandler }) => {
    const clipboardData = event.clipboardData;
    const htmlInspection = inspectNodexClipboardHtml(clipboardData?.getData("text/html") ?? "");
    if (options.onPendingStructuralPaste?.(htmlInspection.writeClaim)) {
      event.preventDefault();
      return true;
    }
    const structuralEnvelope =
      htmlInspection.envelope ??
      (htmlInspection.hasStructuralFallback ? options.readNativeStructuralEnvelope?.() : undefined);
    if (structuralEnvelope && options.onStructuralPaste?.(structuralEnvelope)) {
      event.preventDefault();
      return true;
    }
    if (options.shouldHandleStructuralBlockPaste?.()) {
      const portableBlocks = readPortableClipboardBlocks(editor, clipboardData);
      if (portableBlocks?.length && options.onStructuralBlockPaste?.(portableBlocks)) {
        event.preventDefault();
        return true;
      }
    }
    const handled = handleNotionPasteFromClipboard(
      editor as Parameters<typeof handleNotionPasteFromClipboard>[0],
      clipboardData,
    );
    if (handled) return true;

    const types = Array.from(clipboardData?.types ?? []);
    const internalHtml = types.includes("blocknote/html")
      ? (clipboardData?.getData("blocknote/html") ?? "")
      : "";
    const externalHtml = types.includes("text/html")
      ? (clipboardData?.getData("text/html") ?? "")
      : "";
    const unsafeHtml = internalHtml || externalHtml;
    if (hasUntrustedTypedOwnerHtml(unsafeHtml)) {
      editor.pasteHTML(sanitizeUntrustedTypedOwnerHtml(unsafeHtml), internalHtml.length > 0);
      return true;
    }

    if (clipboardTextLooksLikeGfmTable(clipboardData?.getData("text/plain") ?? "")) {
      return defaultPasteHandler({
        prioritizeMarkdownOverHTML: true,
        plainTextAsMarkdown: true,
      });
    }

    return defaultPasteHandler();
  };
}

export { getNfmSearchState };

function clipboardTextLooksLikeGfmTable(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return false;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = splitGfmTableRow(lines[index]!);
    const delimiterCells = splitGfmTableRow(lines[index + 1]!);
    if (headerCells.length < 2 || headerCells.length !== delimiterCells.length) {
      continue;
    }
    if (delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      return true;
    }
  }

  return false;
}
