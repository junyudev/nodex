import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import { readConversationIdentity } from "./conversation-identity";
import { invokeRendererQuery } from "./renderer-command";

vi.mock("./renderer-command", () => ({ invokeRendererQuery: vi.fn() }));

beforeEach(() => {
  vi.mocked(invokeRendererQuery).mockReset();
});

describe("conversation identity reads", () => {
  test.each([
    "nodex:thread:root",
    "thread:task:child",
    "thread:provider:codex:native-thread:019a0000-0000-7000-8000-000000000001",
    "thread:provider:claude:native-thread:child",
    "019a0000-0000-7000-8000-000000000001",
    "opaque-owned-conversation",
  ])("asks the conversation owner to resolve %s", async (threadId) => {
    const identity: ConversationIdentity = {
      execution: "agent-runtime",
      threadId,
      sessionId: "owning-session",
      title: "Research",
      role: "subagent",
      agent: null,
      archived: false,
      host: null,
    };
    vi.mocked(invokeRendererQuery).mockResolvedValue(identity);

    expect(await readConversationIdentity(threadId)).toBe(identity);
    expect(invokeRendererQuery).toHaveBeenCalledExactlyOnceWith(
      "conversation:identity:get",
      threadId,
    );
  });

  test("keeps an unknown conversation unavailable without probing a native provider", async () => {
    vi.mocked(invokeRendererQuery).mockResolvedValue(null);

    expect(await readConversationIdentity("missing-conversation")).toBeNull();
    expect(invokeRendererQuery).toHaveBeenCalledExactlyOnceWith(
      "conversation:identity:get",
      "missing-conversation",
    );
  });

  test("preserves owner failures instead of treating them as a different execution backend", async () => {
    const unavailable = new Error("Execution owner is unavailable");
    vi.mocked(invokeRendererQuery).mockRejectedValue(unavailable);

    await expect(readConversationIdentity("thread:task:child")).rejects.toBe(unavailable);
    expect(invokeRendererQuery).toHaveBeenCalledTimes(1);
  });
});
