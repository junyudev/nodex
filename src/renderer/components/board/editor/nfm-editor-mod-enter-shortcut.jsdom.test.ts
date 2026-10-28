import { describe, expect, test } from "vite-plus/test";
import { handleNfmEditorModEnterShortcut } from "./nfm-editor-mod-enter-shortcut";
import type { ModifyShortcutEditor } from "./modify-block-shortcut";

describe("handleNfmEditorModEnterShortcut", () => {
  test("modifies the current checkbox", () => {
    let checked = false;
    const editor: ModifyShortcutEditor = {
      getTextCursorPosition: () => ({
        block: { id: "check-1", type: "checkListItem", props: { checked: false } },
      }),
      updateBlock: (_block, update) => {
        checked = update.props?.checked === true;
      },
    };
    expect(handleNfmEditorModEnterShortcut(editor, {})).toBe(true);
    expect(checked).toBe(true);
  });

  test("toggles a Page disclosure", () => {
    let clicks = 0;
    const button = document.createElement("button");
    button.addEventListener("click", () => {
      clicks += 1;
    });
    const editor: ModifyShortcutEditor = {
      domElement: {
        querySelector: (selector: string) =>
          selector === '.bn-block[data-id="page-1"] [data-page-outliner-caret]' ? button : null,
      } as unknown as ParentNode,
      getTextCursorPosition: () => ({ block: { id: "page-1", type: "page", props: {} } }),
    };
    expect(handleNfmEditorModEnterShortcut(editor, {})).toBe(true);
    expect(clicks).toBe(1);
  });

  test("leaves ordinary text unhandled", () => {
    const editor: ModifyShortcutEditor = {
      getTextCursorPosition: () => ({ block: { id: "text-1", type: "paragraph", props: {} } }),
    };
    expect(handleNfmEditorModEnterShortcut(editor, {})).toBe(false);
  });

  test("leaves a missing cursor unhandled", () => {
    expect(handleNfmEditorModEnterShortcut({ getTextCursorPosition: () => ({}) }, {})).toBe(false);
  });
});
