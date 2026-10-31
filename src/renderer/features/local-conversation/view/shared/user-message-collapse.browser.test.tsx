import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { TestQueryProvider } from "@/test/query";
import { describe, expect, test } from "vite-plus/test";
import "../../../../globals.css";
import { waitForCodeHighlight } from "../../../../test/dom";
import { MessageText } from "@/components/message/message-document";

const render = (ui: ReactElement) => renderWithAppMaitai(ui, { wrapper: TestQueryProvider });

describe("MessageText browser collapse", () => {
  test("measures real layout and removes clipped links from keyboard navigation", async () => {
    const message = Array.from(
      { length: 60 },
      (_value, index) => `[Reference ${index + 1}](https://example.test/${index + 1})`,
    ).join("\n");
    const view = render(
      <div style={{ width: 420 }}>
        <MessageText text={message} collapsedLineCount={5} />
      </div>,
    );

    const showMore = await view.findByRole("button", { name: "Show more" });
    const links = view.getAllByRole("link", { hidden: true });
    const clippedLink = links.at(-1);
    expect(clippedLink).toBeDefined();
    if (!clippedLink) throw new Error("Expected the final message link");

    await waitFor(() => {
      expect(clippedLink.getAttribute("aria-hidden")).toBe("true");
      expect(clippedLink.hasAttribute("inert")).toBe(true);
    });

    await act(async () => {
      fireEvent.click(showMore);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
        "true",
      );
      expect(clippedLink.getAttribute("aria-hidden")).toBeNull();
      expect(clippedLink.hasAttribute("inert")).toBe(false);
    });
  });
  test("reserves the final collapsed line for an ellipsis and keeps a crossing code block whole", async () => {
    const tick = String.fromCharCode(96);
    const fence = tick.repeat(3);
    const codeText = Array.from(
      { length: 12 },
      (_, index) => `const codeLine${index} = ${index};`,
    ).join("\n");
    const text =
      "Before code\n\n" +
      fence +
      "typescript\n" +
      codeText +
      "\n" +
      fence +
      "\n\n" +
      Array.from({ length: 30 }, (_, index) => `After code ${index}`).join("\n");
    const view = render(
      <div style={{ width: 420 }}>
        <MessageText text={text} collapsedLineCount={5} />
      </div>,
    );
    await waitForCodeHighlight(view.container);
    await view.findByRole("button", { name: "Show more" });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const code = view.container.querySelector<HTMLElement>("[data-readonly-code-block]");
    const clip = code?.closest(".codex-markdown-user")?.parentElement?.parentElement;
    if (!code || !clip) throw new Error("Expected a mounted code block and clipping viewport");
    await waitFor(() =>
      expect(code.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        clip.getBoundingClientRect().bottom + 1,
      ),
    );
    const ellipsis = clip.nextElementSibling as HTMLElement;
    expect(ellipsis.textContent).toBe("…");
    expect(ellipsis.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(clip.style.maxHeight).toBe(
      `${Math.ceil(code.getBoundingClientRect().bottom - clip.getBoundingClientRect().top)}px`,
    );
  });
});
