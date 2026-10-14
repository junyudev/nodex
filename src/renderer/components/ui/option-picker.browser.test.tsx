import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import "../../globals.css";
import {
  NodexDropdownColorDot,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
  type NodexOptionPickerSearchMode,
} from "./dropdown";

installRendererThemeFixture();

const colors = [
  { value: "blue", label: "Blue", color: "#3566f0" },
  { value: "purple", label: "Purple", color: "#a25bff", disabled: true },
  { value: "green", label: "Green", color: "#04bb9f" },
] as const;

function ColorPicker({ search = "none" }: { search?: NodexOptionPickerSearchMode }) {
  const [value, setValue] = useState("blue");
  const selected = colors.find((option) => option.value === value) ?? colors[0];

  return (
    <NodexOptionPicker
      search={search}
      searchAriaLabel="Search colors"
      value={value}
      onValueChange={setValue}
      options={colors.map((option) => ({
        ...option,
        // An inline caller-provided swatch must also retain geometry in the shared slot.
        leftSlot:
          option.value === "green" ? (
            <span
              data-testid="inline-green-dot"
              className="size-3 rounded-full"
              style={{ backgroundColor: option.color }}
            />
          ) : (
            <NodexDropdownColorDot color={option.color} />
          ),
      }))}
      triggerButton={
        <NodexSettingsDropdownTrigger
          aria-label="Accent color"
          leadingVisual={<NodexDropdownColorDot color={selected.color} />}
        >
          <span>{selected.label}</span>
        </NodexSettingsDropdownTrigger>
      }
    />
  );
}

function colorDot(parent: HTMLElement): HTMLElement {
  const dot = parent.querySelector<HTMLElement>('[data-slot="dropdown-color-dot"]');
  if (!dot) throw new Error("Expected a visible color indicator.");
  return dot;
}

function expectVisibleDot(dot: HTMLElement, color: string): void {
  const bounds = dot.getBoundingClientRect();
  expect(bounds.width).toBe(12);
  expect(bounds.height).toBe(12);
  expect(getComputedStyle(dot).backgroundColor).toBe(color);
}

describe("option picker visuals and interaction in Chromium", () => {
  test.each(["none", "filter"] as const)(
    "keeps color indicators visible and aligned in %s pickers",
    async (search) => {
      const view = render(<ColorPicker search={search} />);
      const trigger = view.getByRole("button", { name: "Accent color" });
      const triggerDot = colorDot(trigger);
      expectVisibleDot(triggerDot, "rgb(53, 102, 240)");
      expect(trigger.getBoundingClientRect().height).toBe(28);

      await act(async () => userEvent.click(trigger));
      const role = search === "none" ? "menuitem" : "option";
      const blue = await view.findByRole(role, { name: "Blue" });
      const green = view.getByRole(role, { name: "Green" });
      expectVisibleDot(colorDot(blue), "rgb(53, 102, 240)");
      const greenDot = view.getByTestId("inline-green-dot");
      expectVisibleDot(greenDot, "rgb(4, 187, 159)");

      const labelBounds = view.getByText("Green").getBoundingClientRect();
      const dotBounds = greenDot.getBoundingClientRect();
      expect(labelBounds.left - dotBounds.right).toBe(8);
      expect(
        Math.abs(dotBounds.top + dotBounds.height / 2 - (labelBounds.top + labelBounds.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(blue.getAttribute(search === "none" ? "aria-current" : "aria-selected")).toBe("true");

      const restingBackground = getComputedStyle(green).backgroundColor;
      await act(async () => userEvent.hover(green));
      await waitFor(() =>
        expect(getComputedStyle(green).backgroundColor).not.toBe(restingBackground),
      );
      expectVisibleDot(greenDot, "rgb(4, 187, 159)");

      await act(async () => userEvent.click(green));
      await waitFor(() => expect(view.queryByRole(role, { name: "Green" })).toBeNull());
      expectVisibleDot(colorDot(trigger), "rgb(4, 187, 159)");
      expect(trigger.textContent).toBe("Green");
    },
  );

  test("prevents disabled selection and restores the trigger after keyboard selection and Escape", async () => {
    const view = render(<ColorPicker />);
    const trigger = view.getByRole("button", { name: "Accent color" });

    await act(async () => {
      trigger.focus();
      await userEvent.keyboard("{ArrowDown}");
    });
    const blue = await view.findByRole("menuitem", { name: "Blue" });
    await waitFor(() => expect(document.activeElement).toBe(blue));

    await act(async () => userEvent.keyboard("{ArrowDown}"));
    const purple = view.getByRole("menuitem", { name: "Purple" });
    await waitFor(() => expect(document.activeElement).toBe(purple));
    expect(purple.getAttribute("aria-disabled")).toBe("true");
    await act(async () => userEvent.keyboard("{Enter}"));
    expect(trigger.textContent).toBe("Blue");
    expect(view.getByRole("menuitem", { name: "Purple" })).toBe(purple);
    await act(async () => userEvent.keyboard("{ArrowDown}"));
    const green = view.getByRole("menuitem", { name: "Green" });
    await waitFor(() => expect(document.activeElement).toBe(green));
    await act(async () => userEvent.keyboard("{Enter}"));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toBe("Green");
    expect(view.queryByRole("menuitem", { name: "Green" })).toBeNull();

    await act(async () => userEvent.keyboard("{ArrowDown}"));
    const selected = await view.findByRole("menuitem", { name: "Green" });
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(view.getByRole("menuitem", { name: "Blue" }).hasAttribute("aria-current")).toBe(false);
    await act(async () => userEvent.keyboard("{Escape}"));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toBe("Green");
  });
});
