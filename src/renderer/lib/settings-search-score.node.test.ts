import { describe, expect, test } from "vite-plus/test";
import {
  createFuzzyQueryScorer,
  matchFuzzyQueryFragments,
  scoreFuzzyQueryMatch,
} from "./settings-search-score";

describe("fuzzy query scorer", () => {
  test.each([
    {
      candidate: "Review PR Code",
      query: "rPc",
      score: 0,
      fragments: null,
    },
    {
      candidate: "Review Code",
      query: "RC",
      score: 110999,
      fragments: [
        { startOffset: 0, endOffset: 1 },
        { startOffset: 7, endOffset: 8 },
      ],
    },
    {
      candidate: "XMLParser",
      query: "xp",
      score: 109891,
      fragments: [
        { startOffset: 0, endOffset: 1 },
        { startOffset: 3, endOffset: 4 },
      ],
    },
    {
      candidate: "a12",
      query: "a2",
      score: 109937,
      fragments: [
        { startOffset: 0, endOffset: 1 },
        { startOffset: 2, endOffset: 3 },
      ],
    },
    {
      candidate: "a1Alpha",
      query: "aa",
      score: 109813,
      fragments: [
        { startOffset: 0, endOffset: 1 },
        { startOffset: 2, endOffset: 3 },
      ],
    },
    {
      candidate: "agent/tools-browser",
      query: "ab",
      score: 109801,
      fragments: [
        { startOffset: 0, endOffset: 1 },
        { startOffset: 12, endOffset: 13 },
      ],
    },
    {
      candidate: "𐐀 Mode",
      query: "𐐀m",
      score: 109913,
      fragments: [
        { startOffset: 0, endOffset: 2 },
        { startOffset: 3, endOffset: 4 },
      ],
    },
  ])("scores and marks $candidate for $query", ({ candidate, query, score, fragments }) => {
    expect(scoreFuzzyQueryMatch(candidate, query)).toBe(score);
    expect(matchFuzzyQueryFragments(candidate, query)).toEqual(fragments);
  });

  test("rejects repeated fragments whose final letter cannot start or continue a word", () => {
    const score = createFuzzyQueryScorer("aaaaaaaaaaaaab");
    const started = performance.now();
    for (let index = 0; index < 40; index += 1) {
      expect(score("aaaa ".repeat(200) + "xb")).toBe(0);
    }
    // A broad responsiveness budget catches multi-second backtracking without
    // depending on sub-millisecond timings or the exact matching implementation.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(score("aaaa ".repeat(200) + "ab")).toBeGreaterThan(0);
  });

  test("reuses a query without leaking failed branches between candidates", () => {
    for (const query of ["aaaaab", "a*b", "s/f", "é", "😀", "İ"]) {
      const score = createFuzzyQueryScorer(query);
      const candidates = ["aaaa xb", "aaaa ab", "src/foo.ts", "Café", "😀 Skill", "İstanbul"];
      for (const candidate of [...candidates, ...candidates.toReversed()]) {
        expect(score(candidate)).toBe(scoreFuzzyQueryMatch(candidate, query));
      }
    }
  });

  test("matches Unicode and paths while preserving UTF-16 offsets", () => {
    expect(scoreFuzzyQueryMatch("Café Editor", "É")).toBeGreaterThan(0);
    expect(scoreFuzzyQueryMatch("😀 Skill", "😀")).toBe(110022);
    expect(scoreFuzzyQueryMatch("İstanbul", "İ")).toBeGreaterThan(0);
    expect(scoreFuzzyQueryMatch("src/foo/bar.ts", "s/b")).toBe(109796);
    expect(scoreFuzzyQueryMatch("src\\foo\\bar.ts", "s\\b")).toBe(109796);
    expect(scoreFuzzyQueryMatch("anything", "  ")).toBe(0);
  });
});

describe("fuzzy query fragments", () => {
  test("returns separate runs at UTF-16 offsets in the original candidate", () => {
    expect(matchFuzzyQueryFragments("🚀 Plan mode", "  🚀M  ")).toEqual([
      { startOffset: 0, endOffset: 2 },
      { startOffset: 8, endOffset: 9 },
    ]);
  });

  test("normalizes path separators and prefers the path match over the basename match", () => {
    expect(matchFuzzyQueryFragments("x /skills/x", "skills/x")).toEqual([
      { startOffset: 3, endOffset: 11 },
    ]);
    expect(matchFuzzyQueryFragments("C:\\Users\\a\\skills\\x\\SKILL.md", "skills/x")).toEqual([
      { startOffset: 11, endOffset: 19 },
    ]);
    expect(matchFuzzyQueryFragments("x", "skills/x")).toEqual([{ startOffset: 0, endOffset: 1 }]);
  });

  test("distinguishes a wildcard match from a blank query or a miss", () => {
    expect(matchFuzzyQueryFragments("Plan mode", "*")).toEqual([]);
    expect(matchFuzzyQueryFragments("Plan mode", "  ")).toBeNull();
    expect(matchFuzzyQueryFragments("Plan mode", "zzz")).toBeNull();
  });
});
