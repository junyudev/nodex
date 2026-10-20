import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { Streamdown, type CodeHighlighterPlugin } from "streamdown";
import { streamdownCodePlugin } from "@/lib/streamdown";
import { settleAsyncRender, waitForStreamdownCodeHighlight } from "./dom";

test("code readiness waits for highlighting instead of accepting the plain fallback", async () => {
  let finishHighlight: Parameters<CodeHighlighterPlugin["highlight"]>[1];
  const highlight = vi.fn<CodeHighlighterPlugin["highlight"]>((_options, callback) => {
    finishHighlight = callback;
    return null;
  });
  const view = render(
    <Streamdown plugins={{ code: { ...streamdownCodePlugin, highlight } }}>
      {"```typescript\nconst answer = 42;\n```"}
    </Streamdown>,
  );
  await waitFor(() => expect(highlight).toHaveBeenCalled());

  let ready = false;
  const highlighting = waitForStreamdownCodeHighlight(view.container).then(() => {
    ready = true;
  });
  await settleAsyncRender();
  const readyBeforeHighlight = ready;
  await act(async () => {
    if (!finishHighlight) throw new Error("Expected the mounted code body's highlighter callback");
    finishHighlight({
      bg: "#ffffff",
      fg: "#111111",
      tokens: [[{ content: "const answer = 42;", color: "#123456", offset: 0 }]],
    });
  });
  await highlighting;

  expect(readyBeforeHighlight).toBe(false);
  expect(ready).toBe(true);
});
