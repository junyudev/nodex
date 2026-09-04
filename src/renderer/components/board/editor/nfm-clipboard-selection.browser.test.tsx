import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  getNodeById,
  MultipleNodeSelection,
  type CustomBlockConfig,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import type { Node } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { act, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  attachNodexClipboardFragment,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../../../../shared/clipboard-paste";
import { createNfmPasteHandler, NfmStructuredClipboardExtension } from "./nfm-editor-extensions";
import { nfmSchema } from "./nfm-schema";

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
  test("routes a clicked atomic image Block through structural cut", async () => {
    const onStructuralClipboard = vi.fn(() => true);
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        {
          id: "image",
          type: "image",
          props: {
            url: "nodex://files/01999999-9999-7999-8999-999999999999",
            caption: "Selected image",
            name: "selected.png",
            showPreview: true,
          },
        },
        { id: "outside", type: "paragraph", content: "Outside" },
      ],
      extensions: [NfmStructuredClipboardExtension({ onStructuralClipboard })],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      const view = requireView(editor);
      await act(async () => {
        const image = getNodeById("image", view.state.doc);
        if (!image) throw new Error("Missing image Block");
        view.dispatch(
          view.state.tr.setSelection(NodeSelection.create(view.state.doc, image.posBeforeNode + 1)),
        );
        editor.focus();
        await settleEditor();
      });

      const cut = await dispatchClipboardEvent(view, "cut");

      expect(cut.dispatched).toBe(false);
      expect(cut.data.getData(NODEX_STRUCTURAL_CLIPBOARD_MIME)).not.toBe("");
      expect(onStructuralClipboard).toHaveBeenCalledOnce();
      expect(onStructuralClipboard).toHaveBeenCalledWith(
        "cut",
        expect.objectContaining({ rootBlockIds: ["image"] }),
      );
      expect(editor.getBlock("image")).toBeDefined();
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("preserves nested Blocks around consecutive Images through copy and cut", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        {
          id: "parent",
          type: "paragraph",
          content: "Parent",
          children: [
            { id: "parent-child", type: "paragraph", content: "Parent child" },
            { id: "after-child", type: "paragraph", content: "After child" },
          ],
        },
        {
          id: "image-one",
          type: "image",
          props: {
            url: "data:image/png;base64,YQ==",
            caption: "First caption",
            name: "one.png",
            showPreview: true,
          },
        },
        {
          id: "image-two",
          type: "image",
          props: {
            url: "data:image/png;base64,Yg==",
            caption: "Second caption",
            name: "two.png",
            showPreview: true,
          },
        },
        {
          id: "after-root",
          type: "paragraph",
          content: "After root",
          children: [{ id: "after-root-child", type: "paragraph", content: "After root child" }],
        },
        { id: "tail", type: "paragraph", content: "Tail" },
      ],
      extensions: [NfmStructuredClipboardExtension()],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      const view = requireView(editor);
      await act(async () => {
        const parent = getNodeById("parent", view.state.doc);
        const imageTwo = getNodeById("image-two", view.state.doc);
        if (!parent || !imageTwo) throw new Error("Missing fixture range");
        view.dispatch(
          view.state.tr.setSelection(
            MultipleNodeSelection.create(
              view.state.doc,
              parent.posBeforeNode,
              imageTwo.posBeforeNode + imageTwo.node.nodeSize,
            ),
          ),
        );
        editor.focus();
        await settleEditor();
      });

      const copied = await dispatchClipboardEvent(view, "copy");
      const clipboardHtml = copied.data.getData("blocknote/html");
      const parsed = editor.tryParseHTMLToBlocks(clipboardHtml);

      expect(clipboardHtml).toContain('data-pm-slice="0 0 -1 []"');
      expect(parsed.map((block) => block.id)).toEqual(["parent", "image-one", "image-two"]);
      expect(parsed[0]?.children.map((block) => block.id)).toEqual(["parent-child", "after-child"]);

      const cut = await dispatchClipboardEvent(view, "cut");
      const cutHtml = cut.data.getData("blocknote/html");
      expect(cutHtml).toBe(clipboardHtml);
      expect(editor.getBlock("parent")).toBeUndefined();
      expect(editor.getBlock("image-one")).toBeUndefined();
      expect(editor.getBlock("image-two")).toBeUndefined();

      const target = BlockNoteEditor.create({
        schema: nfmSchema,
        initialContent: [
          {
            id: "target-root",
            type: "paragraph",
            content: "Target root",
            children: [{ id: "target-child", type: "paragraph", content: "Target child" }],
          },
        ],
      });
      const targetRendered = renderClipboardEditor(target);
      try {
        await act(settleEditor);
        await setTextSelection(target, "target-child", "Target child".length);
        await act(async () => {
          target.pasteHTML(cutHtml, true);
          await settleEditor();
        });

        const insertedRootParentId = target.getParentBlock("parent")?.id;
        expect(insertedRootParentId).toBe("target-root");
        expect(target.getParentBlock("parent-child")?.id).toBe("parent");
        expect(target.getParentBlock("after-child")?.id).toBe("parent");
        expect(target.getParentBlock("image-one")?.id).toBe(insertedRootParentId);
        expect(target.getParentBlock("image-two")?.id).toBe(insertedRootParentId);
      } finally {
        targetRendered.unmount();
        target._tiptapEditor.destroy();
      }
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test.each([
    { command: "copy", transport: "internal" },
    { command: "cut", transport: "internal" },
    { command: "copy", transport: "standard" },
    { command: "cut", transport: "standard" },
  ] as const)(
    "preserves nested Images and partial text boundaries through $command with $transport HTML",
    async ({ command, transport }) => {
      const editor = BlockNoteEditor.create({
        schema: nfmSchema,
        initialContent: [
          {
            id: "parent",
            type: "paragraph",
            content: "Parent",
            children: [
              { id: "child", type: "paragraph", content: "Child" },
              { id: "image-one", type: "image", props: { url: "https://example.com/one.png" } },
              { id: "image-two", type: "image", props: { url: "https://example.com/two.png" } },
              {
                id: "last-child",
                type: "paragraph",
                content: "Last child",
                children: [{ id: "grandchild", type: "paragraph", content: "Grandchild" }],
              },
            ],
          },
          { id: "tail", type: "paragraph", content: "Tail" },
        ],
        extensions: [NfmStructuredClipboardExtension()],
      });
      const target = BlockNoteEditor.create({
        schema: nfmSchema,
        initialContent: [{ id: "target", type: "paragraph", content: "BeforeAfter" }],
        pasteHandler: createNfmPasteHandler(),
      });
      const rendered = renderClipboardEditor(editor);
      const targetRendered = renderClipboardEditor(target);
      try {
        await act(settleEditor);
        const view = requireView(editor);
        await act(async () => {
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(
                view.state.doc,
                inlinePosition(view.state.doc, "parent", 2),
                inlinePosition(view.state.doc, "tail", 2),
              ),
            ),
          );
          editor.focus();
          await settleEditor();
        });
        const copied = await dispatchClipboardEvent(view, command);
        // Native standard-format rewrites and context-menu reads can lose Chromium's custom MIME.
        if (transport === "standard") copied.data.clearData("blocknote/html");
        await setTextSelection(target, "target", 6);
        await act(async () => {
          requireView(target).dom.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: copied.data,
            }),
          );
          await settleEditor();
        });
        expect(target.document.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
        expect(target.document[0]?.content).toEqual([
          { type: "text", text: "Beforerent", styles: {} },
        ]);
        expect(target.document[1]?.content).toEqual([
          { type: "text", text: "TaAfter", styles: {} },
        ]);
        expect(target.document[0]?.children.map((block) => block.type)).toEqual([
          "paragraph",
          "image",
          "image",
          "paragraph",
        ]);
        expect(target.document[0]?.children[3]?.children[0]?.content).toEqual([
          { type: "text", text: "Grandchild", styles: {} },
        ]);
        expect(editor.getBlock("image-one") !== undefined).toBe(command === "copy");
      } finally {
        targetRendered.unmount();
        rendered.unmount();
        target._tiptapEditor.destroy();
        editor._tiptapEditor.destroy();
      }
    },
  );

  test("keeps recovered rich fragments literal when pasted into a Code Block", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "code", type: "codeBlock", content: "Prefix " }],
      pasteHandler: createNfmPasteHandler(),
    });
    const rendered = renderClipboardEditor(editor);
    try {
      await act(settleEditor);
      await setTextSelection(editor, "code", 7);
      const data = new DataTransfer();
      data.setData(
        "text/html",
        attachNodexClipboardFragment(
          "<p>Formatted</p>",
          editor.blocksToClipboardHTML([{ type: "paragraph", content: "Formatted" }], {
            slice: "closed",
          }),
        ),
      );
      data.setData("text/plain", "**literal**\n\tchild");
      await act(async () => {
        requireView(editor).dom.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
        );
        await settleEditor();
      });
      expect(editor.document).toHaveLength(1);
      expect(editor.document[0]?.type).toBe("codeBlock");
      expect(editor.document[0]?.content).toEqual([
        { type: "text", text: "Prefix **literal**\n\tchild", styles: {} },
      ]);
    } finally {
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("does not start a structural copy without a standard portable presentation", async () => {
    const onStructuralClipboard = vi.fn(() => true);
    const onStructuralClipboardUnavailable = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writtenTypes: string[] = [];
    const editor = BlockNoteEditor.create({
      schema: clipboardSchema,
      initialContent: [{ id: "current", type: "paragraph", content: "Current" }],
      extensions: [
        NfmStructuredClipboardExtension({
          onStructuralClipboard,
          onStructuralClipboardUnavailable,
        }),
      ],
    });
    const rendered = renderClipboardEditor(editor);

    try {
      await act(settleEditor);
      await setTextSelection(editor, "current", 3);
      const clipboardData = {
        setData: (type: string) => {
          writtenTypes.push(type);
          if (type === "text/html" || type === "text/plain") {
            throw new Error("standard presentation unavailable");
          }
        },
      };
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboardData });

      await act(async () => {
        requireView(editor).dom.dispatchEvent(event);
        await settleEditor();
      });

      expect(event.defaultPrevented).toBe(true);
      expect(onStructuralClipboard).not.toHaveBeenCalled();
      expect(onStructuralClipboardUnavailable).toHaveBeenCalledOnce();
      expect(writtenTypes).not.toContain(NODEX_STRUCTURAL_CLIPBOARD_MIME);
    } finally {
      warn.mockRestore();
      rendered.unmount();
      editor._tiptapEditor.destroy();
    }
  });

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
      expect(copied.data.getData("blocknote/html")).toContain('data-pm-slice="0 0 -1 []"');
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
      expect(copied.data.getData("blocknote/html")).not.toContain("data-pm-slice");
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
    const onStructuralClipboard = vi.fn(() => true);
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
    const onStructuralClipboard = vi.fn(() => true);
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
