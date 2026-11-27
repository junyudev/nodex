const NS = "http://www.w3.org/2000/svg";

const elements = new Set([
  "svg",
  "g",
  "a",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feColorMatrix",
  "feBlend",
  "feComposite",
  "feFlood",
  "feMerge",
  "feMergeNode",
  "feDropShadow",
]);
const coordinates = new Set([
  "id",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "fx",
  "fy",
  "fr",
  "dx",
  "dy",
  "d",
  "points",
  "pathLength",
  "rotate",
  "startOffset",
  "textLength",
  "lengthAdjust",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "offset",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "filterUnits",
  "stdDeviation",
  "in",
  "in2",
  "result",
  "type",
  "values",
  "mode",
  "operator",
  "transform",
  "role",
  "aria-label",
]);
const presentation = [
  "color",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "paint-order",
  "vector-effect",
  "stop-color",
  "stop-opacity",
  "flood-color",
  "flood-opacity",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
];

function localStyle(value: string): string | undefined {
  if (!/url\s*\(/iu.test(value)) return value;
  return value
    .replace(/url\(["']?[^)"']*?#([\w.:-]+)["']?\)/giu, "url(#$1)")
    .replace(/url\((?!#[\w.:-]+\))[^)]*\)/giu, "none");
}

function cloneSvg(element: Element, budget: { remaining: number }): Element | undefined {
  if (element.namespaceURI !== NS || !elements.has(element.localName)) return undefined;
  if (--budget.remaining < 0) throw new Error("The Visual has too many SVG elements");
  const clone = document.createElementNS(NS, element.localName === "a" ? "g" : element.localName);
  for (const attribute of element.attributes) {
    if (coordinates.has(attribute.name)) clone.setAttribute(attribute.name, attribute.value);
    if (
      ["href", "xlink:href"].includes(attribute.name) &&
      /^#[\w.:-]+$/u.test(attribute.value) &&
      ["use", "textPath", "linearGradient", "radialGradient", "pattern"].includes(element.localName)
    )
      clone.setAttribute("href", attribute.value);
  }
  const computed = getComputedStyle(element);
  for (const property of presentation) {
    const value = localStyle(computed.getPropertyValue(property));
    if (value) clone.setAttribute(property, value);
  }
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) clone.append(child.textContent ?? "");
    if (child instanceof Element) {
      const copy = cloneSvg(child, budget);
      if (copy) clone.append(copy);
    }
  }
  return clone;
}

export function snapshotVisual(root: HTMLElement, width: number, height: number): string {
  const container = document.createElementNS(NS, "svg");
  container.setAttribute("width", String(width));
  container.setAttribute("height", String(height));
  container.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const background = document.createElementNS(NS, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", getComputedStyle(document.body).backgroundColor);
  container.append(background);
  const rootRect = root.getBoundingClientRect();
  const budget = { remaining: 20_000 };
  for (const svg of root.querySelectorAll("svg:not(svg svg)")) {
    const clone = cloneSvg(svg, budget);
    if (!clone) continue;
    const { x, y, width, height } = svg.getBoundingClientRect();
    clone.setAttribute("x", String(x - rootRect.x));
    clone.setAttribute("y", String(y - rootRect.y));
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    container.append(clone);
  }
  return new XMLSerializer().serializeToString(container);
}
