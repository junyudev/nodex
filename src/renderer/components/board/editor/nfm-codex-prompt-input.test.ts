import { describe, expect, test } from "vite-plus/test";
import { buildCodexPromptInputFromBlockNoteBlocks } from "./nfm-codex-prompt-input";

describe("markdown codex prompt input", () => {
  test("serializes text, thread mentions, images, and agent configs for Codex", () => {
    const promptInput = buildCodexPromptInputFromBlockNoteBlocks([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See ", styles: {} },
          { type: "threadMention", props: { uuid: "thread-123" } },
          { type: "text", text: " with mode ", styles: {} },
          {
            type: "agentConfig",
            props: {
              mode: "plan",
              provider: "openai",
              model: "gpt-5.2-codex",
              reasoning: "high",
              speed: "fast",
            },
          },
        ],
        children: [],
      },
      {
        type: "image",
        props: {
          url: "nodex://assets/image.png",
          caption: "Architecture sketch",
        },
        children: [],
      },
    ]);

    expect(promptInput.text).toBe(
      "See <nodex://sessions/thread-123> with mode&#x20;\n\n[Image #1] (caption: Architecture sketch)",
    );
    expect(promptInput.images?.length).toBe(1);
    expect(promptInput.images?.[0]?.source).toBe("nodex://assets/image.png");
    expect(promptInput.images?.[0]?.caption).toBe("Architecture sketch");
    expect(promptInput.agentConfigs?.length).toBe(1);
    expect(promptInput.agentConfigs?.[0]?.mode).toBe("plan");
    expect(promptInput.agentConfigs?.[0]?.provider).toBe("openai");
    expect(promptInput.agentConfigs?.[0]?.model).toBe("gpt-5.2-codex");
    expect(promptInput.agentConfigs?.[0]?.reasoning).toBe("high");
    expect(promptInput.agentConfigs?.[0]?.speed).toBe("fast");
  });
  test("numbers images in document order with text between them", () => {
    const result = buildCodexPromptInputFromBlockNoteBlocks([
      {
        type: "image",
        props: { url: "https://example.com/first.png", caption: "First diagram" },
        children: [],
      },
      { type: "paragraph", content: [{ type: "text", text: "between", styles: {} }], children: [] },
      { type: "image", props: { url: "/tmp/second.png", caption: "Second diagram" }, children: [] },
    ]);
    expect(result.text).toBe(
      "[Image #1] (caption: First diagram)\n\nbetween\n\n[Image #2] (caption: Second diagram)",
    );
    expect(result.images?.map((image) => image.source)).toEqual([
      "https://example.com/first.png",
      "/tmp/second.png",
    ]);
  });

  test("sends captionless image-only content", () => {
    const result = buildCodexPromptInputFromBlockNoteBlocks([
      { type: "image", props: { url: "nodex://assets/photo.png", caption: "" }, children: [] },
    ]);
    expect(result.text).toBe("[Image #1]");
    expect(result.images).toEqual([{ source: "nodex://assets/photo.png" }]);
  });
});
