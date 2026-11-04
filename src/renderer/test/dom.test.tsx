import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
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

const CODE_READINESS_PROBE_TIMEOUT_MS = 1_000;

test("code readiness waits for the queued token result", async () => {
  const client = await import("@/lib/markdown/markdown-code-highlight-client");
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let view: ReturnType<typeof renderWithAppMaitai> | undefined;
  const highlight = vi
    .spyOn(client, "requestCodeHighlight")
    .mockImplementation((input, onResult) => {
      let active = true;
      void released.then(() => {
        if (!active) return;
        onResult({
          ...input,
          paint: { tokens: [[{ content: input.code, offset: 0, color: "var(--foreground)" }]] },
        });
      });
      return () => {
        active = false;
      };
    });
  try {
    view = renderWithAppMaitai(
      <ReadonlyCodeBlock code="const delayedGrammarProbe = 42;" language="typescript" />,
    );
    expect(view.container.querySelector("code span")).toBeNull();
    let settled = false;
    const ready = waitForCodeHighlight(view.container).then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The plain code is on screen, but readiness holds until its tokens arrive.
    expect(settled).toBe(false);
    await act(async () => {
      release();
      await released;
    });
    await ready;
    expect(view.container.querySelector("code")?.textContent).toBe(
      "const delayedGrammarProbe = 42;",
    );
  } finally {
    view?.unmount();
    release();
    highlight.mockRestore();
  }
});

test("code readiness rejects an unhighlighted plain-text fallback", async () => {
  const view = renderWithAppMaitai(
    <ReadonlyCodeBlock code="const answer = 42;" language="unknown-grammar" />,
  );
  expect(view.container.querySelector("code")?.textContent).toBe("const answer = 42;");
  await expect(
    waitForCodeHighlight(view.container, { timeout: CODE_READINESS_PROBE_TIMEOUT_MS }),
  ).rejects.toThrow("Expected code block highlighting to finish.");
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
