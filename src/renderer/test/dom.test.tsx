import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { ReadonlyCodeBlock } from "@/components/shared/readonly-code-block";
import { streamdownCodePlugin } from "@/lib/streamdown";
import { settleAsyncRender, waitForCodeHighlight } from "./dom";

test("code readiness waits for highlighting instead of accepting the plain fallback", async () => {
  let finishHighlight: Parameters<typeof streamdownCodePlugin.highlight>[1];
  const highlight = vi
    .spyOn(streamdownCodePlugin, "highlight")
    .mockImplementation((_options, callback) => {
      finishHighlight = callback;
      return null;
    });
  try {
    const view = render(<ReadonlyCodeBlock code="const answer = 42;" language="typescript" />);
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
