import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveTerminalTypography, sameTerminalTypography } from "./terminal-typography";

afterEach(() => document.body.replaceChildren());

describe("terminal-typography", () => {
  test("normalizes configured font families for xterm canvas metrics", () => {
    const host = document.createElement("div");
    host.style.setProperty("--font-mono", "Monaco");
    host.style.setProperty("--font-code-size", "15.5px");
    document.body.appendChild(host);

    const typography = resolveTerminalTypography(host);

    expect(typography.fontFamily).toBe('Monaco, "Symbols Nerd Font Mono", monospace');
    expect(typography.fontSize).toBe(15.5);
  });

  test("does not pass unresolved CSS variables to xterm", () => {
    const host = document.createElement("div");
    host.style.setProperty("--font-mono", "var(--font-code-family, monospace)");
    document.body.appendChild(host);

    const typography = resolveTerminalTypography(host);

    expect(typography.fontFamily.includes("var(")).toBe(false);
    expect(typography.fontFamily.includes("monospace")).toBe(true);
  });

  test("does not confuse ui-monospace with the generic monospace fallback", () => {
    const host = document.createElement("div");
    host.style.setProperty("--font-mono", "ui-monospace");
    document.body.appendChild(host);

    const typography = resolveTerminalTypography(host);

    expect(typography.fontFamily).toBe('ui-monospace, "Symbols Nerd Font Mono", monospace');
  });

  test("falls back when CSS token resolution is unavailable", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const typography = resolveTerminalTypography(host);

    expect(typography.fontFamily.length > 0).toBe(true);
    expect(typography.fontSize).toBe(12);
  });

  test("compares terminal typography snapshots", () => {
    expect(
      sameTerminalTypography(
        { fontFamily: "Menlo, monospace", fontSize: 14 },
        { fontFamily: "Menlo, monospace", fontSize: 14 },
      ),
    ).toBe(true);
    expect(
      sameTerminalTypography(
        { fontFamily: "Menlo, monospace", fontSize: 14 },
        { fontFamily: "Monaco, monospace", fontSize: 14 },
      ),
    ).toBe(false);
  });
});
