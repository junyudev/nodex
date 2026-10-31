import { describe, expect, test } from "vite-plus/test";
import { __composerAddContextTestUtils } from "./local-conversation-thread-composer";

const { buildComposerPromptInput } = __composerAddContextTestUtils;

const noAttachments = {
  fileAttachments: [],
  addedFiles: [],
  imageAttachments: [],
  appshotContexts: [],
  pastedTextAttachments: [],
  commentAttachments: [],
  browserAnnotationAttachments: [],
};

const attachedImage = {
  id: "image_1",
  filename: "diagram.png",
  mimeType: "image/png",
  src: "data:image/png;base64,aW1hZ2U=",
  origin: "picker" as const,
  materialization: null,
  materializationStatus: "ready" as const,
  uploadStatus: "idle" as const,
  generation: 0,
};

describe("images written into a Composer's text", () => {
  test("travel to the Agent as images after the attachment row's, marked where they sit", () => {
    const promptInput = buildComposerPromptInput({
      prompt:
        "Compare [@notes.md](/tmp/my notes/notes.md) with ![shot](/tmp/shot.png)\n\nand ![](nodex://files/later)",
      attachments: { ...noAttachments, imageAttachments: [attachedImage] },
    });
    expect(promptInput?.images).toEqual([
      { source: "data:image/png;base64,aW1hZ2U=", caption: "diagram.png" },
      { source: "/tmp/shot.png", caption: "shot" },
      { source: "nodex://files/later" },
    ]);
    // A mention keeps its exact source, a path with spaces included.
    expect(promptInput?.mentions).toEqual([{ name: "notes.md", path: "/tmp/my notes/notes.md" }]);
    expect(promptInput?.text).toBe(
      "Compare  with [Image #2] (caption: shot; path: /tmp/shot.png)\n\nand [Image #3]",
    );
  });

  test("an image is never read as a file mention", () => {
    const promptInput = buildComposerPromptInput({
      prompt: "![shot](/tmp/shot.png)",
      attachments: noAttachments,
    });
    expect(promptInput?.mentions).toBeUndefined();
    expect(promptInput?.images).toEqual([{ source: "/tmp/shot.png", caption: "shot" }]);
  });

  test("a web image stays in the text, and text without images is sent as typed", () => {
    expect(
      buildComposerPromptInput({
        prompt: "See ![build](https://example.com/badge.svg)",
        attachments: noAttachments,
      }),
    ).toBeUndefined();
  });
});
