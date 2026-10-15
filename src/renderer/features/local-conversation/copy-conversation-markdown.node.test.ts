import { describe, expect, test, vi } from "vite-plus/test";
import {
  CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES,
  runCopyConversationMarkdown,
  streamReadOnlyConversationMarkdown,
} from "./copy-conversation-markdown";
import type { CodexConversationTurn } from "../../../shared/types";

const stream = (...chunks: string[]): AsyncIterable<string> =>
  (async function* () {
    yield* chunks;
  })();

test("read-only export keeps late background replies with their source Turn across overlapping pages", async () => {
  const turn = (
    turnId: string,
    itemId: string,
    role: "user" | "assistant",
    text: string,
  ): CodexConversationTurn => ({
    threadId: "thread",
    turnId,
    status: "completed",
    itemIds: [itemId],
    items: [
      {
        threadId: "thread",
        turnId,
        itemId,
        type: role === "user" ? "userMessage" : "agentMessage",
        role,
        kind: role === "user" ? "userMessage" : "assistantMessage",
        markdownText: text,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  const latest = turn("new-run", "new-user", "user", "New task");
  const lateReply = turn("old-run", "old-answer", "assistant", "Original background reply");
  const original = turn("old-run", "old-user", "user", "Original task");
  const readPage = vi
    .fn()
    .mockResolvedValueOnce({ turns: [latest, lateReply], olderCursor: "older" })
    .mockResolvedValueOnce({ turns: [original, lateReply], olderCursor: null });
  const chunks: string[] = [];
  for await (const chunk of streamReadOnlyConversationMarkdown({
    title: "History",
    cwd: null,
    signal: new AbortController().signal,
    readPage,
  }))
    chunks.push(chunk);
  const markdown = chunks.join("");
  expect(readPage.mock.calls).toEqual([[null], ["older"]]);
  expect(markdown.indexOf("Original task")).toBeLessThan(
    markdown.indexOf("Original background reply"),
  );
  expect(markdown.indexOf("Original background reply")).toBeLessThan(markdown.indexOf("New task"));
  expect(markdown.split("Original background reply")).toHaveLength(2);
});

describe("runCopyConversationMarkdown", () => {
  test("collects bounded stream pages and writes the complete document byte-for-byte", async () => {
    const calls: string[] = [];
    const value = `# Transcript\n\n${"x".repeat(80_500)}\n`;
    const writeText = vi.fn(async (markdown: string) => {
      calls.push("write");
      expect(markdown).toBe(value);
    });
    const showSuccess = vi.fn();
    await runCopyConversationMarkdown({
      streamMarkdown: () => {
        calls.push("stream");
        return stream("# Transcript", `\n\n${"x".repeat(80_500)}`, "\n");
      },
      writeText,
      showSuccess,
      showTooLarge: vi.fn(),
      showError: vi.fn(),
    });

    expect(calls).toEqual(["stream", "write"]);
    expect(showSuccess).toHaveBeenCalledOnce();
  });

  test("silently ignores an empty export", async () => {
    const writeText = vi.fn();
    const showSuccess = vi.fn();
    const showError = vi.fn();
    await runCopyConversationMarkdown({
      streamMarkdown: () => stream(),
      writeText,
      showSuccess,
      showTooLarge: vi.fn(),
      showError,
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(showSuccess).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  test("fails safely before allocating an oversized clipboard document", async () => {
    const showTooLarge = vi.fn();
    const writeText = vi.fn();
    await runCopyConversationMarkdown({
      streamMarkdown: () => stream("x".repeat(CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES + 1)),
      writeText,
      showSuccess: vi.fn(),
      showTooLarge,
      showError: vi.fn(),
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(showTooLarge).toHaveBeenCalledWith(CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES);
  });

  test("uses the failure toast for stream and clipboard errors", async () => {
    for (const failingStep of ["stream", "clipboard"] as const) {
      const showError = vi.fn();
      await runCopyConversationMarkdown({
        streamMarkdown: () =>
          failingStep === "stream"
            ? (async function* () {
                yield await Promise.reject<string>(new Error("stream"));
              })()
            : stream("# Transcript\n"),
        writeText: async () => {
          if (failingStep === "clipboard") throw new Error("clipboard");
        },
        showSuccess: vi.fn(),
        showTooLarge: vi.fn(),
        showError,
      });
      expect(showError).toHaveBeenCalledOnce();
    }
  });

  test("cancellation stops collection without reporting a failure", async () => {
    const controller = new AbortController();
    const showError = vi.fn();
    const writeText = vi.fn();
    await runCopyConversationMarkdown({
      signal: controller.signal,
      streamMarkdown: () =>
        (async function* () {
          yield "# Transcript";
          controller.abort();
          yield "\nnot copied";
        })(),
      writeText,
      showSuccess: vi.fn(),
      showTooLarge: vi.fn(),
      showError,
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});
