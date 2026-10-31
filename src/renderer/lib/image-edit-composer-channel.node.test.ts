import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ImageEditSubmissionIntent } from "@/lib/content-image";
import {
  clearImageEditComposerDraft,
  compileImageEditComposerPrompt,
  getImageEditComposerDraftSnapshot,
  registerImageEditComposerChannel,
  removeImageEditComposerAttachment,
  replaceImageEditComposerDraft,
  requestImageEditComposerSubmit,
  subscribeImageEditComposerDraft,
} from "./image-edit-composer-channel";

const channelId = "thread-scope:session-1::root";

const resizeIntent: ImageEditSubmissionIntent = {
  analytics: {
    hasGeneralInstruction: false,
    selectedImageCount: 1,
  },
  attachmentIds: ["image-1"],
  attachments: [
    {
      attachmentId: "image-1",
      image: {
        id: "image-1",
        alt: "User attachment",
        attachmentSrc: "data:image/png;base64,a",
        dataUrl: "data:image/png;base64,a",
        source: "uploaded",
        src: "data:image/png;base64,a",
      },
      role: "original",
    },
  ],
  entrypoint: "image_click",
  focusComposerAfterSubmit: true,
  isImageEditFollowUp: true,
  mode: "resize",
  promptRaw: "Make the aspect ratio 1:1",
  queuePolicy: "queue-while-active",
};

beforeEach(() => clearImageEditComposerDraft(channelId));

describe("image edit composer channel", () => {
  test("routes typed edit intents to the mounted composer before a thread exists", async () => {
    const submit = vi.fn(async () => ({ status: "submitted" as const }));
    const unregister = registerImageEditComposerChannel(channelId, submit);

    await expect(
      requestImageEditComposerSubmit(channelId, {
        intent: resizeIntent,
        source: "single",
      }),
    ).resolves.toEqual({ status: "submitted" });
    expect(submit).toHaveBeenCalledWith({
      intent: resizeIntent,
      source: "single",
    });

    unregister();
    await expect(
      requestImageEditComposerSubmit(channelId, {
        intent: resizeIntent,
        source: "single",
      }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "composer-unmounted",
    });
  });

  test("keeps draft and submit routing on the same stable channel", async () => {
    replaceImageEditComposerDraft(channelId, {
      mode: "comment",
      attachments: [
        {
          asset: {
            hostId: null,
            localPath: null,
            managedSource: null,
            src: "https://example.com/a.png",
          },
          comments: [{ id: "c1", text: "Remove sign", x: 0.125, y: 0.5 }],
          filename: "Image A",
          id: "image-playground:a",
          imageSource: "generated",
        },
      ],
    });
    const submit = vi.fn(async () => {
      clearImageEditComposerDraft(channelId);
      return { status: "queued" as const };
    });
    const unregister = registerImageEditComposerChannel(channelId, submit);

    await expect(
      requestImageEditComposerSubmit(channelId, {
        source: "canvas",
      }),
    ).resolves.toEqual({ status: "queued" });
    expect(getImageEditComposerDraftSnapshot(channelId).mode).toBeNull();

    unregister();
  });

  test("does not let stale cleanup remove a replacement composer", async () => {
    const stale = vi.fn(async () => ({ status: "submitted" as const }));
    const current = vi.fn(async () => ({ status: "queued" as const }));
    const unregisterStale = registerImageEditComposerChannel(channelId, stale);
    const unregisterCurrent = registerImageEditComposerChannel(channelId, current);

    unregisterStale();
    await expect(
      requestImageEditComposerSubmit(channelId, {
        source: "canvas",
      }),
    ).resolves.toEqual({ status: "queued" });
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();

    unregisterCurrent();
  });

  test("publishes immutable drafts and compiles positional comments", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeImageEditComposerDraft(channelId, listener);
    replaceImageEditComposerDraft(channelId, {
      mode: "comment",
      attachments: [
        {
          asset: {
            hostId: null,
            localPath: null,
            managedSource: null,
            src: "https://example.com/a.png",
          },
          comments: [{ id: "c1", text: "Remove sign", x: 0.125, y: 0.5 }],
          filename: "Image A",
          id: "image-playground:a",
          imageSource: "generated",
        },
      ],
    });

    const snapshot = getImageEditComposerDraftSnapshot(channelId);
    expect(
      compileImageEditComposerPrompt({
        draft: snapshot,
        generalInstructions: "Keep lighting",
        locales: "en-US",
      }),
    ).toBe(
      [
        "Image 1:",
        "1. (x: 12.5%, y: 50%) Remove sign",
        "",
        "Additional instructions:",
        "Keep lighting",
      ].join("\n"),
    );

    removeImageEditComposerAttachment(channelId, "image-playground:a");
    expect(getImageEditComposerDraftSnapshot(channelId).mode).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
