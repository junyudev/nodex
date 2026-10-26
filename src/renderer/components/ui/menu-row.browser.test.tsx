import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import "../../globals.css";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
  NodexContextMenuTrigger,
} from "./context-menu";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSummarySubmenuItem,
} from "./dropdown";

installRendererThemeFixture();

const icon = <svg viewBox="0 0 20 20" aria-hidden="true" />;

const settleFloatingSurface = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

const labelLeft = (label: string): number =>
  Math.round(
    document.body.querySelector<HTMLElement>(`[data-label="${label}"]`)!.getBoundingClientRect()
      .left,
  );

const menuLeft = (slot: string): number =>
  Math.round(
    document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!.getBoundingClientRect().left,
  );

describe("menu rows in Chromium", () => {
  test("every row kind starts its label in the same column, in dropdowns and context menus", async () => {
    render(
      <NodexDropdownMenu open triggerButton={<button type="button">Chat actions</button>}>
        <NodexDropdownItem leftSlot={icon}>
          <span data-label="item">Rename</span>
        </NodexDropdownItem>
        <NodexDropdownFlyoutSubmenuItem
          leftSlot={icon}
          label={<span data-label="flyout">Fork</span>}
        >
          <NodexDropdownItem>Fork chat</NodexDropdownItem>
        </NodexDropdownFlyoutSubmenuItem>
        <NodexDropdownSummarySubmenuItem
          leftSlot={icon}
          label={<span data-label="summary">Theme</span>}
          value="System"
        >
          <NodexDropdownItem>Light</NodexDropdownItem>
        </NodexDropdownSummarySubmenuItem>
        <NodexDropdownRadioGroup value="codex">
          <NodexDropdownRadioItem value="codex" leftSlot={icon}>
            <span data-label="radio">Codex</span>
          </NodexDropdownRadioItem>
        </NodexDropdownRadioGroup>
      </NodexDropdownMenu>,
    );
    await act(settleFloatingSurface);
    const dropdownColumn = labelLeft("item") - menuLeft("dropdown-content");
    for (const kind of ["flyout", "summary", "radio"])
      expect(labelLeft(kind) - menuLeft("dropdown-content"), kind).toBe(dropdownColumn);

    const view = render(
      <NodexContextMenuRoot>
        <NodexContextMenuTrigger>
          <button type="button">Page row</button>
        </NodexContextMenuTrigger>
        <NodexContextMenuPortal>
          <NodexContextMenuContent>
            <NodexContextMenuItem leftSlot={icon}>
              <span data-label="context-item">Open</span>
            </NodexContextMenuItem>
            <NodexContextMenuSubmenu
              trigger={
                <NodexContextMenuSubmenuTrigger leftSlot={icon}>
                  <span data-label="context-submenu">Move to</span>
                </NodexContextMenuSubmenuTrigger>
              }
              renderContent={() => <NodexContextMenuItem>Inbox</NodexContextMenuItem>}
            />
          </NodexContextMenuContent>
        </NodexContextMenuPortal>
      </NodexContextMenuRoot>,
    );
    await act(async () => {
      fireEvent.contextMenu(view.getByRole("button", { name: "Page row" }), {
        clientX: 80,
        clientY: 80,
      });
      await settleFloatingSurface();
    });
    for (const kind of ["context-item", "context-submenu"])
      expect(labelLeft(kind) - menuLeft("context-menu-content"), kind).toBe(dropdownColumn);
  });
});
