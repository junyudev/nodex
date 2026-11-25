import { describe, expect, test } from "vite-plus/test";
import {
  buildComposerImagePromptInputs,
  createResolvedComposerImageAttachment,
  resolveComposerImageAttachmentSize,
  selectComposerImagePromptSource,
  type ComposerImageAttachment,
} from "./composer-image-attachment-model";
import { buildRemoveSubmissionIntent } from "@/features/user-attachment-image-editor/model/image-edit-submission";
import type { EditableImageDescriptor } from "@/lib/content-image";
import { buildComposerImageEditAttachments } from "./image-edit-intent-attachments";

describe("composer image attachment model", () => {
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
});

describe("image edit intent attachments", () => {
  const MASK: EditableImageDescriptor = {
    id: "mask",
    alt: "Removal mask",
    attachmentSrc: "data:image/png;base64,bWFzaw==",
    dataUrl: "data:image/png;base64,bWFzaw==",
    source: "uploaded",
    src: "data:image/png;base64,bWFzaw==",
  };

  function currentAttachment(
    overrides: Partial<ComposerImageAttachment> = {},
  ): ComposerImageAttachment {
    return {
      id: "original",
      filename: "original.png",
      mimeType: "image/png",
      src: "data:image/png;base64,b3JpZ2luYWw=",
      origin: "browser",
      materialization: {
        hostId: "local",
        localPath: null,
        managedSource: "nodex://assets/original.png",
      },
      materializationStatus: "ready",
      uploadStatus: "idle",
      generation: 1,
      ...overrides,
    };
  }

  describe("image edit intent attachments", () => {
    test("preserves the Composer-owned original when an editor display descriptor lost its source kind", () => {
      const original = currentAttachment();
      const poisonedEditorDescriptor: EditableImageDescriptor = {
        id: original.id,
        attachmentId: original.id,
        alt: "User attachment",
        attachmentSrc: "nodex://assets/original.png",
        dataUrl: "nodex://assets/original.png",
        managedSource: "nodex://assets/original.png",
        source: "uploaded",
        src: "nodex://assets/original.png",
      };

      const attachments = buildComposerImageEditAttachments({
        currentAttachments: [original],
        executionHostId: "local",
        generation: 2,
        intent: buildRemoveSubmissionIntent({
          entrypoint: "image_click",
          image: poisonedEditorDescriptor,
          mask: MASK,
        }),
      });

      expect(attachments).toEqual([
        original,
        expect.objectContaining({
          id: "mask",
          filename: "image-mask.png",
          src: MASK.dataUrl,
        }),
      ]);
    });

    test("uses a canonical managed source only on its owning host", () => {
      const original: EditableImageDescriptor = {
        id: "managed",
        alt: "Managed image",
        attachmentSrc: "nodex://assets/managed.png",
        managedSource: "nodex://assets/managed.png",
        source: "uploaded",
        src: "nodex://assets/managed.png",
      };
      const intent = buildRemoveSubmissionIntent({
        entrypoint: "image_click",
        image: original,
        mask: MASK,
      });

      expect(
        buildComposerImageEditAttachments({
          currentAttachments: [],
          executionHostId: "local",
          generation: 1,
          intent,
        })?.[0],
      ).toMatchObject({
        materialization: {
          hostId: "local",
          localPath: null,
          managedSource: "nodex://assets/managed.png",
        },
      });
      expect(
        buildComposerImageEditAttachments({
          currentAttachments: [],
          executionHostId: "ssh:remote",
          generation: 1,
          intent,
        }),
      ).toBeNull();
    });

    test("treats an unowned absolute path as local instead of leaking it to a remote host", () => {
      const original: EditableImageDescriptor = {
        id: "local",
        alt: "Local image",
        attachmentSrc: "/tmp/original.png",
        localPath: "/tmp/original.png",
        source: "uploaded",
        src: "/tmp/original.png",
      };
      const intent = buildRemoveSubmissionIntent({
        entrypoint: "image_click",
        image: original,
        mask: MASK,
      });

      expect(
        buildComposerImageEditAttachments({
          currentAttachments: [],
          executionHostId: "local",
          generation: 1,
          intent,
        })?.[0],
      ).toMatchObject({
        materialization: {
          hostId: "local",
          localPath: "/tmp/original.png",
          managedSource: null,
        },
      });
      expect(
        buildComposerImageEditAttachments({
          currentAttachments: [],
          executionHostId: "ssh:remote",
          generation: 1,
          intent,
        }),
      ).toBeNull();
    });
  });
});
