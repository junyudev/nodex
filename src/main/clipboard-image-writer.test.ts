import { describe, expect, test } from "vite-plus/test";
import { writeImageToClipboard } from "./clipboard-image-writer";

class FakeImage {
  constructor(private readonly empty: boolean) {}

  isEmpty(): boolean {
    return this.empty;
  }
}

const imagePlatform = (writeCalls: FakeImage[], empty = false) => ({
  createImageFromBuffer: () => new FakeImage(empty) as never,
  createImageFromDataUrl: () => new FakeImage(empty) as never,
  writeImage: (image: unknown) => {
    writeCalls.push(image as FakeImage);
  },
});

describe("clipboard image writer", () => {
  test("writes asset-backed image bytes to the native clipboard", async () => {
    const writeCalls: FakeImage[] = [];
    const result = await writeImageToClipboard(
      "nodex://assets/diagram.png",
      imagePlatform(writeCalls),
      {
        resolveAssetPath: (fileName) => `/tmp/${fileName}`,
        readFile: async (filePath) => Buffer.from(filePath),
      },
    );

    expect(result.ok).toBe(true);
    expect(writeCalls.length).toBe(1);
  });

  test("writes absolute local file images to the native clipboard", async () => {
    const writeCalls: FakeImage[] = [];
    const result = await writeImageToClipboard("/Users/me/image.png", imagePlatform(writeCalls), {
      readFile: async (filePath) => Buffer.from(filePath),
    });

    expect(result.ok).toBe(true);
    expect(writeCalls.length).toBe(1);
  });

  test("fetches remote images and writes the decoded native image", async () => {
    const writeCalls: FakeImage[] = [];
    const result = await writeImageToClipboard(
      "https://example.com/hero.png",
      imagePlatform(writeCalls),
      {
        fetchImpl: async () =>
          ({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          }) as Response,
        readFile: async () => Buffer.from("unused"),
        resolveAssetPath: (fileName) => fileName,
      },
    );

    expect(result.ok).toBe(true);
    expect(writeCalls.length).toBe(1);
  });

  test("returns a decode error when the image format cannot be converted", async () => {
    const writeCalls: FakeImage[] = [];
    const result = await writeImageToClipboard(
      "https://example.com/file.bin",
      imagePlatform(writeCalls, true),
      {
        fetchImpl: async () =>
          ({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          }) as Response,
        readFile: async () => Buffer.from("unused"),
        resolveAssetPath: (fileName) => fileName,
      },
    );

    expect(result.ok).toBe(false);
    expect("message" in result ? result.message : "").toBe(
      "Could not decode this image format for clipboard copy.",
    );
    expect(writeCalls.length).toBe(0);
  });

  test("returns a copy failure for invalid image sources", async () => {
    const result = await writeImageToClipboard("relative/image.png", imagePlatform([]), {
      readFile: async () => Buffer.from("unused"),
      fetchImpl: async () =>
        ({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        }) as Response,
      resolveAssetPath: (fileName) => fileName,
    });

    expect(result.ok).toBe(false);
    expect("message" in result ? result.message : "").toBe("Could not copy image.");
  });
});
