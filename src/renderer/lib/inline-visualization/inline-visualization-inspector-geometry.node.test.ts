import { expect, test } from "vite-plus/test";
import {
  clampInspectorPosition,
  inspectorBoundsOverlap,
  inspectorKeyboardSize,
  inspectorMaximumSize,
  inspectorPickerColor,
  normalizeInspectorPopupHex,
  placeInspector,
  resizeInspector,
} from "./inline-visualization-inspector-geometry";

const viewport = { width: 1000, height: 800, scale: 1 };
test("places a new panel to the right and picks the first clear alternative around declared obstacles", () => {
  const panel = { left: 0, top: 0, width: 368, height: 280 };
  expect(placeInspector(panel, viewport, [], "default")).toEqual({ left: 616, bottom: 563 });
  const obstacle = { left: 600, top: 250, width: 400, height: 400 };
  const position = placeInspector(panel, viewport, [obstacle], "default");
  expect(position).toEqual({ left: 16, bottom: 784 });
  expect(
    inspectorBoundsOverlap(
      { ...panel, left: position.left, top: position.bottom - panel.height },
      obstacle,
    ),
  ).toBe(false);
});
test("settles a moved panel at the nearest clear location and bounds every viewport edge", () => {
  expect(
    placeInspector({ left: 70, top: 200, width: 300, height: 200 }, viewport, [], "nearest"),
  ).toEqual({ left: 16, bottom: 523 });
  expect(
    clampInspectorPosition({ left: -200, bottom: 2000 }, { width: 300, height: 200 }, viewport),
  ).toEqual({ left: 8, bottom: 792 });
  expect(
    clampInspectorPosition({ left: 2000, bottom: -200 }, { width: 300, height: 200 }, viewport),
  ).toEqual({ left: 692, bottom: 262 });
});
test("resizes in CSS units while retaining the opposite edge and bottom under scale", () => {
  const scaled = { ...viewport, scale: 2 };
  expect(inspectorMaximumSize(scaled)).toEqual({ width: 492, height: 342 });
  const bounds = { left: 100, top: 250, width: 300, height: 180 };
  expect(resizeInspector(bounds, { width: 500, height: 400 }, "top-left", scaled)).toEqual({
    position: { left: 8, bottom: 430 },
    size: { width: 196, height: 161 },
  });
  expect(resizeInspector(bounds, { width: 200, height: 100 }, "right", scaled)).toEqual({
    position: { left: 100, bottom: 430 },
    size: { width: 200, height: 100 },
  });
});
test("uses edge direction, ten-unit keyboard steps and minimum/maximum endpoints", () => {
  expect(inspectorKeyboardSize(100, "ArrowRight", "right", 100, 120)).toBe(110);
  expect(inspectorKeyboardSize(100, "ArrowRight", "left", 100, 120)).toBe(100);
  expect(inspectorKeyboardSize(100, "ArrowLeft", "left", 100, 120)).toBe(110);
  expect(inspectorKeyboardSize(115, "ArrowUp", "top", 100, 120)).toBe(120);
  expect(inspectorKeyboardSize(115, "Home", "top", 100, 120)).toBe(100);
  expect(inspectorKeyboardSize(115, "End", "top", 100, 120)).toBe(120);
  expect(inspectorKeyboardSize(115, "ArrowLeft", "top", 100, 120)).toBeNull();
});
test.each([
  [" #aBc ", "#AABBCC"],
  ["aabbcc", "#AABBCC"],
  ["#1234", null],
  ["#11223344", null],
  ["invalid", null],
] as const)("opaque popup HEX validates %s", (input, expected) => {
  expect(normalizeInspectorPopupHex(input)).toBe(expected);
});
test("the opaque picker preserves authored alpha outside its preview representation", () => {
  expect(inspectorPickerColor("#abc9")).toBe("#AABBCC");
  expect(inspectorPickerColor("#abcdef99")).toBe("#ABCDEF");
  expect(inspectorPickerColor("unknown")).toBe("#000000");
});
