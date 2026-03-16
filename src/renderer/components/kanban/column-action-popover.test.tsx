import { describe, expect, test } from "bun:test";
import { render } from "../../test/dom";

describe("column action popover", () => {
  test("renders collapse action and width controls for expanded columns", async () => {
    const { ColumnActionPopoverContent } = await import("./column-action-popover");

    const { getByRole, getByText } = render(
      <ColumnActionPopoverContent
        columnName="In Progress"
        collapsed={false}
        width={360}
        accentColor="#336699"
        onCollapsedChange={() => undefined}
        onWidthChange={() => undefined}
        onRequestClose={() => undefined}
      />,
    );

    expect(getByText("In Progress").textContent).toBe("In Progress");
    expect(getByRole("button", { name: "Collapse" }).textContent).toBe("Collapse");
    expect(getByText("Width").textContent).toBe("Width");
    expect(getByText("360px").textContent).toBe("360px");
  });

  test("switches the action label when the column is collapsed", async () => {
    const { ColumnActionPopoverContent } = await import("./column-action-popover");

    const { getByRole } = render(
      <ColumnActionPopoverContent
        columnName="Done"
        collapsed
        width={288}
        accentColor="#336699"
        onCollapsedChange={() => undefined}
        onWidthChange={() => undefined}
        onRequestClose={() => undefined}
      />,
    );

    expect(getByRole("button", { name: "Expand" }).textContent).toBe("Expand");
  });
});
