import { describe, expect, test } from "vite-plus/test";
import {
  buildCommandPaletteCharacterHighlightSegments,
  buildCommandPaletteQueryHighlightPreview,
  buildCommandPaletteRangeHighlightSegments,
  buildCommandPaletteTokenHighlightSegments,
  limitCommandPaletteHighlightSegments,
  type CommandPaletteHighlightSegment,
} from "./command-palette-highlight";

function highlightedText(segments: readonly CommandPaletteHighlightSegment[]): string {
  return segments
    .filter((segment) => segment.highlight)
    .map((segment) => segment.text)
    .join("");
}

function fullText(segments: readonly CommandPaletteHighlightSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

describe("command palette character highlighting", () => {
  test("prefers an exact case-insensitive substring", () => {
    const segments = buildCommandPaletteCharacterHighlightSegments("Open Settings", "SET");

    expect(fullText(segments)).toBe("Open Settings");
    expect(highlightedText(segments)).toBe("Set");
  });

  test("highlights repeated and overlapping query tokens", () => {
    const segments = buildCommandPaletteTokenHighlightSegments("banana bandana", "ana nan ana");

    expect(fullText(segments)).toBe("banana bandana");
    expect(highlightedText(segments).length).toBeGreaterThanOrEqual(5);
  });

  test("supports fuzzy command subsequences and rolls back failed matches", () => {
    const matched = buildCommandPaletteCharacterHighlightSegments(
      "Command palette",
      "cmdpal",
      "fuzzy",
    );
    const failed = buildCommandPaletteCharacterHighlightSegments(
      "Command palette",
      "cmdxyz",
      "fuzzy",
    );

    expect(highlightedText(matched).toLocaleLowerCase()).toBe("cmdpal");
    expect(failed).toEqual([{ text: "Command palette", highlight: false }]);
  });

  test("keeps CJK, emoji, and combining marks in one code-point coordinate system", () => {
    const text = "修复 Cafe\u0301 😀 搜索";
    const cjk = buildCommandPaletteCharacterHighlightSegments(text, "修复");
    const emojiAndMark = buildCommandPaletteTokenHighlightSegments(text, "e\u0301 😀");

    expect(fullText(cjk)).toBe(text);
    expect(highlightedText(cjk)).toBe("修复");
    expect(fullText(emojiAndMark)).toBe(text);
    expect(highlightedText(emojiAndMark)).toBe("e\u0301😀");
  });

  test("preserves text for an empty query", () => {
    expect(buildCommandPaletteCharacterHighlightSegments("😀 Search", "")).toEqual([
      { text: "😀 Search", highlight: false },
    ]);
  });

  test("centers a bounded preview around the first matching query token", () => {
    const preview = buildCommandPaletteQueryHighlightPreview(
      `${"prefix ".repeat(20)}projection window ${"suffix ".repeat(20)}`,
      "projection",
      { maxCharacters: 72, leadingContextCharacters: 18 },
    );

    expect(preview?.excerpt.startsWith("…")).toBe(true);
    expect(preview?.excerpt.endsWith("…")).toBe(true);
    expect(preview?.excerpt.includes("projection window")).toBe(true);
    expect(highlightedText(preview?.segments ?? [])).toBe("projection");
  });

  test("keeps a tail match near the visible leading edge instead of backfilling", () => {
    const preview = buildCommandPaletteQueryHighlightPreview(
      "A deliberately longer preview explains that local commits should update only the affected projection window while preserving causal coverage.",
      "caus",
      { maxCharacters: 88, leadingContextCharacters: 18 },
    );

    expect(preview?.excerpt.startsWith("…")).toBe(true);
    expect(preview?.excerpt.endsWith("causal coverage.")).toBe(true);
    expect(preview?.excerpt.indexOf("caus")).toBeLessThanOrEqual(24);
    expect(highlightedText(preview?.segments ?? [])).toBe("caus");
  });

  test("repositions a short excerpt when CSS would ellipsize before its match", () => {
    const preview = buildCommandPaletteQueryHighlightPreview(
      "Exercise the actual desktop boundary at the canonical viewport.",
      "ca",
      { maxCharacters: 88, leadingContextCharacters: 18 },
    );

    expect(preview?.excerpt.startsWith("…")).toBe(true);
    expect(preview?.excerpt.indexOf("ca")).toBeLessThanOrEqual(24);
    expect(highlightedText(preview?.segments ?? [])).toBe("ca");
  });
});

test("reported match ranges become segments, and long text keeps its highlights up to the ellipsis", () => {
  expect(
    buildCommandPaletteRangeHighlightSegments("file-index-module.ts", [
      { start: 0, end: 4 },
      { start: 5, end: 8 },
      { start: 40, end: 41 },
    ]),
  ).toEqual([
    { text: "file", highlight: true },
    { text: "-", highlight: false },
    { text: "ind", highlight: true },
    { text: "ex-module.ts", highlight: false },
  ]);
  expect(
    limitCommandPaletteHighlightSegments(
      [
        { text: "ab", highlight: true },
        { text: "cd  ef", highlight: false },
      ],
      5,
    ),
  ).toEqual([
    { text: "ab", highlight: true },
    { text: "cd", highlight: false },
    { text: "…", highlight: false },
  ]);
});
