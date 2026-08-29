import { describe, expect, test } from "vite-plus/test";
import {
  buildRemoveBackgroundSubmissionIntent,
  buildRemoveSubmissionIntent,
  IMAGE_REMOVE_BACKGROUND_PROMPT,
} from "../model/image-edit-submission";
import type { EditableImageDescriptor } from "../model/types";
import { compileImageEditPromptInput } from "./use-image-edit-submission";

const MASK: EditableImageDescriptor = {
  id: "mask",
  alt: "Removal mask",
  attachmentSrc: "data:image/png;base64,bWFzaw==",
  dataUrl: "data:image/png;base64,bWFzaw==",
  source: "uploaded",
  src: "data:image/png;base64,bWFzaw==",
};

describe("direct image edit prompt compilation", () => {
  test("compiles background removal as an original-only image edit", () => {
    const original: EditableImageDescriptor = {
      id: "original",
      alt: "Original",
      attachmentSrc: "data:image/png;base64,b3JpZ2luYWw=",
      dataUrl: "data:image/png;base64,b3JpZ2luYWw=",
      source: "uploaded",
      src: "data:image/png;base64,b3JpZ2luYWw=",
    };

    expect(
      compileImageEditPromptInput(
        buildRemoveBackgroundSubmissionIntent({
          entrypoint: "image_click",
          image: original,
        }),
      ),
    ).toEqual({
      text: IMAGE_REMOVE_BACKGROUND_PROMPT,
      images: [{ source: original.dataUrl }],
    });
  });

  test("ignores a mislabeled dataUrl and keeps the canonical managed source", () => {
    const original: EditableImageDescriptor = {
      id: "managed",
      alt: "Managed original",
      attachmentSrc: "nodex://assets/original.png",
      dataUrl: "nodex://assets/original.png",
      managedSource: "nodex://assets/original.png",
      source: "uploaded",
      src: "nodex://assets/original.png",
    };

    expect(
      compileImageEditPromptInput(
        buildRemoveSubmissionIntent({
          entrypoint: "image_click",
          image: original,
          mask: MASK,
        }),
      ),
    ).toEqual({
      text: "Remove the area marked in the second image from the first image",
      images: [{ source: "nodex://assets/original.png" }, { source: MASK.dataUrl }],
    });
  });

  test("recognizes a canonical managed source even when a legacy descriptor omitted its kind", () => {
    const original: EditableImageDescriptor = {
      id: "managed",
      alt: "Managed original",
      attachmentSrc: "nodex://assets/original.png",
      dataUrl: "nodex://assets/original.png",
      source: "uploaded",
      src: "nodex://assets/original.png",
    };

    const promptInput = compileImageEditPromptInput(
      buildRemoveSubmissionIntent({
        entrypoint: "image_click",
        image: original,
        mask: MASK,
      }),
    );

    expect(promptInput?.images?.[0]).toEqual({
      source: "nodex://assets/original.png",
    });
  });

  test("does not send a managed source owned by another host through the local fallback", () => {
    const original: EditableImageDescriptor = {
      id: "managed",
      alt: "Managed original",
      attachmentSrc: "nodex://assets/original.png",
      hostId: "ssh:remote",
      managedSource: "nodex://assets/original.png",
      source: "uploaded",
      src: "nodex://assets/original.png",
    };

    expect(
      compileImageEditPromptInput(
        buildRemoveSubmissionIntent({
          entrypoint: "image_click",
          image: original,
          mask: MASK,
        }),
      ),
    ).toBeNull();
  });

  test("does not send another host's absolute path through the local fallback", () => {
    const original: EditableImageDescriptor = {
      id: "local",
      alt: "Local original",
      attachmentSrc: "/remote/original.png",
      hostId: "ssh:remote",
      localPath: "/remote/original.png",
      source: "uploaded",
      src: "/remote/original.png",
    };

    expect(
      compileImageEditPromptInput(
        buildRemoveSubmissionIntent({
          entrypoint: "image_click",
          image: original,
          mask: MASK,
        }),
      ),
    ).toBeNull();
  });

  test("rejects unresolved renderer pointers before the app-server boundary", () => {
    const pointer: EditableImageDescriptor = {
      id: "pointer",
      alt: "Generated original",
      attachmentSrc: "file-service://asset-1",
      source: "generated",
      src: "file-service://asset-1",
    };

    expect(
      compileImageEditPromptInput(
        buildRemoveSubmissionIntent({
          entrypoint: "image_click",
          image: pointer,
          mask: MASK,
        }),
      ),
    ).toBeNull();
  });
});
