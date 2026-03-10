import { describe, expect, test } from "bun:test";

import {
  canMaterializePasteResourceItems,
  continueInlinePaste,
  createPastedTextUploadFile,
  derivePastedTextAttachmentName,
  insertAttachmentsAtPasteTarget,
  normalizeClipboardFileDraftItems,
  shouldPromptForOversizedText,
} from "./paste-resource";
import { DEFAULT_PASTE_RESOURCE_SETTINGS } from "../../../lib/paste-resource-settings";

describe("paste resource helpers", () => {
  test("canMaterializePasteResourceItems rejects folders", () => {
    expect(canMaterializePasteResourceItems([{ kind: "file", name: "report.txt" }])).toBeTrue();
    expect(canMaterializePasteResourceItems([{ kind: "folder", name: "Designs" }])).toBeFalse();
    expect(canMaterializePasteResourceItems([
      { kind: "file", name: "report.txt" },
      { kind: "folder", name: "Designs" },
    ])).toBeFalse();
  });

  test("shouldPromptForOversizedText gates on payload size and projected document size", () => {
    expect(shouldPromptForOversizedText("short", 0, DEFAULT_PASTE_RESOURCE_SETTINGS)).toBeFalse();
    expect(shouldPromptForOversizedText("x".repeat(100_000), 0, DEFAULT_PASTE_RESOURCE_SETTINGS)).toBeTrue();
    expect(shouldPromptForOversizedText("x".repeat(10), 749_995, DEFAULT_PASTE_RESOURCE_SETTINGS)).toBeTrue();
    expect(shouldPromptForOversizedText("   ", 900_000)).toBeFalse();
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
            getPathInfoForFile: (file: File) => file.name === "alpha.txt"
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

      const items = normalizeClipboardFileDraftItems([
        new File([""], "Designs", { type: "" }),
      ]);

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
    expect(derivePastedTextAttachmentName("\n\n# Incident summary\nSecond line")).toBe("# Incident summary");
    expect(derivePastedTextAttachmentName("   \n   ")).toBe("Pasted text");
  });

  test("createPastedTextUploadFile keeps a .txt asset filename", () => {
    const file = createPastedTextUploadFile("# Incident summary\nBody");
    expect(file.name.endsWith(".txt")).toBeTrue();
    expect(file.type.startsWith("text/plain")).toBeTrue();
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

    const inserted = insertAttachmentsAtPasteTarget(editor, {
      selectedBlockIds: [],
      currentBlockId: "block-1",
      canInsertInline: true,
      replaceCurrentEmptyParagraph: false,
    }, [
      {
        type: "attachment",
        props: {
          kind: "file",
          mode: "link",
          source: "/tmp/report.txt",
          name: "report.txt",
        },
      },
    ]);

    expect(inserted).toBeTrue();
    expect(calls[0]?.includes("\"attachment\"")).toBeTrue();
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

    const inserted = insertAttachmentsAtPasteTarget(editor, {
      selectedBlockIds: ["block-1"],
      currentBlockId: "block-1",
      canInsertInline: false,
      replaceCurrentEmptyParagraph: true,
    }, [
      {
        type: "attachment",
        props: {
          kind: "folder",
          mode: "materialized",
          source: "nodex://assets/demo.json",
          name: "demo",
        },
      },
    ]);

    expect(inserted).toBeTrue();
    expect(calls.length).toBe(1);
    const paragraph = calls[0]?.blocks[0] as { type?: string; content?: unknown[] } | undefined;
    expect(paragraph?.type).toBe("paragraph");
    expect(Array.isArray(paragraph?.content)).toBeTrue();
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

    expect(continueInlinePaste(editor, {
      textPayload: "**bold**",
      htmlPayload: "<p><strong>bold</strong></p>",
    })).toBeTrue();
    expect(calls[0]).toBe("md:**bold**");

    expect(continueInlinePaste(editor, {
      textPayload: "plain",
      htmlPayload: "<p>plain</p>",
    })).toBeTrue();
    expect(calls[1]).toBe("html:<p>plain</p>");

    expect(continueInlinePaste(editor, {
      textPayload: "plain",
      blocknoteHtmlPayload: "<div data-blocknote>plain</div>",
    })).toBeTrue();
    expect(calls[2]).toBe("blocknote:<div data-blocknote>plain</div>");
  });
});
