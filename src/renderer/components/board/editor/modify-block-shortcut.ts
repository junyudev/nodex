import type { FocusedImagePreview } from "./image-preview-shortcut";
import { findBlockDescendantById } from "./block-dom-selectors";
import { findToggleButtonForBlock } from "./toggle-shortcut";

interface ModifyShortcutBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
}

interface ModifyShortcutSelection {
  blocks?: ModifyShortcutBlock[];
}

export interface ModifyShortcutEditor {
  domElement?: ParentNode;
  getSelection?: () => ModifyShortcutSelection | undefined;
  getTextCursorPosition: () => { block?: ModifyShortcutBlock };
  getBlock?: (id: string) => ModifyShortcutBlock | undefined;
  updateBlock?: (
    block: ModifyShortcutBlock | string,
    update: { props?: Record<string, unknown> },
  ) => unknown;
}

export interface ModifyShortcutActions {
  openImagePreview?: (preview: FocusedImagePreview) => void;
}

function readStringProp(props: Record<string, unknown> | undefined, key: string): string {
  const value = props?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isToggleLikeBlock(block: ModifyShortcutBlock | undefined): boolean {
  if (!block) return false;
  if (block.type === "toggleListItem") return true;
  return block.type === "heading" && block.props?.isToggleable === true;
}

function isPageOutlinerBlock(block: ModifyShortcutBlock | undefined): boolean {
  return block?.type === "page" || block?.type === "pageRef";
}

function isModifiableBlock(block: ModifyShortcutBlock | undefined): boolean {
  if (!block) return false;
  if (block.type === "checkListItem") return true;
  if (block.type === "image") return true;
  if (isPageOutlinerBlock(block)) return true;
  return isToggleLikeBlock(block);
}

function resolveSelectedBlock(
  editor: ModifyShortcutEditor,
): ModifyShortcutBlock | null | undefined {
  const selection = editor.getSelection?.();
  if (!selection) return undefined;

  const selectedBlocks = selection.blocks ?? [];
  if (selectedBlocks.length !== 1) return null;

  const selectedBlock = selectedBlocks[0];
  if (!isModifiableBlock(selectedBlock)) return null;
  if (!selectedBlock.id) return selectedBlock;

  return editor.getBlock?.(selectedBlock.id) ?? selectedBlock;
}

function resolveShortcutBlock(editor: ModifyShortcutEditor): ModifyShortcutBlock | null {
  const selectedBlock = resolveSelectedBlock(editor);
  if (selectedBlock !== undefined) return selectedBlock;

  const cursorBlock = editor.getTextCursorPosition().block;
  if (!isModifiableBlock(cursorBlock)) return null;
  if (!cursorBlock?.id) return cursorBlock ?? null;

  return editor.getBlock?.(cursorBlock.id) ?? cursorBlock;
}

function resolveImagePreview(block: ModifyShortcutBlock): FocusedImagePreview | null {
  const source = readStringProp(block.props, "url");
  if (!source) return null;

  const caption = readStringProp(block.props, "caption");
  const name = readStringProp(block.props, "name");
  return {
    source,
    alt: caption || name || "Image preview",
  };
}

function handleToggleBlock(editor: ModifyShortcutEditor, block: ModifyShortcutBlock): boolean {
  if (!block.id) return false;

  const toggleButton = findToggleButtonForBlock(editor.domElement, block.id);
  if (!toggleButton) return false;

  toggleButton.click();
  return true;
}

function handlePageOutlinerBlock(
  editor: ModifyShortcutEditor,
  block: ModifyShortcutBlock,
): boolean {
  if (!block.id) return true;

  const disclosure = findBlockDescendantById<HTMLButtonElement>(
    editor.domElement,
    block.id,
    "[data-page-outliner-caret]",
  );
  if (!disclosure || disclosure.disabled) return true;

  disclosure.click();
  return true;
}

export function modifyCurrentBlock(
  editor: ModifyShortcutEditor,
  actions: ModifyShortcutActions,
): boolean {
  const block = resolveShortcutBlock(editor);
  if (!block) return false;

  if (block.type === "checkListItem") {
    if (!editor.updateBlock) return false;
    editor.updateBlock(block, { props: { checked: !block.props?.checked } });
    return true;
  }

  if (isToggleLikeBlock(block)) {
    return handleToggleBlock(editor, block);
  }

  if (isPageOutlinerBlock(block)) {
    return handlePageOutlinerBlock(editor, block);
  }

  if (block.type === "image") {
    const preview = resolveImagePreview(block);
    if (!preview || !actions.openImagePreview) return false;
    actions.openImagePreview(preview);
    return true;
  }

  return false;
}
