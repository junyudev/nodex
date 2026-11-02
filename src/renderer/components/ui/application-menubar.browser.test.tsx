import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";

installRendererThemeFixture();
import { NodexApplicationMenubar } from "./application-menubar";
import type { ApplicationMenuAdapter } from "@/lib/application-menu";

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
