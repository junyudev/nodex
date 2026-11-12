import { assert, it } from "@effect/vitest";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  nativeSessionAttachmentResource,
  nativeSessionMediaResources,
} from "./NativeAttachmentResource.ts";

const generatedImage = {
  type: "imageGeneration",
  id: "generated-1",
  status: "completed",
  revisedPrompt: null,
  failure: null,
  generationId: null,
} as const;

it("retains inline image bytes even when the saved file is unavailable", () => {
  const item = {
    ...generatedImage,
    result: "AQID",
    savedPath: "/missing/image.png",
  } satisfies ThreadItem;
  assert.deepEqual(nativeSessionAttachmentResource(item, "image"), {
    name: "Generated image.png",
    source: "data:image/png;base64,AQID",
    mimeType: "image/png",
  });
});

it("uses a saved image file when the producer retains an opaque file ID", () => {
  const item = {
    ...generatedImage,
    fileId: "opaque-image",
    savedPath: "/images/generated.png",
  } satisfies ThreadItem;
  assert.equal(nativeSessionAttachmentResource(item, "image")?.source, "/images/generated.png");
});

it("keeps an opaque generated image visible to import admission without inventing a byte source", () => {
  const item = { ...generatedImage, fileId: "opaque-image" } satisfies ThreadItem;
  assert.deepEqual(nativeSessionMediaResources(item), [
    { id: "image", media: "image", resource: null },
  ]);
});

it("keeps hosted audio visible to import admission without treating its file ID as a URL", () => {
  const item = {
    type: "userMessage",
    id: "message",
    clientId: null,
    content: [
      { type: "audio", fileId: "opaque-audio" },
      { type: "audio", url: "https://example.invalid/audio.wav" },
    ],
  } satisfies ThreadItem;
  assert.deepEqual(nativeSessionMediaResources(item), [
    { id: "input:0", media: "audio", resource: null },
    {
      id: "input:1",
      media: "audio",
      resource: { name: "Attached audio", source: "https://example.invalid/audio.wav" },
    },
  ]);
});
