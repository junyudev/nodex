import { describe, expect, test } from "bun:test";
import { render } from "../../test/dom";
import { StageTabStrip } from "./stage-tab-strip";

describe("StageTabStrip", () => {
  test("renders a running indicator for active thread tabs", () => {
    const { container } = render(
      <StageTabStrip
        tabs={[
          { id: "thread:new", label: "New thread" },
          { id: "thread:1", label: "Build fix", running: true },
        ]}
        activeTabId="thread:1"
        onSelect={() => undefined}
      />,
    );

    expect(container.querySelector('[data-running-indicator="true"]')).not.toBeNull();
  });

  test("hides active tab underline when disabled", () => {
    const { container } = render(
      <StageTabStrip
        tabs={[
          { id: "history", label: "History" },
          { id: "session:1", label: "Card A" },
        ]}
        activeTabId="history"
        showActiveUnderline={false}
        onSelect={() => undefined}
      />,
    );

    expect(
      container.querySelector(".bottom-0.h-\\[calc\\(var\\(--spacing\\)\\*0\\.5\\)\\].rounded-full.bg-\\[var\\(--accent-blue\\)\\]"),
    ).toBe(null);
  });
});
