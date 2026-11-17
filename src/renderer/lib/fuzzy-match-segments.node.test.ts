import { describe, expect, test } from "vite-plus/test";
import { mergeFuzzyMatchSegments, segmentFuzzyMatch } from "./fuzzy-match-segments";

describe("fuzzy match segments", () => {
  test.each<[text: string, query: string, matchedIndices: number[]]>([
    ["Model", "mo", [0, 1]],
    ["Plan mode", "pm", [0, 5]],
    ["Clear context", "cc", [0, 6]],
    ["Review PR", "rpr", [0, 7, 8]],
    ["GitHub: Fix CI", "fci", [8, 12, 13]],
    ["agent-browser", "ab", [0, 6]],
    ["/Users/a/skills/x/SKILL.md", "skills/x", [9, 10, 11, 12, 13, 14, 15, 16]],
    ["数据库迁移", "迁移", [3, 4]],
    ["🚀 Plan mode", "🚀m", [0, 7]],
    ["🚀Model", "MO", [1, 2]],
    ["🚀 Go", "  ", [0, 1, 2, 3]],
    ["Plan mode", "zzz", []],
    ["Plan mode", "*", []],
    ["Plan mode (PM)", "  pM  ", [11, 12]],
    ["", "mo", []],
  ])("segments %j for query %j at code-point indices %j", (text, query, matchedIndices) => {
    expect(segmentFuzzyMatch(text, query)).toEqual(
      Array.from(text, (text, index) => ({ text, isMatch: matchedIndices.includes(index) })),
    );
  });

  test("requires a contiguous match in substring mode", () => {
    expect(segmentFuzzyMatch("Plan mode", "pm", "substring")).toEqual(
      Array.from("Plan mode", (text) => ({ text, isMatch: false })),
    );
    expect(segmentFuzzyMatch("MO", "mo", "substring")).toEqual([
      { text: "M", isMatch: true },
      { text: "O", isMatch: true },
    ]);
  });
});

test("merges adjacent matches and misses without changing the original segments", () => {
  const segments = Object.freeze([
    Object.freeze({ text: "R", isMatch: true }),
    Object.freeze({ text: "P", isMatch: true }),
    Object.freeze({ text: " ", isMatch: false }),
    Object.freeze({ text: "🚀", isMatch: false }),
    Object.freeze({ text: "2", isMatch: true }),
  ]);

  expect(mergeFuzzyMatchSegments(segments)).toEqual([
    { text: "RP", isMatch: true },
    { text: " 🚀", isMatch: false },
    { text: "2", isMatch: true },
  ]);
  expect(mergeFuzzyMatchSegments([])).toEqual([]);
});
