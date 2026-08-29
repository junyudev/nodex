import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../test/dom";

describe("column action popover", () => {
  test("applies collapse, preset, and stepped width actions", async () => {
    const { ColumnActionPopoverContent } = await import("./column-action-popover");
    const onCollapsedChange = vi.fn();
    const onWidthChange = vi.fn();
    const onRequestClose = vi.fn();

    const view = render(
      <ColumnActionPopoverContent
        columnName="In Progress"
        collapsed={false}
        width={360}
        onCollapsedChange={onCollapsedChange}
        onWidthChange={onWidthChange}
        onRequestClose={onRequestClose}
      />,
    );

    expect(view.getByRole("button", { name: "Wide" }).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Narrow" }));
      await Promise.resolve();
    });
    expect(onWidthChange).toHaveBeenLastCalledWith(240);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Decrease In Progress width" }));
      await Promise.resolve();
    });
    expect(onWidthChange).toHaveBeenLastCalledWith(328);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Collapse column" }));
      await Promise.resolve();
    });
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  test("expands collapsed columns and disables stepping below the minimum width", async () => {
    const { ColumnActionPopoverContent } = await import("./column-action-popover");
    const onCollapsedChange = vi.fn();
    const onWidthChange = vi.fn();

    const view = render(
      <ColumnActionPopoverContent
        columnName="Done"
        collapsed
        width={224}
        onCollapsedChange={onCollapsedChange}
        onWidthChange={onWidthChange}
        onRequestClose={() => undefined}
      />,
    );

    expect(
      (view.getByRole("button", { name: "Decrease Done width" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Increase Done width" }));
      fireEvent.click(view.getByRole("button", { name: "Expand column" }));
      await Promise.resolve();
    });
    expect(onWidthChange).toHaveBeenCalledWith(256);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });
});
