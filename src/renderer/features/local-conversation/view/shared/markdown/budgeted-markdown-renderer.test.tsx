import { describe, expect, test, vi } from "vite-plus/test";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { settleLazyRender } from "@/test/dom";

const richRenderCalls = vi.hoisted(() => vi.fn());

vi.mock("./markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => {
    richRenderCalls(content.length);
    return <div data-rich-markdown="true" />;
  },
}));

import {
  BudgetedMarkdownRenderer,
  RICH_MARKDOWN_MAX_BYTES,
  RICH_MARKDOWN_MAX_LINES,
} from "./budgeted-markdown-renderer";

describe("BudgetedMarkdownRenderer", () => {
  test("keeps byte and line budgets inclusive", () => {
    richRenderCalls.mockClear();
    const exactBytes = render(
      <BudgetedMarkdownRenderer
        content={"x".repeat(RICH_MARKDOWN_MAX_BYTES)}
        sourceAriaLabel="Exact byte source"
      />,
    );
    expect(exactBytes.container.querySelector("[data-rich-markdown='true']")).not.toBeNull();

    const exactLines = render(
      <BudgetedMarkdownRenderer
        content={`${"x\n".repeat(RICH_MARKDOWN_MAX_LINES - 1)}x`}
        sourceAriaLabel="Exact line source"
      />,
    );
    expect(exactLines.container.querySelector("[data-rich-markdown='true']")).not.toBeNull();
    expect(richRenderCalls).toHaveBeenCalledTimes(2);
  });

  test("bypasses rich Markdown and opens exact source when either budget is exceeded", async () => {
    richRenderCalls.mockClear();
    const bytes = render(
      <BudgetedMarkdownRenderer
        content={"x".repeat(RICH_MARKDOWN_MAX_BYTES + 1)}
        sourceAriaLabel="Large byte source"
      />,
    );
    const lines = render(
      <BudgetedMarkdownRenderer
        content={`${"x\n".repeat(RICH_MARKDOWN_MAX_LINES)}x`}
        sourceAriaLabel="Large line source"
      />,
    );
    await settleLazyRender();

    expect(richRenderCalls).not.toHaveBeenCalled();
    expect(bytes.container.textContent).toContain("Rich preview is unavailable for large content.");
    expect(lines.container.textContent).toContain("Rich preview is unavailable for large content.");
    expect(bytes.getByRole("region", { name: "Large byte source" })).toBeTruthy();
    expect(lines.getByRole("region", { name: "Large line source" })).toBeTruthy();
  });
});
