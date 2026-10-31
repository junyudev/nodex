import { BlockNoteEditor } from "@blocknote/core";
import { act } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import type { CDPSession } from "@vitest/browser-playwright";
import { createNfmEditorExtensions } from "./nfm-editor-extensions";

const settleEditor = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
};

/** Drives Chromium's IME the way a pinyin input method does, one marked-text update per key. */
const compose = async (session: CDPSession, text: string): Promise<void> => {
  await act(async () => {
    await session.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await settleEditor();
  });
};

const commit = async (session: CDPSession, text: string): Promise<void> => {
  await act(async () => {
    await session.send("Input.insertText", { text });
    await settleEditor();
  });
};

/** Types `nihaoma`, backspaces inside the marked text, keeps typing, then picks `你好们`. */
const composeWithBackspace = async (): Promise<void> => {
  const session: CDPSession = cdp();
  for (let length = 1; length <= "nihaoma".length; length++) {
    await compose(session, "nihaoma".slice(0, length));
  }
  await compose(session, "nihaom");
  await compose(session, "nihaomen");
  await commit(session, "你好们");
};

const blockTexts = (editor: BlockNoteEditor) =>
  editor.document.map((block) =>
    Array.isArray(block.content)
      ? block.content.map((item) => ("text" in item ? item.text : "")).join("")
      : "",
  );

const withEditor = async (
  texts: readonly string[],
  cursorBlockIndex: number,
  run: (editor: BlockNoteEditor) => Promise<void>,
): Promise<void> => {
  const editor = BlockNoteEditor.create({
    initialContent: texts.map((content, index) => ({
      id: `block-${index}`,
      type: "paragraph" as const,
      content,
    })),
    extensions: createNfmEditorExtensions(),
  });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  try {
    await act(settleEditor);
    await act(async () => {
      editor.setTextCursorPosition(`block-${cursorBlockIndex}`, "end");
      editor.focus();
      await settleEditor();
    });
    await run(editor);
  } finally {
    editor.unmount();
    host.remove();
    editor._tiptapEditor.destroy();
  }
};

describe("IME composition in the Page editor", () => {
  test("keeps the marked text intact when Backspace edits it", async () => {
    await withEditor(["Alpha", "Beta", "Omega"], 1, async (editor) => {
      await composeWithBackspace();

      expect(editor.prosemirrorView?.composing).toBe(false);
      expect(blockTexts(editor)).toEqual(["Alpha", "Beta你好们", "Omega"]);
    });
  });

  test("keeps a composition in an empty Block inside that Block", async () => {
    await withEditor(["Alpha", "", "Omega"], 1, async (editor) => {
      await composeWithBackspace();

      expect(blockTexts(editor)).toEqual(["Alpha", "你好们", "Omega"]);
    });
  });
});
