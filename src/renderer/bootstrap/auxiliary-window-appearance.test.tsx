import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { THEME_STORAGE_KEY, writeThemePreference } from "../lib/theme-preferences";
import {
  TYPOGRAPHY_STORAGE_KEY,
  readTypographyPreferences,
  writeTypographyPreferences,
} from "../lib/typography-preferences";
import { AuxiliaryWindowAppearance } from "./auxiliary-window-appearance";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.body.removeAttribute("style");
});

test("restricted windows restore and follow shared typography without the application preload", async () => {
  const apiDescriptor = Object.getOwnPropertyDescriptor(window, "api");
  Object.defineProperty(window, "api", { configurable: true, value: undefined });
  try {
    writeThemePreference("light");
    const preferences = readTypographyPreferences();
    writeTypographyPreferences({
      ...preferences,
      useFontSmoothing: false,
      fonts: {
        ...preferences.fonts,
        dark: { ...preferences.fonts.dark, content: "Georgia" },
      },
    });
    render(
      <StrictMode>
        <AuxiliaryWindowAppearance>
          <span>Overlay content</span>
        </AuxiliaryWindowAppearance>
      </StrictMode>,
    );
    for (const element of [document.documentElement, document.body]) {
      expect(element.style.getPropertyValue("--font-smoothing")).toBe("auto");
    }

    await act(async () => {
      writeTypographyPreferences({ ...readTypographyPreferences(), useFontSmoothing: true });
      writeThemePreference("dark");
      for (const key of [TYPOGRAPHY_STORAGE_KEY, THEME_STORAGE_KEY]) {
        window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      for (const element of [document.documentElement, document.body]) {
        expect(element.style.getPropertyValue("--font-smoothing")).toBe("antialiased");
        expect(element.style.getPropertyValue("--font-content")).toContain("Georgia");
      }
    });
  } finally {
    cleanup();
    if (apiDescriptor) Object.defineProperty(window, "api", apiDescriptor);
    else Reflect.deleteProperty(window, "api");
  }
});
