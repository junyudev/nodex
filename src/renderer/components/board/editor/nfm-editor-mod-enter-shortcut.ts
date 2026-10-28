import {
  modifyCurrentBlock,
  type ModifyShortcutActions,
  type ModifyShortcutEditor,
} from "./modify-block-shortcut";

export function handleNfmEditorModEnterShortcut(
  editor: ModifyShortcutEditor,
  actions: ModifyShortcutActions,
): boolean {
  return modifyCurrentBlock(editor, actions);
}
