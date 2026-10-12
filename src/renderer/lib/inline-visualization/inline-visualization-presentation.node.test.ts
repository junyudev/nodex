import { describe, expect, test } from "vite-plus/test";
import {
  inlineVisualizationContentBounds,
  inlineVisualizationContentWidth,
} from "./inline-visualization-presentation";
import { resolveVisualizationImageCrop } from "../../../shared/visualization-image-capture";

describe("visualization content and paint bounds", () => {
  test("keeps paint overflow outside measured content and includes it in native image capture", () => {
    const viewport = { width: 500.5, height: 151 };
    const content = inlineVisualizationContentBounds(viewport)!;
    expect(inlineVisualizationContentWidth(viewport.width)).toBe(490.5);
    expect(content).toEqual({ x: 5, y: 5, width: 490.5, height: 141 });
    expect(resolveVisualizationImageCrop({ width: 1001, height: 302 }, content, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1001,
      height: 302,
    });
  });

  test("rejects native viewports without a content area", () => {
    expect(inlineVisualizationContentWidth(8)).toBe(0);
    for (const viewport of [
      { width: 10, height: 50 },
      { width: 50, height: 10 },
      { width: NaN, height: 50 },
      { width: 50, height: Infinity },
    ])
      expect(inlineVisualizationContentBounds(viewport)).toBeNull();
  });
});
