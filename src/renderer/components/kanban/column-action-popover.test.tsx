import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("column action popover", () => {
  test("renders collapse action and width controls for expanded columns", async () => {
    const { ColumnActionPopoverContent } = await import("./column-action-popover");

    const markup = renderToStaticMarkup(
      createElement(ColumnActionPopoverContent, {
        columnName: "In Progress",
        collapsed: false,
        width: 360,
        accentColor: "#336699",
        onCollapsedChange: () => undefined,
        onWidthChange: () => undefined,
        onRequestClose: () => undefined,
      }),
    );

    expect(markup.includes("In Progress")).toBeTrue();
    expect(markup.includes("Collapse")).toBeTrue();
    expect(markup.includes("Width")).toBeTrue();
    expect(markup.includes("360px")).toBeTrue();
  });

  test("switches the action label when the column is collapsed", async () => {
    const { ColumnActionPopoverContent } = await import("./column-action-popover");

    const markup = renderToStaticMarkup(
      createElement(ColumnActionPopoverContent, {
        columnName: "Done",
        collapsed: true,
        width: 288,
        accentColor: "#336699",
        onCollapsedChange: () => undefined,
        onWidthChange: () => undefined,
        onRequestClose: () => undefined,
      }),
    );

    expect(markup.includes("Expand")).toBeTrue();
  });
});
