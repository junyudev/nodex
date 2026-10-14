import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  readAccentColorPreferences,
  readThemePreference,
  writeAccentColorPreferences,
  writeThemePreference,
} from "@/lib/theme-preferences";
import {
  TYPOGRAPHY_STORAGE_KEY,
  readTypographyPreferences,
  writeTypographyPreferences,
} from "@/lib/typography-preferences";
import { readReducedMotionPreference, writeReducedMotionPreference } from "@/lib/reduced-motion";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { openNodexMenu } from "@/test/dom";
import { AppearanceSettingsPage } from "./appearance-settings-page";

async function press(control: HTMLElement) {
  await act(async () => {
    fireEvent.click(control);
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  writeThemePreference("dark");
  const preferences = readTypographyPreferences();
  writeTypographyPreferences({
    ...preferences,
    fonts: {
      light: { ...preferences.fonts.light, content: "Georgia" },
      dark: { ...preferences.fonts.dark, content: "Palatino" },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Appearance settings", () => {
  test("keeps the active theme editable while advanced typography starts collapsed", async () => {
    const view = renderWithAppMaitai(<AppearanceSettingsPage />);

    expect(view.getByRole("button", { name: "Dark UI font" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Light UI font" })).toBeNull();
    expect(view.queryByRole("textbox", { name: "Custom Dark UI font" })).toBeNull();
    expect(view.queryByRole("spinbutton", { name: "UI font size" })).toBeNull();
    const advanced = view.getByRole("button", { name: "Advanced" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");

    await press(advanced);

    await waitFor(() => {
      expect(advanced.getAttribute("aria-expanded")).toBe("true");
      expect(view.getByRole("spinbutton", { name: "UI font size" })).toBeTruthy();
      expect(view.getByRole("spinbutton", { name: "Code font size" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Dark Content font" })).toBeTruthy();
    });
    expect(view.getByRole("spinbutton", { name: "Content font size" })).toBeTruthy();
  });

  test("opens Advanced from its canonical route anchor and a matching settings query", async () => {
    const view = renderWithAppMaitai(
      <AppearanceSettingsPage initialSearchQuery="Content font size" />,
    );
    expect(view.getByRole("spinbutton", { name: "Content font size" })).toBeTruthy();
    const advanced = view.getByRole("button", { name: "Advanced" });
    await press(advanced);
    expect(advanced.getAttribute("aria-expanded")).toBe("false");

    view.rerender(<AppearanceSettingsPage settingsAnchor="advanced" />);

    await waitFor(() => expect(advanced.getAttribute("aria-expanded")).toBe("true"));
    expect(view.getByRole("spinbutton", { name: "Content font size" })).toBeTruthy();
  });

  test("showing both themes preserves saved values and edits only the chosen font role", async () => {
    const view = renderWithAppMaitai(<AppearanceSettingsPage />);
    const initial = readTypographyPreferences();
    await press(view.getByRole("button", { name: "Advanced" }));
    const separate = view.getByRole("switch", { name: "Separate light/dark modes" });
    await press(separate);

    expect(readThemePreference()).toBe("dark");
    expect(readTypographyPreferences()).toEqual(initial);
    expect(view.getByRole("button", { name: "Light UI font" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Dark UI font" })).toBeTruthy();

    await openNodexMenu(view.getByRole("button", { name: "Light Content font" }));
    const lightContent = await view.findByRole("textbox", { name: "Custom Light Content font" });
    await act(async () => {
      fireEvent.change(lightContent, { target: { value: "Charter" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(lightContent, { key: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => expect(readTypographyPreferences().fonts.light.content).toBe("Charter"));
    expect(readTypographyPreferences().fonts.dark).toEqual(initial.fonts.dark);
    expect(readTypographyPreferences().uiFontSize).toBe(initial.uiFontSize);
    expect(readTypographyPreferences().codeFontSize).toBe(initial.codeFontSize);
    expect(readTypographyPreferences().pageFontSize).toBe(initial.pageFontSize);
    expect(readThemePreference()).toBe("dark");

    await press(separate);
    expect(view.queryByRole("button", { name: "Light Content font" })).toBeNull();
    expect(view.getByRole("button", { name: "Dark Content font" }).textContent).toBe("Palatino");
    expect(readTypographyPreferences().fonts.light.content).toBe("Charter");
  });

  test("resets advanced appearance while preserving Mode and each theme's main choices", async () => {
    const preferences = readTypographyPreferences();
    writeTypographyPreferences({
      ...preferences,
      uiFontSize: 16,
      pageFontSize: 18,
      codeFontSize: 20,
      fonts: {
        light: { ui: "Arial", content: "Georgia", code: "Monaco" },
        dark: { ui: "Verdana", content: "Palatino", code: "Menlo" },
      },
    });
    const accents = writeAccentColorPreferences({
      light: { kind: "preset", name: "green" },
      dark: { kind: "custom", color: "#123456" },
    });
    writeReducedMotionPreference("on");
    const view = renderWithAppMaitai(<AppearanceSettingsPage />);
    await press(view.getByRole("button", { name: "Advanced" }));
    await press(view.getByRole("switch", { name: "Separate light/dark modes" }));
    await press(view.getByRole("button", { name: "Reset advanced appearance" }));

    await waitFor(() => {
      expect(readTypographyPreferences()).toEqual({
        uiFontSize: 14,
        pageFontSize: 14,
        codeFontSize: 12,
        fonts: {
          light: { ui: "Arial", content: null, code: null },
          dark: { ui: "Verdana", content: null, code: null },
        },
      });
      expect(readReducedMotionPreference()).toBe("system");
      expect(
        view
          .getByRole("switch", { name: "Separate light/dark modes" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
    expect(readThemePreference()).toBe("dark");
    expect(readAccentColorPreferences()).toEqual(accents);
    expect(view.getByRole("button", { name: "Dark UI font" }).textContent).toBe("Verdana");
    expect(view.queryByRole("button", { name: "Light UI font" })).toBeNull();
    expect(view.getByRole("button", { name: "Dark Content font" }).textContent).toBe(
      "Same as UI font",
    );
    expect(view.getByRole("button", { name: "Dark Code font" }).textContent).toBe("System");
  });

  test("commits a size once on Enter without passing the key to workspace actions", async () => {
    const view = renderWithAppMaitai(<AppearanceSettingsPage settingsAnchor="advanced" />);
    const input = view.getByRole("spinbutton", { name: "UI font size" });
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const workspaceKey = vi.fn();
    window.addEventListener("keydown", workspaceKey);
    await act(async () => {
      input.focus();
      fireEvent.change(input, { target: { value: "16" } });
      await Promise.resolve();
    });
    expect(readTypographyPreferences().uiFontSize).toBe(14);
    try {
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
        await Promise.resolve();
      });
    } finally {
      window.removeEventListener("keydown", workspaceKey);
    }

    await waitFor(() => expect(readTypographyPreferences().uiFontSize).toBe(16));
    expect(document.activeElement).not.toBe(input);
    expect(workspaceKey).not.toHaveBeenCalled();
    expect(writes.mock.calls.filter(([key]) => key === TYPOGRAPHY_STORAGE_KEY)).toHaveLength(1);
  });
});
