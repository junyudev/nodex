import { describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { ToolbarDropdownMenu } from "./stage-threads-toolbar-dropdown-menu";
import { SELECTOR_MENU_CONTENT_CLASS_NAME } from "./selector-popover-primitives";
import { render } from "../../../test/dom";

describe("stage threads toolbar dropdown menu", () => {
  test("uses the shared tokenized selector menu surface at runtime", async () => {
    const onSelectCalls: string[] = [];
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ToolbarDropdownMenu
          label="Auto"
          title="Reasoning effort"
          ariaLabel="Reasoning effort"
          items={[
            { value: "auto", label: "Auto", description: "Balanced output" },
            { value: "high", label: "High", description: "More detailed thinking" },
          ]}
          selectedValue="auto"
          onSelect={(value) => {
            onSelectCalls.push(value);
          }}
          showDescriptions
          selectedItemDataAttribute="data-reasoning-selected"
        />,
      );
    });

    const trigger = view.getByLabelText("Reasoning effort");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const content = view.container.ownerDocument.body.querySelector('[data-radix-menu-content]');
    const selectedItem = view.container.ownerDocument.body.querySelector('[data-radix-collection-item][data-reasoning-selected="true"]');

    expect(content).not.toBeNull();
    expect(content?.className.includes("bg-token-dropdown-background/90")).toBeTrue();
    expect(content?.className.includes("ring-token-border")).toBeTrue();
    expect(content?.className.includes(SELECTOR_MENU_CONTENT_CLASS_NAME.split(" ")[0] ?? "")).toBeTrue();
    expect(view.container.ownerDocument.body.textContent?.includes("Balanced output")).toBeTrue();
    expect(selectedItem?.getAttribute("data-reasoning-selected")).toBe("true");
    expect(onSelectCalls.length).toBe(0);
  });
});
