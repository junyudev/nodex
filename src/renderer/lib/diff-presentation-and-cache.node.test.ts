import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, test } from "vite-plus/test";
import { diffHighlightCacheKey, diffHighlightTextLength } from "./diff-highlight-cache";
import { sourceHighlightKeysOverBudget } from "./source-highlight-cache";
import {
  NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT,
  getNodexDiffOptions,
  getNodexReviewDiffOptions,
  getNodexSourceEditorLineHeight,
} from "./diff-presentation";
import {
  middleTruncateReviewJumpText,
  selectReviewJumpToFileMatches,
  splitReviewJumpToFilePath,
} from "./review-jump-to-file";

describe("diff highlight cache", () => {
  const diff = parseDiffFromFile(
    { name: "page.html", contents: "<p>old</p>\n" },
    { name: "page.html", contents: "<p>new</p>\n" },
  );

  describe("diff highlight identity", () => {
    test("reuses identical metadata after reparsing, independent of producer keys", () => {
      const copied: FileDiffMetadata = JSON.parse(JSON.stringify(diff));
      expect(diffHighlightCacheKey({ ...copied, cacheKey: "another-mount" })).toBe(
        diffHighlightCacheKey(diff),
      );
    });

    test("separates texts, language, file names, layout and hydration state", () => {
      const variants: FileDiffMetadata[] = [
        diff,
        { ...diff, additionLines: ["<p>NEW</p>\n"] },
        { ...diff, deletionLines: ["<p>OLD</p>\n"] },
        { ...diff, lang: "text" },
        { ...diff, name: "other.html" },
        { ...diff, prevName: "previous.html" },
        { ...diff, isPartial: true },
        {
          ...diff,
          hunks: diff.hunks.map((hunk) => ({ ...hunk, additionStart: hunk.additionStart + 1 })),
        },
      ];
      expect(new Set(variants.map(diffHighlightCacheKey)).size).toBe(variants.length);
    });

    test("separates line boundaries even when concatenated text matches", () => {
      expect(diffHighlightCacheKey({ ...diff, additionLines: ["ab", "c"] })).not.toBe(
        diffHighlightCacheKey({ ...diff, additionLines: ["a", "bc"] }),
      );
    });

    test("counts full arrays on both sides even if patch character counts are stale", () => {
      const hydrated = {
        ...diff,
        deletionLines: ["x".repeat(60)],
        additionLines: ["y".repeat(60)],
      };
      const key = diffHighlightCacheKey(hydrated);
      expect(diffHighlightTextLength(hydrated)).toBe(120);
      expect(sourceHighlightKeysOverBudget([key, diffHighlightCacheKey(diff)], 100)).toEqual([key]);
    });
  });
});

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

describe("review jump-to-file model", () => {
  test("splits display paths into file name and parent label", () => {
    const nested = splitReviewJumpToFilePath("src/renderer/editor/file.tsx");
    expect(nested.fileName).toBe("file.tsx");
    expect(nested.parentPath).toBe("src/renderer/editor");

    const root = splitReviewJumpToFilePath("README.md");
    expect(root.fileName).toBe("README.md");
    expect(root.parentPath).toBe("");
  });

  test("sorts empty jump results by file name before parent path", () => {
    const matches = selectReviewJumpToFileMatches(
      [
        { displayPath: "src/workbench/zeta.ts" },
        { displayPath: "docs/foo.ts" },
        { displayPath: "src/renderer/foo.ts" },
      ],
      "",
    );

    expect(matches.map((entry) => entry.displayPath).join("|")).toBe(
      "docs/foo.ts|src/renderer/foo.ts|src/workbench/zeta.ts",
    );
  });

  test("scores file name matches before falling back to full path matches", () => {
    const matches = selectReviewJumpToFileMatches(
      [
        { displayPath: "src/renderer/components/board/editor/nfm-editor-popover-content.tsx" },
        { displayPath: "docs/editor.md" },
        { displayPath: "src/renderer/components/board/card.tsx" },
      ],
      "editor",
    );

    expect(matches.map((entry) => entry.displayPath).join("|")).toBe(
      "docs/editor.md|src/renderer/components/board/editor/nfm-editor-popover-content.tsx",
    );
  });

  test("middle truncates parent labels when they do not fit", () => {
    const measureByCharacters = (value: string) => value.length;

    expect(middleTruncateReviewJumpText("src/editor", 20, measureByCharacters)).toBe("src/editor");

    const truncated = middleTruncateReviewJumpText(
      "src/renderer/components/board/editor",
      12,
      measureByCharacters,
    );
    expect(truncated.includes("…")).toBe(true);
    expect(truncated.startsWith("src/")).toBe(true);
    expect(truncated.endsWith("itor")).toBe(true);
    expect(truncated.length <= 12).toBe(true);
  });
});
