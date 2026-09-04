import { describe, expect, test } from "vite-plus/test";
import { act, waitFor } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import { settleAsyncRender, waitForStreamdownCodeHighlight } from "../../../../../test/dom";
import { MarkdownRenderer } from "./markdown-renderer";

const FENCED_TYPESCRIPT_CODE = [
  "function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "const result = add(1, 1);",
  "console.log(result);",
].join("\n");

const FENCED_TYPESCRIPT_MARKDOWN = ["```ts", FENCED_TYPESCRIPT_CODE, "```"].join("\n");

describe("MarkdownRenderer", () => {
  test("renders inline code with the shared inline-markdown span contract", async () => {
    const { container } = render(<MarkdownRenderer content={"Run `bun test` before shipping."} />);

    await settleAsyncRender();

    const inlineCode = container.querySelector("span.inline-markdown");
    expect(Boolean(inlineCode)).toBe(true);
    expect(inlineCode?.textContent).toBe("bun test");
    expect(container.querySelector(".codex-markdown code") === null).toBe(true);
  });

  test("marks heading inline code with the heading-inline-code scope", async () => {
    const { container } = render(<MarkdownRenderer content={"## Heading with `inline code`"} />);

    await settleAsyncRender();

    const heading = container.querySelector("h2");
    const inlineCode = heading?.querySelector("span.inline-markdown");
    expect(Boolean(inlineCode)).toBe(true);
    expect(inlineCode?.textContent).toBe("inline code");
  });

  test("renders paragraph, heading, list, blockquote, table, and details as semantic content", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          "# Heading One",
          "",
          "Paragraph body with a [link](https://example.com).",
          "",
          "- First bullet",
          "- Second bullet",
          "",
          "> Quote block",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| Foo | Bar |",
          "",
          "<details><summary>More</summary>Body</details>",
        ].join("\n")}
      />,
    );

    await settleAsyncRender();

    const paragraph = container.querySelector("p");
    const heading = container.querySelector("h1");
    const listItem = container.querySelector("li");
    const link = container.querySelector("a");
    const blockquote = container.querySelector("blockquote");
    const table = container.querySelector("table");
    const summary = container.querySelector("summary");
    const tableHeadingCell = container.querySelector("th");
    const tableCell = container.querySelector("td");

    expect(paragraph?.textContent).toBe("Paragraph body with a link.");
    expect(heading?.textContent).toBe("Heading One");
    expect(listItem?.textContent).toBe("First bullet");
    expect(link?.getAttribute("href")).toBe("https://example.com/");
    expect(blockquote?.textContent?.trim()).toBe("Quote block");
    expect(Boolean(table)).toBe(true);
    expect(summary?.textContent).toBe("More");
    expect(tableHeadingCell?.textContent).toBe("Name");
    expect(tableCell?.textContent).toBe("Foo");
  });

  test("groups ordered lists by digit width like Codex Electron", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={["99. Ninety-nine", "100. One hundred", "101. One hundred one"].join("\n")}
      />,
    );

    await settleAsyncRender();

    const orderedLists = Array.from(container.querySelectorAll("ol"));
    expect(orderedLists.length).toBe(2);
    expect(orderedLists[0]?.getAttribute("start")).toBe("99");
    expect(orderedLists[1]?.getAttribute("start")).toBe("100");
  });

  test("renders local file links as semantic file references", async () => {
    const { container } = render(
      <NodexTooltipProvider>
        <MarkdownRenderer content={"- [/tmp/example.ts#L12](/tmp/example.ts#L12)"} />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    const link = container.querySelector("button[data-file-reference='true']");
    expect(Boolean(link)).toBe(true);
    expect(link?.textContent).toBe("/tmp/example.ts#L12");
  });

  test("keeps fenced code blocks on the highlighted code-block renderer path", async () => {
    const { container } = render(<MarkdownRenderer content={FENCED_TYPESCRIPT_MARKDOWN} />);

    await waitForStreamdownCodeHighlight(container);

    expect(container.querySelector('[data-streamdown="code-block"]') !== null).toBe(true);
    const code = container.querySelector('[data-streamdown="code-block"] code');
    expect(code !== null).toBe(true);
    expect(code?.querySelectorAll(":scope > span").length).toBe(6);
    expect(code?.querySelector(':scope > span > span[style*="--sdm-c"]') !== null).toBe(true);
    expect(
      container.querySelector('[data-streamdown="code-block"] .inline-markdown') === null,
    ).toBe(true);
    expect(container.querySelector('[data-streamdown="code-block-copy-button"]') !== null).toBe(
      true,
    );
    expect(container.querySelector('[data-streamdown="code-block-download-button"]') === null).toBe(
      true,
    );
  });

  test("copies fenced code through the Nodex clipboard fallback with line breaks intact", async () => {
    let copiedText = "";
    const originalClipboard = navigator.clipboard;
    const originalExecCommand = document.execCommand;

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard permission denied");
        },
      } as unknown as Clipboard,
    });

    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string) => {
        if (command !== "copy") return false;
        copiedText = document.querySelector("textarea")?.value ?? "";
        return true;
      },
    });

    try {
      const { container } = render(<MarkdownRenderer content={FENCED_TYPESCRIPT_MARKDOWN} />);

      await waitForStreamdownCodeHighlight(container);

      const copyButton = container.querySelector<HTMLButtonElement>(
        '[data-streamdown="code-block-copy-button"]',
      );
      expect(copyButton !== null).toBe(true);

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      await waitFor(() => {
        if (copiedText !== FENCED_TYPESCRIPT_CODE) {
          throw new Error("Expected code block copy fallback to preserve source lines.");
        }
      });

      expect(copiedText).toBe(FENCED_TYPESCRIPT_CODE);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: originalExecCommand,
      });
    }
  });

  test("adds Streamdown word-fade markers for streaming assistant prose", async () => {
    const { container } = render(
      <MarkdownRenderer
        content="Investigating the Storybook regression while comparing the streaming transcript against Codex Electron behavior."
        parseIncompleteMarkdown
        animateStreamingText
      />,
    );

    await settleAsyncRender();

    expect(container.querySelectorAll("[data-sd-animate]").length > 0).toBe(true);
  });

  test("keeps completed prose static even when animation support is enabled", async () => {
    const { container } = render(
      <MarkdownRenderer
        content="Completed assistant prose should render statically once the turn finishes."
        animateStreamingText
      />,
    );

    await settleAsyncRender();

    expect(container.querySelector("[data-sd-animate]") === null).toBe(true);
  });
});
