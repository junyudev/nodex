import { describe, expect, test } from "vitest";
import { resolveComposerGlobalDictationAdmission } from "./composer-global-dictation-admission";

describe("resolveComposerGlobalDictationAdmission", () => {
  test("rejects a mounted composer while hidden", () => {
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();
    expect(
      resolveComposerGlobalDictationAdmission({
        visible: false,
        editor,
      }),
    ).toBe("hidden");
  });

  test("requires the Inbox editor to own focus when its composer is visible", () => {
    const editor = document.createElement("textarea");
    const pageEditor = document.createElement("div");
    pageEditor.tabIndex = 0;
    document.body.append(editor, pageEditor);
    pageEditor.focus();
    expect(
      resolveComposerGlobalDictationAdmission({
        visible: true,
        editor,
      }),
    ).toBe("focus-not-owned");

    editor.focus();
    expect(
      resolveComposerGlobalDictationAdmission({
        visible: true,
        editor,
      }),
    ).toBeNull();
  });
});
