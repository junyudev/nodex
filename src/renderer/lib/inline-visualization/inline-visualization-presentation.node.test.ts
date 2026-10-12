import { describe, expect, test } from "vite-plus/test";
import {
  canExpandInlineVisualization,
  resolveInlineVisualizationMode,
} from "./inline-visualization-presentation";

describe("inline visualization preview eligibility", () => {
  test.each([
    ["narrow", false, false],
    ["narrow", true, false],
    ["wide", false, true],
    ["wide", true, false],
  ] as const)("mode %s with streaming %s admits preview %s", (mode, isStreaming, expected) => {
    expect(canExpandInlineVisualization({ mode, isStreaming })).toBe(expected);
  });
  test("only the explicit wide attribute enables the wide presentation", () => {
    expect(resolveInlineVisualizationMode("wide")).toBe("wide");
    for (const value of [undefined, null, "narrow", "Wide", "wide ", true])
      expect(resolveInlineVisualizationMode(value)).toBe("narrow");
  });
});
