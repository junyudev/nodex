import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { prepareNativePromptImages } from "./NativePromptImages";

it("prepares explicitly attached owned media and local files without network reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-native-images-"));
  try {
    const file = path.join(root, "image.png");
    await writeFile(file, Buffer.from([137, 80, 78, 71]));
    const result = await prepareNativePromptImages(
      [{ source: file }, { source: "nodex://assets/owned.jpg" }],
      () => ({ mimeType: "image/jpeg", bytes: Uint8Array.from([255, 216, 255]) }),
    );
    expect(result).toEqual([
      { mediaType: "image/png", data: "iVBORw==" },
      { mediaType: "image/jpeg", data: "/9j/" },
    ]);
    await expect(
      prepareNativePromptImages([{ source: "https://example.com/image.png" }], () => {
        throw new Error("not called");
      }),
    ).rejects.toThrow("local image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects unsupported formats, oversize files and aggregate image payloads", async () => {
  const read = () => ({ mimeType: "image/png", bytes: new Uint8Array(5 * 1024 * 1024) });
  await expect(
    prepareNativePromptImages(
      Array.from({ length: 5 }, () => ({ source: "nodex://assets/image.png" })),
      read,
    ),
  ).rejects.toThrow("20 MB");
  await expect(
    prepareNativePromptImages([{ source: "data:image/svg+xml;base64,PHN2Zz4=" }], read),
  ).rejects.toThrow("valid PNG");
  await expect(
    prepareNativePromptImages([{ source: "nodex://assets/image.png" }], () => ({
      mimeType: "image/png",
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
    })),
  ).rejects.toThrow("20 MB");
});
