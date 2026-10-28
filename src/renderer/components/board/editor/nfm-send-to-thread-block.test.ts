import { describe, expect, test } from "vite-plus/test";
import { writeMarkdown, type MarkdownBlock } from "../../../../shared/nodex-markdown";
import { isUuidV7 } from "../../../../shared/uuid-v7";
import { createSendToThreadToggleBlock } from "./nfm-send-to-thread-block";

describe("markdown send-to-thread block", () => {
  test("allocates a canonical Block identity by default", () => {
    const block = createSendToThreadToggleBlock({
      sessionId: "thread-123",
      children: [],
    });

    expect(isUuidV7(block.id)).toBe(true);
  });

  test("creates a collapsed toggle with a thread mention and preserved children", () => {
    const block = createSendToThreadToggleBlock({
      blockId: "sent-toggle",
      sessionId: "thread-123",
      children: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Original note", styles: {} }],
          children: [],
        },
      ],
    });

    const markdown = writeMarkdown([block]);
    expect(markdown).toBe(":::toggle[sent to <nodex://sessions/thread-123>]\n  Original note\n:::");
  });
});
