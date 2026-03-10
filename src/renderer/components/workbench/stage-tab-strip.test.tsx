import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageTabStrip } from "./stage-tab-strip";

describe("StageTabStrip", () => {
  test("renders a running indicator for active thread tabs", () => {
    const markup = renderToStaticMarkup(
      createElement(StageTabStrip, {
        tabs: [
          { id: "thread:new", label: "New thread" },
          { id: "thread:1", label: "Build fix", running: true },
        ],
        activeTabId: "thread:1",
        onSelect: () => undefined,
      }),
    );

    expect(markup.includes("animate-pulse")).toBeTrue();
  });

  test("hides active tab underline when disabled", () => {
    const markup = renderToStaticMarkup(
      createElement(StageTabStrip, {
        tabs: [
          { id: "history", label: "History" },
          { id: "session:1", label: "Card A" },
        ],
        activeTabId: "history",
        showActiveUnderline: false,
        onSelect: () => undefined,
      }),
    );

    expect(markup.includes("bottom-0 h-[calc(var(--spacing)*0.5)] rounded-full bg-[var(--accent-blue)]")).toBeFalse();
  });
});
