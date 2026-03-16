import { describe, expect, test } from "bun:test";
import { act } from "react";
import {
  SELECTOR_MENU_ITEM_CLASS_NAME,
  SELECTOR_MENU_MATCH_TRIGGER_WIDTH_CLASS_NAME,
  SELECTOR_MENU_SELECT_CONTENT_CLASS_NAME,
  SELECTOR_MENU_SELECT_VIEWPORT_CLASS_NAME,
} from "./selector-menu-chrome";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { render } from "../../test/dom";

describe("shared select", () => {
  test("exports the shared selector chrome tokens", () => {
    expect(SELECTOR_MENU_SELECT_CONTENT_CLASS_NAME.includes("bg-token-dropdown-background/90")).toBeTrue();
    expect(SELECTOR_MENU_SELECT_CONTENT_CLASS_NAME.includes("ring-token-border")).toBeTrue();
    expect(SELECTOR_MENU_SELECT_CONTENT_CLASS_NAME.includes(SELECTOR_MENU_MATCH_TRIGGER_WIDTH_CLASS_NAME)).toBeTrue();
    expect(SELECTOR_MENU_ITEM_CLASS_NAME.includes("hover:bg-token-list-hover-background")).toBeTrue();
    expect(SELECTOR_MENU_ITEM_CLASS_NAME.includes("focus-visible:bg-token-list-hover-background")).toBeTrue();
    expect(SELECTOR_MENU_ITEM_CLASS_NAME.includes("min-w-32")).toBeFalse();
  });

  test("uses the shared popper chrome and item layout at runtime", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <Select open value="default" onValueChange={() => undefined}>
          <SelectTrigger aria-label="Destination project">
            <SelectValue placeholder="Choose project" />
          </SelectTrigger>
          <SelectContent sideOffset={6}>
            <SelectItem value="default">Default</SelectItem>
            <SelectItem value="ops">Ops</SelectItem>
          </SelectContent>
        </Select>,
      );
      await Promise.resolve();
    });

    const content = view.container.ownerDocument.querySelector('[data-slot="select-content"]');
    const viewport = view.container.ownerDocument.querySelector('[data-radix-select-viewport]');
    const defaultItem = view.container.ownerDocument.querySelector('[data-slot="select-item"][data-state="checked"]');

    expect(content).not.toBeNull();
    expect(content?.className.includes("bg-token-dropdown-background/90")).toBeTrue();
    expect(content?.className.includes(SELECTOR_MENU_MATCH_TRIGGER_WIDTH_CLASS_NAME)).toBeTrue();
    expect(viewport?.className.includes(SELECTOR_MENU_SELECT_VIEWPORT_CLASS_NAME)).toBeTrue();
    expect(defaultItem).not.toBeNull();
    expect(defaultItem?.className.includes("grid-cols-[minmax(0,1fr)_auto]")).toBeTrue();
    expect(defaultItem?.className.includes("p-1")).toBeFalse();
  });
});
