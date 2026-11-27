import type { VisualRect, VisualRenderFrame } from "../shared/visual/bridge";
import { VISUAL_LIMITS, type VisualDiagnostic, type VisualSpan } from "../shared/visual/contract";

const GEOMETRY_LIMIT = 2_000;
function rectIn(element: Element, root: DOMRect): VisualRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.x - root.x, y: rect.y - root.y, width: rect.width, height: rect.height };
}

function readSpan(value: string | null): VisualSpan | undefined {
  const match = value?.match(/^(\d+):(\d+)$/u);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end > start && end <= VISUAL_LIMITS.textBytes ? { start, end } : undefined;
}

function intersects(a: VisualRect, b: VisualRect, tolerance = 1) {
  return (
    a.x + a.width > b.x + tolerance &&
    b.x + b.width > a.x + tolerance &&
    a.y + a.height > b.y + tolerance &&
    b.y + b.height > a.y + tolerance
  );
}

function outside(a: VisualRect, b: VisualRect, tolerance = 1) {
  return (
    a.x < b.x - tolerance ||
    a.y < b.y - tolerance ||
    a.x + a.width > b.x + b.width + tolerance ||
    a.y + a.height > b.y + b.height + tolerance
  );
}

function measureMark(mark: SVGGeometryElement, root: DOMRect) {
  if (mark.closest("defs,clipPath,mask,pattern,marker")) return [];
  const style = getComputedStyle(mark);
  const stroke = style.stroke !== "none" && style.strokeOpacity !== "0";
  const fill = style.fill !== "none" && style.fillOpacity !== "0";
  if (style.visibility !== "visible" || style.opacity === "0" || (!stroke && !fill)) return [];
  const matrix = mark.getScreenCTM();
  if (!matrix) return [];
  const bounds = rectIn(mark, root);
  const pad = stroke ? Math.max(1, Number.parseFloat(style.strokeWidth)) : 0;
  return [
    {
      mark,
      stroke,
      fill,
      matrix,
      inverse: matrix.inverse(),
      bounds: {
        x: bounds.x - pad,
        y: bounds.y - pad,
        width: bounds.width + pad * 2,
        height: bounds.height + pad * 2,
      },
    },
  ];
}

function geometryHits(
  measured: ReturnType<typeof measureMark>[number],
  extent: VisualRect,
  root: DOMRect,
) {
  const { mark, stroke, fill, inverse, matrix, bounds } = measured;
  if (!intersects(bounds, extent, 0)) return false;
  // Test points across the label rather than treating an entire path's bounding box as paint.
  for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const y of [0.25, 0.5, 0.75]) {
      const point = new DOMPoint(
        extent.x + root.x + extent.width * x,
        extent.y + root.y + extent.height * y,
      ).matrixTransform(inverse);
      if ((stroke && mark.isPointInStroke(point)) || (fill && mark.isPointInFill(point)))
        return true;
    }
  }
  if (!stroke) return false;
  // A thin line may pass between samples taken in the text box. Sample the stroke as well.
  const length = mark.getTotalLength();
  const count = Math.min(64, Math.max(2, Math.ceil(length / 4)));
  for (let index = 0; index <= count; index++) {
    const point = mark.getPointAtLength((length * index) / count).matrixTransform(matrix);
    if (!outside({ x: point.x - root.x, y: point.y - root.y, width: 0, height: 0 }, extent, 0))
      return true;
  }
  return false;
}

export function measureVisual(
  root: Element,
  readToken: (token: string) => Omit<VisualRenderFrame["datum"][number], "rect"> | undefined,
) {
  const origin = root.getBoundingClientRect();
  const width = Math.ceil(origin.width);
  const height = Math.ceil(origin.height);
  if (
    !width ||
    !height ||
    width > VISUAL_LIMITS.pixelsPerSide ||
    height > VISUAL_LIMITS.pixelsPerSide
  )
    throw new Error("Visual dimensions must be between 1 and 4,096 pixels");
  const datum = [...root.querySelectorAll("[data-nodex-datum]")]
    .slice(0, GEOMETRY_LIMIT)
    .flatMap((element) => {
      const identity = readToken(element.getAttribute("data-nodex-datum") ?? "");
      const elementSpan = readSpan(element.getAttribute("data-nodex-datum-span"));
      return identity ? [{ ...identity, span: elementSpan, rect: rectIn(element, origin) }] : [];
    });
  const text = [...root.querySelectorAll("[data-nodex-text-span]")]
    .slice(0, GEOMETRY_LIMIT)
    .flatMap((element) => {
      const span = readSpan(element.getAttribute("data-nodex-text-span"));
      return span ? [{ span, rect: rectIn(element, origin) }] : [];
    });
  const labels = [...root.querySelectorAll("svg text")]
    .slice(0, GEOMETRY_LIMIT)
    .flatMap((element) => {
      const rect = rectIn(element, origin);
      const style = getComputedStyle(element);
      if (
        !element.textContent?.trim() ||
        rect.width === 0 ||
        rect.height === 0 ||
        style.visibility !== "visible" ||
        style.opacity === "0"
      )
        return [];
      const span = readSpan(
        element.querySelector("[data-nodex-text-span]")?.getAttribute("data-nodex-text-span") ??
          null,
      );
      return [{ element, rect, span, name: element.textContent.trim().slice(0, 120) }];
    });
  const marks = [
    ...root.querySelectorAll(
      "svg line,svg path,svg rect,svg polyline,svg polygon,svg circle,svg ellipse",
    ),
  ]
    .filter((element): element is SVGGeometryElement => element instanceof SVGGeometryElement)
    .slice(0, GEOMETRY_LIMIT)
    .flatMap((mark) => measureMark(mark, origin));
  const diagnostics: VisualDiagnostic[] = [];
  const warn = (code: string, message: string, span?: VisualSpan) => {
    if (diagnostics.length < 100) diagnostics.push({ severity: "warning", code, message, span });
  };
  for (const [index, label] of labels.entries()) {
    const viewport = label.element.closest("svg");
    if (
      outside(label.rect, { x: 0, y: 0, width, height }) ||
      (viewport && outside(label.rect, rectIn(viewport, origin)))
    )
      warn("clipped-text", `“${label.name}” extends outside the SVG viewport`, label.span);
    const overlapping = labels.slice(index + 1).find((other) => intersects(label.rect, other.rect));
    if (overlapping)
      warn("text-overlap", `“${label.name}” overlaps “${overlapping.name}”`, label.span);
    if (marks.some((mark) => geometryHits(mark, label.rect, origin)))
      warn("mark-overlap", `“${label.name}” overlaps a mark or line`, label.span);
  }
  return { width, height, diagnostics, datum, text };
}
