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
import { streamdownCodePlugin } from "@/lib/streamdown";
import { installAsyncRequestAnimationFrame } from "./browser-globals";
import { renderWithAppMaitai } from "./app-maitai";
import { openNodexMenu, render, settleAsyncRender, waitForCodeHighlight } from "./dom";

test("code readiness waits for highlighting instead of accepting the plain fallback", async () => {
  let finishHighlight: Parameters<typeof streamdownCodePlugin.highlight>[1];
  const highlight = vi
    .spyOn(streamdownCodePlugin, "highlight")
    .mockImplementation((_options, callback) => {
      finishHighlight = callback;
      return null;
    });
  try {
    const view = renderWithAppMaitai(
      <ReadonlyCodeBlock code="const answer = 42;" language="typescript" />,
    );
    await waitFor(() => expect(highlight).toHaveBeenCalled());

    let ready = false;
    const highlighting = waitForCodeHighlight(view.container).then(() => {
      ready = true;
    });
    await settleAsyncRender();
    const readyBeforeHighlight = ready;
    await act(async () => {
      if (!finishHighlight)
        throw new Error("Expected the mounted code block's highlighter callback");
      finishHighlight({
        bg: "#ffffff",
        fg: "#111111",
        tokens: [[{ content: "const answer = 42;", color: "#123456", offset: 0 }]],
      });
    });
    await highlighting;

    expect(readyBeforeHighlight).toBe(false);
    expect(ready).toBe(true);
  } finally {
    highlight.mockRestore();
  }
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
