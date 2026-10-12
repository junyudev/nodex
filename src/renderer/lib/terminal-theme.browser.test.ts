import { afterEach, expect, test } from "vite-plus/test";
import { applyCodexThemeVariant } from "./codex-theme-variant";
import { readTerminalTheme } from "./use-terminal";

import "@/globals.css";

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-codex-window-type");
});

test("resolves the terminal palette from the active semantic theme after appearance changes", () => {
  const root = document.documentElement;
  root.dataset.codexWindowType = "electron";
  const terminal = document.createElement("div");
  terminal.dataset.codexTerminal = "true";
  terminal.className = "terminal-fallback-surface";
  document.body.append(terminal);

  for (const variant of ["light", "dark", "light"] as const) {
    applyCodexThemeVariant(root, variant, document.body);
    const theme = readTerminalTheme(terminal);
    const isDark = variant === "dark";

    expect(theme.background).toBe(isDark ? "#111111" : "#ffffff");
    expect(theme.foreground).toBe(isDark ? "#fcfcfc" : "#0d0d0d");
    expect(theme.cursor).toBe(theme.foreground);
    expect(theme.red).toBe(isDark ? "#ff6764" : "#e02e2a");
    expect(theme.green).toBe(isDark ? "#40c977" : "#00a240");
    expect(theme.magenta).toBe(isDark ? "#b06dff" : "#751ed9");
    expect(theme.brightBlack).toBe(
      isDark ? "rgba(252, 252, 252, 0.71)" : "rgba(13, 13, 13, 0.695)",
    );
    expect(theme.selectionBackground).toBe(
      isDark ? "rgba(252, 252, 252, 0.104)" : "rgba(0, 0, 0, 0.098)",
    );
    expect(theme.selectionInactiveBackground).toBe(theme.selectionBackground);
    expect(getComputedStyle(terminal).backgroundColor).toBe(
      isDark ? "rgb(17, 17, 17)" : "rgb(255, 255, 255)",
    );
  }
});
