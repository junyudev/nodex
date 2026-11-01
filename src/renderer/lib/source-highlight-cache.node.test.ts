import { describe, expect, it } from "vite-plus/test";
import {
  MAIN_THREAD_HIGHLIGHT_MAX_CHARACTERS,
  mainThreadSourceLanguage,
  sourceComparisonHighlightCacheKey,
  sourceHighlightCacheKey,
  sourceHighlightKeysOverBudget,
} from "./source-highlight-cache";
import {
  getSourceContentDigest,
  getSourceContentVersion,
  sourceContentVersionOfDigest,
} from "./source-content-version";

describe("source highlight cache identity", () => {
  it("names unchanged content the same way across viewers and mounts", () => {
    const text = "<p>hello</p>\n";
    expect(sourceHighlightCacheKey("local\0/repo/a.html", "html", text)).toBe(
      sourceHighlightCacheKey("local\0/repo/a.html", "html", `${text}`),
    );
  });

  it("separates different text, language, source, and comparison base", () => {
    const keys = new Set([
      sourceHighlightCacheKey("/repo/a.html", "html", "<p>a</p>"),
      sourceHighlightCacheKey("/repo/a.html", "html", "<p>b</p>"),
      sourceHighlightCacheKey("/repo/a.html", "markdown", "<p>a</p>"),
      sourceHighlightCacheKey("/repo/b.html", "html", "<p>a</p>"),
      sourceComparisonHighlightCacheKey("/repo/a.html", "html", "<p>a</p>", {
        path: "/repo/a.html",
        contents: "<p>old</p>",
      }),
      sourceComparisonHighlightCacheKey("/repo/a.html", "html", "<p>a</p>", {
        path: "/repo/a.html",
        contents: "<p>older</p>",
      }),
    ]);
    expect(keys.size).toBe(6);
  });

  it("tells apart texts whose 32-bit version collides", () => {
    // Same length and same 32-bit FNV-1a version.
    const first = 'const x = "9525a3fa";';
    const second = 'const x = "c33c41a0";';
    expect(getSourceContentVersion(first)).toBe(getSourceContentVersion(second));
    expect(sourceHighlightCacheKey("/repo/a.ts", "typescript", first)).not.toBe(
      sourceHighlightCacheKey("/repo/a.ts", "typescript", second),
    );
  });

  it("carries the 32-bit version inside the digest", () => {
    const text = "<main>\n  <p>hello</p>\n</main>\n";
    expect(sourceContentVersionOfDigest(getSourceContentDigest(text))).toBe(
      getSourceContentVersion(text),
    );
  });
});

describe("window-thread highlighting", () => {
  it("keeps the language for text small enough to tokenize without a stall", () => {
    expect(mainThreadSourceLanguage("html", MAIN_THREAD_HIGHLIGHT_MAX_CHARACTERS)).toBe("html");
  });

  it("shows larger text plain", () => {
    expect(mainThreadSourceLanguage("html", MAIN_THREAD_HIGHLIGHT_MAX_CHARACTERS + 1)).toBe("text");
  });
});

describe("source highlight cache budget", () => {
  const key = (length: number, name: string) =>
    sourceHighlightCacheKey(name, "html", "x".repeat(length));

  it("keeps every highlight while their text fits the budget", () => {
    expect(sourceHighlightKeysOverBudget([key(40, "a"), key(60, "b")], 100)).toEqual([]);
  });

  it("drops the oldest highlights until the rest fit", () => {
    const keys = [key(50, "a"), key(30, "b"), key(40, "c"), key(20, "d")];
    expect(sourceHighlightKeysOverBudget(keys, 70)).toEqual([keys[0], keys[1]]);
  });

  it("always keeps the newest highlight, even when it alone exceeds the budget", () => {
    const keys = [key(10, "a"), key(500, "huge")];
    expect(sourceHighlightKeysOverBudget(keys, 100)).toEqual([keys[0]]);
  });

  it("counts both sides of a comparison", () => {
    const comparison = sourceComparisonHighlightCacheKey("/repo/a.html", "html", "x".repeat(60), {
      path: "/repo/a.html",
      contents: "y".repeat(60),
    });
    expect(sourceHighlightKeysOverBudget([comparison, key(1, "b")], 100)).toEqual([comparison]);
  });
});
