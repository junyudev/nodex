import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  buildVscodeTokenCss,
  parseVscodeTokenKeys,
  resolveVscodeTokenValue,
  toVscodeCssVariableName,
} from "./vscode-theme-vars";

const THIS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const KEYS_FILE = resolve(REPO_ROOT, "scripts/vscode-theme-color-keys.txt");
const GENERATED_CSS_FILE = resolve(REPO_ROOT, "src/renderer/styles/vscode-theme-vars.css");

function readTokenKeys(): string[] {
  return parseVscodeTokenKeys(readFileSync(KEYS_FILE, "utf8"));
}

describe("vscode-theme-vars", () => {
  test("converts VS Code token key names to CSS variable names", () => {
    expect(toVscodeCssVariableName("sideBar.background")).toBe("--vscode-sideBar-background");
    expect(toVscodeCssVariableName("titleBar.activeForeground")).toBe("--vscode-titleBar-activeForeground");
  });

  test("resolves critical explicit mappings", () => {
    expect(resolveVscodeTokenValue("sideBar.background")).toBe("var(--color-background-surface)");
    expect(resolveVscodeTokenValue("sideBarSectionHeader.background")).toBe("var(--background-secondary)");
    expect(resolveVscodeTokenValue("titleBar.activeBackground")).toBe("var(--background-secondary)");
    expect(resolveVscodeTokenValue("descriptionForeground")).toBe(
      "var(--color-text-foreground-tertiary)",
    );
    expect(resolveVscodeTokenValue("icon.foreground")).toBe("var(--color-icon-primary)");
    expect(resolveVscodeTokenValue("badge.foreground")).toBe(
      "var(--color-text-foreground-secondary)",
    );
    expect(resolveVscodeTokenValue("input.background")).toBe(
      "var(--color-background-elevated-primary)",
    );
    expect(resolveVscodeTokenValue("button.background")).toBe("var(--accent-blue)");
    expect(resolveVscodeTokenValue("dropdown.background")).toBe("var(--color-background-elevated-primary-opaque)");
    expect(resolveVscodeTokenValue("dropdown.listBackground")).toBe(
      "var(--color-background-elevated-primary)",
    );
    expect(resolveVscodeTokenValue("scrollbarSlider.background")).toBe("var(--color-border)");
    expect(resolveVscodeTokenValue("textLink.foreground")).toBe("var(--color-text-accent)");
    expect(resolveVscodeTokenValue("chart.axis")).toBe(
      "var(--color-text-foreground-tertiary)",
    );
    expect(resolveVscodeTokenValue("terminal.ansiBlack")).toBe(
      "var(--color-text-foreground-tertiary)",
    );
    expect(resolveVscodeTokenValue("terminal.ansiBrightBlack")).toBe(
      "var(--color-text-foreground-secondary)",
    );
  });

  test("resolves fallback mappings case-insensitively", () => {
    expect(resolveVscodeTokenValue("any.unknownActiveBackground")).toBe(
      "color-mix(in srgb, var(--accent-blue) 16%, var(--background))",
    );
    expect(resolveVscodeTokenValue("another.keySecondaryBackground")).toBe("var(--background-secondary)");
    expect(resolveVscodeTokenValue("another.keyFocusBorder")).toBe("var(--color-border-focus)");
    expect(resolveVscodeTokenValue("something.customForeground")).toBe(
      "var(--color-text-foreground)",
    );
  });

  test("generates declarations for every token key", () => {
    const keys = readTokenKeys();
    const css = buildVscodeTokenCss(keys);

    for (const key of keys) {
      const declarationPrefix = `  ${toVscodeCssVariableName(key)}:`;
      expect(css.includes(declarationPrefix)).toBe(true);
    }
  });

  test("generated css file is up to date", () => {
    const keys = readTokenKeys();
    const expectedCss = buildVscodeTokenCss(keys);
    const actualCss = readFileSync(GENERATED_CSS_FILE, "utf8");

    expect(actualCss).toBe(expectedCss);
  });
});
