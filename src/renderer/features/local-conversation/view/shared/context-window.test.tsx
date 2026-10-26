import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { ContextWindowTooltipContent } from "./context-window";

describe("ContextWindowTooltipContent", () => {
  test("matches the Codex used-left branch with rounded token thousands", () => {
    const view = render(
      <ContextWindowTooltipContent
        state={{
          status: "ready",
          percentFull: 44,
          usedTokens: 113_400,
          windowTokens: 258_200,
        }}
        showAutoCompactionNote={true}
      />,
    );

    expect(view.getByText("Context window:").textContent).toBe("Context window:");
    expect(view.getByText("44% used (56% left)").textContent).toBe("44% used (56% left)");
    expect(view.getByText("113k / 258k tokens used").textContent).toBe("113k / 258k tokens used");
    expect(view.getByText("Nodex automatically compacts its context").textContent).toBe(
      "Nodex automatically compacts its context",
    );
  });

  test("matches the Codex full branch without the auto-compaction line", () => {
    const view = render(
      <ContextWindowTooltipContent
        state={{
          status: "ready",
          percentFull: 71,
          usedTokens: 182_000,
          windowTokens: 258_000,
        }}
        showAutoCompactionNote={false}
      />,
    );

    expect(view.getByText("71% full").textContent).toBe("71% full");
    expect(view.getByText("182k / 258k tokens used").textContent).toBe("182k / 258k tokens used");
    expect(view.queryByText("Nodex automatically compacts its context") === null).toBe(true);
  });

  test("shows unavailable usage without claiming an empty context", () => {
    const view = render(
      <ContextWindowTooltipContent
        state={{
          status: "unavailable",
          percentFull: null,
          usedTokens: null,
          windowTokens: null,
        }}
        showAutoCompactionNote={true}
      />,
    );

    expect(view.getByText("Usage unavailable")).toBeTruthy();
    expect(view.queryByText(/0%/)).toBeNull();
    expect(view.queryByText(/tokens used/) === null).toBe(true);
  });
});

test("usage without capacity shows the token count rather than a percentage", () => {
  const view = render(
    <ContextWindowTooltipContent
      state={{ status: "usageOnly", usedTokens: 42_123, windowTokens: null, percentFull: null }}
      showAutoCompactionNote={false}
    />,
  );
  expect(view.getByText("42,123 tokens used")).toBeTruthy();
  expect(view.queryByText(/%/)).toBeNull();
});
