import { describe, expect, test } from "vite-plus/test";
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
});
