import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { CodexAccent } from "@/lib/codex-theme-variant";
import { openNodexMenu, render, settleAsyncRender } from "@/test/dom";
import { AccentColorSettingControl } from "./accent-color-setting-control";

const theme = vi.hoisted(() => ({
  accent: { kind: "preset", name: "default" } as CodexAccent,
  resolved: "light" as "light" | "dark",
  setAccent: vi.fn(),
}));

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => theme,
  useAppearanceAccent: () => theme,
}));

beforeEach(() => {
  theme.accent = { kind: "preset", name: "default" };
  theme.resolved = "light";
  theme.setAccent.mockReset();
});

describe("accent color setting", () => {
  test("selects named colors and seeds a custom color from the current accent", async () => {
    const view = render(<AccentColorSettingControl />);
    await openNodexMenu(view.getByRole("button", { name: "Light accent color" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Purple" }));
      await settleAsyncRender();
    });
    expect(theme.setAccent).toHaveBeenLastCalledWith({ kind: "preset", name: "purple" });

    theme.accent = { kind: "preset", name: "purple" };
    view.rerender(<AccentColorSettingControl />);
    await openNodexMenu(view.getByRole("button", { name: "Light accent color" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Custom" }));
      await settleAsyncRender();
    });
    expect(theme.setAccent).toHaveBeenLastCalledWith({ kind: "custom", color: "#a67df2" });
  });

  test("commits complete hex colors and discards incomplete drafts on blur or appearance change", async () => {
    theme.accent = { kind: "custom", color: "#a67df2" };
    const view = render(<AccentColorSettingControl />);
    const input = view.getByRole("textbox", {
      name: "Light custom accent color",
    }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "abc" } });
      await Promise.resolve();
    });
    expect(input.value).toBe("#ABC");
    expect(theme.setAccent).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(input.value).toBe("#A67DF2");

    await act(async () => {
      fireEvent.change(input, { target: { value: "12aBef" } });
      await Promise.resolve();
    });
    expect(theme.setAccent).toHaveBeenLastCalledWith({ kind: "custom", color: "#12abef" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "#2" } });
      await Promise.resolve();
    });
    theme.resolved = "dark";
    theme.accent = { kind: "custom", color: "#123456" };
    view.rerender(<AccentColorSettingControl />);
    expect(
      (view.getByRole("textbox", { name: "Dark custom accent color" }) as HTMLInputElement).value,
    ).toBe("#123456");
  });

  test("opens the accessible color picker and updates a custom accent from its keyboard controls", async () => {
    theme.accent = { kind: "custom", color: "#a67df2" };
    const view = render(<AccentColorSettingControl />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose light custom accent color" }));
      await settleAsyncRender();
    });
    const hue = await view.findByRole("slider", { name: "Hue" });
    await act(async () => {
      fireEvent.keyDown(hue, { key: "ArrowRight", keyCode: 39 });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(theme.setAccent).toHaveBeenCalledWith({
        kind: "custom",
        color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      }),
    );
    expect(theme.setAccent.mock.lastCall?.[0].color).not.toBe("#a67df2");
  });
});
