import { BlockNoteEditor } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import { TextSelection, EditorState } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Schema, type Node as ProsemirrorNode } from "@tiptap/pm/model";
import { EditorView } from "@tiptap/pm/view";
import {
  resolvePageMentionContextTarget,
  turnPageMentionIntoEmbed,
  type NfmPageMentionMenuEditor,
} from "./nfm-page-mention-context-target";

describe("nfm formatting toolbar gesture", () => {
  function selectText(editor: BlockNoteEditor, from = 1, to = 4) {
    editor.setTextCursorPosition("paragraph-0", "start");
    editor.transact((transaction) => {
      const start = transaction.selection.$from.start();
      transaction.setSelection(TextSelection.create(transaction.doc, start + from, start + to));
    });
    editor.focus();
  }

  function getEditorDom(editor: BlockNoteEditor): HTMLElement {
    const view = editor.prosemirrorView;
    if (!view) throw new Error("Expected the test editor to be mounted");
    return view.dom;
  }

  describe("NFM formatting-toolbar gesture ownership", () => {
    let editor: BlockNoteEditor;
    let host: HTMLDivElement;

    beforeEach(() => {
      host = document.createElement("div");
      document.body.append(host);
      editor = BlockNoteEditor.create({
        initialContent: [{ id: "paragraph-0", type: "paragraph", content: "hello" }],
      });
      editor.mount(host);
      selectText(editor);
    });

    afterEach(() => {
      editor._tiptapEditor.destroy();
      host.remove();
    });

    test("settles ordinary pointer completion and cancellation", () => {
      const store = editor.getExtension(FormattingToolbarExtension)!.store;
      const editorDom = getEditorDom(editor);

      editorDom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(store.state).toBe(false);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      expect(store.state).toBe(true);

      editorDom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
      expect(store.state).toBe(true);
    });

    test("stays hidden through drag cancellation and settles on drag end", () => {
      const store = editor.getExtension(FormattingToolbarExtension)!.store;
      const editorDom = getEditorDom(editor);
      editorDom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      editorDom.dispatchEvent(new Event("dragstart", { bubbles: true }));
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
      expect(store.state).toBe(false);

      editorDom.dispatchEvent(new Event("dragend", { bubbles: true }));

      expect(store.state).toBe(true);
    });

    test("ignores drag gestures owned by an unrelated surface", () => {
      const store = editor.getExtension(FormattingToolbarExtension)!.store;
      const unrelatedSurface = document.createElement("div");
      document.body.append(unrelatedSurface);

      try {
        unrelatedSurface.dispatchEvent(new Event("dragstart", { bubbles: true }));
        unrelatedSurface.dispatchEvent(new Event("dragend", { bubbles: true }));

        expect(store.state).toBe(true);
      } finally {
        unrelatedSurface.remove();
      }
    });

    test("window blur and editor unmount clear transient presentation", () => {
      const formattingToolbar = editor.getExtension(FormattingToolbarExtension)!;
      window.dispatchEvent(new Event("blur"));
      expect(formattingToolbar.store.state).toBe(false);

      editor.unmount();
      expect(formattingToolbar.store.state).toBe(false);
    });

    test("nested editor focus and gestures cannot reopen the ancestor toolbar", () => {
      const outerStore = editor.getExtension(FormattingToolbarExtension)!.store;
      expect(outerStore.state).toBe(true);

      const innerHost = document.createElement("div");
      getEditorDom(editor).append(innerHost);
      const innerEditor = BlockNoteEditor.create({
        initialContent: [{ id: "inner-0", type: "paragraph", content: "inner" }],
      });
      innerEditor.mount(innerHost);
      try {
        innerEditor.setTextCursorPosition("inner-0", "start");
        innerEditor.focus();
        expect(outerStore.state).toBe(false);

        const innerEditorDom = getEditorDom(innerEditor);
        innerEditorDom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        innerEditorDom.dispatchEvent(new Event("dragstart", { bubbles: true }));
        document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
        innerEditorDom.dispatchEvent(new Event("dragend", { bubbles: true }));
        expect(outerStore.state).toBe(false);
      } finally {
        innerEditor._tiptapEditor.destroy();
        innerHost.remove();
      }
    });
  });
});

describe("nfm page mention context target", () => {
  /** The slice of BlockNote's document shape the context target reads. */
  const schema = new Schema({
    nodes: {
      doc: { content: "blockGroup" },
      blockGroup: { content: "blockContainer+", toDOM: () => ["div", 0] },
      blockContainer: {
        attrs: { id: { default: "" } },
        content: "paragraph blockGroup?",
        toDOM: (node) => ["div", { "data-id": node.attrs.id }, 0],
      },
      paragraph: { content: "inline*", toDOM: () => ["p", 0] },
      text: { group: "inline" },
      pageMention: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { targetPageId: { default: "" } },
        // Like a React node view: the view owns an outer renderer element around BlockNote's wrapper.
        toDOM: () => [
          "span",
          { class: "react-renderer" },
          [
            "span",
            { "data-inline-content-type": "pageMention" },
            ["a", { "data-inline-reference-chip": "true" }, ["span", "Roadmap"]],
          ],
        ],
      },
    },
    marks: {},
  });

  const mention = (targetPageId = "page-b") => schema.node("pageMention", { targetPageId });
  const block = (id: string, content: ProsemirrorNode[]) =>
    schema.node("blockContainer", { id }, [schema.node("paragraph", null, content)]);

  const views: EditorView[] = [];

  function mountEditor(blocks: ProsemirrorNode[]) {
    const mount = document.createElement("div");
    mount.style.whiteSpace = "pre-wrap";
    document.body.append(mount);
    const view = new EditorView(
      { mount },
      {
        state: EditorState.create({
          schema,
          doc: schema.node("doc", null, [schema.node("blockGroup", null, blocks)]),
        }),
      },
    );
    views.push(view);
    return view;
  }

  /** Mirrors BlockNote's JSON for the paragraphs this test document holds. */
  function readBlock(view: EditorView, blockId: string) {
    let found: ReturnType<typeof toBlock> | undefined;
    function toBlock(node: ProsemirrorNode) {
      const paragraph = node.child(0);
      const content: unknown[] = [];
      paragraph.forEach((child) => {
        content.push(
          child.isText
            ? { type: "text", text: child.text, styles: {} }
            : { type: child.type.name, props: { ...child.attrs } },
        );
      });
      return { id: String(node.attrs.id), type: "paragraph", content, children: [] };
    }
    view.state.doc.descendants((node) => {
      if (node.type.name === "blockContainer" && node.attrs.id === blockId) found = toBlock(node);
      return found === undefined;
    });
    return found;
  }

  function editorFor(view: EditorView) {
    const updateBlock = vi.fn();
    const editor: NfmPageMentionMenuEditor = {
      prosemirrorView: view,
      getBlock: (blockId) => readBlock(view, blockId),
      updateBlock,
    };
    return { editor, updateBlock };
  }

  const chipIn = (view: EditorView, blockId: string) =>
    view.dom.querySelector(`[data-id="${blockId}"] [data-inline-reference-chip="true"] span`);

  afterEach(() => {
    for (const view of views.splice(0)) {
      view.destroy();
      view.dom.remove();
    }
  });

  describe("Page Mention context target", () => {
    test("reads the right-clicked mention from the document and offers an embed only on its own line", () => {
      const view = mountEditor([
        block("alone", [mention(), schema.text(" ")]),
        block("inline", [schema.text("See "), mention("page-c"), schema.text(" first")]),
      ]);
      const { editor } = editorFor(view);

      expect(resolvePageMentionContextTarget(editor, chipIn(view, "alone"))).toMatchObject({
        pageId: "page-b",
        blockId: "alone",
        embeddable: true,
      });
      expect(resolvePageMentionContextTarget(editor, chipIn(view, "inline"))).toMatchObject({
        pageId: "page-c",
        blockId: "inline",
        embeddable: false,
      });
      expect(
        resolvePageMentionContextTarget(editor, view.dom.querySelector('[data-id="inline"] p')),
      ).toBeNull();
    });

    test("leaves a mention inside another editor to that editor's menu", () => {
      const outer = mountEditor([block("outer", [schema.text("Outer")])]);
      const inner = mountEditor([block("inner", [mention()])]);
      outer.dom.append(inner.dom);

      expect(
        resolvePageMentionContextTarget(editorFor(outer).editor, chipIn(inner, "inner")),
      ).toBeNull();
    });

    test("turns the mention's Block into an embed of the same Page, unless the line changed", () => {
      const view = mountEditor([block("alone", [mention()])]);
      const { editor, updateBlock } = editorFor(view);
      const target = resolvePageMentionContextTarget(editor, chipIn(view, "alone"));
      if (!target) throw new Error("expected a mention target");

      expect(turnPageMentionIntoEmbed(editor, target)).toBe(true);
      expect(updateBlock).toHaveBeenCalledExactlyOnceWith("alone", {
        type: "pageRef",
        props: { targetBlockId: "page-b" },
      });

      updateBlock.mockClear();
      view.dispatch(view.state.tr.insertText("Notes ", 4));
      expect(turnPageMentionIntoEmbed(editor, target)).toBe(false);
      expect(updateBlock).not.toHaveBeenCalled();
    });
  });
});
