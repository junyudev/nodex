import { describe, expect, test } from "vite-plus/test";
import { buildCodexPromptInputFromBlockNoteBlocks } from "./nfm-codex-prompt-input";

describe("nfm codex prompt input", () => {
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
              permission: "auto",
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
      "See [Thread: thread-123] with mode\n[Image #1] (caption: Architecture sketch)",
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
    expect(promptInput.agentConfigs?.[0]?.permission).toBe("auto");
  });
});
