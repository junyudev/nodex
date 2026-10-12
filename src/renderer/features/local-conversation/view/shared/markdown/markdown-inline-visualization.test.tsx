import { describe, expect, test, vi } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import { MarkdownRenderer } from "./markdown-renderer";
import { stripCodexRemarkDirectiveLines } from "../../../../../../shared/codex-remark-directives";
import { projectAssistantText } from "../../../../../../shared/codex-canonical-item-projector";

vi.mock("../../local-conversation-inline-visualization", () => ({
  LocalConversationInlineVisualization: ({
    file,
    sourceThreadId,
    mode,
  }: {
    file: string;
    sourceThreadId?: string;
    mode?: string;
  }) => (
    <button data-source-thread={sourceThreadId} data-mode={mode}>
      {file}
    </button>
  ),
}));

describe("assistant Markdown inline visualizations", () => {
  test("retains an interactive leaf and its focus when an assistant response finishes", async () => {
    const content = 'Before\n\n::codex-inline-vis{file="plot.html"}\n\nAfter';
    const context = {
      hostId: "local",
      threadId: "visible",
      turnId: "turn",
      markdownStreaming: true,
      readChangedFilePaths: () => [],
    };
    const mounted = render(
      <MarkdownRenderer
        content={content}
        parseIncompleteMarkdown
        animateStreamingText
        visualizationContext={context}
      />,
    );
    const original = await screen.findByRole("button", { name: "plot.html" });
    await act(async () => {
      original.focus();
      await Promise.resolve();
    });
    mounted.rerender(
      <MarkdownRenderer
        content={content}
        parseIncompleteMarkdown={false}
        visualizationContext={{ ...context, markdownStreaming: false }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "plot.html" })).toBe(original));
    expect(document.activeElement).toBe(original);
  });
  test.each(["", "<oai-mem-citation>hidden</oai-mem-citation>\n"])(
    "preserves an indented code example through assistant text projection (%s)",
    async (prefix) => {
      const literal = '::codex-inline-vis{file="literal.html"}';
      const content = stripCodexRemarkDirectiveLines(
        projectAssistantText(`${prefix}    ${literal}`, false),
        { keepInlineVisualizations: true },
      );
      render(
        <MarkdownRenderer
          content={content}
          visualizationContext={{
            hostId: "local",
            threadId: "visible",
            turnId: "turn",
            markdownStreaming: false,
            readChangedFilePaths: () => [],
          }}
        />,
      );
      await screen.findByText(literal);
      expect(screen.queryByRole("button", { name: "literal.html" })).toBeNull();
    },
  );
  test("renders the directive in place with its source Thread, while leaving fenced examples literal", async () => {
    render(
      <MarkdownRenderer
        content={
          'Before\n\n::codex-inline-vis{threadId="source-thread" mode="wide" file="plot.html"}\n\nAfter\n\n```md\n::codex-inline-vis{file="literal.html"}\n```'
        }
        visualizationContext={{
          hostId: "local",
          threadId: "visible",
          turnId: "turn",
          markdownStreaming: false,
          readChangedFilePaths: () => [],
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "plot.html" })).toBeDefined());
    expect(
      screen.getByRole("button", { name: "plot.html" }).getAttribute("data-source-thread"),
    ).toBe("source-thread");
    expect(screen.getByRole("button", { name: "plot.html" }).getAttribute("data-mode")).toBe(
      "wide",
    );
    expect(screen.queryByRole("button", { name: "literal.html" })).toBeNull();
  });
  test("does not execute visualization directives in a user/plain Markdown context", async () => {
    render(<MarkdownRenderer content={'::codex-inline-vis{file="plot.html"}'} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "plot.html" })).toBeNull());
  });
});
