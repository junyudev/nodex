import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { waitForStreamdownCodeHighlight } from "@/test/dom";
import { MarkdownRenderer } from "./markdown-renderer";
import { markdownSyntaxEngine } from "@/lib/markdown/markdown-syntax";

const mermaid = vi.hoisted(() => ({
  render: vi.fn(async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
    width: 1,
    height: 1,
  })),
}));
vi.mock("@/lib/mermaid-runtime", async (original) => ({
  ...(await original<typeof import("@/lib/mermaid-runtime")>()),
  renderMermaidDiagram: mermaid.render,
}));

function proseKeys(root: Element): string[] {
  return Array.from(root.querySelectorAll("[data-markdown-segment]")).map((node) =>
    node.getAttribute("data-markdown-segment")!,
  );
}

describe("typed Markdown document through the public rich provider", () => {
  test.each(["alpha\n\n\n\nbeta", "alpha\u2028beta\u2029gamma\u0085delta"])(
    "copies the authored code payload through the public code block: %j",
    async (code) => {
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      try {
        const view = render(
          <NodexTooltipProvider>
            <MarkdownRenderer content={`\`\`\`text\n${code}\n\`\`\``} />
          </NodexTooltipProvider>,
        );
        await waitForStreamdownCodeHighlight(view.container);
        const copy = view.container.querySelector<HTMLButtonElement>(
          '[data-streamdown="code-block-copy-button"]',
        )!;
        await act(async () => {
          fireEvent.click(copy);
          await Promise.resolve();
        });
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    },
  );

  test("commits appended prose immediately on completion and preserves settled nodes through StrictMode", async () => {
    const view = render(
      <StrictMode>
        <MarkdownRenderer content="hello world" parseIncompleteMarkdown animateStreamingText />
      </StrictMode>,
    );
    const original = view.container.querySelector<HTMLSpanElement>("[data-markdown-segment]")!;
    const key = original.getAttribute("data-markdown-segment");
    await act(async () => {
      fireEvent(original, new Event("webkitAnimationEnd", { bubbles: true }));
      await Promise.resolve();
    });
    view.rerender(
      <StrictMode>
        <MarkdownRenderer
          content={"hello world appended\n\nfinal"}
          parseIncompleteMarkdown
          animateStreamingText
        />
      </StrictMode>,
    );
    expect(view.container.querySelector("[data-markdown-segment]")).toBe(original);
    expect(original.getAttribute("data-markdown-segment")).toBe(key);
    expect(original.hasAttribute("data-sd-animate")).toBe(false);
    expect(new Set(proseKeys(view.container)).size).toBe(proseKeys(view.container).length);
    view.rerender(
      <StrictMode>
        <MarkdownRenderer
          content={"hello world appended\n\nfinal"}
          parseIncompleteMarkdown={false}
          animateStreamingText={false}
        />
      </StrictMode>,
    );
    expect(view.container.querySelectorAll("p")[1]?.textContent).toBe("final");
    expect(view.container.querySelector("[data-markdown-segment]")).toBeNull();
    expect(view.container.querySelector("[data-sd-animate]")).toBeNull();
  });
  test("observes same-content syntax changes and equal-length strong, image and code replacements", async () => {
    const view = render(
      <NodexTooltipProvider>
        <MarkdownRenderer content={"first\nother"} />
      </NodexTooltipProvider>,
    );
    expect(view.container.querySelector("br")).toBeNull();
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer content={"first\nother"} preserveLineBreaks />
      </NodexTooltipProvider>,
    );
    expect(view.container.querySelectorAll("br")).toHaveLength(1);
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer
          content={"**first**\n\n![first](https://example.com/a.png)\n\n```text\nfirst\n```"}
        />
      </NodexTooltipProvider>,
    );
    await waitForStreamdownCodeHighlight(view.container);
    const codeButton = view.container.querySelector<HTMLButtonElement>(
      '[data-streamdown="code-block-copy-button"]',
    )!;
    await act(async () => {
      codeButton.focus();
      await Promise.resolve();
    });
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer
          content={"**other**\n\n![other](https://example.com/b.png)\n\n```text\nother\n```"}
        />
      </NodexTooltipProvider>,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-streamdown="code-block"] code')?.textContent?.trim(),
      ).toBe("other"),
    );
    expect(view.container.querySelector("strong")?.textContent).toBe("other");
    expect(view.getByAltText("other").getAttribute("src")).toBe("https://example.com/b.png");
    expect(view.container.querySelector('[data-streamdown="code-block-copy-button"]')).toBe(
      codeButton,
    );
    expect(document.activeElement).toBe(codeButton);
  });
  test("uses the public highlight provider, explicit incomplete code and immediate diagram boundary", async () => {
    mermaid.render.mockClear();
    const view = render(
      <NodexTooltipProvider>
        <MarkdownRenderer content={"```mermaid\ngraph TD; A-->B"} parseIncompleteMarkdown />
      </NodexTooltipProvider>,
    );
    expect(
      view.container.querySelector('[data-streamdown="mermaid-block"] code')?.textContent,
    ).toBe("graph TD; A-->B");
    expect(mermaid.render).not.toHaveBeenCalled();
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer content={"```mermaid\ngraph TD; A-->B\n```"} parseIncompleteMarkdown />
      </NodexTooltipProvider>,
    );
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    await view.findByRole("button", { name: "Download diagram" });
    expect(view.container.querySelector("svg text")?.textContent).toBe("Diagram");
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer content={"```ts\nconst answer = 42"} parseIncompleteMarkdown />
      </NodexTooltipProvider>,
    );
    await waitForStreamdownCodeHighlight(view.container);
    expect(
      view.container
        .querySelector('[data-streamdown="code-block"]')
        ?.getAttribute("data-incomplete"),
    ).toBe("true");
  });
  test("retains embedded image load state and DOM identity when streaming completes", async () => {
    const content = "Before ![retained](https://example.com/image.png) after";
    const view = render(
      <NodexTooltipProvider>
        <MarkdownRenderer content={content} parseIncompleteMarkdown animateStreamingText />
      </NodexTooltipProvider>,
    );
    const image = view.getByAltText("retained");
    await act(async () => {
      fireEvent.load(image);
      await Promise.resolve();
    });
    const download = await view.findByRole("button", { name: "Download image" });
    await act(async () => {
      download.focus();
      await Promise.resolve();
    });
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer
          content={content}
          parseIncompleteMarkdown={false}
          animateStreamingText={false}
        />
      </NodexTooltipProvider>,
    );
    expect(view.getByAltText("retained")).toBe(image);
    expect(view.getByRole("button", { name: "Download image" })).toBe(download);
    expect(document.activeElement).toBe(download);
    view.rerender(
      <NodexTooltipProvider>
        <MarkdownRenderer content={`# New heading\n\n${content}`} />
      </NodexTooltipProvider>,
    );
    expect(view.getByAltText("retained")).toBe(image);
    expect(view.getByRole("button", { name: "Download image" })).toBe(download);
    expect(document.activeElement).toBe(download);
  });

  test("retains distinct loaded image-only paragraphs after a preceding heading is inserted", async () => {
    const content = "![first](https://example.com/a.png)\n\n![other](https://example.com/b.png)";
    const wrap = (source: string) => (
      <NodexTooltipProvider>
        <MarkdownRenderer content={source} />
      </NodexTooltipProvider>
    );
    const view = render(wrap(content));
    const first = view.getByAltText("first");
    const other = view.getByAltText("other");
    await act(async () => {
      fireEvent.load(first);
      fireEvent.load(other);
      await Promise.resolve();
    });
    const controls = await view.findAllByRole("button", { name: "Download image" });
    await act(async () => {
      controls[1]!.focus();
      await Promise.resolve();
    });
    view.rerender(wrap(`# Inserted heading\n\n${content}`));
    expect(view.getByAltText("first")).toBe(first);
    expect(view.getByAltText("other")).toBe(other);
    expect(view.getAllByRole("button", { name: "Download image" })).toEqual(controls);
    expect(document.activeElement).toBe(controls[1]);
  });

  test("keeps immutable prefix HAST transform cost bounded across actual streaming renders", () => {
    markdownSyntaxEngine.resetMeasurements();
    const stable = "# renderer-measurement-unique\n\n";
    const view = render(
      <MarkdownRenderer
        content={`${stable}short tail`}
        parseIncompleteMarkdown
        animateStreamingText
      />,
    );
    const heading = view.container.querySelector("h1");
    const before = markdownSyntaxEngine.getMeasurements();
    view.rerender(
      <MarkdownRenderer
        content={`${stable}short tail\n\nnew tail`}
        parseIncompleteMarkdown
        animateStreamingText
      />,
    );
    const after = markdownSyntaxEngine.getMeasurements();
    expect(view.container.querySelector("h1")).toBe(heading);
    expect(after.parsedUnits - before.parsedUnits).toBe(
      "short tail\n\n".length + "new tail".length,
    );
    expect(after.transformedUnits - before.transformedUnits).toBe(
      "short tail".length + "new tail".length,
    );
  });
});
