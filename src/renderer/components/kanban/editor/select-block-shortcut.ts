import { findBlockDescendantById } from "./block-dom-selectors";

interface BlockCursor {
  id: string;
  type: string;
}

interface BlockConfig {
  content?: string;
}

interface EditorWithSelectShortcut {
  domElement?: ParentNode;
  schema: { blockSchema: Record<string, BlockConfig> };
  getTextCursorPosition: () => { block: BlockCursor };
}

function getBrowserSelection(): Selection | null {
  if (typeof window === "undefined") return null;
  return window.getSelection();
}

function isInlineBlock(editor: EditorWithSelectShortcut, blockType: string): boolean {
  const blockConfig = editor.schema.blockSchema[blockType];
  return blockConfig?.content === "inline";
}

export function findInlineContentForBlock(
  editorDom: ParentNode | undefined,
  blockId: string,
): HTMLElement | null {
  return findBlockDescendantById<HTMLElement>(editorDom, blockId, ".bn-inline-content");
}

export function selectCurrentBlockContent(
  editor: EditorWithSelectShortcut,
  selection: Selection | null = getBrowserSelection(),
): boolean {
  if (!selection) return false;

  const cursor = editor.getTextCursorPosition();
  if (!isInlineBlock(editor, cursor.block.type)) return false;

  const inlineContent = findInlineContentForBlock(editor.domElement, cursor.block.id);
  if (!inlineContent) return false;

  const range = inlineContent.ownerDocument.createRange();
  range.selectNodeContents(inlineContent);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
