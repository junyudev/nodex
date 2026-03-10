import { describe, expect, test } from "bun:test";

import { copyImageToClipboard, resolveImageCopyUrl } from "./copy-image";

const BASE_HREF = "http://localhost:51284/editor";

class FakeClipboardItem {
  static supports(mimeType: string): boolean {
    return mimeType === "image/png";
  }

  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

describe("copy image helpers", () => {
  test("resolveImageCopyUrl resolves source with resolver and normalizes to absolute URL", async () => {
    const resolvedUrl = await resolveImageCopyUrl("nodex://assets/a.png", {
      resolveFileUrl: async () => "/api/assets/a.png",
      baseHref: BASE_HREF,
    });

    expect(resolvedUrl).toBe("http://localhost:51284/api/assets/a.png");
  });

  test("copyImageToClipboard writes image bytes when clipboard image write is supported", async () => {
    const writes: ClipboardItem[][] = [];
    const clipboard = {
      write: async (items: ClipboardItem[]) => {
        writes.push(items);
      },
    };

    const mode = await copyImageToClipboard({
      source: "http://localhost:51283/api/assets/a.png",
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          blob: async () => new Blob(["png"], { type: "image/png" }),
        }) as Response,
      clipboard,
      clipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
      baseHref: BASE_HREF,
    });

    expect(mode).toBe("image");
    expect(writes.length).toBe(1);
    const firstWrite = writes[0][0] as unknown as FakeClipboardItem;
    expect(firstWrite.items["image/png"] instanceof Blob).toBeTrue();
  });

  test("copyImageToClipboard falls back to URL text when image mime is not supported", async () => {
    const writtenTexts: string[] = [];
    const clipboard = {
      write: async () => {
        throw new Error("should not use image write path");
      },
      writeText: async (text: string) => {
        writtenTexts.push(text);
      },
    };

    const mode = await copyImageToClipboard({
      source: "/api/assets/a.webp",
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          blob: async () => new Blob(["webp"], { type: "image/webp" }),
        }) as Response,
      clipboard,
      clipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
      baseHref: BASE_HREF,
    });

    expect(mode).toBe("url");
    expect(writtenTexts.length).toBe(1);
    expect(writtenTexts[0]).toBe("http://localhost:51284/api/assets/a.webp");
  });
});
