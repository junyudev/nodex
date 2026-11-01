import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, test } from "vite-plus/test";
import { diffHighlightCacheKey, diffHighlightTextLength } from "./diff-highlight-cache";
import { sourceHighlightKeysOverBudget } from "./source-highlight-cache";

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
    const hydrated = { ...diff, deletionLines: ["x".repeat(60)], additionLines: ["y".repeat(60)] };
    const key = diffHighlightCacheKey(hydrated);
    expect(diffHighlightTextLength(hydrated)).toBe(120);
    expect(sourceHighlightKeysOverBudget([key, diffHighlightCacheKey(diff)], 100)).toEqual([key]);
  });
});
