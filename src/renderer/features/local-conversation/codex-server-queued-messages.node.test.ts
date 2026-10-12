import { expect, test, vi } from "vite-plus/test";
import { prepareUntrustedAppInput } from "../../../shared/codex-untrusted-app-input";
import {
  CodexServerQueuedMessages,
  type CodexServerQueuedMessagesOptions,
} from "./codex-server-queued-messages";

test("reconstructs hosted images and preserves their native details when a queued message is removed", async () => {
  const input = [{ type: "image" as const, fileId: "file-123", detail: "original" as const }];
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list")
      return {
        data: [
          {
            id: "queued-1",
            clientUserMessageId: "client-1",
            input: input.map((image) => ({ ...image, url: 123 })),
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/queue/delete") return { deleted: true };
    throw new Error(`Unexpected request: ${method}`);
  });
  const queue = new CodexServerQueuedMessages({
    request: request as CodexServerQueuedMessagesOptions["request"],
    compileInput: () => ({ input: [], responseItems: [] }),
    getConversationCwd: () => "/workspace",
    isConversationInterrupted: () => false,
    isConversationStreaming: () => false,
    onQueueChanged: () => {},
  });
  try {
    await queue.load("thread-1");
    expect(queue.read("thread-1")?.[0]?.context.imageAttachments).toEqual([
      { source: "file-service://file-123" },
    ]);
    const removed = await queue.remove("thread-1", "queued-1");
    expect(removed?.serverSubmission.input).toEqual(input);
    expect(queue.read("thread-1")).toEqual([]);
  } finally {
    queue[Symbol.dispose]();
  }
});

test.each(["pair", "placeholder"] as const)(
  "refuses %s app input before server queue mutation",
  async (form) => {
    const compiled = prepareUntrustedAppInput(
      "Use the selected variant",
      {
        mcpAppModelContextAttachments: [
          {
            id: "/widget.html",
            kind: "context",
            sourceName: "Changes",
            text: null,
            structuredContent: { selectedVariants: [{ carousel: 0, variant: "Dots" }] },
            imageAttachments: [],
            untrusted: true,
          },
        ],
      },
      "annotation-call",
    );
    const request = vi.fn(async (method: string) => {
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected native queue mutation ${method}`);
    });
    const queue = new CodexServerQueuedMessages({
      request: request as CodexServerQueuedMessagesOptions["request"],
      compileInput: () => ({
        input: form === "pair" ? [] : [compiled.input],
        responseItems: form === "pair" ? compiled.responseItems : [],
      }),
      getConversationCwd: () => "/workspace",
      isConversationInterrupted: () => false,
      isConversationStreaming: () => false,
      onQueueChanged: () => {},
    });
    try {
      await expect(
        queue.enqueue("thread-1", {
          id: "message",
          cwd: "/workspace",
          context: {
            prompt: "Use the selected variant",
            fileAttachments: [],
            addedFiles: [],
            commentAttachments: [],
            imageAttachments: [],
          },
        }),
      ).rejects.toThrow("requires confirmation");
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list"]);
      expect(queue.read("thread-1")).toEqual([]);
    } finally {
      queue[Symbol.dispose]();
    }
  },
);
