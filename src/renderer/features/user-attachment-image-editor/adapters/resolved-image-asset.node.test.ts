import { describe, expect, test, vi } from "vite-plus/test";
import { readNativeResource } from "../../../lib/native-resource-operations";
import * as workspaceFiles from "../../../lib/workspace-file-operations";
vi.mock("../../../lib/native-resource-operations", () => ({ readNativeResource: vi.fn() }));
import {
  ImageAssetResolutionError,
  blobToDataUrl,
  classifyImageAssetSource,
  createImageDownloadFilename,
  dataUrlToBlob,
  downloadImageDataUrl,
  fetchImageSourceAsDataUrl,
  materializeImageSourceAsDataUrl,
  resolveImageDisplaySource,
} from "./resolved-image-asset";

describe("resolved image assets", () => {
  test("does not materialize resource bytes after their source retires", async () => {
    let current = true;
    let finish!: (blob: Blob) => void;
    const body = new Promise<Blob>((resolve) => {
      finish = resolve;
    });
    const blob = new Blob(["image"], { type: "image/png" });
    const readBytes = vi.spyOn(blob, "arrayBuffer");
    const result = fetchImageSourceAsDataUrl(
      "app://fs/host/image",
      async () => ({ ok: true, blob: () => body }) as Response,
      { isCurrent: () => current },
    );
    await Promise.resolve();
    current = false;
    finish(blob);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(readBytes).not.toHaveBeenCalled();
  });
  test("desktop image downloads export bytes through the native destination boundary", async () => {
    const save = vi
      .spyOn(workspaceFiles, "saveWorkspaceFileData")
      .mockResolvedValue({ path: null });
    vi.stubGlobal("window", { electronBridge: {} });
    try {
      await downloadImageDataUrl("data:image/png;base64,AAH/", "chart.png");
      expect(save).toHaveBeenCalledExactlyOnceWith({
        fileName: "chart.png",
        contentsBase64: "AAH/",
      });
    } finally {
      save.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  test("HTTP image reads use the desktop network boundary", async () => {
    vi.mocked(readNativeResource).mockResolvedValueOnce({
      contentsBase64: "AAH/",
      mimeType: "image/png",
    });
    await expect(fetchImageSourceAsDataUrl("https://example.test/native.png")).resolves.toBe(
      "data:image/png;base64,AAH/",
    );
    expect(readNativeResource).toHaveBeenCalledExactlyOnceWith("https://example.test/native.png");
  });
  test("classifies data, managed, pointer, remote, and local sources", () => {
    expect(classifyImageAssetSource("data:image/png;base64,YQ==").kind).toBe("data");
    expect(classifyImageAssetSource("nodex://assets/hero.png").kind).toBe("managed");
    expect(classifyImageAssetSource("nodex://assets/folder/hero.png").kind).toBe("invalid");
    expect(classifyImageAssetSource("file-service://asset-1").kind).toBe("pointer");
    expect(classifyImageAssetSource("https://example.test/hero.png").kind).toBe("remote");
    expect(classifyImageAssetSource("nodex-asset://managed/hero.png").kind).toBe("invalid");
    expect(classifyImageAssetSource("data:text/plain,hello").kind).toBe("invalid");
    expect(classifyImageAssetSource("/tmp/hero.png")).toMatchObject({
      kind: "local",
      localPath: "/tmp/hero.png",
    });
    expect(classifyImageAssetSource("file:///tmp/hero.png")).toMatchObject({
      kind: "local",
      localPath: "/tmp/hero.png",
    });
    expect(classifyImageAssetSource("javascript:alert(1)").kind).toBe("invalid");
  });

  test("only exposes local display URLs when the caller owns local-path access", () => {
    expect(resolveImageDisplaySource("/tmp/hero.png", { allowLocalPath: false })).toBe(null);
    expect(resolveImageDisplaySource("/tmp/hero.png", { allowLocalPath: true })).toBe(
      "app://fs/@fs/tmp/hero.png",
    );
    expect(
      resolveImageDisplaySource("nodex://assets/hero.png", {
        allowLocalPath: false,
        resolveManagedAssetPath: () => "/profile/assets/hero.png",
      }),
    ).toBe("app://fs/@fs/profile/assets/hero.png");
    expect(
      resolveImageDisplaySource("nodex://assets/missing.png", {
        allowLocalPath: false,
        resolveManagedAssetPath: () => null,
      }),
    ).toBe(null);
  });

  test("round trips binary and percent-encoded data URLs", async () => {
    const encoded = await blobToDataUrl(
      new Blob([new Uint8Array([0, 1, 2, 255])], {
        type: "image/png",
      }),
    );
    expect(encoded).toBe("data:image/png;base64,AAEC/w==");
    expect(new Uint8Array(await dataUrlToBlob(encoded).arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
    expect(await dataUrlToBlob("data:image/svg+xml,%3Csvg%3E%3C/svg%3E").text()).toBe(
      "<svg></svg>",
    );
  });

  test("materializes successful remote images and rejects non-2xx responses", async () => {
    const fetchSuccess = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/webp" },
      });
    await expect(
      fetchImageSourceAsDataUrl("https://example.test/hero.webp", fetchSuccess as typeof fetch),
    ).resolves.toBe("data:image/webp;base64,AQID");

    const fetchFailure = async () => new Response(null, { status: 404 });
    await expect(
      fetchImageSourceAsDataUrl("https://example.test/missing.png", fetchFailure as typeof fetch),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ImageAssetResolutionError",
        status: 404,
      }),
    );
  });

  test("uses the source-specific materializer without weakening local access", async () => {
    await expect(
      materializeImageSourceAsDataUrl("/tmp/hero.png", {
        readLocalFile: async (path) => `data:image/png;base64,${path.length}`,
      }),
    ).resolves.toBe("data:image/png;base64,13");
    await expect(
      materializeImageSourceAsDataUrl("file-service://asset-1", {
        resolvePointer: async () => "data:image/jpeg;base64,YQ==",
      }),
    ).resolves.toBe("data:image/jpeg;base64,YQ==");
    await expect(materializeImageSourceAsDataUrl("/tmp/hero.png")).rejects.toBeInstanceOf(
      ImageAssetResolutionError,
    );
  });

  test("derives safe download filenames", () => {
    expect(
      createImageDownloadFilename(
        "data:image/jpeg;base64,YQ==",
        undefined,
        new Date("2026-08-13T12:34:56Z"),
      ),
    ).toMatch(/^Nodex Image .*\.jpg$/u);
    expect(createImageDownloadFilename("data:image/png;base64,YQ==", "before/after.png")).toBe(
      "before_after.png",
    );
  });
});
