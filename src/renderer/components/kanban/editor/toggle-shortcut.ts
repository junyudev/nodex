import { findBlockDescendantById } from "./block-dom-selectors";

interface BlockCursor {
  id: string;
  type: string;
}

interface EditorWithToggleShortcut {
  domElement?: ParentNode;
  getTextCursorPosition: () => { block: BlockCursor };
}

export function findToggleButtonForBlock(
  editorDom: ParentNode | undefined,
  blockId: string,
): HTMLButtonElement | null {
  return findBlockDescendantById<HTMLButtonElement>(editorDom, blockId, ".bn-toggle-button");
}

export function toggleCurrentToggleBlock(
  editor: EditorWithToggleShortcut,
): boolean {
  const cursor = editor.getTextCursorPosition();
  const toggleButton = findToggleButtonForBlock(editor.domElement, cursor.block.id);
  if (!toggleButton) return false;

  toggleButton.click();
  return true;
}
