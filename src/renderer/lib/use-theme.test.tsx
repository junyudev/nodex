import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "./maitai";
import { getCodexThemeVariantStyle } from "./codex-theme-variant";
import { ACCENT_COLOR_STORAGE_KEY, THEME_STORAGE_KEY } from "./theme-preferences";
import { initializeRendererDocument } from "../bootstrap/renderer-document";
import { ThemeProvider, useTheme } from "./use-theme";

const stores: ReturnType<typeof createMaitaiStore>[] = [];

function Controls({ customColor }: { customColor: string }) {
  const { accent, resolved, setAccent, setTheme } = useTheme();
  return (
    <>
      <output aria-label="Appearance">{resolved}</output>
      <output aria-label="Accent">{accent.kind === "preset" ? accent.name : accent.color}</output>
      <button onClick={() => setAccent({ kind: "preset", name: "green" })}>Green</button>
      <button onClick={() => setAccent({ kind: "preset", name: "default" })}>Default</button>
      <button onClick={() => setAccent({ kind: "preset", name: "black" })}>Black</button>
      <button onClick={() => setAccent({ kind: "custom", color: customColor })}>Custom</button>
      <button onClick={() => setTheme("dark")}>Dark</button>
      <button onClick={() => setTheme("light")}>Light</button>
    </>
  );
}

function mountTheme(customColor = "#112233") {
  const store = createMaitaiStore();
  stores.push(store);
  return render(
    <MaitaiProvider store={store}>
      <ThemeProvider>
        <Controls customColor={customColor} />
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
  for (const store of stores.splice(0)) disposeMaitaiStore(store);
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-codex-window-type");
  document.body.removeAttribute("style");
});

describe("appearance preference application", () => {
  test("restores and reapplies Default as Blue while preserving the authored Default choice", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    initializeRendererDocument();
    const expected = getCodexThemeVariantStyle("light", { kind: "preset", name: "blue" });
    expect(
      document.documentElement.style.getPropertyValue("--color-background-composer-primary"),
    ).toBe(expected["--color-background-composer-primary"]);
    mountTheme();
    expect(screen.getByLabelText("Accent").textContent).toBe("default");
    await click("Black");
    expect(
      document.documentElement.style.getPropertyValue("--color-background-composer-primary"),
    ).toBe("#000000");
    await click("Default");
    expect(screen.getByLabelText("Accent").textContent).toBe("default");
    expect(JSON.parse(localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)!).preset).toBe("default");
    expect(
      document.documentElement.style.getPropertyValue("--color-background-composer-primary"),
    ).toBe(expected["--color-background-composer-primary"]);
    expect(document.documentElement.style.getPropertyValue("--color-background-user-message")).toBe(
      expected["--color-background-user-message"],
    );
  });

  test("restores the saved accent before the application renderer initializes", () => {
    localStorage.setItem(
      ACCENT_COLOR_STORAGE_KEY,
      JSON.stringify({ preset: "green", light: null, dark: null }),
    );
    initializeRendererDocument();
    expect(
      document.documentElement.style.getPropertyValue("--color-background-composer-primary"),
    ).toBe(
      getCodexThemeVariantStyle("light", { kind: "preset", name: "green" })[
        "--color-background-composer-primary"
      ],
    );
  });

  test("saves a shared preset, retains appearance-specific custom colors, and restores after remount", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const view = mountTheme();
    await click("Green");
    await click("Custom");
    expect(screen.getByLabelText("Accent").textContent).toBe("#112233");
    await click("Dark");
    await waitFor(() => expect(screen.getByLabelText("Accent").textContent).toBe("green"));
    view.unmount();
    mountTheme();
    expect(screen.getByLabelText("Appearance").textContent).toBe("dark");
    expect(screen.getByLabelText("Accent").textContent).toBe("green");
    await click("Light");
    await waitFor(() => expect(screen.getByLabelText("Accent").textContent).toBe("#112233"));
  });

  test("updates the active appearance and accent when another window writes its preferences", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    mountTheme();
    await act(async () => {
      localStorage.setItem(THEME_STORAGE_KEY, "dark");
      localStorage.setItem(
        ACCENT_COLOR_STORAGE_KEY,
        JSON.stringify({ preset: "orange", light: null, dark: null }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: ACCENT_COLOR_STORAGE_KEY, storageArea: localStorage }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, storageArea: localStorage }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByLabelText("Accent").textContent).toBe("orange"));
    expect(screen.getByLabelText("Appearance").textContent).toBe("dark");
    expect(
      document.documentElement.style.getPropertyValue("--color-background-composer-primary"),
    ).toBe(
      getCodexThemeVariantStyle("dark", { kind: "preset", name: "orange" })[
        "--color-background-composer-primary"
      ],
    );
  });

  test("preserves another window's custom color when its storage event has not arrived", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const light = mountTheme("#112233");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const dark = mountTheme("#445566");

    await act(async () => {
      fireEvent.click(within(light.container).getByRole("button", { name: "Custom" }));
      await Promise.resolve();
    });
    expect(within(dark.container).getByLabelText("Accent").textContent).toBe("default");
    await act(async () => {
      fireEvent.click(within(dark.container).getByRole("button", { name: "Custom" }));
      await Promise.resolve();
    });
    expect(JSON.parse(localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)!)).toEqual({
      preset: "default",
      light: "#112233",
      dark: "#445566",
    });
  });

  test("system appearance changes select the matching custom accent without changing preferences", async () => {
    const events = new window.EventTarget();
    let systemDark = false;
    const media = {
      get matches() {
        return systemDark;
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: events.dispatchEvent.bind(events),
    } satisfies MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const preferences = JSON.stringify({ preset: "green", light: "#112233", dark: "#445566" });
    localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, preferences);
    mountTheme();
    expect(screen.getByLabelText("Accent").textContent).toBe("#112233");

    await act(async () => {
      systemDark = true;
      events.dispatchEvent(new Event("change"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByLabelText("Accent").textContent).toBe("#445566"));
    expect(document.documentElement.style.getPropertyValue("--codex-base-accent")).toBe("#445566");
    expect(localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)).toBe(preferences);
  });
});
