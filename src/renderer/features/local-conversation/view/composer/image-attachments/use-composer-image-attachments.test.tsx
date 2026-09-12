import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ComposerImageAttachmentMaterialization } from "./composer-image-attachment-model";
import {
  readComposerImageFileAsDataUrl,
  useComposerImageAttachments,
} from "./use-composer-image-attachments";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderController(input: {
  readonly readFileAsDataUrl: (file: File) => Promise<string>;
  readonly materializeFile: (
    file: File,
    origin: "paste" | "drop",
  ) => Promise<ComposerImageAttachmentMaterialization>;
  readonly enabled?: boolean;
  readonly onError?: (message: string) => void;
}) {
  let id = 0;
  return renderHook(() => {
    const [attachments, setAttachments] = useState<
      readonly import("./composer-image-attachment-model").ComposerImageAttachment[]
    >([]);
    const controller = useComposerImageAttachments({
      attachments,
      setAttachments,
      enabled: input.enabled ?? true,
      onError: input.onError ?? vi.fn(),
      onOpen: vi.fn(),
      adapters: {
        createId: () => `image-${++id}`,
        readFileAsDataUrl: input.readFileAsDataUrl,
        materializeFile: input.materializeFile,
      },
    });
    return { attachments, controller };
  });
}

describe("useComposerImageAttachments", () => {
  test("normalizes an extension-qualified generic File into an image data URL", async () => {
    await expect(
      readComposerImageFileAsDataUrl(
        new File(["image"], "diagram.WEBP", { type: "application/octet-stream" }),
      ),
    ).resolves.toMatch(/^data:image\/webp;base64,/u);
  });

  test("gives an unnamed pasted image a stable readable filename", async () => {
    const hook = renderController({
      readFileAsDataUrl: async () => "data:image/png;base64,aW1hZ2U=",
      materializeFile: async () => ({
        hostId: "local",
        managedSource: "nodex://assets/image.png",
        localPath: "/managed/image.png",
      }),
    });

    await act(async () => {
      await hook.result.current.controller.addFiles(
        [new File(["image"], "", { type: "image/png" })],
        "paste",
      );
    });

    expect(hook.result.current.attachments[0]?.filename).toBe("pasted-image-1.png");
  });

  test("shows a readable image before local materialization completes and patches it in place", async () => {
    const materialization = deferred<ComposerImageAttachmentMaterialization>();
    const hook = renderController({
      readFileAsDataUrl: async () => "data:image/png;base64,aW1hZ2U=",
      materializeFile: () => materialization.promise,
    });
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    let operation!: Promise<void>;

    await act(async () => {
      operation = hook.result.current.controller.addFiles([file], "paste");
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.attachments).toHaveLength(1));
    expect(hook.result.current.attachments[0]).toMatchObject({
      filename: "diagram.png",
      src: "data:image/png;base64,aW1hZ2U=",
      materializationStatus: "pending",
    });

    await act(async () => {
      materialization.resolve({
        hostId: "local",
        managedSource: "nodex://assets/diagram.png",
        localPath: "/managed/diagram.png",
      });
      await operation;
    });
    expect(hook.result.current.attachments[0]).toMatchObject({
      materializationStatus: "ready",
      materialization: { localPath: "/managed/diagram.png" },
    });
  });

  test("does not resurrect a removed attachment when materialization finishes late", async () => {
    const materialization = deferred<ComposerImageAttachmentMaterialization>();
    const hook = renderController({
      readFileAsDataUrl: async () => "data:image/png;base64,aW1hZ2U=",
      materializeFile: () => materialization.promise,
    });
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    let operation!: Promise<void>;

    await act(async () => {
      operation = hook.result.current.controller.addFiles([file], "paste");
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.attachments).toHaveLength(1));
    act(() => hook.result.current.controller.remove("image-1"));
    expect(hook.result.current.attachments).toEqual([]);

    await act(async () => {
      materialization.resolve({
        hostId: "local",
        managedSource: "nodex://assets/diagram.png",
        localPath: "/managed/diagram.png",
      });
      await operation;
    });
    expect(hook.result.current.attachments).toEqual([]);
  });

  test("drops late reads after clear and keeps repeated explicit additions distinct", async () => {
    const firstRead = deferred<string>();
    let readCount = 0;
    const hook = renderController({
      readFileAsDataUrl: () => {
        readCount += 1;
        return readCount === 1
          ? firstRead.promise
          : Promise.resolve("data:image/png;base64,c2Vjb25k");
      },
      materializeFile: async () => ({
        hostId: "local",
        managedSource: "nodex://assets/image.png",
        localPath: "/managed/image.png",
      }),
    });
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    let firstOperation!: Promise<void>;

    act(() => {
      firstOperation = hook.result.current.controller.addFiles([file], "paste");
      hook.result.current.controller.clear();
    });
    await act(async () => {
      firstRead.resolve("data:image/png;base64,Zmlyc3Q=");
      await firstOperation;
    });
    expect(hook.result.current.attachments).toEqual([]);

    await act(async () => {
      await hook.result.current.controller.addFiles([file, file], "paste");
    });
    expect(hook.result.current.attachments.map((attachment) => attachment.id)).toEqual([
      "image-2",
      "image-3",
    ]);
  });

  test("rejects files when the selected model lacks image input", async () => {
    const onError = vi.fn();
    const readFileAsDataUrl = vi.fn(async () => "data:image/png;base64,aW1hZ2U=");
    const hook = renderController({
      enabled: false,
      onError,
      readFileAsDataUrl,
      materializeFile: vi.fn(),
    });

    await act(async () => {
      await hook.result.current.controller.addFiles(
        [new File(["image"], "diagram.png", { type: "image/png" })],
        "paste",
      );
    });

    expect(readFileAsDataUrl).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "This model does not support image inputs. Try a different model.",
    );
    expect(hook.result.current.attachments).toEqual([]);
  });

  test("adapts picker results into the same immediate and host-bound model", () => {
    const hook = renderController({
      readFileAsDataUrl: vi.fn(),
      materializeFile: vi.fn(),
    });

    act(() => {
      hook.result.current.controller.addPickedFiles([
        {
          label: "diagram.png",
          path: "/picked/diagram.png",
          bytes: 5,
          mimeType: "image/png",
          imageDataUrl: "data:image/png;base64,aW1hZ2U=",
        },
      ]);
    });

    expect(hook.result.current.attachments).toEqual([
      expect.objectContaining({
        filename: "diagram.png",
        materialization: {
          hostId: "local",
          localPath: "/picked/diagram.png",
          managedSource: null,
        },
        materializationStatus: "ready",
        origin: "picker",
        src: "data:image/png;base64,aW1hZ2U=",
      }),
    ]);
  });

  test("preserves a Composer-owned attachment when an editor draft reuses its id", () => {
    const hook = renderController({
      readFileAsDataUrl: vi.fn(),
      materializeFile: vi.fn(),
    });

    act(() => {
      hook.result.current.controller.addResolvedImages([
        {
          id: "shared-image",
          filename: "before.png",
          mimeType: "image/png",
          origin: "browser",
          src: "data:image/png;base64,YmVmb3Jl",
        },
      ]);
      hook.result.current.controller.syncResolvedImages("image-editor", [
        {
          id: "shared-image",
          filename: "after.png",
          mimeType: "image/png",
          origin: "image-editor",
          src: "data:image/png;base64,YWZ0ZXI=",
        },
      ]);
    });

    expect(hook.result.current.attachments).toEqual([
      expect.objectContaining({
        id: "shared-image",
        filename: "before.png",
        origin: "browser",
      }),
    ]);
  });

  test("drops late work even when the owning composer scope changes away and back", async () => {
    const read = deferred<string>();
    const materialization = deferred<ComposerImageAttachmentMaterialization>();
    let id = 0;
    const hook = renderHook(
      ({ scopeKey }: { scopeKey: string }) => {
        const [attachments, setAttachments] = useState<
          readonly import("./composer-image-attachment-model").ComposerImageAttachment[]
        >([]);
        const controller = useComposerImageAttachments({
          attachments,
          setAttachments,
          scopeKey,
          enabled: true,
          onError: vi.fn(),
          onOpen: vi.fn(),
          adapters: {
            createId: () => `image-${++id}`,
            readFileAsDataUrl: () => read.promise,
            materializeFile: () => materialization.promise,
          },
        });
        return { attachments, controller };
      },
      { initialProps: { scopeKey: "composer-a" } },
    );
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    let operation!: Promise<void>;

    act(() => {
      operation = hook.result.current.controller.addFiles([file], "paste");
    });
    hook.rerender({ scopeKey: "composer-b" });
    hook.rerender({ scopeKey: "composer-a" });
    await act(async () => {
      read.resolve("data:image/png;base64,aW1hZ2U=");
      materialization.resolve({
        hostId: "local",
        managedSource: "nodex://assets/image.png",
        localPath: "/managed/image.png",
      });
      await operation;
    });

    expect(hook.result.current.attachments).toEqual([]);
  });
});
