import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TextSelection } from "@tiptap/pm/state";
import { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import type { PartialBlock } from "../defaultBlocks.js";
import { createCodeBlockSpec } from "./block.js";
import {
  getLanguageId,
  resolveCodeBlockInputLanguage,
  type CodeBlockOptions,
} from "./CodeBlockOptions.js";

/**
 * @vitest-environment jsdom
 */

/**
 * Simulate typing text into the editor at the current cursor position.
 * This triggers input rules by calling the view's handleTextInput prop,
 * which is how ProseMirror processes keyboard text input.
 */
function simulateTextInput(editor: BlockNoteEditor, text: string) {
  const view = editor.prosemirrorView;
  const { from, to } = view.state.selection;
  const deflt = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp("handleTextInput", (f) =>
    f(view, from, to, text, deflt),
  );
  if (!handled) {
    view.dispatch(deflt());
  }
}

function typeString(editor: BlockNoteEditor, str: string) {
  for (const char of str) {
    simulateTextInput(editor, char);
  }
}

/**
 * Simulate a keyboard shortcut by invoking the view's handleKeyDown prop,
 * which is how ProseMirror routes keymap-based handlers like Enter.
 */
function pressKey(editor: BlockNoteEditor, key: string, shiftKey = false) {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent("keydown", { key, shiftKey });
  return view.someProp("handleKeyDown", (f) => f(view, event));
}

function setCodeSelection(
  editor: BlockNoteEditor,
  text: string,
  anchor: number,
  head = anchor,
) {
  editor.replaceBlocks(editor.document, [
    { id: "code-0", type: "codeBlock", content: text },
  ]);
  editor.setTextCursorPosition("code-0", "start");
  editor.transact((tr) => {
    const parentStart = tr.selection.$from.start();
    tr.setSelection(TextSelection.create(tr.doc, parentStart + anchor, parentStart + head));
  });
}

function getCodeState(editor: BlockNoteEditor) {
  const { selection } = editor.prosemirrorState;
  const parentStart = selection.$anchor.start();
  return {
    text: selection.$anchor.parent.textContent,
    anchor: selection.anchor - parentStart,
    head: selection.head - parentStart,
  };
}

describe("Code block input rule", () => {
  let editor: BlockNoteEditor;
  const div = document.createElement("div");

  beforeAll(() => {
    editor = BlockNoteEditor.create();
    editor.mount(div);
  });

  afterAll(() => {
    editor._tiptapEditor.destroy();
    editor = undefined as any;
  });

  beforeEach(() => {
    const testDoc: PartialBlock[] = [
      {
        id: "test-paragraph",
        type: "paragraph",
        content: "",
      },
    ];
    editor.replaceBlocks(editor.document, testDoc);
    editor.setTextCursorPosition("test-paragraph", "start");
  });

  it("converts ```ts + space into a codeBlock", () => {
    typeString(editor, "```ts ");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect((block.props as any).language).toBe("text");
  });

  it("converts ``` + space into a codeBlock with empty language", () => {
    typeString(editor, "``` ");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect((block.props as any).language).toBe("text");
  });

  it("converts ```javascript + space into a codeBlock", () => {
    typeString(editor, "```javascript ");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect((block.props as any).language).toBe("text");
  });

  it("does not trigger input rule without trailing space", () => {
    typeString(editor, "```ts");

    const block = editor.document[0];
    expect(block.type).toBe("paragraph");
  });

  it("does not trigger with only two backticks", () => {
    typeString(editor, "``ts ");

    const block = editor.document[0];
    expect(block.type).toBe("paragraph");
  });

  it("does not trigger in non-empty paragraph with preceding text", () => {
    typeString(editor, "some text ```ts ");

    const block = editor.document[0];
    // The ^ anchor in the regex means it only triggers at the start of a block
    expect(block.type).toBe("paragraph");
  });

  it("code block content is empty after conversion", () => {
    typeString(editor, "```ts ");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect(block.content).toEqual([]);
  });

  it("converts ```ts + Enter into a codeBlock", () => {
    typeString(editor, "```ts");
    pressKey(editor, "Enter");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect((block.props as any).language).toBe("text");
    expect(block.content).toEqual([]);
  });

  it("converts ``` + Enter into a codeBlock with empty language", () => {
    typeString(editor, "```");
    pressKey(editor, "Enter");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect((block.props as any).language).toBe("text");
  });

  it("converts ```javascript + Enter into a codeBlock", () => {
    typeString(editor, "```javascript");
    pressKey(editor, "Enter");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");
    expect((block.props as any).language).toBe("text");
  });

  it("does not trigger Enter conversion in non-empty paragraph with preceding text", () => {
    typeString(editor, "some text ```ts");
    pressKey(editor, "Enter");

    const block = editor.document[0];
    expect(block.type).toBe("paragraph");
  });

  it("does not trigger Enter conversion with only two backticks", () => {
    typeString(editor, "``ts");
    pressKey(editor, "Enter");

    const block = editor.document[0];
    expect(block.type).toBe("paragraph");
  });

  it("places cursor inside the new code block after space conversion", () => {
    typeString(editor, "```ts ");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");

    const { block: cursorBlock } = editor.getTextCursorPosition();
    expect(cursorBlock.id).toBe(block.id);

    // Typing should now go into the code block, not after it.
    typeString(editor, "hello");
    const after = editor.document[0];
    expect(after.type).toBe("codeBlock");
    expect(after.id).toBe(block.id);
    expect(after.content).toEqual([
      { type: "text", text: "hello", styles: {} },
    ]);
  });

  it("places cursor inside the new code block after Enter conversion", () => {
    typeString(editor, "```ts");
    pressKey(editor, "Enter");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");

    const { block: cursorBlock } = editor.getTextCursorPosition();
    expect(cursorBlock.id).toBe(block.id);

    typeString(editor, "world");
    const after = editor.document[0];
    expect(after.type).toBe("codeBlock");
    expect(after.id).toBe(block.id);
    expect(after.content).toEqual([
      { type: "text", text: "world", styles: {} },
    ]);
  });

  it("Enter inside an existing code block does not retrigger conversion", () => {
    typeString(editor, "```ts ");

    const block = editor.document[0];
    expect(block.type).toBe("codeBlock");

    typeString(editor, "```js");
    pressKey(editor, "Enter");

    // Enter inside a code block should insert a newline, not convert again.
    const after = editor.document[0];
    expect(after.type).toBe("codeBlock");
    expect((after.props as any).language).toBe("text");
  });
});

describe("getLanguageId", () => {
  const options: CodeBlockOptions = {
    supportedLanguages: {
      typescript: {
        name: "TypeScript",
        aliases: ["ts", "typescript"],
      },
      javascript: {
        name: "JavaScript",
        aliases: ["js", "javascript"],
      },
      python: {
        name: "Python",
        aliases: ["py", "python"],
      },
    },
  };

  it("resolves alias to language id", () => {
    expect(getLanguageId(options, "ts")).toBe("typescript");
    expect(getLanguageId(options, "js")).toBe("javascript");
    expect(getLanguageId(options, "py")).toBe("python");
  });

  it("resolves language id directly", () => {
    expect(getLanguageId(options, "typescript")).toBe("typescript");
    expect(getLanguageId(options, "javascript")).toBe("javascript");
  });

  it("returns undefined for unknown language", () => {
    expect(getLanguageId(options, "unknown")).toBeUndefined();
  });

  it("returns undefined with no supportedLanguages", () => {
    expect(getLanguageId({}, "ts")).toBeUndefined();
  });

  it("falls back unknown and empty input-rule languages to the configured default", () => {
    expect(resolveCodeBlockInputLanguage(options, "TS")).toBe("typescript");
    expect(resolveCodeBlockInputLanguage({ ...options, defaultLanguage: "python" }, "vue")).toBe(
      "python",
    );
    expect(resolveCodeBlockInputLanguage({ ...options, defaultLanguage: "python" }, "")).toBe(
      "python",
    );
  });

  it("reads a dynamic creation default without changing explicit supported languages", () => {
    const getDefaultLanguage = () => "python";
    const preferredOptions = { ...options, defaultLanguage: "text", getDefaultLanguage };

    expect(resolveCodeBlockInputLanguage(preferredOptions, "TS")).toBe("typescript");
    expect(resolveCodeBlockInputLanguage(preferredOptions, "vue")).toBe("python");
    expect(resolveCodeBlockInputLanguage(preferredOptions, "")).toBe("python");
  });

  it("exposes the shared keyboard extension for React block specs", () => {
    expect(createCodeBlockSpec(options).extensions).toHaveLength(1);
  });
});

describe("Code block deletion boundaries", () => {
  let editor: BlockNoteEditor;

  afterEach(() => {
    editor?._tiptapEditor.destroy();
  });

  function createBoundaryEditor(initialContent: PartialBlock[]) {
    editor = BlockNoteEditor.create({ initialContent });
    editor.mount(document.createElement("div"));
    return editor;
  }

  it("merges a following paragraph into the code block on Backspace", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "alpha" },
      { id: "after", type: "paragraph", content: "beta" },
    ]);
    editor.setTextCursorPosition("after", "start");

    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]).toMatchObject({ id: "code", type: "codeBlock" });
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "alphabeta", styles: {} },
    ]);
    expect(editor.getTextCursorPosition().block.id).toBe("code");
    expect(editor.transact((tr) => tr.selection.$anchor.parentOffset)).toBe(5);
  });

  it("keeps an empty code block when it absorbs the following paragraph", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "" },
      { id: "after", type: "paragraph", content: "beta" },
    ]);
    editor.setTextCursorPosition("after", "start");

    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]).toMatchObject({ id: "code", type: "codeBlock" });
    expect(editor.document[0].content).toEqual([{ type: "text", text: "beta", styles: {} }]);
    expect(editor.transact((tr) => tr.selection.$anchor.parentOffset)).toBe(0);
  });

  it("flattens rich paragraph content when merging it into code", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "alpha" },
      {
        id: "after",
        type: "paragraph",
        content: [{ type: "text", text: "beta", styles: { bold: true } }],
      },
    ]);
    editor.setTextCursorPosition("after", "start");

    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.document[0].content).toEqual([
      { type: "text", text: "alphabeta", styles: {} },
    ]);
  });

  it("preserves line breaks when merging rich text into code", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "alpha" },
      { id: "after", type: "paragraph", content: "beta\ngamma" },
    ]);
    editor.setTextCursorPosition("after", "start");

    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.document[0].content).toEqual([
      { type: "text", text: "alphabeta\ngamma", styles: {} },
    ]);
  });

  it("promotes children of a paragraph merged into code", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "alpha" },
      {
        id: "after",
        type: "paragraph",
        content: "beta",
        children: [{ id: "child", type: "paragraph", content: "child" }],
      },
    ]);
    editor.setTextCursorPosition("after", "start");
    const before = editor.document;

    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.document).toHaveLength(2);
    expect(editor.document[0]).toMatchObject({ id: "code", type: "codeBlock", children: [] });
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "alphabeta", styles: {} },
    ]);
    expect(editor.document[1]).toMatchObject({ id: "child", type: "paragraph" });
    const merged = editor.document;

    expect(editor.undo()).toBe(true);
    expect(editor.document).toEqual(before);
    expect(editor.redo()).toBe(true);
    expect(editor.document).toEqual(merged);
  });

  it("treats Backspace at the start of code as a handled no-op", () => {
    createBoundaryEditor([{ id: "code", type: "codeBlock", content: "alpha" }]);
    editor.setTextCursorPosition("code", "start");
    const before = editor.document;

    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.document).toEqual(before);
    expect(editor.getTextCursorPosition().block.id).toBe("code");
    expect(editor.transact((tr) => tr.selection.$anchor.parentOffset)).toBe(0);
  });

  it("merges the following paragraph into code on forward Delete", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "alpha" },
      { id: "after", type: "paragraph", content: "beta" },
    ]);
    editor.setTextCursorPosition("code", "end");

    expect(pressKey(editor, "Delete")).toBe(true);

    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]).toMatchObject({ id: "code", type: "codeBlock" });
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "alphabeta", styles: {} },
    ]);
    expect(editor.transact((tr) => tr.selection.$anchor.parentOffset)).toBe(5);
  });

  it("records the boundary merge as one undoable transaction", () => {
    createBoundaryEditor([
      { id: "code", type: "codeBlock", content: "alpha" },
      { id: "after", type: "paragraph", content: "beta" },
    ]);
    editor.setTextCursorPosition("after", "start");
    expect(pressKey(editor, "Backspace")).toBe(true);

    expect(editor.undo()).toBe(true);
    expect(editor.document).toHaveLength(2);
    expect(editor.document[0]).toMatchObject({ id: "code", type: "codeBlock" });
    expect(editor.document[0].content).toEqual([{ type: "text", text: "alpha", styles: {} }]);
    expect(editor.document[1]).toMatchObject({ id: "after", type: "paragraph" });
    expect(editor.document[1].content).toEqual([{ type: "text", text: "beta", styles: {} }]);

    expect(editor.redo()).toBe(true);
    expect(editor.document).toHaveLength(1);
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "alphabeta", styles: {} },
    ]);
  });
});

describe("Code block line indentation", () => {
  let editor: BlockNoteEditor;

  beforeAll(() => {
    editor = BlockNoteEditor.create();
    editor.mount(document.createElement("div"));
  });

  afterAll(() => {
    editor?._tiptapEditor.destroy();
  });

  it("inserts a literal tab at the current line start", () => {
    setCodeSelection(editor, "alpha\nbeta", 8);

    expect(pressKey(editor, "Tab")).toBe(true);

    expect(getCodeState(editor)).toEqual({
      text: "alpha\n\tbeta",
      anchor: 9,
      head: 9,
    });
  });

  it("indents every selected line while preserving a backward selection", () => {
    setCodeSelection(editor, "one\ntwo\nthree", 11, 5);

    expect(pressKey(editor, "Tab")).toBe(true);

    expect(getCodeState(editor)).toEqual({
      text: "one\n\ttwo\n\tthree",
      anchor: 13,
      head: 6,
    });
  });

  it("outdents mixed leading whitespace one level per selected line", () => {
    setCodeSelection(editor, "\tone\n  two\n three\nfour", 0, 22);

    expect(pressKey(editor, "Tab", true)).toBe(true);

    expect(getCodeState(editor)).toEqual({
      text: "one\ntwo\nthree\nfour",
      anchor: 0,
      head: 18,
    });
  });

  it("consumes Shift-Tab with no indentation instead of unnesting the code block", () => {
    setCodeSelection(editor, "plain", 2);

    expect(pressKey(editor, "Tab", true)).toBe(true);

    expect(getCodeState(editor)).toEqual({ text: "plain", anchor: 2, head: 2 });
    expect(editor.document).toHaveLength(1);
    expect(editor.document[0].type).toBe("codeBlock");
  });

  it("records one indentation transaction for undo and redo", () => {
    setCodeSelection(editor, "one\ntwo", 1, 6);
    expect(pressKey(editor, "Tab")).toBe(true);
    expect(getCodeState(editor).text).toBe("\tone\n\ttwo");

    expect(editor.undo()).toBe(true);
    expect(getCodeState(editor)).toEqual({ text: "one\ntwo", anchor: 1, head: 6 });

    expect(editor.redo()).toBe(true);
    expect(getCodeState(editor)).toEqual({
      text: "\tone\n\ttwo",
      anchor: 2,
      head: 8,
    });
  });
});

describe("Prefer-indent Tab boundaries", () => {
  it.each([
    { key: "Tab", shiftKey: false },
    { key: "Tab", shiftKey: true },
  ])("consumes an ordinary top-level $key no-op", ({ key, shiftKey }) => {
    const editor = BlockNoteEditor.create({
      tabBehavior: "prefer-indent",
      initialContent: [{ id: "paragraph-0", type: "paragraph", content: "alpha" }],
    });
    editor.mount(document.createElement("div"));
    editor.setTextCursorPosition("paragraph-0", "start");

    expect(pressKey(editor, key, shiftKey)).toBe(true);
    expect(editor.prosemirrorState.doc.textContent).toBe("alpha");

    editor._tiptapEditor.destroy();
  });

  it.each([
    { key: "Tab", shiftKey: false },
    { key: "Tab", shiftKey: true },
  ])("leaves a top-level $key no-op available for UI navigation", ({ key, shiftKey }) => {
    const editor = BlockNoteEditor.create({
      tabBehavior: "prefer-navigate-ui",
      initialContent: [{ id: "paragraph-0", type: "paragraph", content: "alpha" }],
    });
    editor.mount(document.createElement("div"));
    editor.setTextCursorPosition("paragraph-0", "start");

    expect(pressKey(editor, key, shiftKey)).toBeUndefined();
    expect(editor.prosemirrorState.doc.textContent).toBe("alpha");

    editor._tiptapEditor.destroy();
  });
});
