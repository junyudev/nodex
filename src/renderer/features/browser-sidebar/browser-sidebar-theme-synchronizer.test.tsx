import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { BrowserSidebarThemeSynchronizer } from "./browser-sidebar-theme-synchronizer";

let resolvedTheme: "light" | "dark" = "light";
const invoke = vi.fn(async (...args: unknown[]) => {
  void args;
  return { ok: true };
});

vi.mock("@/lib/api", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({
    resolved: resolvedTheme,
    setTheme: () => undefined,
    theme: resolvedTheme,
  }),
}));

beforeEach(() => {
  invoke.mockClear();
  resolvedTheme = "light";
  window.__NODEX_STORYBOOK__ = false;
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { invoke: (...args: unknown[]) => invoke(...args) },
  });
});

describe("BrowserSidebarThemeSynchronizer", () => {
  test("keeps Main-owned live guests synchronized outside the workbench route", async () => {
    const view = render(<BrowserSidebarThemeSynchronizer />);
    await waitFor(() => {
      expect(invoke).toHaveBeenLastCalledWith("browser-sidebar-command", {
        type: "sync-theme",
        themeVariant: "light",
      });
    });

    resolvedTheme = "dark";
    view.rerender(<BrowserSidebarThemeSynchronizer />);
    await waitFor(() => {
      expect(invoke).toHaveBeenLastCalledWith("browser-sidebar-command", {
        type: "sync-theme",
        themeVariant: "dark",
      });
    });
  });
});
