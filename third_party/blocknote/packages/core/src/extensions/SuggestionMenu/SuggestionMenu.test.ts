import { describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { DecorationSet } from "prosemirror-view";
import * as Y from "yjs";

import { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import { SuggestionMenu } from "./SuggestionMenu.js";
import { withCollaboration } from "../../yjs/extensions/index.js";

/**
 * @vitest-environment jsdom
 */

/**
 * Find the SuggestionMenu ProseMirror plugin instance from the editor state.
 * We need to do this because the PluginKey is not exported, and creating a new
 * PluginKey with the same name gives a different instance.
 */
function findSuggestionPlugin(editor: BlockNoteEditor) {
  const state = editor._tiptapEditor.state;
  const plugin = state.plugins.find(
    (p) => (p as any).key === "SuggestionMenuPlugin$",
  );
  if (!plugin) {
    throw new Error("SuggestionMenuPlugin not found in editor state");
  }
  return plugin;
}

function getSuggestionPluginState(editor: BlockNoteEditor) {
  const plugin = findSuggestionPlugin(editor);
  const state = plugin.getState(editor._tiptapEditor.state);
  return state?.status === "active" ? state : undefined;
}

function getSuggestionDecorations(editor: BlockNoteEditor) {
  const plugin = findSuggestionPlugin(editor);
  const decorations = plugin.props.decorations?.call(plugin, editor.prosemirrorState);
  if (!decorations) return [];
  if (!(decorations instanceof DecorationSet)) {
    throw new Error("SuggestionMenu must expose a DecorationSet");
  }
  return decorations.find();
}

/**
 * Calls the `handleTextInput` prop of the SuggestionMenu plugin directly,
 * which mirrors what ProseMirror would do when the user types a character.
 * This allows us to test the `shouldTrigger` filtering path.
 */
function simulateTextInput(editor: BlockNoteEditor, char: string): boolean {
  const plugin = findSuggestionPlugin(editor);
  const view = editor._tiptapEditor.view;
  const from = view.state.selection.from;
  const to = view.state.selection.to;
  const handler = plugin.props.handleTextInput;
  if (!handler) {
    throw new Error("handleTextInput not found on SuggestionMenu plugin");
  }
  return (
    handler.call(plugin, view, from, to, char, () =>
      view.state.tr.insertText(char, from, to),
    ) === true
  );
}

function createEditor() {
  const editor = BlockNoteEditor.create();
  const div = document.createElement("div");
  editor.mount(div);
  return editor;
}

describe("SuggestionMenu", () => {
  it("owns one temporary input range from a multi-character trigger through the query", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "[[" });

    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "prefix " },
    ]);
    editor.setTextCursorPosition("paragraph-0", "end");
    expect(simulateTextInput(editor, "[")).toBe(false);
    editor.insertInlineContent("[");
    expect(simulateTextInput(editor, "[")).toBe(true);
    editor.insertInlineContent("road");

    const state = suggestionMenu.getMenuState();
    expect(state).toMatchObject({
      triggerCharacter: "[[",
      query: "road",
      acceptancePhase: "editing",
    });
    expect(
      suggestionMenu.setTemporaryInputData(state!.sessionId, {
        enabled: true,
        completion: "map",
      }),
    ).toBe(true);

    const decorations = getSuggestionDecorations(editor);
    const range = decorations.find((decoration) => decoration.from !== decoration.to);
    expect(range).toMatchObject({
      from: editor._tiptapEditor.state.selection.from - "[[road".length,
      to: editor._tiptapEditor.state.selection.from,
    });
    expect(decorations).toHaveLength(1);
    expect(
      editor.prosemirrorView?.dom
        .querySelector(".bn-suggestion-temporary-input")
        ?.getAttribute("data-suggestion-completion"),
    ).toBe("map");
    expect(suggestionMenu.setTemporaryInputData("stale-session", { enabled: false })).toBe(false);

    suggestionMenu.closeMenu("escape");
    expect(getSuggestionDecorations(editor)).toEqual([]);
    expect(editor._tiptapEditor.state.doc.textContent).toBe("prefix [[road");
    editor._tiptapEditor.destroy();
  });

  it("leases deferred acceptance without changing the live Document and rolls back in place", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "+" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "before " },
    ]);
    editor.setTextCursorPosition("paragraph-0", "end");
    expect(simulateTextInput(editor, "+")).toBe(true);
    editor.insertInlineContent("Child");

    const lease = suggestionMenu.beginDeferredAcceptance(["CHILD "]);
    expect(lease).not.toBeNull();
    expect(lease).toMatchObject({ blockId: "paragraph-0" });
    expect(editor._tiptapEditor.state.doc.textContent).toBe("before +Child");
    expect(suggestionMenu.getMenuState()?.acceptancePhase).toBe("pending_authoritative");

    editor.transact((transaction) => transaction.setMeta("blur", true));
    expect(suggestionMenu.getMenuState()?.acceptancePhase).toBe("pending_authoritative");
    editor.transact((transaction) => transaction.setMeta("focus", true));
    expect(suggestionMenu.getMenuState()?.acceptancePhase).toBe("pending_authoritative");

    expect(lease!.rollback("head-conflict")).toBe(true);
    expect(suggestionMenu.getMenuState()).toMatchObject({
      query: "Child",
      acceptancePhase: "editing",
    });
    expect(editor._tiptapEditor.state.doc.textContent).toBe("before +Child");

    editor.transact((transaction) => transaction.setMeta("blur", true));
    expect(suggestionMenu.getMenuState()).toBeUndefined();
    expect(suggestionMenu.getLastCloseReason()).toBe("blur");
    editor._tiptapEditor.destroy();
  });

  it("closes a deferred session only after the authoritative replacement is visible", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "+" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "before " },
    ]);
    editor.setTextCursorPosition("paragraph-0", "end");
    expect(simulateTextInput(editor, "+")).toBe(true);
    editor.insertInlineContent("Child");

    const lease = suggestionMenu.beginDeferredAcceptance(["CHILD "]);
    expect(lease?.commit()).toBe(false);
    editor.updateBlock("paragraph-0", { content: lease!.replacementContent as never });
    expect(lease!.commit()).toBe(true);
    expect(suggestionMenu.getMenuState()).toBeUndefined();
    expect(editor.getBlock("paragraph-0")?.content).toEqual(lease!.replacementContent);
    editor._tiptapEditor.destroy();
  });
  it("should open suggestion menu in a paragraph", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    // Register "/" trigger character (no filter)
    sm.addSuggestionMenu({ triggerCharacter: "/" });

    editor.replaceBlocks(editor.document, [
      {
        id: "paragraph-0",
        type: "paragraph",
        content: "Hello world",
      },
    ]);

    editor.setTextCursorPosition("paragraph-0", "end");

    // Verify we start with no active suggestion menu
    expect(getSuggestionPluginState(editor)).toBeUndefined();

    // Simulate typing "/" — handleTextInput should trigger the menu
    const handled = simulateTextInput(editor, "/");

    // The input should be handled (menu opened)
    expect(handled).toBe(true);

    // Plugin state should now be defined (menu opened)
    const pluginState = getSuggestionPluginState(editor);
    expect(pluginState).toBeDefined();
    expect(pluginState.triggerCharacter).toBe("/");

    editor._tiptapEditor.destroy();
  });

  it("should not open suggestion menu in table content when shouldTrigger returns false", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    // Register "/" with a shouldTrigger filter that blocks table content.
    // This mirrors what BlockNoteDefaultUI does.
    sm.addSuggestionMenu({
      triggerCharacter: "/",
      shouldOpen: (tr) =>
        !tr.selection.$from.parent.type.isInGroup("tableContent"),
    });

    editor.replaceBlocks(editor.document, [
      {
        id: "table-0",
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            {
              cells: ["Cell 1", "Cell 2", "Cell 3"],
            },
            {
              cells: ["Cell 4", "Cell 5", "Cell 6"],
            },
          ],
        },
      },
    ]);

    // Place cursor inside a table cell
    editor.setTextCursorPosition("table-0", "start");

    // Verify the cursor is inside table content
    const $from = editor._tiptapEditor.state.selection.$from;
    expect($from.parent.type.isInGroup("tableContent")).toBe(true);

    // Verify we start with no active suggestion menu
    expect(getSuggestionPluginState(editor)).toBeUndefined();

    // Simulate typing "/" — shouldTrigger should prevent the menu from opening
    const handled = simulateTextInput(editor, "/");

    // handleTextInput should return false (not handled) because
    // shouldTrigger rejected the context
    expect(handled).toBe(false);

    // Plugin state should remain undefined
    expect(getSuggestionPluginState(editor)).toBeUndefined();

    editor._tiptapEditor.destroy();
  });

  it("should open a suggestion menu with a multi-character trigger", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    sm.addSuggestionMenu({ triggerCharacter: "img:" });

    editor.replaceBlocks(editor.document, [
      {
        id: "paragraph-0",
        type: "paragraph",
        content: "img",
      },
    ]);

    editor.setTextCursorPosition("paragraph-0", "end");

    expect(getSuggestionPluginState(editor)).toBeUndefined();

    // Typing the final ":" completes the "img:" trigger.
    const handled = simulateTextInput(editor, ":");

    expect(handled).toBe(true);

    const pluginState = getSuggestionPluginState(editor);
    expect(pluginState).toBeDefined();
    expect(pluginState.triggerCharacter).toBe("img:");

    editor._tiptapEditor.destroy();
  });

  it("should match a multi-character trigger that is preceded by other text", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    sm.addSuggestionMenu({ triggerCharacter: "img:" });

    editor.replaceBlocks(editor.document, [
      {
        id: "paragraph-0",
        type: "paragraph",
        content: "hello img",
      },
    ]);

    editor.setTextCursorPosition("paragraph-0", "end");

    expect(getSuggestionPluginState(editor)).toBeUndefined();

    const handled = simulateTextInput(editor, ":");

    expect(handled).toBe(true);

    const pluginState = getSuggestionPluginState(editor);
    expect(pluginState).toBeDefined();
    expect(pluginState.triggerCharacter).toBe("img:");

    editor._tiptapEditor.destroy();
  });

  it("should prefer a longer trigger over a shorter one that would shadow it", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    // Register the shorter ":" trigger first so it would win in insertion
    // order, then the longer "img:" trigger that ends in the same character.
    sm.addSuggestionMenu({ triggerCharacter: ":" });
    sm.addSuggestionMenu({ triggerCharacter: "img:" });

    editor.replaceBlocks(editor.document, [
      {
        id: "paragraph-0",
        type: "paragraph",
        content: "img",
      },
    ]);

    editor.setTextCursorPosition("paragraph-0", "end");

    const handled = simulateTextInput(editor, ":");

    expect(handled).toBe(true);

    const pluginState = getSuggestionPluginState(editor);
    expect(pluginState).toBeDefined();
    expect(pluginState.triggerCharacter).toBe("img:");

    editor._tiptapEditor.destroy();
  });

  it("should fall back to the shorter trigger when the longer one does not match", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    sm.addSuggestionMenu({ triggerCharacter: ":" });
    sm.addSuggestionMenu({ triggerCharacter: "img:" });

    editor.replaceBlocks(editor.document, [
      {
        id: "paragraph-0",
        type: "paragraph",
        content: "hello",
      },
    ]);

    editor.setTextCursorPosition("paragraph-0", "end");

    // "hello" + ":" doesn't complete "img:", so the bare ":" trigger wins.
    const handled = simulateTextInput(editor, ":");

    expect(handled).toBe(true);

    const pluginState = getSuggestionPluginState(editor);
    expect(pluginState).toBeDefined();
    expect(pluginState.triggerCharacter).toBe(":");

    editor._tiptapEditor.destroy();
  });

  it("should still allow suggestion menus without shouldTrigger in table content", () => {
    const editor = createEditor();
    const sm = editor.getExtension(SuggestionMenu)!;

    // Register "@" WITHOUT a shouldTrigger filter — should still work in tables
    sm.addSuggestionMenu({ triggerCharacter: "@" });

    editor.replaceBlocks(editor.document, [
      {
        id: "table-0",
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            {
              cells: ["Cell 1", "Cell 2", "Cell 3"],
            },
            {
              cells: ["Cell 4", "Cell 5", "Cell 6"],
            },
          ],
        },
      },
    ]);

    // Place cursor inside a table cell
    editor.setTextCursorPosition("table-0", "start");

    // Verify the cursor is inside table content
    const $from = editor._tiptapEditor.state.selection.$from;
    expect($from.parent.type.isInGroup("tableContent")).toBe(true);

    // Verify we start with no active suggestion menu
    expect(getSuggestionPluginState(editor)).toBeUndefined();

    // Simulate typing "@" — no shouldTrigger filter, so it should still work
    const handled = simulateTextInput(editor, "@");

    // The input should be handled (menu opened)
    expect(handled).toBe(true);

    // Plugin state should now be defined
    const pluginState = getSuggestionPluginState(editor);
    expect(pluginState).toBeDefined();
    expect(pluginState.triggerCharacter).toBe("@");

    editor._tiptapEditor.destroy();
  });

  it("keeps the active typed session when another trigger is typed into its query", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "@" });

    expect(simulateTextInput(editor, "/")).toBe(true);
    expect(getSuggestionPluginState(editor)?.triggerCharacter).toBe("/");

    expect(simulateTextInput(editor, "@")).toBe(false);
    expect(getSuggestionPluginState(editor)?.triggerCharacter).toBe("/");

    editor._tiptapEditor.destroy();
  });

  it("atomically consumes the active query when a suggestion is accepted", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: ":" });

    expect(simulateTextInput(editor, ":")).toBe(true);
    editor.insertInlineContent("sm");
    expect(editor.prosemirrorState.doc.textContent).toBe(":sm");
    const transactionListener = vi.fn();
    editor._tiptapEditor.on("transaction", transactionListener);

    expect(suggestionMenu.acceptMenu()).toBe(true);

    expect(transactionListener).toHaveBeenCalledTimes(1);
    expect(editor.prosemirrorState.doc.textContent).toBe("");
    expect(getSuggestionPluginState(editor)).toBeUndefined();
    expect(suggestionMenu.getLastCloseReason()).toBe("accepted");
    editor._tiptapEditor.destroy();
  });

  it("accepts a tracked query in a collaborative editor", () => {
    const doc = new Y.Doc();
    const editor = BlockNoteEditor.create(
      withCollaboration({
        collaboration: {
          fragment: doc.getXmlFragment("doc"),
          user: { name: "Suggestion Test", color: "#ffffff" },
        },
      }),
    );
    editor.mount(document.createElement("div"));
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: ":" });

    expect(simulateTextInput(editor, ":")).toBe(true);
    editor.insertInlineContent("sm");

    expect(suggestionMenu.acceptMenu()).toBe(true);
    expect(editor.prosemirrorState.doc.textContent).toBe("");
    expect(suggestionMenu.getLastCloseReason()).toBe("accepted");

    editor._tiptapEditor.destroy();
    doc.destroy();
  });

  it("preserves preceding text when accepting a programmatic query", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "@" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "prefix " },
    ]);
    editor.setTextCursorPosition("paragraph-0", "end");

    suggestionMenu.openSuggestionMenu("@", { deleteTriggerCharacter: false });
    editor.insertInlineContent("query");

    expect(suggestionMenu.acceptMenu()).toBe(true);
    expect(editor.prosemirrorState.doc.textContent).toBe("prefix ");
    expect(suggestionMenu.getLastCloseReason()).toBe("accepted");

    editor._tiptapEditor.destroy();
  });

  it("closes an active session when the caret enters a code block", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "" },
      { id: "code-0", type: "codeBlock", content: "const value = 1" },
    ]);
    editor.setTextCursorPosition("paragraph-0", "start");
    expect(simulateTextInput(editor, "/")).toBe(true);

    editor.setTextCursorPosition("code-0", "end");

    expect(getSuggestionPluginState(editor)).toBeUndefined();
    expect(suggestionMenu.getLastCloseReason()).toBe("code-block");
    editor._tiptapEditor.destroy();
  });

  it("uses identity-safe registration cleanup", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    const disposeOld = suggestionMenu.addSuggestionMenu({
      triggerCharacter: "/",
      shouldOpen: () => false,
    });
    const disposeCurrent = suggestionMenu.addSuggestionMenu({
      triggerCharacter: "/",
      shouldOpen: () => true,
    });

    disposeOld();
    expect(simulateTextInput(editor, "/")).toBe(true);

    disposeCurrent();
    editor._tiptapEditor.destroy();
  });

  it("closes the active session when its controller unregisters", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    const dispose = suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });
    expect(simulateTextInput(editor, "/")).toBe(true);

    dispose();

    expect(getSuggestionPluginState(editor)).toBeUndefined();
    expect(suggestionMenu.getLastCloseReason()).toBe("controller-unmounted");
    editor._tiptapEditor.destroy();
  });

  it("inserts a programmatic trigger and its required separator atomically", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "@" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "abc" },
    ]);
    editor.setTextCursorPosition("paragraph-0", "end");

    suggestionMenu.openSuggestionMenu("@", {
      deleteTriggerCharacter: true,
      ensureLeadingSpace: true,
    });

    expect(editor._tiptapEditor.state.doc.textContent).toBe("abc @");
    expect(getSuggestionPluginState(editor)?.triggerCharacter).toBe("@");
    editor._tiptapEditor.destroy();
  });

  it("does not open a programmatic suggestion session inside code", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "@" });
    editor.replaceBlocks(editor.document, [
      { id: "code-0", type: "codeBlock", content: "abc" },
    ]);
    editor.setTextCursorPosition("code-0", "end");

    suggestionMenu.openSuggestionMenu("@", { deleteTriggerCharacter: true });

    expect(editor._tiptapEditor.state.doc.textContent).toBe("abc");
    expect(getSuggestionPluginState(editor)).toBeUndefined();
    editor._tiptapEditor.destroy();
  });

  it("closes when the selection expands", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });
    expect(simulateTextInput(editor, "/")).toBe(true);

    editor.transact((transaction) => {
      const { from } = transaction.selection;
      transaction.setSelection(TextSelection.create(transaction.doc, from - 1, from));
    });

    expect(getSuggestionPluginState(editor)).toBeUndefined();
    editor._tiptapEditor.destroy();
  });

  it("closes when the caret moves to another text block", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "" },
      { id: "paragraph-1", type: "paragraph", content: "next" },
    ]);
    editor.setTextCursorPosition("paragraph-0", "start");
    expect(simulateTextInput(editor, "/")).toBe(true);

    editor.setTextCursorPosition("paragraph-1", "start");

    expect(getSuggestionPluginState(editor)).toBeUndefined();
    editor._tiptapEditor.destroy();
  });

  it("recognizes a multi-character trigger from the preceding characters", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "[[" });
    editor.replaceBlocks(editor.document, [
      { id: "paragraph-0", type: "paragraph", content: "[" },
    ]);
    editor.setTextCursorPosition("paragraph-0", "end");

    expect(simulateTextInput(editor, "[")).toBe(true);
    expect(getSuggestionPluginState(editor)?.triggerCharacter).toBe("[[");
    editor._tiptapEditor.destroy();
  });

  it("projects IME composition as part of the active runtime session", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const editor = BlockNoteEditor.create();
    editor.mount(host);
    const view = editor.prosemirrorView;
    if (!view) throw new Error("Composition requires a mounted editor");
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });

    try {
      expect(simulateTextInput(editor, "/")).toBe(true);
      expect(suggestionMenu.getMenuState()?.isComposing).toBe(false);

      view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      expect(suggestionMenu.getMenuState()?.isComposing).toBe(true);

      view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      expect(suggestionMenu.getMenuState()?.isComposing).toBe(true);
      vi.runAllTimers();
      expect(suggestionMenu.getMenuState()?.isComposing).toBe(false);
    } finally {
      editor._tiptapEditor.destroy();
      host.remove();
      vi.useRealTimers();
    }
  });

  it("keeps IME composition local to the editor that owns the event", () => {
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);
    const firstEditor = BlockNoteEditor.create();
    const secondEditor = BlockNoteEditor.create();
    firstEditor.mount(firstHost);
    secondEditor.mount(secondHost);
    const secondView = secondEditor.prosemirrorView;
    if (!secondView) throw new Error("Composition requires a mounted editor");
    const firstMenu = firstEditor.getExtension(SuggestionMenu)!;
    firstMenu.addSuggestionMenu({ triggerCharacter: "/" });

    try {
      expect(simulateTextInput(firstEditor, "/")).toBe(true);
      secondView.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );

      expect(firstMenu.getMenuState()?.isComposing).toBe(false);
    } finally {
      firstEditor._tiptapEditor.destroy();
      secondEditor._tiptapEditor.destroy();
      firstHost.remove();
      secondHost.remove();
    }
  });

  it("closes idempotently and preserves the first committed close reason", () => {
    const editor = createEditor();
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    const dispose = suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });
    expect(simulateTextInput(editor, "/")).toBe(true);
    const transactionListener = vi.fn();
    editor._tiptapEditor.on("transaction", transactionListener);

    suggestionMenu.closeMenu("escape");
    suggestionMenu.closeMenu("outside");
    dispose();

    expect(transactionListener).toHaveBeenCalledTimes(1);
    expect(suggestionMenu.getLastCloseReason()).toBe("escape");
    expect(getSuggestionPluginState(editor)).toBeUndefined();
    editor._tiptapEditor.destroy();
  });

  it("lets Escape close a session even when no React popup is rendered", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = BlockNoteEditor.create();
    editor.mount(host);
    const view = editor.prosemirrorView;
    if (!view) throw new Error("Keyboard input requires a mounted editor");
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.addSuggestionMenu({ triggerCharacter: "/" });

    try {
      expect(simulateTextInput(editor, "/")).toBe(true);
      expect(suggestionMenu.shown()).toBe(true);

      const event = new KeyboardEvent("keydown", { key: "Escape" });
      const handled = view.someProp("handleKeyDown", (handler) =>
        handler(view, event),
      );

      expect(handled).toBe(true);
      expect(getSuggestionPluginState(editor)).toBeUndefined();
    } finally {
      editor._tiptapEditor.destroy();
      host.remove();
    }
  });
});
