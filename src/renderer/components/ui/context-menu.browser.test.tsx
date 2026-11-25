import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent, cdp } from "vite-plus/test/browser";
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
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { NodexApplicationMenubar } from "./application-menubar";
import type { ApplicationMenuAdapter } from "@/lib/application-menu";
import {
  NodexDropdownRoot,
  NodexDropdownTrigger,
  NodexDropdownPortal,
  NodexDropdownContent,
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownColorDot,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
  type NodexOptionPickerSearchMode,
} from "./dropdown";
import { PanelDestinationPickerSurface } from "../workbench/panel-destination-picker";
import { useState } from "react";

describe("context menu", () => {
  const settleFloatingSurface = async (): Promise<void> => {
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };

  function ContextMenuProbe() {
    const submenu = (label: string) => (
      <NodexContextMenuSubmenu
        trigger={<NodexContextMenuSubmenuTrigger>{label}</NodexContextMenuSubmenuTrigger>}
        renderContent={() => (
          <>
            <NodexContextMenuItem>{label} action</NodexContextMenuItem>
            <NodexContextMenuItem>{label} secondary action</NodexContextMenuItem>
            <NodexContextMenuItem>{label} tertiary action</NodexContextMenuItem>
          </>
        )}
      />
    );

    return (
      <NodexContextMenuRoot>
        <NodexContextMenuTrigger>
          <button type="button">Page row</button>
        </NodexContextMenuTrigger>
        <NodexContextMenuPortal>
          <NodexContextMenuContent>
            {submenu("First")}
            <NodexContextMenuItem>Plain action</NodexContextMenuItem>
            {submenu("Second")}
          </NodexContextMenuContent>
        </NodexContextMenuPortal>
      </NodexContextMenuRoot>
    );
  }

  describe("context menu interaction in Chromium", () => {
    test("shows the root without entry motion and switches sibling submenus through native pointer movement", async () => {
      const view = render(<ContextMenuProbe />);

      await act(async () => {
        fireEvent.contextMenu(view.getByRole("button", { name: "Page row" }), {
          clientX: 80,
          clientY: 80,
        });
        await settleFloatingSurface();
      });

      const root = document.querySelector<HTMLElement>("[data-slot='context-menu-content']");
      if (!root) throw new Error("Expected the root context menu surface.");
      expect(getComputedStyle(root).animationName).toBe("none");

      await act(async () => userEvent.hover(view.getByText("First")));
      expect(view.getByText("First action")).toBeTruthy();

      await act(async () => userEvent.hover(view.getByText("First tertiary action")));
      expect(view.getByText("First action")).toBeTruthy();
      expect(view.queryByText("Second action")).toBeNull();

      await act(async () => userEvent.hover(view.getByText("First")));
      await act(async () => userEvent.hover(view.getByText("Second")));

      expect(view.queryByText("First action")).toBeNull();
      expect(view.getByText("Second action")).toBeTruthy();

      await act(async () => userEvent.hover(view.getByText("Plain action")));
      expect(view.queryByText("Second action")).toBeNull();

      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      });
      expect(view.queryByText("First action")).toBeNull();
      expect(view.queryByText("Second action")).toBeNull();

      await act(async () => userEvent.hover(view.getByText("Second")));
      await act(settleFloatingSurface);
      const content = view
        .getByText("Second action")
        .closest<HTMLElement>("[data-slot='context-menu-subcontent']");
      if (!content) throw new Error("Expected the open submenu surface.");
      const contentRect = content.getBoundingClientRect();
      expect(Math.abs(contentRect.left - root.getBoundingClientRect().right)).toBeLessThanOrEqual(
        4,
      );
    });
  });
});

describe("application menubar", () => {
  installRendererThemeFixture();

  const keyboardAdapter: ApplicationMenuAdapter = {
    invoke: async () => true,
    read: async () => ({
      menus: ["File", "Edit", "View"].map((label) => ({
        type: "submenu",
        id: label,
        label,
        enabled: true,
        items: [
          {
            type: "item",
            id: `${label}.disabled`,
            label: "Unavailable",
            enabled: false,
            checked: false,
          },
          {
            type: "item",
            id: `${label}.first`,
            label: `${label} first`,
            enabled: true,
            checked: false,
          },
        ],
      })),
    }),
  };

  test("keyboard menu switches highlight the first enabled item and never outline the popup", async () => {
    const view = render(<NodexApplicationMenubar adapter={keyboardAdapter} />);
    await view.findByRole("menuitem", { name: "File" });
    await act(async () => userEvent.keyboard("{F10}{ArrowDown}"));
    for (const [key, label] of [
      ["", "File"],
      ["{ArrowRight}", "Edit"],
      ["{ArrowRight}", "View"],
      ["{ArrowLeft}", "Edit"],
    ]) {
      if (key) await act(async () => userEvent.keyboard(key));
      await waitFor(() => {
        const item = view.getByRole("menuitem", { name: `${label} first` });
        expect(document.activeElement).toBe(item);
        expect(item.hasAttribute("data-highlighted")).toBe(true);
        expect(getComputedStyle(view.getByRole("menu")).outlineStyle).toBe("none");
      });
    }
  });

  test.each(["light", "dark", "forced-colors"] as const)(
    "Alt focus is visible in %s",
    async (appearance) => {
      applyRendererThemeForTest(appearance === "dark" ? "dark" : "light");
      if (appearance === "forced-colors") {
        await cdp().send("Emulation.setEmulatedMedia", {
          features: [{ name: "forced-colors", value: "active" }],
        });
      }
      try {
        const view = render(<NodexApplicationMenubar adapter={keyboardAdapter} />);
        const file = await view.findByRole("menuitem", { name: "File" });
        const restingBackground = getComputedStyle(file).backgroundColor;
        await act(async () => userEvent.keyboard("{Alt>}{/Alt}"));
        await waitFor(() => {
          expect(document.activeElement).toBe(file);
          const style = getComputedStyle(file);
          expect(style.backgroundColor).not.toBe(restingBackground);
          if (appearance !== "forced-colors")
            expect(style.backgroundColor).toBe(
              readRendererThemeColor("--color-token-list-hover-background"),
            );
          else expect(style.forcedColorAdjust).toBe("none");
        });
      } finally {
        if (appearance === "forced-colors")
          await cdp().send("Emulation.setEmulatedMedia", { features: [] });
      }
    },
  );

  test.each([0.8, 1, 1.5, 2])(
    "menu popups remain inside the viewport at %sx shell zoom",
    async (zoom) => {
      const root = document.documentElement;
      const previousZoom = root.style.getPropertyValue("--codex-window-zoom");
      root.style.setProperty("--codex-window-zoom", String(zoom));
      const adapter: ApplicationMenuAdapter = {
        invoke: async () => true,
        read: async () => ({
          menus: [
            {
              type: "submenu",
              id: "File",
              label: "File",
              enabled: true,
              items: Array.from({ length: 40 }, (_, index) => ({
                type: "item",
                id: `action-${index}`,
                label: `Action ${index}`,
                enabled: true,
                checked: false,
              })),
            },
          ],
        }),
      };
      try {
        const view = render(
          <div style={{ position: "fixed", right: 0, top: 0, zoom }}>
            <NodexApplicationMenubar adapter={adapter} />
          </div>,
        );
        const trigger = await view.findByRole("menuitem", { name: "File" });
        await act(async () => userEvent.click(trigger));
        const popup = await view.findByRole("menu");
        await waitFor(() => {
          const bounds = popup.getBoundingClientRect();
          expect(bounds.left).toBeGreaterThanOrEqual(5);
          expect(bounds.right).toBeLessThanOrEqual(innerWidth - 5);
          expect(bounds.top).toBeGreaterThanOrEqual(5);
          expect(bounds.bottom).toBeLessThanOrEqual(innerHeight - 5);
        });
      } finally {
        if (previousZoom) root.style.setProperty("--codex-window-zoom", previousZoom);
        else root.style.removeProperty("--codex-window-zoom");
      }
    },
  );
});

describe("menu keyboard", () => {
  test("Page flyout accepts native typing, caret editing, and IME without losing focus", async () => {
    const close = vi.fn();
    const view = render(
      <NodexDropdownRoot defaultOpen>
        <NodexDropdownTrigger>
          <button>Open side panel tab</button>
        </NodexDropdownTrigger>
        <NodexDropdownPortal>
          <NodexDropdownContent>
            <NodexDropdownItem>Review</NodexDropdownItem>
            <NodexDropdownFlyoutSubmenuItem label="Page" open>
              <PanelDestinationPickerSurface
                projects={[]}
                boardMap={new Map()}
                databaseDescriptorMap={new Map()}
                loading={false}
                scope="page-only"
                onAccept={vi.fn()}
                onClose={close}
              />
            </NodexDropdownFlyoutSubmenuItem>
          </NodexDropdownContent>
        </NodexDropdownPortal>
      </NodexDropdownRoot>,
    );
    const input = await view.findByRole("combobox");
    await act(async () => {
      await userEvent.click(input);
      await userEvent.type(input, "review page");
    });
    expect((input as HTMLInputElement).value).toBe("review page");
    expect(document.activeElement).toBe(input);
    await act(async () => {
      await userEvent.keyboard("{ArrowLeft}{Backspace}");
    });
    expect((input as HTMLInputElement).value).toBe("review pae");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
      );
    });
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    expect(close).toHaveBeenCalledOnce();
  });

  test("context menu editors keep typing and textarea newlines in root and submenu", async () => {
    const view = render(
      <NodexContextMenuRoot>
        <NodexContextMenuTrigger>
          <div>Context target</div>
        </NodexContextMenuTrigger>
        <NodexContextMenuPortal>
          <NodexContextMenuContent>
            <input aria-label="Root search" />
            <NodexContextMenuSubmenu
              trigger={<NodexContextMenuSubmenuTrigger>More</NodexContextMenuSubmenuTrigger>}
              renderContent={() => <textarea aria-label="Nested notes" />}
            />
          </NodexContextMenuContent>
        </NodexContextMenuPortal>
      </NodexContextMenuRoot>,
    );
    await act(async () => {
      await userEvent.click(view.getByText("Context target"), { button: "right" });
    });
    const rootInput = await view.findByRole("textbox", { name: "Root search" });
    await act(async () => {
      await userEvent.type(rootInput, "hello");
    });
    expect((rootInput as HTMLInputElement).value).toBe("hello");
    await act(async () => {
      await userEvent.hover(view.getByRole("menuitem", { name: "More" }));
    });
    const notes = await view.findByRole("textbox", { name: "Nested notes" });
    await act(async () => {
      await userEvent.type(notes, "first{Enter}second");
    });
    expect((notes as HTMLTextAreaElement).value).toBe("first\nsecond");
    expect(document.activeElement).toBe(notes);
  });
});

describe("option picker", () => {
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
          Math.abs(
            dotBounds.top + dotBounds.height / 2 - (labelBounds.top + labelBounds.height / 2),
          ),
        ).toBeLessThanOrEqual(1);
        expect(blue.getAttribute(search === "none" ? "aria-current" : "aria-selected")).toBe(
          "true",
        );

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
});
