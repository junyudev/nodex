import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "./maitai";
import {
  TYPOGRAPHY_STORAGE_KEY,
  readTypographyPreferences,
  writeTypographyPreferences,
} from "./typography-preferences";
import { ThemeProvider, useTheme } from "./use-theme";
import { TypographyProvider, useTypographyPreferences } from "./use-typography-preferences";

const stores: ReturnType<typeof createMaitaiStore>[] = [];
function Controls() {
  const { preferences, setFontSmoothing, setFontFamily, setFontSize } = useTypographyPreferences();
  const { setTheme } = useTheme();
  return (
    <>
      <output aria-label="Font sizes">{`${preferences.uiFontSize}/${preferences.codeFontSize}/${preferences.pageFontSize}`}</output>
      <output aria-label="Font smoothing">{String(preferences.useFontSmoothing)}</output>
      <button onClick={() => setFontSize("ui", 16)}>Grow UI</button>
      <button onClick={() => setFontSmoothing(!preferences.useFontSmoothing)}>
        Toggle smoothing
      </button>
      <button onClick={() => setFontFamily("dark", "content", "Georgia")}>Dark content</button>
      <button onClick={() => setTheme("dark")}>Dark</button>
    </>
  );
}
function mount() {
  const store = createMaitaiStore();
  stores.push(store);
  return render(
    <MaitaiProvider store={store}>
      <ThemeProvider>
        <TypographyProvider>
          <Controls />
        </TypographyProvider>
      </ThemeProvider>
    </MaitaiProvider>,
  );
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}
afterEach(() => {
  cleanup();
  stores.splice(0).forEach((store) => disposeMaitaiStore(store));
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});
describe("typography owner", () => {
  test("persists one preference envelope, restores it, and applies each appearance to root and body", async () => {
    const view = mount();
    for (const element of [document.documentElement, document.body]) {
      expect(element.style.getPropertyValue("--font-smoothing")).toBe("antialiased");
    }
    await click("Toggle smoothing");
    await click("Grow UI");
    await click("Dark content");
    await click("Dark");
    expect(readTypographyPreferences().uiFontSize).toBe(16);
    expect(readTypographyPreferences().fonts.dark.content).toBe("Georgia");
    expect(readTypographyPreferences().useFontSmoothing).toBe(false);
    for (const element of [document.documentElement, document.body]) {
      expect(element.style.getPropertyValue("--codex-chat-font-size")).toBe("16px");
      expect(element.style.getPropertyValue("--text-document")).toBe("14px");
      expect(element.style.getPropertyValue("--font-content")).toContain("Georgia");
      expect(element.style.getPropertyValue("--font-smoothing")).toBe("auto");
    }
    view.unmount();
    mount();
    expect(screen.getByLabelText("Font sizes").textContent).toBe("16/12/14");
    expect(screen.getByLabelText("Font smoothing").textContent).toBe("false");
    expect(document.body.style.getPropertyValue("--font-smoothing")).toBe("auto");
    await click("Toggle smoothing");
    expect(readTypographyPreferences().useFontSmoothing).toBe(true);
    expect(document.body.style.getPropertyValue("--font-smoothing")).toBe("antialiased");
  });

  test("responds to another window's saved settings without losing its independent font roles", async () => {
    mount();
    await act(async () => {
      writeTypographyPreferences({
        ...readTypographyPreferences(),
        useFontSmoothing: false,
        codeFontSize: 20,
        pageFontSize: 18,
      });
      window.dispatchEvent(
        new StorageEvent("storage", { key: TYPOGRAPHY_STORAGE_KEY, storageArea: localStorage }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByLabelText("Font sizes").textContent).toBe("14/20/18"));
    await click("Grow UI");
    expect(readTypographyPreferences()).toMatchObject({
      uiFontSize: 16,
      codeFontSize: 20,
      pageFontSize: 18,
      useFontSmoothing: false,
    });
    expect(document.body.style.getPropertyValue("--codex-chat-code-font-size")).toBe("20px");
    expect(screen.getByLabelText("Font smoothing").textContent).toBe("false");
    expect(document.body.style.getPropertyValue("--font-smoothing")).toBe("auto");
  });
});
