import { describe, expect, it } from "vitest";
import { CHAT_REPLY_PREVIEW_LIMIT } from "./chat-reply-preview";
import { presentChatReplyPreview } from "./chat-reply-preview-text";

describe("presentChatReplyPreview", () => {
  it("reads a reply's Markdown as one line of text", () => {
    expect(
      presentChatReplyPreview("## Done\n\n- Fixed **the race** in `sync.ts`\n- Added a test"),
    ).toBe("Done Fixed the race in sync.ts Added a test");
  });

  it("keeps no more of a long reply than a row can show", () => {
    const preview = presentChatReplyPreview("字".repeat(CHAT_REPLY_PREVIEW_LIMIT + 40));
    expect(Array.from(preview ?? "")).toHaveLength(CHAT_REPLY_PREVIEW_LIMIT);
  });

  it("has nothing to show for a reply without readable text", () => {
    expect(presentChatReplyPreview("   \n\n ")).toBeNull();
  });
});
