import { describe, expect, test } from "bun:test";
import {
  NODEX_DIFF_HOST_CLASS,
  NODEX_DIFF_UNSAFE_CSS,
  getNodexDiffHostStyle,
  getNodexDiffOptions,
} from "./diff-presentation";

describe("diff-presentation", () => {
  test("returns codex-like diff options", () => {
    const options = getNodexDiffOptions("dark", true);
    const theme = options.theme as Record<string, string>;

    expect(theme.dark).toBe("pierre-dark");
    expect(theme.light).toBe("pierre-light");
    expect(options.themeType).toBe("dark");
    expect(options.diffStyle).toBe("unified");
    expect(options.diffIndicators).toBe("bars");
    expect(options.overflow).toBe("scroll");
    expect(options.hunkSeparators).toBe("simple");
    expect(options.disableFileHeader).toBe(true);
    expect(options.unsafeCSS?.includes(`:host(.${NODEX_DIFF_HOST_CLASS}) [data-separator]:empty`)).toBeTrue();
    expect(options.unsafeCSS?.includes('[data-line-type="change-addition"]')).toBeTrue();
    expect(options.unsafeCSS?.includes('--diffs-bg: transparent;')).toBeTrue();
    expect(options.unsafeCSS?.includes("[data-separator-content]:first-child")).toBeTrue();
    expect(options.unsafeCSS?.includes("[data-diffs] [data-column-content] {")).toBeFalse();
  });

  test("returns codex-like host-level style variables for diff theming", () => {
    const darkStyle = getNodexDiffHostStyle("dark") as Record<string, string>;
    const lightStyle = getNodexDiffHostStyle("light") as Record<string, string>;

    expect(darkStyle["--nodex-diffs-surface"]?.includes("color-mix")).toBeTrue();
    expect(darkStyle["--nodex-diffs-context-number"]?.includes("98.5%")).toBeTrue();
    expect(darkStyle["--nodex-diffs-addition-number"]?.includes("91%")).toBeTrue();
    expect(darkStyle["--nodex-diffs-deletion-number"]?.includes("91%")).toBeTrue();
    expect(darkStyle["--diffs-addition-color-override"]).toBe("#40c977");
    expect(darkStyle["--diffs-deletion-color-override"]).toBe("#fa423e");
    expect(lightStyle["--diffs-addition-color-override"]).toBe("#00a240");
    expect(lightStyle["--diffs-deletion-color-override"]).toBe("#ba2623");
    expect(darkStyle["--diffs-font-size"]).toBe("var(--vscode-editor-font-size, 14px)");
    expect(darkStyle["--diffs-line-height"]).toBe(
      "calc(var(--diffs-font-size, var(--vscode-editor-font-size, 14px)) * 1.8)",
    );
    expect(darkStyle["--diffs-gap-block"]).toBe("0");
    expect(darkStyle["--diffs-min-number-column-width"]).toBe("4ch");
    expect(NODEX_DIFF_UNSAFE_CSS.includes("[data-diffs-header]")).toBeTrue();
  });
});
