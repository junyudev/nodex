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
  },
  marks: {},
});

function createDocument(type: "pageMention" | "threadMention" = "pageMention") {
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

  test.each(["pageMention", "threadMention"] as const)(
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

  test.each(["pageMention", "threadMention"] as const)(
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
      if (type === "pageMention") {
        action.dataset.pageMentionInlineAnchor = "true";
      } else {
        action.dataset.mentionInlineChip = "true";
      }
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
    button.dataset.mentionInlineChip = "true";
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
    chip.dataset.mentionInlineChip = "true";
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
