import { describe, expect, it } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import {
  isCodexProtocolThreadItem,
  parseCodexProtocolThreadItem,
} from "./codex-protocol-thread-item";

describe("generated Codex ThreadItem runtime boundary", () => {
  it("accepts representative current variants", () => {
    const values = [
      { type: "plan", id: "plan-1", text: "Ship it" },
      {
        type: "userMessage",
        id: "user-1",
        clientId: null,
        content: [{ type: "text", text: "Hello", text_elements: [] }],
      },
      { type: "contextCompaction", id: "compact-1" },
    ] satisfies ThreadItem[];

    expect(values.every(isCodexProtocolThreadItem)).toBe(true);
    expect(parseCodexProtocolThreadItem(values[0])).toEqual({
      ...values[0],
      startedAtMs: null,
      completedAtMs: null,
    });
  });

  it("rejects an invalid nested field", () => {
    expect(
      isCodexProtocolThreadItem({
        type: "userMessage",
        id: "user-1",
        clientId: null,
        content: [{ type: "text", text: 42, text_elements: [] }],
      }),
    ).toBe(false);
  });

  it.each([{ url: "https://example.com/image.png" }, { fileId: "file_123" }])(
    "preserves the image source %j through the runtime boundary",
    (source) => {
      const item = {
        type: "userMessage",
        id: "image-1",
        clientId: null,
        content: [{ type: "image", detail: "original", ...source }],
      } satisfies ThreadItem;

      expect(parseCodexProtocolThreadItem(item)).toEqual({
        ...item,
        startedAtMs: null,
        completedAtMs: null,
      });
    },
  );

  it("rejects an image without a source", () => {
    expect(
      parseCodexProtocolThreadItem({
        type: "userMessage",
        id: "image-1",
        clientId: null,
        content: [{ type: "image", detail: "original" }],
      }),
    ).toBeNull();
  });

  it.each([{ result: "aW1hZ2U=" }, { fileId: "file_123" }])(
    "preserves a generated image source and lifecycle times %j",
    (source) => {
      const item = {
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        generationId: null,
        transparentBackground: false,
        startedAtMs: 1_000,
        completedAtMs: 2_000,
        ...source,
      } satisfies ThreadItem;

      expect(parseCodexProtocolThreadItem(item)).toEqual(item);
    },
  );

  it("rejects a generated image without a source", () => {
    expect(
      parseCodexProtocolThreadItem({
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        generationId: null,
      }),
    ).toBeNull();
  });

  it("rejects an unknown variant instead of casting it into the generated union", () => {
    expect(
      parseCodexProtocolThreadItem({
        type: "futureItem",
        id: "future-1",
      }),
    ).toBeNull();
  });
});
