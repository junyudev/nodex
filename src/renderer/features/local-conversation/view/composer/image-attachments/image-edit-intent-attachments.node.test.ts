import { describe, expect, test } from "vite-plus/test";
import { buildRemoveSubmissionIntent } from "@/features/user-attachment-image-editor/model/image-edit-submission";
import type { EditableImageDescriptor } from "@/features/user-attachment-image-editor/model/types";
import type { ComposerImageAttachment } from "./composer-image-attachment-model";
import { buildComposerImageEditAttachments } from "./image-edit-intent-attachments";

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
