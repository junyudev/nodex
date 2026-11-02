import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import "../../globals.css";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";

installRendererThemeFixture();
import { NodexApplicationMenubar } from "./application-menubar";
import type { ApplicationMenuAdapter } from "@/lib/application-menu";

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
