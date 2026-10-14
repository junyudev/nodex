import { StrictMode } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { MarkdownRenderer } from "./markdown-renderer";
import { revealContentSearchUnit } from "../../../../content-search/content-search-reveal-owner";

const source = ':::github-details{summary="More" open="false"}\nBody **strong**\n:::\n\nTail';
const message = (content: string, streaming = true) => (
  <StrictMode>
    <NodexTooltipProvider>
      <MarkdownRenderer
        dialect="conversation"
        content={content}
        parseIncompleteMarkdown={streaming}
      />
    </NodexTooltipProvider>
  </StrictMode>
);

describe("mounted directive disclosures", () => {
  test("registers the real disclosure and releases it when its document is removed", async () => {
    const view = render(message(source));
    const details = view.container.querySelector("details")!;
    try {
      expect(details.open).toBe(false);
      await act(async () => {
        expect(revealContentSearchUnit(view.container)).toBe(true);
        await Promise.resolve();
      });
      expect(details.open).toBe(true);
      view.rerender(message("Replaced"));
      details.open = false;
      const retired = document.createElement("div");
      retired.append(details);
      expect(revealContentSearchUnit(retired)).toBe(false);
      expect(details.open).toBe(false);
    } finally {
      view.unmount();
    }
  });

  test("retains a manually opened disclosure and nested content through prefix, tail and terminal updates", async () => {
    const view = render(message(source));
    try {
      const details = view.container.querySelector("details")!;
      const strong = view.getByText("strong", { selector: "strong" });
      await act(async () => {
        details.open = true;
        fireEvent(details, new Event("toggle"));
        await Promise.resolve();
      });
      view.rerender(message(`Preceding\n\n${source} appended`));
      view.rerender(message(`Preceding\n\n${source} appended`, false));
      await waitFor(() => expect(view.container.querySelector("details")).toBe(details));
      expect(details.open).toBe(true);
      expect(view.getByText("strong", { selector: "strong" })).toBe(strong);
    } finally {
      view.unmount();
    }
  });

  test("does not create a summary label while preserving unknown raw and metadata-null behavior", () => {
    const unknown = ':::unknown-next{title="Keep"}\nAuthored body\n:::';
    const view = render(
      message(`:::github-details\nBody\n:::\n\n::inbox-item{title="No UI"}\n\n${unknown}`, false),
    );
    try {
      expect(view.container.querySelector("summary")?.textContent).toBe("");
      expect(view.getByText(unknown, { normalizer: (value) => value })).toBeTruthy();
      expect(view.queryByText("No UI")).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
