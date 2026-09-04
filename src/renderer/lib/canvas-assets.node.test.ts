import { describe, expect, test, vi } from "vite-plus/test";
import {
  CanvasBinaryFileResolver,
  collectCanvasReferencedFileIds,
  createCanvasFileBridge,
  materializeDurableCanvasFiles,
  resolveCanvasBinaryFiles,
} from "./canvas-assets";
import { CanvasSceneStagedFileCatalog } from "./canvas-scene-binding";

const resources = vi.hoisted(() => ({ importFile: vi.fn(), readFile: vi.fn() }));
vi.mock("./library-file-resources", async (original) => ({
  ...(await original<typeof import("./library-file-resources")>()),
  importLibraryFile: resources.importFile,
  readAuthorizedFile: resources.readFile,
}));

describe("Canvas managed asset bridge", () => {
  test("publishes a File and reads the exact authorized Canvas slot", async () => {
    resources.importFile.mockResolvedValue({
      file: { file_id: "file", head_version: 3, default_name: "Image.png", mime_type: "image/png" },
      source: "nodex://files/file",
    });
    resources.readFile.mockResolvedValue({
      bytes: new Uint8Array([98, 121, 116, 101, 115]),
      mimeType: "image/png",
      etag: "hash",
    });
    const authority = {
      libraryId: "library",
      storeEpoch: "epoch",
      contentAccessContext: { kind: "project", projectId: "project" },
    } as const;
    const bridge = createCanvasFileBridge(authority, (file) => ({
      kind: "canvas",
      canvas_id: "canvas",
      scene_file_id: file.id,
    }));
    await expect(
      bridge.materializeImage?.(new File(["bytes"], "source.png", { type: "image/png" })),
    ).resolves.toEqual({
      source: "nodex://files/file",
      fileVersion: 3,
      defaultName: "Image.png",
      mimeType: "image/png",
    });
    await expect(
      bridge.readFileDataUrl?.({
        id: "slot",
        source: "nodex://files/file",
        fileVersion: 3,
        defaultName: "Image.png",
        mimeType: "image/png",
      }),
    ).resolves.toBe("data:image/png;base64,Ynl0ZXM=");
    expect(resources.readFile).toHaveBeenCalledWith(
      {
        ...authority,
        readSource: { kind: "canvas", canvas_id: "canvas", scene_file_id: "slot" },
        version: 3,
      },
      "nodex://files/file",
    );
  });

  test("keeps only active image files and uploads new payloads before return", async () => {
    const uploadOrder: string[] = [];
    const durable = await materializeDurableCanvasFiles({
      elementsIncludingDeleted: [
        { id: "image", type: "image", fileId: "new", isDeleted: false },
        { id: "deleted", type: "image", fileId: "old", isDeleted: true },
      ],
      binaryFiles: {
        new: {
          id: "new",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AA==",
          created: 10,
        },
      },
      current: {},
      dependencies: {
        materializeImage: async () => {
          uploadOrder.push("uploaded");
          return {
            source: "nodex://files/new.png",
            fileVersion: 1,
            defaultName: "image.png",
            mimeType: "image/png",
          };
        },
      },
    });
    expect(uploadOrder.join(",")).toBe("uploaded");
    expect(Object.keys(durable).join(",")).toBe("new");
    expect(durable.new?.source).toBe("nodex://files/new.png");
    expect([...collectCanvasReferencedFileIds([{ type: "image", fileId: "new" }])].join(",")).toBe(
      "new",
    );
  });

  test("single-flights the same staged file across concurrent surface ports", async () => {
    const catalog = new CanvasSceneStagedFileCatalog();
    let materializationCount = 0;
    const request = {
      elementsIncludingDeleted: [
        { id: "image", type: "image", fileId: "shared", isDeleted: false },
      ],
      binaryFiles: {
        shared: {
          id: "shared",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AA==",
          created: 10,
        },
      },
      current: {},
      getAccepted: () => ({}),
      dependencies: {
        materializeImage: async () => {
          materializationCount += 1;
          return {
            source: "nodex://files/shared.png",
            fileVersion: 1,
            defaultName: "image.png",
            mimeType: "image/png",
          };
        },
      },
    } as const;

    const [first, second] = await Promise.all([
      catalog.materialize(request),
      catalog.materialize(request),
    ]);

    expect(materializationCount).toBe(1);
    expect(first.shared).toEqual(second.shared);
  });

  test("resolves durable refs into disposable Excalidraw binary data", async () => {
    const files = await resolveCanvasBinaryFiles(
      {
        image: {
          id: "image",
          mimeType: "image/png",
          source: "nodex://files/image.png",
          fileVersion: 1,
          defaultName: "image.png",
          created: 5,
        },
      },
      {
        readFileDataUrl: async () => "data:image/png;base64,Ynl0ZXM=",
        now: () => 20,
      },
    );
    expect(files.image?.dataURL).toBe("data:image/png;base64,Ynl0ZXM=");
    expect(files.image?.created).toBe(5);
    expect(files.image?.lastRetrieved).toBe(20);
  });

  test("incrementally resolves unchanged files and prunes unreferenced cache entries", async () => {
    const fetched: string[] = [];
    const resolver = new CanvasBinaryFileResolver({
      readFileDataUrl: async ({ source }) => {
        fetched.push(source);
        return `data:${source}`;
      },
      now: () => 50,
    });
    const first = await resolver.resolve({
      first: {
        id: "first",
        mimeType: "image/png",
        source: "nodex://files/first.png",
        fileVersion: 1,
        defaultName: "image.png",
        created: 1,
      },
      second: {
        id: "second",
        mimeType: "image/png",
        source: "nodex://files/second.png",
        fileVersion: 1,
        defaultName: "image.png",
        created: 2,
      },
    });
    expect(fetched.length).toBe(2);
    expect(Object.keys(first).join(",")).toBe("first,second");

    const retained = await resolver.resolve({
      first: {
        id: "first",
        mimeType: "image/png",
        source: "nodex://files/first.png",
        fileVersion: 1,
        defaultName: "image.png",
        created: 9,
      },
    });
    expect(fetched.length).toBe(2);
    expect(retained.first?.created).toBe(9);

    await resolver.resolve({
      first: {
        id: "first",
        mimeType: "image/webp",
        source: "nodex://files/first-v2.webp",
        fileVersion: 1,
        defaultName: "image.png",
      },
      second: {
        id: "second",
        mimeType: "image/png",
        source: "nodex://files/second.png",
        fileVersion: 1,
        defaultName: "image.png",
      },
    });
    expect(fetched.length).toBe(4);
    resolver.clear();
    await resolver.resolve({
      first: {
        id: "first",
        mimeType: "image/webp",
        source: "nodex://files/first-v2.webp",
        fileVersion: 1,
        defaultName: "image.png",
      },
    });
    expect(fetched.length).toBe(5);
    resolver.destroy();
  });

  test("shares concurrent in-flight reads and retries a failed asset", async () => {
    let fetchCount = 0;
    let fail = true;
    const resolver = new CanvasBinaryFileResolver({
      readFileDataUrl: async () => {
        fetchCount += 1;
        if (fail) throw new Error("unavailable");
        return "data:image/png;base64,b2s=";
      },
    });
    const files = {
      image: {
        id: "image",
        mimeType: "image/png",
        source: "nodex://files/image.png",
        fileVersion: 1,
        defaultName: "image.png",
      },
    } as const;
    const first = resolver.resolve(files);
    const second = resolver.resolve(files);
    let firstError: unknown;
    let secondError: unknown;
    try {
      await first;
    } catch (error) {
      firstError = error;
    }
    try {
      await second;
    } catch (error) {
      secondError = error;
    }
    expect(firstError instanceof Error).toBe(true);
    expect(secondError instanceof Error).toBe(true);
    expect(fetchCount).toBe(1);

    fail = false;
    const retried = await resolver.resolve(files);
    expect(fetchCount).toBe(2);
    expect(retried.image?.dataURL).toBe("data:image/png;base64,b2s=");
    resolver.destroy();
    let destroyedError: unknown;
    try {
      await resolver.resolve(files);
    } catch (error) {
      destroyedError = error;
    }
    expect(destroyedError instanceof Error).toBe(true);
  });
  test("rejects an in-flight read after the resolver is cleared", async () => {
    let finish: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const resolver = new CanvasBinaryFileResolver({ readFileDataUrl: () => pending });
    const reading = resolver.resolve({
      image: {
        id: "image",
        mimeType: "image/png",
        source: "nodex://files/file",
        fileVersion: 1,
        defaultName: "Image.png",
      },
    });
    resolver.clear();
    finish("data:image/png;base64,Ynl0ZXM=");
    await expect(reading).rejects.toThrow("invalidated");
    resolver.destroy();
  });
});
