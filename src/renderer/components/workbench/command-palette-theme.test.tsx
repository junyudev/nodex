import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { ACCENT_COLOR_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/theme-preferences";
import { ThemeProvider, useTheme } from "@/lib/use-theme";
import { CommandPaletteThemeRow, useCommandPaletteTheme } from "./command-palette-theme";

const stores: ReturnType<typeof createMaitaiStore>[] = [];

function ThemeCommands() {
  const { parentCommand, pageCommands, execute } = useCommandPaletteTheme();
  const { accent, resolved } = useTheme();
  return (
    <>
      <output aria-label="Current theme">{parentCommand.subtitle}</output>
      <output aria-label="Saved appearance">
        {resolved}:{accent.kind === "preset" ? accent.name : accent.color}
      </output>
      {pageCommands.map((item) => (
        <button
          key={item.id}
          aria-label={item.title}
          aria-pressed={item.active}
          onClick={() => execute(item.id)}
        >
          <CommandPaletteThemeRow item={item} />
        </button>
      ))}
    </>
  );
}

function mount() {
  const store = createMaitaiStore();
  stores.push(store);
  return render(
    <MaitaiProvider store={store}>
      <ThemeProvider>
        <ThemeCommands />
      </ThemeProvider>
    </MaitaiProvider>,
  );
}

async function choose(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) disposeMaitaiStore(store);
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.body.removeAttribute("style");
});

test("theme commands persist through the appearance owner without changing the other variant", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  localStorage.setItem(
    ACCENT_COLOR_STORAGE_KEY,
    JSON.stringify({
      light: { kind: "preset", name: "green" },
      dark: { kind: "preset", name: "purple" },
    }),
  );
  const view = mount();
  expect(screen.getByLabelText("Current theme").textContent).toBe("Green");
  expect(screen.getByRole("button", { name: "Green" }).getAttribute("aria-pressed")).toBe("true");

  await choose("Orange");
  expect(screen.getByLabelText("Saved appearance").textContent).toBe("light:orange");
  expect(JSON.parse(localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)!)).toMatchObject({
    light: { kind: "preset", name: "orange" },
    dark: { kind: "preset", name: "purple" },
  });
  await choose("Switch to dark theme");
  expect(screen.getByLabelText("Saved appearance").textContent).toBe("dark:purple");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(screen.getByRole("button", { name: "White" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Purple" }).getAttribute("aria-pressed")).toBe("true");

  view.unmount();
  mount();
  await choose("Switch to light theme");
  expect(screen.getByLabelText("Current theme").textContent).toBe("Orange");
});

test("custom appearance remains accurately identified until a real preset is selected", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  localStorage.setItem(
    ACCENT_COLOR_STORAGE_KEY,
    JSON.stringify({ light: { kind: "custom", color: "#123456" } }),
  );
  mount();
  expect(screen.getByLabelText("Current theme").textContent).toBe("Custom");
  expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  await choose("Default");
  expect(screen.getByLabelText("Saved appearance").textContent).toBe("light:default");
  expect(screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed")).toBe("true");
});
