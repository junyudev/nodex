import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  activateSelectedMention,
  getAdjacentMentionTokenRange,
  getSelectedMentionTokenRange,
  mentionChipKeyboardNavigationExtension,
  selectAdjacentMention,
} from "./mention-chip-keyboard-navigation";
import { embeddedEditorSelectionContextAttributes } from "@/lib/editor-selection-presentation";
import { ownsNfmEditorEvent } from "./nfm-editor-event-owner";
import { readNfmLinkHrefAtElement } from "./nfm-link-element";
import { selectCurrentBlockContent } from "./select-block-shortcut";

describe("mention chip keyboard navigation", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph" },
      paragraph: {
        content: "inline*",
        group: "block",
        toDOM: () => ["p", 0],
      },
      text: { group: "inline" },
      pageMention: {
        group: "inline",
        inline: true,
        atom: true,
        selectable: false,
        toDOM: () => ["span", { "data-page-mention": "true" }],
      },
      threadMention: {
        group: "inline",
        inline: true,
        atom: true,
        selectable: false,
        toDOM: () => ["span", { "data-thread-mention": "true" }],
      },
      attachment: {
        group: "inline",
        inline: true,
        atom: true,
        selectable: false,
        toDOM: () => ["span", { "data-attachment": "true" }],
      },
    },
    marks: {},
  });

  type TokenType = "pageMention" | "threadMention" | "attachment";

  function createDocument(type: TokenType = "pageMention") {
    return schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("before"),
        schema.node(type),
        schema.text("after"),
      ]),
    ]);
  }

  function createView(state: EditorState, nodeDOM: Node) {
    return {
      state,
      dispatch: vi.fn(),
      nodeDOM: vi.fn(() => nodeDOM),
    } as unknown as EditorView & {
      dispatch: ReturnType<typeof vi.fn>;
    };
  }

  describe("mention chip keyboard navigation", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test.each(["pageMention", "threadMention", "attachment"] as const)(
      "selects the complete %s when ArrowLeft reaches its boundary",
      (type) => {
        const doc = createDocument(type);
        const state = EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 8),
        });

        expect(getAdjacentMentionTokenRange(state.selection, "left")).toEqual({
          from: 7,
          to: 8,
        });
        expect(getAdjacentMentionTokenRange(state.selection, "right")).toBeNull();

        const view = createView(state, document.createElement("span"));
        expect(selectAdjacentMention({ prosemirrorView: view }, "left")).toBe(true);

        const transaction = view.dispatch.mock.calls[0]?.[0];
        expect(transaction.selection.from).toBe(7);
        expect(transaction.selection.to).toBe(8);
        expect(transaction.selection.visible).toBe(false);
      },
    );

    test("selects a chat mention from the right boundary too", () => {
      const doc = createDocument("threadMention");
      const state = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 7),
      });
      const view = createView(state, document.createElement("span"));

      expect(selectAdjacentMention({ prosemirrorView: view }, "right")).toBe(true);
      const transaction = view.dispatch.mock.calls[0]?.[0];
      expect(transaction.selection.from).toBe(7);
      expect(transaction.selection.to).toBe(8);
      expect(transaction.selection.visible).toBe(false);
    });

    test("does not treat a text cursor or a partial range as a mention", () => {
      const doc = createDocument();
      const textCursor = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 6),
      });
      const partialRange = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 6, 8),
      });

      expect(getAdjacentMentionTokenRange(textCursor.selection, "left")).toBeNull();
      expect(getSelectedMentionTokenRange(textCursor)).toBeNull();
      expect(getSelectedMentionTokenRange(partialRange)).toBeNull();
    });

    test.each(["pageMention", "threadMention", "attachment"] as const)(
      "Enter activates the selected %s through its rendered action",
      (type) => {
        const doc = createDocument(type);
        const state = EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 7, 8),
        });
        const action =
          type === "pageMention" ? document.createElement("a") : document.createElement("button");
        action.dataset.inlineReferenceChip = "true";
        if (type === "pageMention") action.dataset.pageMentionInlineAnchor = "true";
        const click = vi.fn();
        action.addEventListener("click", click);
        const nodeViewRoot = document.createElement("span");
        nodeViewRoot.append(action);
        const view = createView(state, nodeViewRoot);

        expect(activateSelectedMention({ prosemirrorView: view })).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
      },
    );

    test("the ProseMirror key handler bridges ArrowLeft and chat Enter", () => {
      const doc = createDocument("threadMention");
      const state = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 8),
      });
      const button = document.createElement("button");
      button.dataset.inlineReferenceChip = "true";
      const click = vi.fn();
      button.addEventListener("click", click);
      const nodeViewRoot = document.createElement("span");
      nodeViewRoot.append(button);
      const view = createView(state, nodeViewRoot);
      const editor = {
        prosemirrorView: view,
      } as never;
      const extension = mentionChipKeyboardNavigationExtension()({ editor });
      const plugin = extension.prosemirrorPlugins?.[0];
      if (!plugin) throw new Error("Mention chip keyboard plugin is missing");

      const arrowLeft = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        cancelable: true,
      });
      expect(plugin.props.handleKeyDown?.call(plugin, view, arrowLeft)).toBe(true);
      const transaction = view.dispatch.mock.calls[0]?.[0];
      expect(transaction.selection.from).toBe(7);
      expect(transaction.selection.to).toBe(8);
      expect(transaction.selection.visible).toBe(false);

      const selectedView = createView(
        EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 7, 8),
        }),
        nodeViewRoot,
      );
      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
      });
      expect(plugin.props.handleKeyDown?.call(plugin, selectedView, enter)).toBe(true);
      expect(click).toHaveBeenCalledTimes(1);
    });

    test("the plugin paints the shared selected state without moving focus", () => {
      const doc = createDocument("threadMention");
      const state = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 7, 8),
      });
      const chip = document.createElement("button");
      chip.dataset.inlineReferenceChip = "true";
      const nodeViewRoot = document.createElement("span");
      nodeViewRoot.append(chip);
      const view = createView(state, nodeViewRoot);
      const editor = { prosemirrorView: view } as never;
      const extension = mentionChipKeyboardNavigationExtension()({ editor });
      const plugin = extension.prosemirrorPlugins?.[0];
      if (!plugin) throw new Error("Mention chip keyboard plugin is missing");

      const pluginView = plugin.spec.view?.(view);
      expect(chip.dataset.mentionTokenSelected).toBe("true");
      expect(chip.classList.contains("nodex-mention-token-selected")).toBe(true);

      pluginView?.destroy?.();
      expect(chip.dataset.mentionTokenSelected).toBeUndefined();
    });
  });
});

describe("nfm editor event owner", () => {
  afterEach(() => document.body.replaceChildren());

  test("only the deepest NFM owns history inside an embedded Page, including another embed", () => {
    const outer = document.createElement("div");
    outer.className = "nfm-editor";
    const boundary = document.createElement("section");
    for (const [name, value] of Object.entries(embeddedEditorSelectionContextAttributes)) {
      boundary.setAttribute(name, value);
    }
    const inner = document.createElement("div");
    inner.className = "nfm-editor";
    const paragraph = document.createElement("p");
    const title = document.createElement("div");
    title.setAttribute("data-embedded-surface-input", "page-title");
    const titleText = document.createElement("span");
    title.append(titleText);
    const nestedScene = boundary.cloneNode() as HTMLElement;
    const canvas = document.createElement("button");
    nestedScene.append(canvas);
    inner.append(paragraph, nestedScene);
    boundary.append(title, inner);
    outer.append(boundary);
    document.body.append(outer);

    const calls: string[] = [];
    for (const [element, label] of [
      [outer, "outer"],
      [inner, "inner"],
    ] as const) {
      element.addEventListener(
        "beforeinput",
        (event) => {
          if (!ownsNfmEditorEvent(element, event.target)) return;
          calls.push(label);
          event.preventDefault();
          event.stopPropagation();
        },
        true,
      );
    }
    const undo = () =>
      new InputEvent("beforeinput", {
        inputType: "historyUndo",
        bubbles: true,
        cancelable: true,
      });
    expect(paragraph.dispatchEvent(undo())).toBe(false);
    expect(calls).toEqual(["inner"]);
    expect(titleText.dispatchEvent(undo())).toBe(true);
    expect(canvas.dispatchEvent(undo())).toBe(true);
    expect(calls).toEqual(["inner"]);
  });
});

describe("readNfmLinkHrefAtElement", () => {
  test("reads the canonical Page href from the editor when the DOM href was cleared", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "");
    const posAtDOM = vi.fn(() => 12);
    const getLinkMarkAtPos = vi.fn(() => ({
      href: "nodex://pages/018f47b1-93e1-7a25-b58e-8d9018a460d3",
    }));

    expect(
      readNfmLinkHrefAtElement(
        {
          prosemirrorView: { posAtDOM },
          getLinkMarkAtPos,
        },
        anchor,
      ),
    ).toBe("nodex://pages/018f47b1-93e1-7a25-b58e-8d9018a460d3");
    expect(posAtDOM).toHaveBeenCalledWith(anchor, 0);
    expect(getLinkMarkAtPos).toHaveBeenCalledWith(13);
  });

  test("falls back to the rendered href when no editor mark is present", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://example.com/docs");

    expect(
      readNfmLinkHrefAtElement(
        {
          prosemirrorView: { posAtDOM: () => 4 },
          getLinkMarkAtPos: () => undefined,
        },
        anchor,
      ),
    ).toBe("https://example.com/docs");
  });
});

describe("select block shortcut DOM behavior", () => {
  test("treats a nested editable title as the current leaf of a non-inline block", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<div class="bn-block" data-id="page-1">',
      '<div data-editor-select-all-scope="leaf"><span>Nested Page</span></div>',
      "</div>",
    ].join("");
    document.body.append(root);
    const title = root.querySelector<HTMLElement>("[data-editor-select-all-scope='leaf']");
    const text = title?.querySelector("span")?.firstChild;
    if (!title || !(text instanceof Text)) throw new TypeError("Missing title fixture");
    const selection = document.getSelection();
    selection?.setBaseAndExtent(text, 3, text, 3);
    const editor = {
      domElement: root,
      schema: { blockSchema: { page: { content: "none" } } },
      getTextCursorPosition: () => ({ block: { id: "page-1", type: "page" } }),
    };

    expect(selectCurrentBlockContent(editor, selection)).toBe(true);
    expect(selection?.toString()).toBe("Nested Page");
    root.remove();
  });
});
