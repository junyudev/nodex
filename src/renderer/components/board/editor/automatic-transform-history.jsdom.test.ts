import { BlockNoteEditor, dispatchHistoryBoundary, type PartialBlock } from "@blocknote/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { NFM_AUTOLINK_SETTINGS_STORAGE_KEY } from "@/lib/nfm-autolink-settings";
import { createNfmLinkExtension } from "./nfm-link-extension";
import { createNfmEditorExtensions, NFM_DISABLED_EXTENSIONS } from "./nfm-editor-extensions";
import { nfmSchema } from "./nfm-schema";

function simulateTextInput(editor: BlockNoteEditor<any, any, any>, text: string) {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");

  const { from, to } = view.state.selection;
  const defaultTransaction = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp("handleTextInput", (handler) =>
    handler(view, from, to, text, defaultTransaction),
  );

  if (!handled) {
    view.dispatch(defaultTransaction());
  }
}

function typeString(editor: BlockNoteEditor<any, any, any>, text: string) {
  for (const character of text) {
    simulateTextInput(editor, character);
  }
}

function pressKey(editor: BlockNoteEditor<any, any, any>, key: string) {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");
  return view.someProp("handleKeyDown", (handler) =>
    handler(view, new KeyboardEvent("keydown", { key })),
  );
}

function linkTexts(editor: BlockNoteEditor<any, any, any>): string[] {
  const result: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    if (node.marks.some((mark) => mark.type.name === "link")) {
      result.push(node.text);
    }
  });
  return result;
}

describe("automatic transform history", () => {
  let editor: BlockNoteEditor;
  const mount = document.createElement("div");

  beforeAll(() => {
    editor = BlockNoteEditor.create();
    editor.mount(mount);
  });

  afterAll(() => {
    editor._tiptapEditor.destroy();
  });

  beforeEach(() => {
    const document: PartialBlock[] = [
      {
        id: "automatic-transform-paragraph",
        type: "paragraph",
        content: "",
      },
    ];
    editor.replaceBlocks(editor.document, document);
    editor.setTextCursorPosition("automatic-transform-paragraph", "start");
  });

  it("separates ordinary history events without changing the document or selection", () => {
    const boundaryEditor = BlockNoteEditor.create();
    const boundaryMount = document.createElement("div");
    boundaryEditor.mount(boundaryMount);
    const view = boundaryEditor.prosemirrorView;
    if (!view) throw new Error("Expected a mounted editor view");

    try {
      view.dispatch(view.state.tr.insertText("A"));
      const documentAfterA = view.state.doc;
      const selectionAfterA = view.state.selection;
      dispatchHistoryBoundary(view);
      expect(view.state.doc.eq(documentAfterA)).toBe(true);
      expect(view.state.selection.eq(selectionAfterA)).toBe(true);

      view.dispatch(view.state.tr.insertText("B"));
      dispatchHistoryBoundary(view);
      view.dispatch(view.state.tr.insertText("C"));
      expect(view.state.doc.textContent).toBe("ABC");

      expect(boundaryEditor.undo()).toBe(true);
      expect(view.state.doc.textContent).toBe("AB");
      expect(boundaryEditor.undo()).toBe(true);
      expect(view.state.doc.textContent).toBe("A");
      expect(boundaryEditor.undo()).toBe(true);
      expect(view.state.doc.textContent).toBe("");
      expect(boundaryEditor.undo()).toBe(false);
    } finally {
      boundaryEditor._tiptapEditor.destroy();
    }
  });

  it("undoes literal Markdown input and automatic formatting as separate intentions", () => {
    typeString(editor, "**ABC**");

    expect(editor.document[0].content).toEqual([
      { type: "text", text: "ABC", styles: { bold: true } },
    ]);

    expect(editor.undo()).toBe(true);
    expect(editor.document[0].content).toEqual([{ type: "text", text: "**ABC**", styles: {} }]);

    expect(editor.undo()).toBe(true);
    expect(editor.document[0].content).toEqual([]);

    expect(editor.redo()).toBe(true);
    expect(editor.document[0].content).toEqual([{ type: "text", text: "**ABC**", styles: {} }]);

    expect(editor.redo()).toBe(true);
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "ABC", styles: { bold: true } },
    ]);
  });

  it.each([
    ["**bold**", "bold", { bold: true }],
    ["__bold__", "bold", { bold: true }],
    ["*italic*", "italic", { italic: true }],
    ["_italic_", "italic", { italic: true }],
    ["~~strike~~", "strike", { strike: true }],
    ["`code`", "code", { code: true }],
    ["＊＊粗体＊＊", "粗体", { bold: true }],
    ["＿＿粗体＿＿", "粗体", { bold: true }],
    ["＊斜体＊", "斜体", { italic: true }],
    ["＿斜体＿", "斜体", { italic: true }],
    ["´code´", "code", { code: true }],
    ["｀代码｀", "代码", { code: true }],
  ] as const)(
    "keeps the complete raw form of %s behind its automatic transform",
    (raw, formatted, styles) => {
      typeString(editor, raw);

      expect(editor.document[0].content).toEqual([{ type: "text", text: formatted, styles }]);
      expect(editor.undo()).toBe(true);
      expect(editor.document[0].content).toEqual([{ type: "text", text: raw, styles: {} }]);
    },
  );

  it.each(["abc**x**", "** **"])(
    "keeps ineligible Markdown literal without adding a transform event: %s",
    (raw) => {
      typeString(editor, raw);

      expect(editor.document[0].content).toEqual([{ type: "text", text: raw, styles: {} }]);
      expect(editor.undo()).toBe(true);
      expect(editor.document[0].content).toEqual([]);
    },
  );

  it("keeps following typing outside the automatic-transform history event", () => {
    typeString(editor, "**ABC**X");

    expect(editor.document[0].content).toEqual([
      { type: "text", text: "ABC", styles: { bold: true } },
      { type: "text", text: "X", styles: {} },
    ]);

    expect(editor.undo()).toBe(true);
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "ABC", styles: { bold: true } },
    ]);

    expect(editor.undo()).toBe(true);
    expect(editor.document[0].content).toEqual([{ type: "text", text: "**ABC**", styles: {} }]);
  });

  it("restores literal input once when Backspace immediately follows a transform", () => {
    typeString(editor, "**ABC**");

    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(editor.document[0].content).toEqual([{ type: "text", text: "**ABC**", styles: {} }]);
  });

  it("restores a Block prefix once when Backspace immediately follows its transform", () => {
    typeString(editor, "# ");
    expect(editor.document[0].type).toBe("heading");

    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(editor.document[0].type).toBe("paragraph");
    expect(editor.document[0].content).toEqual([{ type: "text", text: "# ", styles: {} }]);
  });

  it.each([
    ["# ", "heading", "# "],
    ["- ", "bulletListItem", "- "],
    ["1. ", "numberedListItem", "1. "],
    ["[ ] ", "checkListItem", "[ ] "],
    ["> ", "quote", "> "],
    ["``` ", "codeBlock", "``` "],
    ["---", "divider", "---"],
  ] as const)(
    "undoes the %s Block-prefix transform before its literal input",
    (input, blockType, raw) => {
      typeString(editor, input);
      expect(editor.document[0].type).toBe(blockType);

      expect(editor.undo()).toBe(true);
      expect(editor.document[0].type).toBe("paragraph");
      expect(editor.document[0].content).toEqual([{ type: "text", text: raw, styles: {} }]);
    },
  );

  it("restores an Enter-triggered Block prefix without inserting a phantom newline", () => {
    typeString(editor, "#");
    expect(pressKey(editor, "Enter")).toBe(true);
    expect(editor.document[0].type).toBe("heading");

    expect(editor.undo()).toBe(true);
    expect(editor.document[0].type).toBe("paragraph");
    expect(editor.document[0].content).toEqual([{ type: "text", text: "#", styles: {} }]);
  });

  it("undoes typing autolink without removing the literal URL or separator", () => {
    typeString(editor, "https://example.com ");
    expect(linkTexts(editor)).toEqual(["https://example.com"]);

    expect(editor.undo()).toBe(true);
    expect(linkTexts(editor)).toEqual([]);
    expect(editor.prosemirrorState.doc.textContent).toBe("https://example.com ");

    expect(editor.redo()).toBe(true);
    expect(linkTexts(editor)).toEqual(["https://example.com"]);
  });

  it("formats committed composition text only after composition ends", async () => {
    const view = editor.prosemirrorView;
    if (!view) throw new Error("Expected a mounted editor view");
    const { from, to } = view.state.selection;
    view.dispatch(view.state.tr.insertText("＊＊中文＊＊", from, to));

    expect(editor.document[0].content).toEqual([
      { type: "text", text: "＊＊中文＊＊", styles: {} },
    ]);
    view.someProp("handleDOMEvents", (handlers) =>
      handlers.compositionend?.(view, new CompositionEvent("compositionend")),
    );
    await new Promise((resolve) => setTimeout(resolve));

    expect(editor.document[0].content).toEqual([
      { type: "text", text: "中文", styles: { bold: true } },
    ]);
    expect(editor.undo()).toBe(true);
    expect(editor.document[0].content).toEqual([
      { type: "text", text: "＊＊中文＊＊", styles: {} },
    ]);
  });
});

describe("NFM typing autolink history", () => {
  it("uses the same independently undoable transform with NFM URL guards", () => {
    localStorage.removeItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY);
    const editor = BlockNoteEditor.create({
      disableExtensions: ["link"],
      _tiptapOptions: { extensions: [createNfmLinkExtension()] },
    });
    const mount = document.createElement("div");
    editor.mount(mount);

    try {
      const blockId = editor.document[0]?.id;
      if (!blockId) throw new Error("Expected an initial paragraph");
      editor.setTextCursorPosition(blockId, "start");
      typeString(editor, "https://example.com ");

      expect(linkTexts(editor)).toEqual(["https://example.com"]);
      expect(editor.undo()).toBe(true);
      expect(linkTexts(editor)).toEqual([]);
      expect(editor.prosemirrorState.doc.textContent).toBe("https://example.com ");
    } finally {
      editor._tiptapEditor.destroy();
      localStorage.removeItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY);
    }
  });

  it("does not add a transform history event when typing autolink is disabled", () => {
    localStorage.setItem(
      NFM_AUTOLINK_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        autoLinkWhileTyping: false,
        autoLinkOnPaste: true,
        linkifyBareDomains: true,
      }),
    );
    const editor = BlockNoteEditor.create({
      disableExtensions: ["link"],
      _tiptapOptions: { extensions: [createNfmLinkExtension()] },
    });
    const mount = document.createElement("div");
    editor.mount(mount);

    try {
      const blockId = editor.document[0]?.id;
      if (!blockId) throw new Error("Expected an initial paragraph");
      editor.setTextCursorPosition(blockId, "start");
      typeString(editor, "https://example.com ");

      expect(linkTexts(editor)).toEqual([]);
      expect(editor.undo()).toBe(true);
      expect(editor.prosemirrorState.doc.textContent).toBe("");
    } finally {
      editor._tiptapEditor.destroy();
      localStorage.removeItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY);
    }
  });
});

describe("NFM Block-prefix history", () => {
  it.each([
    ["> ", "toggleListItem"],
    ["| ", "quote"],
  ] as const)("restores the literal %s prefix for NFM %s Blocks", (raw, blockType) => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      disableExtensions: [...NFM_DISABLED_EXTENSIONS],
      extensions: createNfmEditorExtensions(),
    });
    const mount = document.createElement("div");
    editor.mount(mount);

    try {
      const blockId = editor.document[0]?.id;
      if (!blockId) throw new Error("Expected an initial paragraph");
      editor.setTextCursorPosition(blockId, "start");
      typeString(editor, raw);

      expect(editor.document[0].type).toBe(blockType);
      expect(editor.undo()).toBe(true);
      expect(editor.document[0].type).toBe("paragraph");
      expect(editor.document[0].content).toEqual([{ type: "text", text: raw, styles: {} }]);
    } finally {
      editor._tiptapEditor.destroy();
    }
  });

  it("restores the literal divider prefix before removing its input", () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      disableExtensions: [...NFM_DISABLED_EXTENSIONS],
      extensions: createNfmEditorExtensions(),
    });
    const mount = document.createElement("div");
    editor.mount(mount);

    try {
      const blockId = editor.document[0]?.id;
      if (!blockId) throw new Error("Expected an initial paragraph");
      editor.setTextCursorPosition(blockId, "start");
      typeString(editor, "---");

      expect(editor.document[0].type).toBe("divider");
      expect(editor.undo()).toBe(true);
      expect(editor.document[0].type).toBe("paragraph");
      expect(editor.document[0].content).toEqual([{ type: "text", text: "---", styles: {} }]);
      expect(editor.undo()).toBe(true);
      expect(editor.document[0].content).toEqual([]);
    } finally {
      editor._tiptapEditor.destroy();
    }
  });
});
