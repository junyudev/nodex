import { describe, expect, test, vi } from "vite-plus/test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  captureNfmPasteTarget,
  clearNfmPasteTargets,
  createNfmPasteTargetPlugin,
} from "./nfm-paste-target";
import {
  markdownPlainText,
  writeMarkdown,
  type MarkdownBlock,
} from "../../../../shared/nodex-markdown";
import {
  NOTION_BLOCKS_MIME,
  extractNotionBlocksFromClipboardData,
  extractNotionBlocksFromPayload,
  insertMarkdownBlocksFromPaste,
} from "./notion-paste";
import {
  canMaterializePasteResourceItems,
  capturePasteResourceTarget,
  clipboardFilesFromDataTransfer,
  continueInlinePaste,
  createPastedTextUploadFile,
  derivePastedTextAttachmentName,
  insertBlocksAtPasteTarget,
  insertAttachmentsAtPasteTarget,
  normalizeClipboardFileDraftItems,
  shouldPromptForOversizedText,
} from "./paste-resource";
import { DEFAULT_PASTE_RESOURCE_SETTINGS } from "../../../lib/paste-resource-settings";
import { attachNodexClipboardFragment } from "../../../../shared/clipboard-paste";

describe("nfm paste target", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "blockGroup" },
      blockGroup: { content: "blockContainer+" },
      blockContainer: { group: "bnBlock", attrs: { id: { default: null } }, content: "paragraph" },
      paragraph: { content: "text*" },
      text: {},
    },
  });
  const block = (id: string, text: string) =>
    schema.node("blockContainer", { id }, schema.node("paragraph", null, schema.text(text)));
  const makeView = () => {
    const doc = schema.node(
      "doc",
      null,
      schema.node("blockGroup", null, [block("a", "hello"), block("b", "world")]),
    );
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 4, 6),
      plugins: [createNfmPasteTargetPlugin()],
    });
    return {
      isDestroyed: false,
      get state() {
        return state;
      },
      dispatch: (tr: Transaction) => {
        state = state.apply(tr);
      },
    };
  };

  describe("asynchronous paste targets", () => {
    test("unmounted editors have no usable paste target", () => {
      expect(captureNfmPasteTarget(undefined).restore()).toBe(false);
      expect(() => clearNfmPasteTargets(undefined)).not.toThrow();
    });
    test("maps the original range through edits without following a moved caret", () => {
      const view = makeView();
      const pending = captureNfmPasteTarget(view);
      view.dispatch(view.state.tr.insertText("prefix", 3));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 19)));
      expect(pending.restore()).toBe(true);
      expect(pending.restore()).toBe(false);
      expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
        "el",
      );
      view.dispatch(view.state.tr.insertText("PASTE"));
      expect(view.state.doc.textContent).toBe("prefixhPASTEloworld");
      pending.release();
      expect(pending.restore()).toBe(false);
    });
    test("refuses a deleted target even when another block can accept text", () => {
      const view = makeView();
      const pending = captureNfmPasteTarget(view);
      view.dispatch(view.state.tr.delete(1, 1 + view.state.doc.child(0).child(0).nodeSize));
      expect(pending.restore()).toBe(false);
      expect(view.state.doc.textContent).toBe("world");
    });
    test("invalidates pending operations when a retained view closes", () => {
      const view = makeView();
      const pending = captureNfmPasteTarget(view);
      clearNfmPasteTargets(view);
      expect(pending.restore()).toBe(false);
      const next = captureNfmPasteTarget(view);
      view.isDestroyed = true;
      expect(next.restore()).toBe(false);
      next.release();
    });
  });
});

describe("notion paste", () => {
  const payload = (roots: unknown[]) => ({ selection: { roots } });

  describe("Notion clipboard conversion", () => {
    test("keeps hierarchy, title styles and links directly in BlockNote JSON", () => {
      const blocks = extractNotionBlocksFromClipboardData({
        types: [NOTION_BLOCKS_MIME],
        getData: () =>
          JSON.stringify(
            payload([
              {
                id: "toggle",
                type: "toggle",
                title: [["Details", [["b"]]]],
                children: [
                  {
                    id: "child",
                    type: "text",
                    title: [["first\nsecond", [["a", "https://example.com"], ["_"]]]],
                    children: [],
                  },
                ],
              },
            ]),
          ),
      });
      expect(blocks?.[0]?.type).toBe("toggleListItem");
      expect(blocks?.[0]?.children?.[0]?.content).toEqual([
        {
          type: "link",
          href: "https://example.com",
          content: [{ type: "text", text: "first\nsecond", styles: { underline: true } }],
        },
      ]);
      expect(markdownPlainText(blocks ?? [])).toBe("Details first second");
    });
    test("keeps table headers, column order and widths", () => {
      const blocks = extractNotionBlocksFromPayload(
        payload([
          {
            id: "table",
            type: "table",
            format: {
              table_block_column_order: ["b", "a"],
              table_block_row_header: true,
              table_block_column_header: true,
              table_block_column_format: { b: { width: 180, color: "blue_background" } },
            },
            children: [
              {
                id: "row",
                type: "table_row",
                properties: { a: [["A"]], b: [["B"]] },
                children: [],
              },
              {
                id: "row-2",
                type: "table_row",
                properties: { a: [["2"]], b: [["1"]] },
                children: [],
              },
            ],
          },
        ]),
      );
      expect(blocks?.[0]?.content).toEqual({
        type: "tableContent",
        headerRows: 1,
        headerCols: 1,
        columnWidths: [180, undefined],
        rows: [
          {
            cells: [
              {
                type: "tableCell",
                props: { backgroundColor: "blue" },
                content: [{ type: "text", text: "B", styles: {} }],
              },
              { type: "tableCell", content: [{ type: "text", text: "A", styles: {} }] },
            ],
          },
          {
            cells: [
              {
                type: "tableCell",
                props: { backgroundColor: "blue" },
                content: [{ type: "text", text: "1", styles: {} }],
              },
              { type: "tableCell", content: [{ type: "text", text: "2", styles: {} }] },
            ],
          },
        ],
      });
      expect(writeMarkdown(blocks ?? [])).toContain(':::table{header="both" widths="180,auto"}');
    });
    test("rejects invalid clipboard data and lets structural authority intercept insertion", () => {
      expect(
        extractNotionBlocksFromClipboardData({ types: [NOTION_BLOCKS_MIME], getData: () => "{" }),
      ).toBeNull();
      const replaceBlocks = vi.fn();
      const editor = {
        getSelection: () => ({ blocks: [{ id: "selected", type: "paragraph" }] }),
        getTextCursorPosition: () => ({ block: { id: "cursor", type: "paragraph" } }),
        replaceBlocks,
        insertBlocks: vi.fn(),
      };
      expect(
        insertMarkdownBlocksFromPaste(editor, [{ type: "paragraph", content: [] }], {
          onBeforeReplaceBlocks: () => true,
        }),
      ).toBe(true);
      expect(replaceBlocks).not.toHaveBeenCalled();
      expect(insertMarkdownBlocksFromPaste(editor, [{ type: "paragraph", content: [] }])).toBe(
        true,
      );
      expect(replaceBlocks).toHaveBeenCalledWith(
        ["selected"],
        [{ type: "paragraph", content: [] }],
      );
    });
  });
});

describe("paste resource helpers", () => {
  test("reads screenshot clipboard images from DataTransfer items when files is empty", () => {
    const image = new File(["png"], "image.png", { type: "image/png" });

    expect(
      clipboardFilesFromDataTransfer({
        files: [],
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => image },
        ],
      }),
    ).toEqual([image]);
  });

  test("captures typed descendants when a resource paste would replace a parent", () => {
    const target = capturePasteResourceTarget({
      getSelection: () => ({
        blocks: [
          {
            id: "parent",
            type: "toggleListItem",
            children: [{ id: "page", type: "page", children: [] }],
          },
        ],
      }),
      getTextCursorPosition: () => ({
        block: { id: "parent", type: "toggleListItem", children: [] },
      }),
    });

    expect(target.selectedBlockTypes).toEqual(["toggleListItem", "page"]);
  });

  test("canMaterializePasteResourceItems rejects folders", () => {
    expect(canMaterializePasteResourceItems([{ kind: "file", name: "report.txt" }])).toBe(true);
    expect(canMaterializePasteResourceItems([{ kind: "folder", name: "Designs" }])).toBe(false);
    expect(
      canMaterializePasteResourceItems([
        { kind: "file", name: "report.txt" },
        { kind: "folder", name: "Designs" },
      ]),
    ).toBe(false);
  });

  test("shouldPromptForOversizedText gates on payload size and projected document size", () => {
    expect(shouldPromptForOversizedText("short", 0, DEFAULT_PASTE_RESOURCE_SETTINGS)).toBe(false);
    expect(
      shouldPromptForOversizedText("x".repeat(100_000), 0, DEFAULT_PASTE_RESOURCE_SETTINGS),
    ).toBe(true);
    expect(
      shouldPromptForOversizedText("x".repeat(10), 749_995, DEFAULT_PASTE_RESOURCE_SETTINGS),
    ).toBe(true);
    expect(shouldPromptForOversizedText("   ", 900_000)).toBe(false);
  });

  test("normalizeClipboardFileDraftItems marks pasted blobs as files without links", () => {
    const items = normalizeClipboardFileDraftItems([
      new File(["alpha"], "alpha.txt", { type: "text/plain" }),
      new File(["beta"], "", { type: "application/octet-stream" }),
    ]);

    expect(items.length).toBe(2);
    expect(items[0]?.kind).toBe("file");
    expect(items[0]?.name).toBe("alpha.txt");
    expect(items[0]?.bytes).toBe(5);
    expect(items[1]?.name).toBe("Untitled file");
    expect(items[1]?.path).toBe(undefined);
  });

  test("normalizeClipboardFileDraftItems keeps Electron-backed file paths when available", () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: {
          api: {
            invoke: async () => null,
            on: () => () => {},
            getPathInfoForFile: (file: File) =>
              file.name === "alpha.txt"
                ? { path: "/tmp/alpha.txt", kind: "file", name: "alpha.txt", bytes: 5 }
                : null,
          },
        },
      });

      const items = normalizeClipboardFileDraftItems([
        new File(["alpha"], "alpha.txt", { type: "text/plain" }),
        new File(["beta"], "beta.txt", { type: "text/plain" }),
      ]);

      expect(items[0]?.path).toBe("/tmp/alpha.txt");
      expect(items[1]?.path).toBe(undefined);
    } finally {
      if (!originalWindowDescriptor) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });

  test("normalizeClipboardFileDraftItems preserves folder kind from Electron path info", () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: {
          api: {
            invoke: async () => null,
            on: () => () => {},
            getPathInfoForFile: () => ({
              path: "/tmp/Designs",
              kind: "folder",
              name: "Designs",
            }),
          },
        },
      });

      const items = normalizeClipboardFileDraftItems([new File([""], "Designs", { type: "" })]);

      expect(items[0]?.kind).toBe("folder");
      expect(items[0]?.path).toBe("/tmp/Designs");
      expect(items[0]?.name).toBe("Designs");
      expect(items[0]?.bytes).toBe(undefined);
    } finally {
      if (!originalWindowDescriptor) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });

  test("derivePastedTextAttachmentName uses the first non-empty line", () => {
    expect(derivePastedTextAttachmentName("\n\n# Incident summary\nSecond line")).toBe(
      "# Incident summary",
    );
    expect(derivePastedTextAttachmentName("   \n   ")).toBe("Pasted text");
  });

  test("createPastedTextUploadFile keeps a .txt asset filename", () => {
    const file = createPastedTextUploadFile("# Incident summary\nBody");
    expect(file.name.endsWith(".txt")).toBe(true);
    expect(file.type.startsWith("text/plain")).toBe(true);
  });

  test("insertAttachmentsAtPasteTarget inserts inline content when the cursor supports it", () => {
    const calls: string[] = [];
    const editor = {
      insertInlineContent: (content: unknown[]) => {
        calls.push(JSON.stringify(content));
      },
      replaceBlocks: () => {
        calls.push("replace");
      },
      insertBlocks: () => {
        calls.push("insert");
      },
    };

    const inserted = insertAttachmentsAtPasteTarget(
      editor,
      {
        selectedBlockIds: [],
        currentBlockId: "block-1",
        canInsertInline: true,
        replaceCurrentEmptyParagraph: false,
      },
      [
        {
          type: "attachment",
          props: {
            kind: "file",
            mode: "link",
            source: "/tmp/report.txt",
            name: "report.txt",
          },
        },
      ],
    );

    expect(inserted).toBe(true);
    expect(calls[0]?.includes('"attachment"')).toBe(true);
  });

  test("insertAttachmentsAtPasteTarget falls back to a paragraph block when inline insertion is unavailable", () => {
    const calls: Array<{ blockIds: string[]; blocks: unknown[] }> = [];
    const editor = {
      document: [{ id: "block-1" }],
      insertInlineContent: () => {},
      replaceBlocks: (blockIds: string[], blocks: unknown[]) => {
        calls.push({ blockIds, blocks });
      },
      insertBlocks: () => {},
    };

    const inserted = insertAttachmentsAtPasteTarget(
      editor,
      {
        selectedBlockIds: ["block-1"],
        currentBlockId: "block-1",
        canInsertInline: false,
        replaceCurrentEmptyParagraph: true,
      },
      [
        {
          type: "attachment",
          props: {
            kind: "folder",
            mode: "materialized",
            source: "nodex://assets/demo.json",
            name: "demo",
          },
        },
      ],
    );

    expect(inserted).toBe(true);
    expect(calls.length).toBe(1);
    const paragraph = calls[0]?.blocks[0] as { type?: string; content?: unknown[] } | undefined;
    expect(paragraph?.type).toBe("paragraph");
    expect(Array.isArray(paragraph?.content)).toBe(true);
  });

  test("insertBlocksAtPasteTarget replaces the captured empty paragraph atomically", () => {
    const calls: Array<{ blockIds: string[]; blocks: unknown[] }> = [];
    const editor = {
      document: [{ id: "block-1" }],
      insertInlineContent: () => {},
      replaceBlocks: (blockIds: string[], blocks: unknown[]) => {
        calls.push({ blockIds, blocks });
      },
      insertBlocks: () => {},
    };
    const image = {
      id: "image-1",
      type: "image",
      props: { url: "nodex://files/file-1", name: "diagram.png" },
      children: [],
    };

    expect(
      insertBlocksAtPasteTarget(
        editor,
        {
          selectedBlockIds: [],
          currentBlockId: "block-1",
          canInsertInline: true,
          replaceCurrentEmptyParagraph: true,
        },
        [image],
      ),
    ).toBe(true);
    expect(calls).toEqual([{ blockIds: ["block-1"], blocks: [image] }]);
  });

  test("insertBlocksAtPasteTarget preserves the captured position after async upload", () => {
    const calls: Array<{
      blocks: unknown[];
      referenceBlockId: string;
      placement: "before" | "after";
    }> = [];
    const editor = {
      document: [{ id: "block-1" }, { id: "block-2" }],
      insertInlineContent: () => {},
      replaceBlocks: () => {},
      insertBlocks: (
        blocks: unknown[],
        referenceBlockId: string,
        placement: "before" | "after",
      ) => {
        calls.push({ blocks, referenceBlockId, placement });
      },
    };
    const image = {
      id: "image-1",
      type: "image",
      props: { url: "nodex://files/file-1", name: "diagram.png" },
      children: [],
    };

    expect(
      insertBlocksAtPasteTarget(
        editor,
        {
          selectedBlockIds: [],
          currentBlockId: "block-1",
          canInsertInline: true,
          replaceCurrentEmptyParagraph: false,
        },
        [image],
      ),
    ).toBe(true);
    expect(calls).toEqual([{ blocks: [image], referenceBlockId: "block-1", placement: "after" }]);
  });

  test("continueInlinePaste replays a held-back paste by the rules the paste follows", () => {
    const read: string[] = [];
    const pasted: { html: string; raw: boolean }[] = [];
    const editor = {
      blocksToFullHTML: (blocks: unknown) => {
        read.push(writeMarkdown(blocks as MarkdownBlock[]));
        return "";
      },
      pasteHTML: (html: string, raw = false) => {
        pasted.push({ html, raw });
      },
    };

    expect(continueInlinePaste(editor, { textPayload: "one\ntwo" })).toBe(true);
    expect(read).toEqual(["one\n\ntwo"]);
    expect(continueInlinePaste(editor, { textPayload: "# Plan\n- one" })).toBe(true);
    expect(read.at(-1)).toBe("# Plan\n\n- one");
    expect(continueInlinePaste(editor, { textPayload: "Plan", markdownPayload: "**Plan**" })).toBe(
      true,
    );
    expect(read.at(-1)).toBe("**Plan**");
    expect(pasted.every((paste) => paste.raw)).toBe(true);

    expect(
      continueInlinePaste(editor, {
        textPayload: "**bold**",
        htmlPayload: "<p><strong>bold</strong></p>",
      }),
    ).toBe(true);
    expect(pasted.at(-1)).toEqual({ html: "<p><strong>bold</strong></p>", raw: false });
    expect(read).toHaveLength(3);

    expect(
      continueInlinePaste(editor, {
        textPayload: "plain",
        blocknoteHtmlPayload: "<div data-blocknote>plain</div>",
      }),
    ).toBe(true);
    expect(pasted.at(-1)).toEqual({ html: "<div data-blocknote>plain</div>", raw: true });

    const internal = '<div data-pm-slice="0 0 -1 []"><p>Rich fragment</p></div>';
    expect(
      continueInlinePaste(editor, {
        textPayload: "**Portable Markdown**",
        htmlPayload: attachNodexClipboardFragment("<p>Portable presentation</p>", internal),
      }),
    ).toBe(true);
    expect(pasted.at(-1)).toEqual({ html: internal, raw: true });
    expect(read).toHaveLength(3);
  });
});
