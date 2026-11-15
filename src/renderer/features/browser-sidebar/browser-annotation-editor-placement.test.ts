import { describe, expect, test } from "vite-plus/test";
import { placeBrowserAnnotationEditor } from "./browser-annotation-editor-position";
const page = { width: 800, height: 600 };
const editor = { width: 320, height: 240 };
describe("Browser annotation editor placement", () => {
  test("places beside the target and flips at the right edge", () => {
    expect(
      placeBrowserAnnotationEditor({ x: 20, y: 30, width: 80, height: 50 }, page, editor),
    ).toMatchObject({ left: 108, top: 30 });
    expect(
      placeBrowserAnnotationEditor({ x: 700, y: 30, width: 80, height: 50 }, page, editor),
    ).toMatchObject({ left: 372, top: 30 });
  });
  test("goes below a target with no room beside it, and above one at the bottom", () => {
    expect(
      placeBrowserAnnotationEditor({ x: 20, y: 30, width: 760, height: 50 }, page, editor),
    ).toMatchObject({ left: 20, top: 88 });
    expect(
      placeBrowserAnnotationEditor({ x: 20, y: 500, width: 760, height: 50 }, page, editor),
    ).toMatchObject({ left: 20, top: 252 });
  });
  test("clamps offscreen anchors and constrains an oversized editor", () => {
    expect(
      placeBrowserAnnotationEditor({ x: -200, y: 700, width: 1, height: 1 }, page, editor),
    ).toMatchObject({ left: 8, top: 352 });
    expect(
      placeBrowserAnnotationEditor(
        { x: 200, y: -20, width: 1, height: 1 },
        { width: 200, height: 100 },
        editor,
      ),
    ).toEqual({ left: 8, top: 8, maxWidth: 184, maxHeight: 84 });
  });
});
