import { expect, test } from "vite-plus/test";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { applyTerminalTheme } from "./terminal-appearance";
import { TerminalRenderer } from "./terminal-renderer";
import type { ITheme } from "@xterm/xterm";

import "@/globals.css";
import "@xterm/xterm/css/xterm.css";

installRendererThemeFixture();

const tokens = {
  background: "background",
  foreground: "foreground",
  cursor: "foreground",
  selectionBackground: "selection",
  selectionInactiveBackground: "selection-inactive",
  black: "ansi-black",
  red: "ansi-red",
  green: "ansi-green",
  yellow: "ansi-yellow",
  blue: "ansi-blue",
  magenta: "ansi-magenta",
  cyan: "ansi-cyan",
  white: "ansi-white",
  brightBlack: "ansi-bright-black",
  brightRed: "ansi-bright-red",
  brightGreen: "ansi-bright-green",
  brightYellow: "ansi-bright-yellow",
  brightBlue: "ansi-bright-blue",
  brightMagenta: "ansi-bright-magenta",
  brightCyan: "ansi-bright-cyan",
  brightWhite: "ansi-bright-white",
} satisfies Partial<Record<keyof ITheme, string>>;

test("applies the computed terminal tokens across light, dark, and light appearances", async () => {
  const surface = document.createElement("div");
  surface.dataset.codexTerminal = "true";
  surface.className = "terminal-fallback-surface";
  document.body.append(surface);
  const renderer = new TerminalRenderer({});
  const term = renderer.terminal;

  try {
    term.open(surface);
    renderer.replaceOutput("\x1b[31mR");
    await renderer.ready;

    const palettes: ITheme[] = [];
    for (const variant of ["light", "dark", "light"] as const) {
      applyRendererThemeForTest(variant);
      applyTerminalTheme(term, surface);
      const theme = term.options.theme ?? {};
      for (const [role, token] of Object.entries(tokens)) {
        expect(theme[role as keyof typeof tokens], role).toBe(
          readRendererThemeColor(`--color-codex-terminal-${token}`),
        );
      }
      await expect.poll(() => readCellColor(surface, "R")).toBe(theme.red);
      palettes.push(theme);
    }

    expect(palettes[1]).not.toEqual(palettes[0]);
    expect(palettes[2]).toEqual(palettes[0]);
  } finally {
    renderer.dispose();
    surface.remove();
  }
});

function readCellColor(surface: HTMLElement, glyph: string): string | undefined {
  const cell = Array.from(surface.querySelectorAll(".xterm-rows span")).find(
    (element) => element.textContent === glyph,
  );
  return cell ? getComputedStyle(cell).color : undefined;
}

test("paints indexed SGR with the resolved modern CSS color and truecolor with the SGR value", async () => {
  const surface = document.createElement("div");
  surface.style.setProperty(
    "--color-codex-terminal-ansi-red",
    "color-mix(in srgb, rgb(40 80 120), rgb(80 120 160))",
  );
  document.body.append(surface);
  const expected = document.createElement("span");
  expected.style.color = "var(--color-codex-terminal-ansi-red)";
  surface.append(expected);
  const indexedColor = getComputedStyle(expected).color;
  expected.remove();
  const renderer = new TerminalRenderer({});
  const term = renderer.terminal;

  try {
    term.open(surface);
    applyTerminalTheme(term, surface);
    renderer.replaceOutput("\x1b[38;5;1mI\x1b[38;2;12;98;207mT");
    await renderer.ready;

    await expect.poll(() => readCellColor(surface, "I")).toBe(indexedColor);
    expect(readCellColor(surface, "T")).toBe("rgb(12, 98, 207)");
  } finally {
    renderer.dispose();
    surface.remove();
  }
});
