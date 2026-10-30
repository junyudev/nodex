import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { fitWithImageCodec, type EncodableImage, type FitPromptImage } from "./AgentImageFitting";
import { prepareNativePromptImages } from "./NativePromptImages";

const MB = 1024 * 1024;
const unused: FitPromptImage = () => {
  throw new Error("not called");
};

it("prepares explicitly attached owned media and local files without network reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-native-images-"));
  try {
    const file = path.join(root, "image.png");
    await writeFile(file, Buffer.from([137, 80, 78, 71]));
    const result = await prepareNativePromptImages(
      [{ source: file }, { source: "nodex://assets/owned.jpg" }],
      () => ({ mimeType: "image/jpeg", bytes: Uint8Array.from([255, 216, 255]) }),
      unused,
    );
    expect(result).toEqual([
      { mediaType: "image/png", data: "iVBORw==" },
      { mediaType: "image/jpeg", data: "/9j/" },
    ]);
    await expect(
      prepareNativePromptImages(
        [{ source: "https://example.com/image.png" }],
        () => {
          throw new Error("not called");
        },
        unused,
      ),
    ).rejects.toThrow("local image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fits only the images over their share of what one message carries", async () => {
  const read = () => ({ mimeType: "image/png", bytes: new Uint8Array(5 * MB) });
  const fit = vi.fn<FitPromptImage>(async () => ({
    mediaType: "image/jpeg",
    bytes: new Uint8Array(3 * MB),
  }));
  // Five full-size screenshots share 20 MB, so each one is fitted to 4 MB.
  const shared = await prepareNativePromptImages(
    Array.from({ length: 5 }, () => ({ source: "nodex://assets/image.png" })),
    read,
    fit,
  );
  expect(shared.map((image) => image.mediaType)).toEqual(Array(5).fill("image/jpeg"));
  expect(fit.mock.calls.map(([, budget]) => budget)).toEqual(Array(5).fill(4 * MB));

  fit.mockClear();
  // One screenshot within its own share is sent as it is.
  const single = await prepareNativePromptImages(
    [{ source: "nodex://assets/image.png" }],
    () => ({ mimeType: "image/png", bytes: new Uint8Array(4 * MB) }),
    fit,
  );
  expect(single[0]?.mediaType).toBe("image/png");
  expect(fit).not.toHaveBeenCalled();
});

it("rejects what cannot be sent as an image at all", async () => {
  const read = () => ({ mimeType: "image/png", bytes: new Uint8Array(6 * MB) });
  await expect(
    prepareNativePromptImages([{ source: "data:image/svg+xml;base64,PHN2Zz4=" }], read, unused),
  ).rejects.toThrow("valid PNG");
  await expect(
    prepareNativePromptImages(
      Array.from({ length: 21 }, () => ({ source: "nodex://assets/image.png" })),
      read,
      unused,
    ),
  ).rejects.toThrow("at most 20 images");
  await expect(
    prepareNativePromptImages(
      [{ source: "nodex://assets/image.png" }],
      read,
      async (image) => image,
    ),
  ).rejects.toThrow("too large to send");
});

/** A decoded image whose encodings grow with its pixel count, as real ones roughly do. */
const image = (width: number, height: number, bytesPerPixel: { png: number; jpeg: number }) => {
  const encoded = (perPixel: number) => new Uint8Array(Math.round(width * height * perPixel));
  const decoded: EncodableImage = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size) => image(size.width, size.height, bytesPerPixel),
    toPNG: () => encoded(bytesPerPixel.png),
    toJPEG: (quality) => encoded((bytesPerPixel.jpeg * quality) / 85),
  };
  return decoded;
};

it("keeps a screenshot PNG while it fits, and steps its size down before giving up", async () => {
  const source = { mediaType: "image/png" as const, bytes: new Uint8Array(6 * MB) };
  // A Retina screenshot: too large as it is, a sharp PNG once its longest edge is 2048px.
  const screenshot = await fitWithImageCodec(() => image(5120, 2880, { png: 0.5, jpeg: 0.3 }))(
    source,
    5 * MB,
  );
  expect(screenshot.mediaType).toBe("image/png");
  expect(screenshot.bytes.byteLength).toBeLessThanOrEqual(5 * MB);

  // A photo that never fits as PNG becomes JPEG.
  const photo = await fitWithImageCodec(() => image(4000, 3000, { png: 3, jpeg: 0.5 }))(
    source,
    4 * MB,
  );
  expect(photo.mediaType).toBe("image/jpeg");
  expect(photo.bytes.byteLength).toBeLessThanOrEqual(4 * MB);

  await expect(
    fitWithImageCodec(() => image(4000, 3000, { png: 30, jpeg: 30 }))(source, 1 * MB),
  ).rejects.toThrow("too large to send");
  await expect(
    fitWithImageCodec(() => ({ ...image(1, 1, { png: 1, jpeg: 1 }), isEmpty: () => true }))(
      source,
      MB,
    ),
  ).rejects.toThrow("could not be read");
});
