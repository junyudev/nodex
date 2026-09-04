import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ClipboardOperationError } from "./platform/electron/ElectronClipboard";
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
  writeImage: (image: unknown) =>
    Effect.sync(() => {
      writeCalls.push(image as FakeImage);
    }),
});

describe("clipboard image writer", () => {
  it.effect("reports an asynchronous native write rejection as a controlled failure", () =>
    Effect.gen(function* () {
      const result = yield* writeImageToClipboard(
        "data:image/png;base64,aGVsbG8=",
        {
          ...imagePlatform([]),
          writeImage: () => Effect.fail(new ClipboardOperationError({ reason: "write_failed" })),
        },
        { resolveAssetPath: (name) => name },
      );
      expect(result).toEqual({ ok: false, message: "Could not copy image." });
    }),
  );
  it.effect("writes asset-backed image bytes to the native clipboard", () =>
    Effect.gen(function* () {
      const writeCalls: FakeImage[] = [];
      const result = yield* writeImageToClipboard(
        "nodex://assets/diagram.png",
        imagePlatform(writeCalls),
        {
          resolveAssetPath: (fileName) => `/tmp/${fileName}`,
          readFile: async (filePath) => Buffer.from(filePath),
        },
      );

      expect(result.ok).toBe(true);
      expect(writeCalls.length).toBe(1);
    }),
  );

  it.effect("writes absolute local file images to the native clipboard", () =>
    Effect.gen(function* () {
      const writeCalls: FakeImage[] = [];
      const result = yield* writeImageToClipboard(
        "/Users/me/image.png",
        imagePlatform(writeCalls),
        {
          readFile: async (filePath) => Buffer.from(filePath),
          resolveAssetPath: (fileName) => fileName,
        },
      );

      expect(result.ok).toBe(true);
      expect(writeCalls.length).toBe(1);
    }),
  );

  it.effect("fetches remote images and writes the decoded native image", () =>
    Effect.gen(function* () {
      const writeCalls: FakeImage[] = [];
      const result = yield* writeImageToClipboard(
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
    }),
  );

  it.effect("returns a decode error when the image format cannot be converted", () =>
    Effect.gen(function* () {
      const writeCalls: FakeImage[] = [];
      const result = yield* writeImageToClipboard(
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
    }),
  );

  it.effect("returns a copy failure for invalid image sources", () =>
    Effect.gen(function* () {
      const result = yield* writeImageToClipboard("relative/image.png", imagePlatform([]), {
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
    }),
  );
});
