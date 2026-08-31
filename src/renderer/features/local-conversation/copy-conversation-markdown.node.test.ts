import { describe, expect, test, vi } from "vite-plus/test";
import {
  CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES,
  runCopyConversationMarkdown,
} from "./copy-conversation-markdown";

const stream = (...chunks: string[]): AsyncIterable<string> =>
  (async function* () {
    yield* chunks;
  })();

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
