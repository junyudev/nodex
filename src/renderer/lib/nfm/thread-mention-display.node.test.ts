import { describe, expect, test } from "vite-plus/test";
import type { CodexThreadSummary } from "@/lib/types";
import { resolveThreadMentionDisplay } from "./thread-mention-display";

const thread = (overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary => ({
  threadId: "thread-mention",
  projectId: "project-1",
  source: null,
  threadName: null,
  threadPreview: "",
  modelProvider: "openai",
  cwd: null,
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  linkedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("resolveThreadMentionDisplay", () => {
  test("projects stored Markdown before presenting a thread label", () => {
    expect(
      resolveThreadMentionDisplay({
        uuid: "thread-mention",
        thread: thread({ threadName: "**Review** [changes](https://example.com)" }),
      }).label,
    ).toBe("Review changes");
  });
});
