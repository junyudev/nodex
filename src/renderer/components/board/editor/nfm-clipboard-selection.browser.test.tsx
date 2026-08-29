import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  type CustomBlockConfig,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import type { Node } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { act, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { NfmStructuredClipboardExtension } from "./nfm-editor-extensions";

const typedOwnerConfig = {
  type: "page",
  propSchema: {},
  content: "none",
} as const satisfies CustomBlockConfig;

const typedOwnerSpec = createReactBlockSpec(typedOwnerConfig, {
  render: () => <section>Nested Page</section>,
});

const clipboardSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    divider: defaultBlockSpecs.divider,
    page: typedOwnerSpec(),
  },
});

const settleEditor = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

type AnyBlockNoteEditor = BlockNoteEditor<any, any, any>;

function requireView(editor: AnyBlockNoteEditor): EditorView {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");
  return view;
}

function inlinePosition(doc: Node, blockId: string, offset: number): number {
  let position: number | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer" || node.attrs.id !== blockId) return true;
    position = pos + 2 + offset;
    return false;
  });
  if (position === undefined) throw new Error(`Missing fixture Block ${blockId}`);
  return position;
}

async function setTextSelection(
  editor: AnyBlockNoteEditor,
  blockId: string,
  anchorOffset: number,
  headOffset = anchorOffset,
): Promise<void> {
  const view = requireView(editor);
  await act(async () => {
    const doc = view.state.doc;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(
          doc,
          inlinePosition(doc, blockId, anchorOffset),
          inlinePosition(doc, blockId, headOffset),
        ),
      ),
    );
    editor.focus();
    await settleEditor();
  });
}

async function dispatchClipboardEvent(
  view: EditorView,
  type: "copy" | "cut",
  target: HTMLElement = view.dom,
): Promise<{ readonly data: DataTransfer; readonly dispatched: boolean }> {
  const data = new DataTransfer();
  const event = new ClipboardEvent(type, {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  let dispatched = true;
  await act(async () => {
    dispatched = target.dispatchEvent(event);
    await settleEditor();
  });
  return { data, dispatched };
}

function renderClipboardEditor(editor: AnyBlockNoteEditor) {
  return render(
    <BlockNoteView
      editor={editor}
      formattingToolbar={false}
      linkToolbar={false}
      slashMenu={false}
      sideMenu={false}
      tableHandles={false}
    />,
  );
}

describe("current Block clipboard behavior in Chromium", () => {
  test("copies the complete current Block subtree while preserving a collapsed caret", async () => {
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        {
          id: "current",
          type: "paragraph",
          content: "Current",
          children: [{ id: "child", type: "paragraph", content: "Child" }],
        },
        { id: "outside", type: "paragraph", content: "Outside" },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 3);
      const selectionBefore = editor.prosemirrorState.selection;

      const copied = await dispatchClipboardEvent(requireView(editor), "copy");

      expect(copied.dispatched).toBe(false);
      expect(copied.data.getData("text/plain")).toBe("Current\n\tChild");
      expect(copied.data.getData("text/html")).toContain("Current");
      expect(copied.data.getData("text/html")).toContain("Child");
      expect(copied.data.getData("text/html")).not.toContain("Outside");
      expect(copied.data.getData("blocknote/html")).toContain("Current");
      expect(copied.data.getData("blocknote/html")).toContain("Child");
      expect(editor.prosemirrorState.selection.empty).toBe(true);
      expect(editor.prosemirrorState.selection.from).toBe(selectionBefore.from);
      expect(editor.prosemirrorState.selection.to).toBe(selectionBefore.to);
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("keeps a non-empty text range authoritative over the current Block", async () => {
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        {
          id: "current",
          type: "paragraph",
          content: "Current",
          children: [{ id: "child", type: "paragraph", content: "Child" }],
        },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 1, 4);

      const copied = await dispatchClipboardEvent(requireView(editor), "copy");

      expect(copied.dispatched).toBe(false);
      expect(copied.data.getData("text/plain")).toBe("urr");
      expect(copied.data.getData("text/html")).not.toContain("Child");
      expect(editor.prosemirrorState.selection.empty).toBe(false);
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("treats an empty current Block as a real copy and cut target", async () => {
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        { id: "before-atomic", type: "divider" },
        { id: "empty", type: "paragraph", content: "" },
        { id: "outside", type: "paragraph", content: "Outside" },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "empty", 0);

      const copied = await dispatchClipboardEvent(requireView(editor), "copy");
      expect(copied.dispatched).toBe(false);
      expect(copied.data.getData("blocknote/html")).not.toBe("");
      expect(copied.data.getData("text/plain")).toBe("");
      expect(editor.getBlock("empty")).toBeDefined();

      const cut = await dispatchClipboardEvent(requireView(editor), "cut");
      expect(cut.dispatched).toBe(false);
      expect(cut.data.getData("blocknote/html")).not.toBe("");
      expect(editor.getBlock("empty")).toBeUndefined();
      expect(editor.document.map((block) => block.id)).toEqual(["before-atomic", "outside"]);
      expect(editor.getTextCursorPosition().block.id).toBe("outside");
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("cuts the current Block subtree and restores it in one undo step", async () => {
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        { id: "before", type: "paragraph", content: "Before" },
        {
          id: "current",
          type: "paragraph",
          content: "Current",
          children: [{ id: "child", type: "paragraph", content: "Child" }],
        },
        { id: "outside", type: "paragraph", content: "Outside" },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 3);

      const cut = await dispatchClipboardEvent(requireView(editor), "cut");

      expect(cut.dispatched).toBe(false);
      expect(cut.data.getData("text/plain")).toBe("Current\n\tChild");
      expect(editor.getBlock("current")).toBeUndefined();
      expect(editor.getBlock("child")).toBeUndefined();
      expect(editor.document.map((block) => block.id)).toEqual(["before", "outside"]);
      expect(editor.getTextCursorPosition().block.id).toBe("before");
      expect(editor.prosemirrorState.selection.$from.parentOffset).toBe("Before".length);

      await act(async () => {
        expect(editor.undo()).toBe(true);
        await settleEditor();
      });
      expect(editor.document.map((block) => block.id)).toEqual(["before", "current", "outside"]);
      expect(editor.getBlock("child")).toBeDefined();
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("leaves one editable paragraph when cutting the only root Block", async () => {
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        {
          id: "only",
          type: "paragraph",
          content: "Only",
          children: [{ id: "child", type: "paragraph", content: "Child" }],
        },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "only", 2);

      const cut = await dispatchClipboardEvent(requireView(editor), "cut");

      expect(cut.dispatched).toBe(false);
      expect(editor.getBlock("only")).toBeUndefined();
      expect(editor.getBlock("child")).toBeUndefined();
      expect(editor.document).toHaveLength(1);
      expect(editor.document[0]?.type).toBe("paragraph");
      expect(editor.document[0]?.content).toEqual([]);
      expect(editor.prosemirrorState.selection.empty).toBe(true);

      await act(async () => {
        expect(editor.undo()).toBe(true);
        await settleEditor();
      });
      expect(editor.document.map((block) => block.id)).toEqual(["only"]);
      expect(editor.getBlock("child")).toBeDefined();
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("does not replace native clipboard behavior inside a non-editable island", async () => {
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        { id: "current", type: "paragraph", content: "Current" },
        { id: "divider", type: "divider" },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 3);
      const divider = rendered.container.querySelector<HTMLElement>(
        '.bn-block-content[data-content-type="divider"]',
      );
      if (!divider) throw new Error("Expected divider NodeView");
      expect(divider.closest('[contenteditable="false"]')).not.toBeNull();

      const copied = await dispatchClipboardEvent(requireView(editor), "copy", divider);

      expect(copied.dispatched).toBe(true);
      expect([...copied.data.types]).toEqual([]);
      expect(editor.prosemirrorState.selection.empty).toBe(true);
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("routes a current Block with an owning descendant through structural capture", async () => {
    const onStructuralClipboard = vi.fn(() => "0199134e-cbb0-7000-8000-000000000006");
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        {
          id: "current",
          type: "paragraph",
          content: "Current",
          children: [{ id: "page", type: "page" }],
        },
      ],
      extensions: [NfmStructuredClipboardExtension({ onStructuralClipboard })],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 3);

      const copied = await dispatchClipboardEvent(requireView(editor), "copy");

      expect(copied.dispatched).toBe(false);
      expect(onStructuralClipboard).toHaveBeenCalledOnce();
      expect(onStructuralClipboard).toHaveBeenCalledWith(
        "copy",
        expect.objectContaining({
          rootBlockIds: ["current"],
          presentation: expect.objectContaining({ text: expect.stringContaining("Current") }),
        }),
      );
      expect(editor.getBlock("current")).toBeDefined();
      expect(editor.getBlock("page")).toBeDefined();
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("routes an ordinary current Block subtree through the same structural capture", async () => {
    const onStructuralClipboard = vi.fn(() => "0199134e-cbb0-7000-8000-000000000006");
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [
        {
          id: "current",
          type: "paragraph",
          content: "Current",
          children: [{ id: "child", type: "paragraph", content: "Child" }],
        },
        { id: "outside", type: "paragraph", content: "Outside" },
      ],
      extensions: [NfmStructuredClipboardExtension({ onStructuralClipboard })],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 3);

      const cut = await dispatchClipboardEvent(requireView(editor), "cut");

      expect(cut.dispatched).toBe(false);
      expect(onStructuralClipboard).toHaveBeenCalledWith(
        "cut",
        expect.objectContaining({
          rootBlockIds: ["current"],
          presentation: expect.objectContaining({ text: "Current\n\tChild" }),
        }),
      );
      expect(editor.getBlock("current")).toBeDefined();
      expect(editor.getBlock("child")).toBeDefined();
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });
});
