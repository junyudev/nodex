import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import {
  ImageCanvasViewIcon,
  ImageFocusedViewIcon,
  ImageResizeIcon,
  LandscapeAspectRatioIcon,
  PortraitAspectRatioIcon,
  SquareAspectRatioIcon,
  StoryAspectRatioIcon,
  WidescreenAspectRatioIcon,
} from "./image-editor-aspect-icons";
import {
  ImageCommentMarkerShape,
  ImageCommentIcon,
  ImageEditorTabIcon,
  ImageEraseIcon,
  ImageMultiSelectIcon,
  ImageRedoIcon,
  ImageRemoveBackgroundIcon,
  ImageRemoveBrushTrackShape,
  ImageRemoveIcon,
  ImageUndoIcon,
  ImageZoomMinusIcon,
} from "./image-editor-icons";

describe("image-editor semantic icons", () => {
  test.each([
    ["square", SquareAspectRatioIcon],
    ["portrait", PortraitAspectRatioIcon],
    ["story", StoryAspectRatioIcon],
    ["landscape", LandscapeAspectRatioIcon],
    ["widescreen", WidescreenAspectRatioIcon],
  ])("renders exact aspect-ratio geometry for %s", (_label, Icon) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("height")).toBe("20");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
    expect(svg?.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(300);
  });

  test("keeps each aspect option visually distinct", () => {
    const geometries = [
      SquareAspectRatioIcon,
      PortraitAspectRatioIcon,
      StoryAspectRatioIcon,
      LandscapeAspectRatioIcon,
      WidescreenAspectRatioIcon,
    ].map((Icon) => {
      const view = render(<Icon />);
      return view.container.querySelector("path")?.getAttribute("d");
    });

    expect(new Set(geometries).size).toBe(5);
  });

  test("renders the focused and four-tile canvas view affordances", () => {
    const focusedView = render(<ImageFocusedViewIcon />);
    const canvasView = render(<ImageCanvasViewIcon />);
    const focusedSvg = focusedView.container.querySelector("svg");
    const canvasSvg = canvasView.container.querySelector("svg");

    expect(focusedSvg?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(focusedSvg?.querySelector("g")?.getAttribute("transform")).toBe("translate(1.468 2.11)");
    expect(focusedSvg?.querySelectorAll("path")).toHaveLength(1);
    expect(canvasSvg?.querySelector("g")?.getAttribute("transform")).toBe("translate(1.516 1.516)");
    expect(canvasSvg?.querySelectorAll("path")).toHaveLength(4);
  });

  test("renders tab, comment, erase, background, resize, history, and selection identities", () => {
    const tab = render(<ImageEditorTabIcon />).container.querySelector("svg");
    const comment = render(<ImageCommentIcon />).container.querySelector("svg");
    const erase = render(<ImageEraseIcon />).container.querySelector("svg");
    const removeBackground = render(<ImageRemoveBackgroundIcon />).container.querySelector("svg");
    const remove = render(<ImageRemoveIcon />).container.querySelector("svg");
    const resize = render(<ImageResizeIcon />).container.querySelector("svg");
    const undo = render(<ImageUndoIcon />).container.querySelector("svg");
    const redo = render(<ImageRedoIcon />).container.querySelector("svg");
    const select = render(<ImageMultiSelectIcon />).container.querySelector("svg");

    expect(tab?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(tab?.querySelectorAll("path")).toHaveLength(3);
    expect(comment?.querySelectorAll("path")).toHaveLength(2);
    expect(erase?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(erase?.querySelector("path")?.getAttribute("fill-rule")).toBe("evenodd");
    expect(removeBackground?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(removeBackground?.querySelector("path")?.getAttribute("fill-rule")).toBe("evenodd");
    expect(removeBackground?.querySelector("path")?.getAttribute("d")).not.toBe(
      erase?.querySelector("path")?.getAttribute("d"),
    );
    expect(remove?.querySelector("path")?.getAttribute("transform")).toBe(
      "translate(2 2) scale(1.25)",
    );
    expect(resize?.querySelector("path")?.getAttribute("fill-rule")).toBe("evenodd");
    expect(undo?.querySelectorAll("path")).toHaveLength(1);
    expect(redo?.getAttribute("class")).toContain("-scale-x-100");
    expect(select?.getAttribute("viewBox")).toBe("0 0 13 13");
  });

  test("keeps marker, zoom, and brush-track shapes at their authored geometry", () => {
    const marker = render(<ImageCommentMarkerShape />).container.querySelector("svg");
    const zoomMinus = render(<ImageZoomMinusIcon />).container.querySelector("svg");
    const brushTrack = render(<ImageRemoveBrushTrackShape />).container.querySelector("svg");

    expect(marker?.getAttribute("viewBox")).toBe("0 0 26 25");
    expect(marker?.querySelector("path")?.getAttribute("stroke-width")).toBe("1.65");
    expect(zoomMinus?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(brushTrack?.getAttribute("viewBox")).toBe("0 0 12 160");
    expect(brushTrack?.getAttribute("preserveAspectRatio")).toBe("none");
  });
});
