import { describe, expect, test } from "bun:test";
import {
  isSpaceShortcut,
  resolveImagePreviewByBlockId,
  resolveFocusedImagePreview,
  type ImageBlockLookupEditor,
  type ImageSelectionEditor,
} from "./image-preview-shortcut";

function makeEditor(overrides: Partial<ImageSelectionEditor> = {}): ImageSelectionEditor {
  return {
    getSelection: () => undefined,
    getTextCursorPosition: () => ({
      block: { type: "paragraph", props: {} },
    }),
    ...overrides,
  };
}

function makeLookupEditor(overrides: Partial<ImageBlockLookupEditor> = {}): ImageBlockLookupEditor {
  return {
    getBlock: () => undefined,
    ...overrides,
  };
}

describe("image preview shortcut helpers", () => {
  test("resolveFocusedImagePreview returns selected image block data", () => {
    const editor = makeEditor({
      getSelection: () => ({
        blocks: [{ type: "image", props: { url: "https://example.com/a.png", caption: "diagram" } }],
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
        blocks: [{ type: "image", props: { url: "" } }, { type: "paragraph", props: {} }],
      }),
    });

    expect(resolveFocusedImagePreview(editor)).toBe(null);
  });

  test("resolveImagePreviewByBlockId returns image data for clicked image block", () => {
    const editor = makeLookupEditor({
      getBlock: (id) => (id === "image-1"
        ? { type: "image", props: { url: "https://example.com/hero.png", name: "hero" } }
        : undefined),
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
    expect(isSpaceShortcut({ key: " ", code: "Space" })).toBeTrue();
    expect(isSpaceShortcut({ key: "Spacebar", code: "" })).toBeTrue();
    expect(isSpaceShortcut({ key: "Enter", code: "Enter" })).toBeFalse();
  });
});
