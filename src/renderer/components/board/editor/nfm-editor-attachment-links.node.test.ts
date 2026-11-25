import { describe, expect, test } from "vite-plus/test";
import type { FilePreviewAuthority, FileReadAuthority } from "@/lib/library-file-resources";
import { describeAttachment, resolveAttachmentDestination } from "./attachment-reference";
import { copyImageToClipboardWithPort } from "./copy-image";
import { formatImageFileSize, resolveExternalImageSource } from "./image-block";
import {
  isSpaceShortcut,
  resolveImagePreviewByBlockId,
  resolveFocusedImagePreview,
  type ImageBlockLookupEditor,
  type ImageSelectionEditor,
} from "./image-preview-shortcut";
import { normalizeNfmEditorLinkUrl } from "./nfm-link-url";

describe("attachment reference", () => {
  const FILE_ID = "0199134e-cbb0-7000-8000-000000000006";
  const routingContext = { kind: "project", projectId: "project-1" } as const;
  const pageAuthority: FileReadAuthority = {
    contentRoutingContext: routingContext,
    storeEpoch: "store-1",
    libraryId: "library-1",
    readSource: { kind: "page", page_id: "page-1" },
  };
  const saved = {
    kind: "file",
    mode: "materialized",
    source: `nodex://files/${FILE_ID}`,
  } as const;

  describe("attachment destination", () => {
    test("opens a Library File beside its Page when the surface can open Page File tabs", () => {
      expect(
        resolveAttachmentDestination({
          attachment: saved,
          authority: pageAuthority,
          canOpenPageFile: true,
        }),
      ).toEqual({ kind: "page-file", routingContext, pageId: "page-1", fileId: FILE_ID });
    });

    test("keeps a captured or tab-less read in a viewer bound to the surface's authority", () => {
      const revision: FileReadAuthority = {
        ...pageAuthority,
        readSource: { kind: "document_revision", document_id: "document-1", revision_id: "r-1" },
      };
      const exactVersion: FileReadAuthority = { ...pageAuthority, version: 3 };
      const recovery: FilePreviewAuthority = {
        contentRoutingContext: routingContext,
        storeEpoch: "store-1",
        libraryId: "library-1",
        bindings: {},
      };
      for (const authority of [revision, exactVersion, recovery]) {
        expect(
          resolveAttachmentDestination({ attachment: saved, authority, canOpenPageFile: true }),
        ).toEqual({ kind: "file-viewer", authority, fileId: FILE_ID });
      }
      expect(
        resolveAttachmentDestination({
          attachment: saved,
          authority: pageAuthority,
          canOpenPageFile: false,
        }),
      ).toEqual({ kind: "file-viewer", authority: pageAuthority, fileId: FILE_ID });
    });

    test("cannot open a Library File without a read authority", () => {
      expect(
        resolveAttachmentDestination({ attachment: saved, authority: null, canOpenPageFile: true }),
      ).toEqual({ kind: "none" });
    });

    test("opens linked paths and older saved copies as local files", () => {
      expect(
        resolveAttachmentDestination({
          attachment: { kind: "folder", mode: "link", source: "/Users/me/Reports" },
          authority: pageAuthority,
          canOpenPageFile: true,
        }),
      ).toEqual({ kind: "local-path", path: "/Users/me/Reports", directory: true });
      expect(
        resolveAttachmentDestination({
          attachment: { kind: "text", mode: "materialized", source: "nodex://assets/notes.txt" },
          authority: null,
          canOpenPageFile: false,
        }),
      ).toEqual({ kind: "managed-asset", source: "nodex://assets/notes.txt", directory: false });
    });
  });

  describe("attachment summary", () => {
    test("names the File, then its format and size", () => {
      expect(
        describeAttachment({
          ...saved,
          name: "guide.md",
          mimeType: "text/markdown",
          bytes: 31_744,
        }),
      ).toEqual({ title: "guide.md", detail: "Markdown · 31 KB" });
      expect(
        describeAttachment({
          kind: "text",
          mode: "materialized",
          source: `nodex://files/${FILE_ID}`,
          name: "Incident timeline",
          bytes: 12,
        }),
      ).toEqual({ title: "Incident timeline", detail: "Text · 12 B" });
    });

    test("shows where a linked attachment points", () => {
      expect(
        describeAttachment({
          kind: "file",
          mode: "link",
          source: "/tmp/report.txt",
          name: "report.txt",
          bytes: 2048,
        }),
      ).toEqual({ title: "report.txt", detail: "/tmp/report.txt" });
    });
  });
});

describe("copy image helper", () => {
  test("passes the raw source through the clipboard image port", async () => {
    const invokeCalls: unknown[][] = [];
    const result = await copyImageToClipboardWithPort(
      "nodex://assets/diagram.png",
      async (source) => {
        invokeCalls.push([source]);
        return { ok: true };
      },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(invokeCalls)).toBe(JSON.stringify([["nodex://assets/diagram.png"]]));
  });

  test("returns the structured failure result from the native clipboard path", async () => {
    const result = await copyImageToClipboardWithPort(
      "https://example.com/image.png",
      async () => ({ ok: false, message: "Could not load the image file." }),
    );

    expect(result.ok).toBe(false);
    expect("message" in result ? result.message : "").toBe("Could not load the image file.");
  });

  test("normalizes unexpected invoke failures to a user-facing copy error", async () => {
    const result = await copyImageToClipboardWithPort("nodex://assets/diagram.png", async () => {
      throw new Error("boom");
    });

    expect(result.ok).toBe(false);
    expect("message" in result ? result.message : "").toBe("boom");
  });
});

describe("image block external source resolution", () => {
  test("resolves a canonical managed locator to app://fs", () => {
    const resolved = resolveExternalImageSource(
      "nodex://assets/plan.png",
      () => "/profile/assets/plan.png",
    );
    expect(resolved).toBe("app://fs/@fs/profile/assets/plan.png");
  });

  test("keeps standard URLs unchanged", () => {
    const source = "https://example.com/plan.png";
    expect(resolveExternalImageSource(source)).toBe(source);
  });

  test("formats image sizes like the compact file row", () => {
    expect(formatImageFileSize(10137)).toBe("9.9 KiB");
    expect(formatImageFileSize(512)).toBe("512 B");
    expect(formatImageFileSize(1024 * 1024)).toBe("1 MiB");
  });
});

describe("image preview shortcut", () => {
  function makeEditor(overrides: Partial<ImageSelectionEditor> = {}): ImageSelectionEditor {
    return {
      getSelection: () => undefined,
      getTextCursorPosition: () => ({
        block: { type: "paragraph", props: {} },
      }),
      ...overrides,
    };
  }

  function makeLookupEditor(
    overrides: Partial<ImageBlockLookupEditor> = {},
  ): ImageBlockLookupEditor {
    return {
      getBlock: () => undefined,
      ...overrides,
    };
  }

  describe("image preview shortcut helpers", () => {
    test("resolveFocusedImagePreview returns selected image block data", () => {
      const editor = makeEditor({
        getSelection: () => ({
          blocks: [
            { type: "image", props: { url: "https://example.com/a.png", caption: "diagram" } },
          ],
        }),
      });

      const result = resolveFocusedImagePreview(editor);
      expect(result?.source).toBe("https://example.com/a.png");
      expect(result?.alt).toBe("diagram");
    });

    test("resolveFocusedImagePreview falls back to text cursor block when selection is empty", () => {
      const editor = makeEditor({
        getTextCursorPosition: () => ({
          block: { type: "image", props: { url: "nodex://assets/a.png", name: "roadmap" } },
        }),
      });

      const result = resolveFocusedImagePreview(editor);
      expect(result?.source).toBe("nodex://assets/a.png");
      expect(result?.alt).toBe("roadmap");
    });

    test("resolveFocusedImagePreview returns null for invalid image selection", () => {
      const editor = makeEditor({
        getSelection: () => ({
          blocks: [
            { type: "image", props: { url: "" } },
            { type: "paragraph", props: {} },
          ],
        }),
      });

      expect(resolveFocusedImagePreview(editor)).toBe(null);
    });

    test("resolveImagePreviewByBlockId returns image data for clicked image block", () => {
      const editor = makeLookupEditor({
        getBlock: (id) =>
          id === "image-1"
            ? { type: "image", props: { url: "https://example.com/hero.png", name: "hero" } }
            : undefined,
      });

      const result = resolveImagePreviewByBlockId(editor, "image-1");
      expect(result?.source).toBe("https://example.com/hero.png");
      expect(result?.alt).toBe("hero");
    });

    test("resolveImagePreviewByBlockId returns null when block is not image", () => {
      const editor = makeLookupEditor({
        getBlock: () => ({ type: "paragraph", props: {} }),
      });

      expect(resolveImagePreviewByBlockId(editor, "p-1")).toBe(null);
    });

    test("isSpaceShortcut matches keyboard event variants for space", () => {
      expect(isSpaceShortcut({ key: " ", code: "Space" })).toBe(true);
      expect(isSpaceShortcut({ key: "Spacebar", code: "" })).toBe(true);
      expect(isSpaceShortcut({ key: "Enter", code: "Enter" })).toBe(false);
    });
  });
});

describe("normalizeNfmEditorLinkUrl", () => {
  test("preserves absolute local paths", () => {
    expect(normalizeNfmEditorLinkUrl("/Users/asc/repo/abc")).toBe("/Users/asc/repo/abc");
    expect(normalizeNfmEditorLinkUrl("C:\\repo\\abc")).toBe("C:\\repo\\abc");
  });

  test("preserves explicit urls and relative references", () => {
    expect(normalizeNfmEditorLinkUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeNfmEditorLinkUrl("mailto:test@example.com")).toBe("mailto:test@example.com");
    expect(normalizeNfmEditorLinkUrl("file:///Users/asc/repo/abc")).toBe(
      "file:///Users/asc/repo/abc",
    );
    expect(normalizeNfmEditorLinkUrl("./notes.md")).toBe("./notes.md");
    expect(normalizeNfmEditorLinkUrl("../notes.md")).toBe("../notes.md");
    expect(normalizeNfmEditorLinkUrl("#section")).toBe("#section");
    expect(normalizeNfmEditorLinkUrl("?tab=details")).toBe("?tab=details");
  });

  test("preserves protocol-less inputs exactly as entered", () => {
    expect(normalizeNfmEditorLinkUrl("example.com")).toBe("example.com");
    expect(normalizeNfmEditorLinkUrl("folder/abc/file")).toBe("folder/abc/file");
    expect(normalizeNfmEditorLinkUrl("www.example.com/docs")).toBe("www.example.com/docs");
  });

  test("trims surrounding whitespace only", () => {
    expect(normalizeNfmEditorLinkUrl("  folder/abc/file  ")).toBe("folder/abc/file");
    expect(normalizeNfmEditorLinkUrl("   ")).toBe("");
  });
});
