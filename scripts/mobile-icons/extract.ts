import { DOMParser, type Element } from "@xmldom/xmldom";
import svgpath from "svgpath";
import type { IconGlyph, IconPathDescriptor } from "../../packages/mobile/src/ui/icon-glyphs";

type Transform = readonly [sx: number, sy: number, tx: number, ty: number];
const IDENTITY: Transform = [1, 1, 0, 0];
const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/giu;
const PRESENTATION = [
  "fill",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "transform",
];
const GEOMETRY: Record<string, readonly string[]> = {
  path: ["d"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  g: ["style"],
  svg: ["viewBox", "width", "height", "xmlns", "focusable", "role"],
};
const children = (element: Element): Element[] =>
  Array.from(element.childNodes).flatMap((node) => {
    if (node.nodeType === 1) return [node as Element];
    if (node.nodeType === 3 && !node.textContent?.trim()) return [];
    throw new Error(`Unsupported content in <${element.tagName}>`);
  });

function numbers(value: string): number[] {
  const result = Array.from(value.matchAll(NUMBER), (match) => Number(match[0]));
  if (
    !result.length ||
    value.replace(NUMBER, "").replace(/[\s,]/gu, "") ||
    result.some((n) => !Number.isFinite(n))
  ) {
    throw new Error(`Invalid SVG numbers: ${value}`);
  }
  return result;
}

function number(element: Element, attribute: string, fallback?: number): number {
  if (!element.hasAttribute(attribute) && fallback !== undefined) return fallback;
  const values = numbers(element.getAttribute(attribute) ?? "");
  if (values.length !== 1) throw new Error(`Expected one number for ${attribute}`);
  return values[0]!;
}

function validateAttributes(element: Element, extra: readonly string[] = []) {
  const allowed = [...PRESENTATION, ...(GEOMETRY[element.tagName] ?? []), ...extra];
  for (const { name } of Array.from(element.attributes)) {
    if (allowed.includes(name) || name === "class" || name.startsWith("aria-")) continue;
    throw new Error(`Unsupported ${name} on <${element.tagName}>`);
  }
}

function compose([sx, sy, tx, ty]: Transform, [x, y, dx, dy]: Transform): Transform {
  return [sx * x, sy * y, tx + sx * dx, ty + sy * dy];
}

function transform(value: string): Transform {
  const operations = Array.from(value.matchAll(/(translate|scale)\s*\(([^)]+)\)/gu));
  if (value.replace(/(translate|scale)\s*\(([^)]+)\)/gu, "").replace(/[\s,]/gu, "")) {
    throw new Error(`Unsupported transform: ${value}`);
  }
  return operations.reduce<Transform>((matrix, [, kind, arguments_]) => {
    const args = numbers(arguments_!);
    if (args.length > 2) throw new Error(`Unsupported transform: ${value}`);
    const first = args[0]!;
    const next: Transform =
      kind === "translate" ? [1, 1, first, args[1] ?? 0] : [first, args[1] ?? first, 0, 0];
    if (!next[0] || !next[1]) throw new Error(`Degenerate transform: ${value}`);
    return compose(matrix, next);
  }, IDENTITY);
}

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  if (rx < 0 || ry < 0) throw new Error("Negative ellipse radius");
  if (!rx || !ry) return "";
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
}

/** Normalize SVG primitives without approximating their curves. */
function geometry(element: Element): string {
  const n = (name: string, fallback?: number) => number(element, name, fallback);
  if (element.tagName === "path") return element.getAttribute("d") ?? "";
  if (element.tagName === "circle") return ellipse(n("cx", 0), n("cy", 0), n("r"), n("r"));
  if (element.tagName === "ellipse") return ellipse(n("cx", 0), n("cy", 0), n("rx"), n("ry"));
  if (element.tagName === "line") return `M${n("x1", 0)} ${n("y1", 0)}L${n("x2", 0)} ${n("y2", 0)}`;
  if (element.tagName === "polyline" || element.tagName === "polygon") {
    const points = numbers(element.getAttribute("points") ?? "");
    if (points.length < 4 || points.length % 2) throw new Error("Invalid polyline/polygon points");
    return `M${points.slice(0, 2).join(" ")}L${points.slice(2).join(" ")}${element.tagName === "polygon" ? "Z" : ""}`;
  }
  if (element.tagName !== "rect") throw new Error(`Unsupported <${element.tagName}>`);
  const [x, y, w, h] = [n("x", 0), n("y", 0), n("width"), n("height")];
  if (w < 0 || h < 0) throw new Error("Negative rectangle size");
  if (!w || !h) return "";
  const rx = Math.min(n("rx", n("ry", 0)), w / 2);
  const ry = Math.min(n("ry", n("rx", 0)), h / 2);
  if (rx < 0 || ry < 0) throw new Error("Negative rectangle radius");
  if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
}

type Paint = {
  fill: string;
  fillRule: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: string;
  strokeLinejoin: string;
};
const DEFAULT_PAINT: Paint = {
  fill: "black",
  fillRule: "nonzero",
  stroke: "none",
  strokeWidth: 1,
  strokeLinecap: "butt",
  strokeLinejoin: "miter",
};
function paint(element: Element, inherited: Paint): Paint {
  const get = (name: string, fallback: string) => element.getAttribute(name) ?? fallback;
  const result = {
    fill: get("fill", inherited.fill),
    fillRule: get("fill-rule", inherited.fillRule),
    stroke: get("stroke", inherited.stroke),
    strokeWidth: number(element, "stroke-width", inherited.strokeWidth),
    strokeLinecap: get("stroke-linecap", inherited.strokeLinecap),
    strokeLinejoin: get("stroke-linejoin", inherited.strokeLinejoin),
  };
  for (const value of [element.getAttribute("fill"), element.getAttribute("stroke")].filter(
    (value) => value !== null,
  )) {
    if (value !== "none" && value !== "currentColor")
      throw new Error(`Non-monochrome paint: ${value}`);
  }
  if (
    !["nonzero", "evenodd"].includes(result.fillRule) ||
    !["butt", "round", "square"].includes(result.strokeLinecap) ||
    !["miter", "round", "bevel"].includes(result.strokeLinejoin) ||
    result.strokeWidth < 0
  ) {
    throw new Error("Unsupported fill or stroke attributes");
  }
  return result;
}

function paths(element: Element, inherited: Paint, outer: Transform): IconPathDescriptor[] {
  validateAttributes(element);
  const current = paint(element, inherited);
  const matrix = compose(outer, transform(element.getAttribute("transform") ?? ""));
  const opacity = number(element, "opacity", 1);
  if (opacity < 0 || opacity > 1) throw new Error("Opacity outside 0–1");
  if (element.tagName === "svg")
    throw new Error("Nested SVG viewports cannot be flattened faithfully");
  if (element.tagName === "g") {
    if (opacity !== 1) throw new Error("Group opacity cannot be flattened faithfully");
    if (element.hasAttribute("style")) throw new Error("Unsupported group style");
    return children(element).flatMap((child) => paths(child, current, matrix));
  }
  if (children(element).length) throw new Error(`Unexpected children in <${element.tagName}>`);
  if (!["none", "currentColor"].includes(current.fill))
    throw new Error(`Non-monochrome paint: ${current.fill}`);
  const d = geometry(element);
  if (!d) return [];
  const parsed = svgpath(d);
  if ("err" in parsed && parsed.err) throw new Error(`Invalid path: ${String(parsed.err)}`);
  const [sx, sy, tx, ty] = matrix;
  if (current.stroke !== "none" && Math.abs(sx) !== Math.abs(sy))
    throw new Error("Non-uniformly scaled strokes cannot be flattened faithfully");
  return [
    {
      d: matrix.every((value, index) => value === IDENTITY[index])
        ? d
        : parsed.matrix([sx, 0, 0, sy, tx, ty]).toString(),
      ...(current.fill === "none" ? { fill: "none" as const } : {}),
      ...(current.fillRule === "evenodd" ? { fillRule: "evenodd" as const } : {}),
      ...(opacity !== 1 ? { opacity } : {}),
      ...(current.stroke === "none"
        ? {}
        : {
            stroke: "currentColor" as const,
            ...(current.strokeWidth * Math.abs(sx) !== 1
              ? { strokeWidth: current.strokeWidth * Math.abs(sx) }
              : {}),
            ...(current.strokeLinecap !== "butt"
              ? { strokeLinecap: current.strokeLinecap as "round" | "square" }
              : {}),
            ...(current.strokeLinejoin !== "miter"
              ? { strokeLinejoin: current.strokeLinejoin as "round" | "bevel" }
              : {}),
          }),
    },
  ];
}

/** Accept only the exact IconSilhouette wrapper; arbitrary or nested masks must be reviewed. */
export function extractIcon(
  name: string,
  markup: string,
): { glyph: IconGlyph; silhouette: boolean } {
  try {
    const document = new DOMParser({
      onError: (_level, message) => {
        throw new Error(message);
      },
    }).parseFromString(markup, "image/svg+xml");
    const svg = document.documentElement;
    if (!svg || svg.tagName !== "svg") throw new Error("Expected one SVG root");
    validateAttributes(svg);
    const viewBox = svg.getAttribute("viewBox") ?? "";
    const dimensions = numbers(viewBox);
    if (dimensions.length !== 4 || dimensions[2]! <= 0 || dimensions[3]! <= 0)
      throw new Error("Invalid viewBox");
    if (number(svg, "opacity", 1) !== 1)
      throw new Error("Root opacity cannot be flattened faithfully");
    const rootPaint = paint(svg, DEFAULT_PAINT);
    const rootTransform = transform(svg.getAttribute("transform") ?? "");
    const content = children(svg);
    const masks = content.filter((child) => child.tagName === "mask");
    if (!masks.length) {
      const result = content.flatMap((child) => paths(child, rootPaint, rootTransform));
      if (!result.length) throw new Error("No visible geometry");
      return { glyph: { viewBox, paths: result }, silhouette: false };
    }
    const [mask, rect] = content;
    if (content.length !== 2 || mask?.tagName !== "mask" || rect?.tagName !== "rect")
      throw new Error("Unsupported mask composition");
    validateAttributes(mask, ["id"]);
    validateAttributes(rect, ["mask"]);
    if (mask.attributes.length !== 1 || !mask.getAttribute("id"))
      throw new Error("Unsupported mask attributes");
    const expectedRect = {
      width: "100%",
      height: "100%",
      fill: "currentColor",
      mask: `url(#${mask.getAttribute("id")})`,
    };
    if (
      rect.attributes.length !== 4 ||
      Object.entries(expectedRect).some(([key, value]) => rect.getAttribute(key) !== value)
    )
      throw new Error("Unsupported silhouette paint rectangle");
    const [group] = children(mask);
    if (
      children(mask).length !== 1 ||
      group?.tagName !== "g" ||
      group.attributes.length !== 1 ||
      group.getAttribute("style") !== "color:white"
    )
      throw new Error("Unsupported silhouette mask contents");
    const result = children(group).flatMap((child) => paths(child, rootPaint, rootTransform));
    if (!result.length) throw new Error("Empty silhouette");
    return { glyph: { viewBox, paths: result }, silhouette: true };
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
