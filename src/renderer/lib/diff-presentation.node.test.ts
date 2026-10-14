import { describe, expect, test } from "vite-plus/test";
import {
  NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT,
  getNodexDiffOptions,
  getNodexReviewDiffOptions,
  getNodexSourceEditorLineHeight,
} from "./diff-presentation";

describe("getNodexDiffOptions", () => {
  test.each([
    [8, 14],
    [12, 22],
    [12.5, 23],
    [16, 29],
    [24, 43],
  ])("keeps %ipx editable code rows on a %ipx caret grid", (fontSize, lineHeight) => {
    expect(getNodexSourceEditorLineHeight(fontSize)).toBe(lineHeight);
  });
  test("uses wrap overflow when word wrap is enabled", () => {
    const options = getNodexDiffOptions("light", true, { wrap: true });
    expect(options.overflow).toBe("wrap");
  });

  test("keeps scroll overflow when word wrap is disabled", () => {
    const options = getNodexDiffOptions("light", true, { wrap: false });
    expect(options.overflow).toBe("scroll");
  });

  test("lets an explicit overflow override the wrap default", () => {
    const options = getNodexDiffOptions("light", true, {
      wrap: true,
      overflow: "scroll",
    });
    expect(options.overflow).toBe("scroll");
  });

  test("uses wrap overflow for Review when word wrap is enabled", () => {
    const options = getNodexReviewDiffOptions("light", true, { wrap: true });
    expect(options.overflow).toBe("wrap");
  });

  test("lets Review explicitly override word wrap overflow", () => {
    const options = getNodexReviewDiffOptions("light", true, {
      wrap: true,
      overflow: "scroll",
    });
    expect(options.overflow).toBe("scroll");
  });

  test("keeps inline diffs on simple hunk separators by default", () => {
    const options = getNodexDiffOptions("light", true);

    expect(options.hunkSeparators).toBe("simple");
  });

  test("uses Codex review hunk separators for review diffs", () => {
    const options = getNodexReviewDiffOptions("dark", true);

    expect(options.hunkSeparators).toBe("line-info");
    expect(options.collapsedContextThreshold).toBe(1);
    expect(options.expansionLineCount).toBe(NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT);
    expect(options.lineDiffType).toBe("word-alt");
    expect(options.overflow).toBe("scroll");
  });

  test("uses Codex review separator geometry without local gutter offsets", () => {
    const options = getNodexReviewDiffOptions("dark", true);
    const unsafeCss = String(options.unsafeCSS);

    expect(unsafeCss.includes("grid-template-columns: var(--diffs-column-number-width) auto")).toBe(
      true,
    );
    expect(unsafeCss.includes("padding-inline: 2px")).toBe(true);
    expect(unsafeCss.includes("margin-left: 34px")).toBe(false);
    expect(unsafeCss.includes("width: 44px")).toBe(false);
  });

  test("uses Codex continuous addition bar and mark styling", () => {
    const options = getNodexReviewDiffOptions("dark", true);
    const unsafeCss = String(options.unsafeCSS);

    expect(unsafeCss.includes("--codex-diffs-header-surface")).toBe(true);
    expect(unsafeCss.includes("--diffs-bg-buffer-override")).toBe(false);
    expect(unsafeCss.includes("--diffs-bg-selection-override")).toBe(false);
    expect(
      unsafeCss.includes('+ [data-line-type="change-addition"][data-column-number]::before'),
    ).toBe(true);
    expect(unsafeCss.includes("contain: none")).toBe(true);
    expect(unsafeCss.includes("height: calc(100% + 1px)")).toBe(true);
    expect(unsafeCss.includes("data-previous-line-type")).toBe(false);
    expect(unsafeCss.includes("box-shadow: 0 -2px")).toBe(false);
    expect(unsafeCss.includes("mark.codex-thread-find-match")).toBe(true);
    expect(unsafeCss.includes("mark[data-mark]")).toBe(false);
  });

  test("does not mix review line-info styling into inline diffs", () => {
    const options = getNodexDiffOptions("dark", true);
    const unsafeCss = String(options.unsafeCSS);

    expect(options.hunkSeparators).toBe("simple");
    expect(unsafeCss.includes("color-token-list-active-selection-background) 56%")).toBe(false);
  });

  test("allows review word diffs to be disabled explicitly", () => {
    const options = getNodexReviewDiffOptions("dark", true, {
      lineDiffType: "none",
    });

    expect(options.lineDiffType).toBe("none");
    expect(options.hunkSeparators).toBe("line-info");
  });

  test("passes collapsed state through the Review layout options", () => {
    const options = getNodexReviewDiffOptions("dark", true, {
      collapsed: true,
    });

    expect(options.collapsed).toBe(true);
  });
});
