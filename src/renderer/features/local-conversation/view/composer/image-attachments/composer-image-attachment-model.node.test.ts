import { describe, expect, test } from "vite-plus/test";
import {
  buildComposerImagePromptInputs,
  createResolvedComposerImageAttachment,
  resolveComposerImageAttachmentSize,
  selectComposerImagePromptSource,
  type ComposerImageAttachment,
} from "./composer-image-attachment-model";

function attachment(overrides: Partial<ComposerImageAttachment> = {}): ComposerImageAttachment {
  return {
    id: "image-1",
    filename: "diagram.png",
    mimeType: "image/png",
    src: "data:image/png;base64,aW1hZ2U=",
    origin: "paste",
    materialization: {
      hostId: "local",
      managedSource: "nodex://assets/image-1.png",
      localPath: "/managed/image-1.png",
    },
    materializationStatus: "ready",
    uploadStatus: "idle",
    generation: 1,
    ...overrides,
  };
}

describe("composer image attachment model", () => {
  test("uses Codex attachment sizes for image-only and mixed rows", () => {
    expect(resolveComposerImageAttachmentSize(false)).toBe(80);
    expect(resolveComposerImageAttachmentSize(true)).toBe(54);
  });

  test("uses a local materialization only on its execution host", () => {
    const value = attachment();
    expect(selectComposerImagePromptSource(value, "local")).toBe("/managed/image-1.png");
    expect(selectComposerImagePromptSource(value, "ssh:remote")).toBe(value.src);
    expect(selectComposerImagePromptSource(value, null)).toBe(value.src);
  });

  test("falls back to the portable source while materialization is unavailable", () => {
    const value = attachment({
      materialization: null,
      materializationStatus: "failed",
    });
    expect(buildComposerImagePromptInputs([value], "local")).toEqual([
      {
        source: value.src,
        caption: "diagram.png",
      },
    ]);
  });

  test("never sends a host-bound source to another execution host", () => {
    const value = attachment({
      src: "/managed/image-1.png",
    });

    expect(selectComposerImagePromptSource(value, "local")).toBe("/managed/image-1.png");
    expect(selectComposerImagePromptSource(value, "ssh:remote")).toBeNull();
    expect(selectComposerImagePromptSource(value, null)).toBeNull();
    expect(buildComposerImagePromptInputs([value], "ssh:remote")).toEqual([]);
  });

  test("submits a managed asset on its owner without pretending its URI is a path", () => {
    const value = attachment({
      src: "nodex://assets/image-1.png",
      materialization: {
        hostId: "local",
        managedSource: "nodex://assets/image-1.png",
        localPath: null,
      },
    });

    expect(selectComposerImagePromptSource(value, "local")).toBe("nodex://assets/image-1.png");
    expect(selectComposerImagePromptSource(value, "ssh:remote")).toBeNull();
  });

  test("retains native hosted file IDs on their restored execution host", () => {
    const value = createResolvedComposerImageAttachment({
      id: "image-1",
      generation: 0,
      value: {
        src: "file-service://asset-1",
        filename: "diagram.png",
        origin: "restored",
        hostId: "ssh:owner",
      },
    });
    expect(value).not.toBeNull();
    if (!value) throw new Error("Missing hosted attachment");

    expect(buildComposerImagePromptInputs([value], "ssh:owner")).toEqual([
      { source: "file-service://asset-1", caption: "diagram.png" },
    ]);
    expect(buildComposerImagePromptInputs([value], "local")).toEqual([]);
    expect(buildComposerImagePromptInputs([value], null)).toEqual([]);
  });

  test("does not submit hosted pointers without execution-host evidence", () => {
    const value = attachment({
      src: "file-service://asset-1",
      materialization: null,
      materializationStatus: "failed",
    });

    expect(selectComposerImagePromptSource(value, "local")).toBeNull();
    expect(buildComposerImagePromptInputs([value], "local")).toEqual([]);
  });
});
