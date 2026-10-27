import { expect, test } from "vite-plus/test";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { readTerminalTheme } from "./use-terminal";

import "@/globals.css";

installRendererThemeFixture();

function readSemanticRole(variable: `--app-color-${string}`): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  expect(value, variable).not.toBe("");
  return value;
}

test("resolves the terminal palette from the active semantic theme after appearance changes", () => {
  const terminal = document.createElement("div");
  terminal.dataset.codexTerminal = "true";
  terminal.className = "terminal-fallback-surface";
  document.body.append(terminal);

  const palettes = (["light", "dark", "light"] as const).map((variant) => {
    applyRendererThemeForTest(variant);
    const theme = readTerminalTheme(terminal);

    expect(theme.background).toBe(readSemanticRole("--app-color-background-surface"));
    expect(theme.foreground).toBe(readSemanticRole("--app-color-text-foreground"));
    expect(theme.cursor).toBe(theme.foreground);
    expect(theme.red).toBe(readSemanticRole("--app-color-accent-red"));
    expect(theme.green).toBe(readSemanticRole("--app-color-accent-green"));
    expect(theme.magenta).toBe(readSemanticRole("--app-color-accent-purple"));
    expect(theme.brightBlack).toBe(readSemanticRole("--app-color-text-foreground-secondary"));
    expect(theme.selectionBackground).toBe(readSemanticRole("--app-color-simple-scrim"));
    expect(theme.selectionInactiveBackground).toBe(theme.selectionBackground);
    expect(getComputedStyle(terminal).backgroundColor).toBe(
      readRendererThemeColor("--app-color-background-surface"),
    );
    expect(getComputedStyle(terminal).color).toBe(
      readRendererThemeColor("--app-color-text-foreground"),
    );
    return theme;
  });

  expect(palettes[1]).not.toEqual(palettes[0]);
  expect(palettes[2]).toEqual(palettes[0]);
});
