import { describe, expect, test } from "vite-plus/test";
import { createFuzzyQueryScorer, scoreFuzzyQueryMatch } from "./settings-search-score";

describe("fuzzy query scorer", () => {
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
