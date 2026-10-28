import { act, fireEvent, getConfig, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { HighlightResult } from "@streamdown/code";
import {
  NodexDropdownRoot,
  NodexDropdownTrigger,
  NodexDropdownPortal,
  NodexDropdownContent,
  NodexDropdownItem,
} from "@/components/ui/dropdown";
import { ReadonlyCodeBlock } from "@/components/shared/readonly-code-block";
import { installAsyncRequestAnimationFrame } from "./browser-globals";
import { renderWithAppMaitai } from "./app-maitai";
import { openNodexMenu, render, waitForCodeHighlight } from "./dom";

test("code readiness waits for the plugin beyond the DOM polling budget", async () => {
  const { streamdownCodePlugin } = await import("@/lib/markdown/markdown-code-highlighter");
  const actualHighlight = streamdownCodePlugin.highlight;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  let settledBeforeRelease: boolean | undefined;
  let releaseTask: ReturnType<typeof setTimeout> | undefined;
  let view: ReturnType<typeof renderWithAppMaitai> | undefined;
  const highlight = vi
    .spyOn(streamdownCodePlugin, "highlight")
    .mockImplementation((options, callback) => {
      const accept = (result: HighlightResult) => {
        void released.then(() => callback?.(result));
      };
      const immediate = actualHighlight(options, accept);
      if (immediate) accept(immediate);
      return null;
    });
  try {
    view = renderWithAppMaitai(
      <ReadonlyCodeBlock code="const delayedGrammarProbe = 42;" language="typescript" />,
    );
    expect(view.container.querySelector("code span")).toBeNull();
    // The real token results arrive after the ordinary DOM polling deadline.
    releaseTask = setTimeout(() => {
      settledBeforeRelease = settled;
      release();
    }, getConfig().asyncUtilTimeout * 2);
    await waitForCodeHighlight(view.container);
    settled = true;
    expect(settledBeforeRelease).toBe(false);
    expect(view.container.querySelector("code")?.textContent).toBe(
      "const delayedGrammarProbe = 42;",
    );
  } finally {
    view?.unmount();
    if (releaseTask !== undefined) clearTimeout(releaseTask);
    release();
    highlight.mockRestore();
  }
});

test("code readiness rejects an unhighlighted plain-text fallback", async () => {
  const view = renderWithAppMaitai(
    <ReadonlyCodeBlock code="const answer = 42;" language="unknown-grammar" />,
  );
  expect(view.container.querySelector("code")?.textContent).toBe("const answer = 42;");
  await expect(waitForCodeHighlight(view.container)).rejects.toThrow(
    "Expected code block highlighting to finish.",
  );
});

test("a menu opened with the mouse stays dismissed after selecting an item", async () => {
  // Keep the opening frame pending beyond the helper's ordinary async-render turn.
  installAsyncRequestAnimationFrame(100);
  const changeOpen = vi.fn();
  const view = render(
    <NodexDropdownRoot onOpenChange={changeOpen}>
      <NodexDropdownTrigger>
        <button type="button">Actions</button>
      </NodexDropdownTrigger>
      <NodexDropdownPortal>
        <NodexDropdownContent>
          <NodexDropdownItem>Choose</NodexDropdownItem>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>,
  );
  await openNodexMenu(view.getByRole("button", { name: "Actions" }));
  const item = view.getByRole("menuitem", { name: "Choose" });
  await act(async () => {
    fireEvent.click(item);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
  expect(changeOpen.mock.calls).toEqual([[true], [false]]);
});
