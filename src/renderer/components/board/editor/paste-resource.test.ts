import { describe, expect, test } from "vite-plus/test";

import {
  canMaterializePasteResourceItems,
  capturePasteResourceTarget,
  clipboardFilesFromDataTransfer,
  continueInlinePaste,
  createPastedTextUploadFile,
  derivePastedTextAttachmentName,
  insertBlocksAtPasteTarget,
  insertAttachmentsAtPasteTarget,
  looksLikeMarkdown,
  normalizeClipboardFileDraftItems,
  shouldPromptForOversizedText,
} from "./paste-resource";
import { DEFAULT_PASTE_RESOURCE_SETTINGS } from "../../../lib/paste-resource-settings";
import { attachNodexClipboardFragment } from "../../../../shared/clipboard-paste";

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

  test("detects Markdown tables with a linear delimiter scan", () => {
    expect(looksLikeMarkdown("| Name | Status |\n| --- | :---: |\n| Nodex | Ready |")).toBe(true);
    expect(looksLikeMarkdown(`|${"a|".repeat(100_000)}not-a-closed-row`)).toBe(false);
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

  test("continueInlinePaste replays html, markdown, and plain text using paste semantics", () => {
    const calls: string[] = [];
    const editor = {
      pasteHTML: (html: string, raw?: boolean) => {
        calls.push(raw ? `blocknote:${html}` : `html:${html}`);
      },
      pasteMarkdown: (markdown: string) => {
        calls.push(`md:${markdown}`);
      },
      pasteText: (text: string) => {
        calls.push(`text:${text}`);
        return true;
      },
    };

    expect(
      continueInlinePaste(editor, {
        textPayload: "**bold**",
        htmlPayload: "<p><strong>bold</strong></p>",
      }),
    ).toBe(true);
    expect(calls[0]).toBe("md:**bold**");

    expect(
      continueInlinePaste(editor, {
        textPayload: "plain",
        htmlPayload: "<p>plain</p>",
      }),
    ).toBe(true);
    expect(calls[1]).toBe("html:<p>plain</p>");

    expect(
      continueInlinePaste(editor, {
        textPayload: "plain",
        blocknoteHtmlPayload: "<div data-blocknote>plain</div>",
      }),
    ).toBe(true);
    expect(calls[2]).toBe("blocknote:<div data-blocknote>plain</div>");

    const internal = '<div data-pm-slice="0 0 -1 []"><p>Rich fragment</p></div>';
    expect(
      continueInlinePaste(editor, {
        textPayload: "**Portable Markdown**",
        htmlPayload: attachNodexClipboardFragment("<p>Portable presentation</p>", internal),
      }),
    ).toBe(true);
    expect(calls[3]).toBe(`blocknote:${internal}`);
  });
});
