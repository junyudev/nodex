import { expect, test } from "vite-plus/test";
import { resolveVisualizationImageCrop } from "./visualization-image-capture";

test("maps CSS content and symmetric padding to actual screenshot pixels", () => {
  expect(
    resolveVisualizationImageCrop(
      { width: 2000, height: 1000 },
      { x: 32, y: 32, width: 600, height: 300 },
      { width: 1000, height: 500 },
    ),
  ).toEqual({ x: 0, y: 0, width: 1328, height: 728 });
  expect(
    resolveVisualizationImageCrop(
      { width: 1250, height: 625 },
      { x: 0.5, y: 0, width: 100.25, height: 20.5 },
      { width: 1000, height: 500 },
    ),
  ).toEqual({ x: 0, y: 0, width: 126, height: 26 });
});

test("rejects invalid, empty or out-of-viewport captures", () => {
  const image = { width: 100, height: 100 };
  const viewport = { width: 100, height: 100 };
  for (const rect of [
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: NaN, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: Infinity, height: 10 },
    { x: 91, y: 0, width: 10, height: 10 },
  ])
    expect(resolveVisualizationImageCrop(image, rect, viewport)).toBeNull();
  expect(
    resolveVisualizationImageCrop(
      { width: 0, height: 100 },
      { x: 0, y: 0, width: 10, height: 10 },
      viewport,
    ),
  ).toBeNull();
});
