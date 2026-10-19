import { describe, expect, test } from "vitest";
import { resolveComposerGlobalDictationAdmission } from "./composer-global-dictation-admission";

describe("resolveComposerGlobalDictationAdmission", () => {
  test("rejects a mounted floating composer while minimized", () => {
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();
    expect(
      resolveComposerGlobalDictationAdmission({
        floating: true,
        visible: false,
        editor,
      }),
    ).toBe("hidden");
  });

  test("requires the editor to own focus even when the floating composer is shown", () => {
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    const pageEditor = document.createElement("div");
    pageEditor.tabIndex = 0;
    document.body.append(editor, pageEditor);
    pageEditor.focus();
    expect(
      resolveComposerGlobalDictationAdmission({
        floating: true,
        visible: true,
        editor,
      }),
    ).toBe("focus-not-owned");

    editor.focus();
    expect(
      resolveComposerGlobalDictationAdmission({
        floating: true,
        visible: true,
        editor,
      }),
    ).toBeNull();
  });
});
