import { StrictMode } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import {
  applyContentSearchDomMarks,
  clearContentSearchMarks,
} from "@/features/content-search/content-search-dom";

const leaf = vi.hoisted(() => ({ renders: [] as string[] }));
vi.mock("@/features/local-conversation/view/local-conversation-inline-visualization", () => ({
  LocalConversationInlineVisualization: ({ file }: { file: string }) => {
    leaf.renders.push(file);
    return <button>{file}</button>;
  },
}));

const context = {
  hostId: "local",
  threadId: "source",
  turnId: "turn",
  markdownStreaming: true,
  readChangedFilePaths: () => [],
};
const message = (content: string, streaming = true) => (
  <StrictMode>
    <NodexTooltipProvider>
      <MarkdownRenderer
        dialect="conversation"
        content={content}
        parseIncompleteMarkdown={streaming}
        animateStreamingText={streaming}
        visualizationContext={context}
      />
    </NodexTooltipProvider>
  </StrictMode>
);

describe("the mounted conversation token document", () => {
  test.each(["- [x] Done\n- [ ] Pending", "- [x] Done\n\n- [ ] Pending"])(
    "renders each task marker once in its tight or loose list: %s",
    async (source) => {
      const view = render(message(source, false));
      try {
        const completed = (await view.findByRole("checkbox", {
          name: "Completed task",
        })) as HTMLInputElement;
        const pending = view.getByRole("checkbox", {
          name: "Incomplete task",
        }) as HTMLInputElement;
        expect(view.getAllByRole("checkbox")).toHaveLength(2);
        expect(completed.checked).toBe(true);
        expect(pending.checked).toBe(false);
        expect(completed.disabled).toBe(true);
        expect(pending.disabled).toBe(true);
        expect(completed.closest("li")).toBe(view.getByText("Done").closest("li"));
        expect(pending.closest("li")).toBe(view.getByText("Pending").closest("li"));
      } finally {
        view.unmount();
      }
    },
  );

  test("keeps mixed media and its paragraph connected when streaming completes", async () => {
    const source =
      "Ordinary paragraph.\n\nBefore **the image** ![Inline image](data:image/png;base64,AA==) *after the image*.";
    const view = render(message(source));
    try {
      const image = await view.findByAltText("Inline image");
      const paragraph = image.closest("div");
      expect(image.closest("p")).toBeNull();
      expect(view.container.querySelector("p")?.textContent).toBe("Ordinary paragraph.");
      view.rerender(message(`${source}\n\nCompleted.`, false));
      expect(view.getByAltText("Inline image")).toBe(image);
      expect(image.closest("div")).toBe(paragraph);
      expect(
        view.getByText("the image").compareDocumentPosition(image) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        image.compareDocumentPosition(view.getByText("after the image")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  test.each([
    ["needle and needle", "needle and needle"],
    ["needle [link](https://example.test) and needle", "needle link and needle"],
    ["needle #112233 and needle", "needle #112233 and needle"],
    ["\\*needle\\* and needle", "*needle* and needle"],
  ])(
    "updates highlighted text without retaining split-node tails: %s",
    async (source, displayed) => {
      const view = render(message(source, false));
      try {
        const paragraph = view.container.querySelector("p")!;
        expect(
          applyContentSearchDomMarks({ root: paragraph, query: "needle", idPrefix: "text" })
            .totalMatches,
        ).toBe(2);
        view.rerender(message(`${source} new ending`, false));
        expect(view.container.querySelector("p")).toBe(paragraph);
        clearContentSearchMarks(paragraph);
        expect(paragraph.textContent).toBe(`${displayed} new ending`);
        expect(
          applyContentSearchDomMarks({ root: paragraph, query: "needle", idPrefix: "text" })
            .totalMatches,
        ).toBe(2);
        view.rerender(message("needle and needle final", false));
        const current = view.container.querySelector("p")!;
        clearContentSearchMarks(current);
        expect(current.textContent).toBe("needle and needle final");
      } finally {
        view.unmount();
      }
    },
  );
  test("keeps both code controls with their authored sources when a new block precedes them", async () => {
    const code = (value: string) => `\`\`\`text\n${value}\n\`\`\``;
    const source = `${code("first")}\n\n${code("second")}`;
    const view = render(message(source, false));
    try {
      const [first, second] = view.getAllByRole("button", { name: "Copy code to clipboard" });
      await act(async () => {
        second!.focus();
        await Promise.resolve();
      });
      view.rerender(message(`${code("inserted")}\n\n${source}`, false));
      const controls = view.getAllByRole("button", { name: "Copy code to clipboard" });
      expect(controls[1]).toBe(first);
      expect(controls[2]).toBe(second);
      expect(document.activeElement).toBe(second);
    } finally {
      view.unmount();
    }
  });
  test.each(["quote", "list"])(
    "keeps separate widgets when another %s precedes their containers",
    async (kind) => {
      const block = (file: string) =>
        kind === "quote"
          ? `> ::codex-inline-vis{file="${file}"}`
          : `- ::codex-inline-vis{file="${file}"}`;
      const source = `${block("one.html")}\n\nSeparator\n\n${block("two.html")}`;
      const view = render(message(source, false));
      try {
        const first = await view.findByRole("button", { name: "one.html" });
        const second = await view.findByRole("button", { name: "two.html" });
        await act(async () => {
          second.focus();
          await Promise.resolve();
        });
        view.rerender(message(`${block("new.html")}\n\nBoundary\n\n${source}`, false));
        expect(view.getByRole("button", { name: "one.html" })).toBe(first);
        expect(view.getByRole("button", { name: "two.html" })).toBe(second);
        expect(document.activeElement).toBe(second);
      } finally {
        view.unmount();
      }
    },
  );
  test("retains a focused interactive leaf when a preceding paragraph is inserted inside its quote", async () => {
    const source = '> Stable\n>\n> ::codex-inline-vis{file="nested.html"}\n>\n> Tail';
    const view = render(message(source));
    try {
      const button = await view.findByRole("button", { name: "nested.html" });
      await act(async () => {
        button.focus();
        await Promise.resolve();
      });
      view.rerender(message(`> Preceding\n>\n${source}`, false));
      await waitFor(() => expect(view.getByRole("button", { name: "nested.html" })).toBe(button));
      expect(document.activeElement).toBe(button);
    } finally {
      view.unmount();
    }
  });
  test("retains a focused widget and stable prefix render boundary through append, insertion and completion", async () => {
    const source = '::codex-inline-vis{file="plot.html"}\n\nGrowing tail';
    const view = render(message(source));
    try {
      const button = await view.findByRole("button", { name: "plot.html" });
      await act(async () => {
        button.focus();
        await Promise.resolve();
      });
      leaf.renders.length = 0;
      view.rerender(message(`${source} appended`));
      expect(leaf.renders).toEqual([]);
      expect(view.getByRole("button", { name: "plot.html" })).toBe(button);
      view.rerender(message(`Preceding text\n\n${source} appended`, false));
      await waitFor(() => expect(view.getByRole("button", { name: "plot.html" })).toBe(button));
      expect(document.activeElement).toBe(button);
    } finally {
      view.unmount();
    }
  });
  test("copies one authored code source and retains its control when source and phase change", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const payload = "alpha\n\n\n\nbeta\u2028gamma\u2029delta\u0085end";
    const source = `\`\`\`text\n${payload}\n\`\`\`\n\ntail`;
    const view = render(message(source));
    try {
      const copy = view.getByRole("button", { name: "Copy code to clipboard" });
      await act(async () => {
        copy.focus();
        fireEvent.click(copy);
        await Promise.resolve();
      });
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(payload));
      view.rerender(message(`Preceding\n\n${source} final`, false));
      expect(view.getByRole("button", { name: "Copied code" })).toBe(copy);
      expect(document.activeElement).toBe(copy);
    } finally {
      view.unmount();
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
  test("uses the actual math phase for errors, independently of text animation", async () => {
    const view = render(message("valid \\(x^2\\) and \\(\\badcommand\\)"));
    try {
      await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull());
      expect(view.queryByText("\\(\\badcommand\\)")).toBeNull();
      view.rerender(message("valid \\(x^2\\) and \\(\\badcommand\\)", false));
      await waitFor(() =>
        expect(
          view.container.querySelectorAll("[data-math-source]")[1]?.querySelector(".katex-html")
            ?.textContent,
        ).toBe("\\badcommand"),
      );
      expect(view.container.querySelector(".katex")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
  test("keeps a manually opened details disclosure across an unrelated tail update", async () => {
    const source = ':::github-details{summary="More" open="false"}\nBody **strong**\n:::\n\ntail';
    const view = render(message(source));
    try {
      const disclosure = view.container.querySelector("details")!;
      await act(async () => {
        disclosure.open = true;
        fireEvent(disclosure, new Event("toggle"));
        await Promise.resolve();
      });
      view.rerender(message(`${source} appended`));
      expect(view.container.querySelector("details")).toBe(disclosure);
      expect(disclosure.open).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
