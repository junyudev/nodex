import type { MermaidConfig } from "mermaid";
import type { DiagramPlugin } from "streamdown";
import DOMPurify from "dompurify";
import { trimDiagramSVG } from "@blocknote/diagram-block/trim-diagram-svg";

export type MermaidRenderTheme = "light" | "dark";

export interface MermaidRenderResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export interface MermaidDownloadResult {
  readonly blob: Blob;
  readonly format: "jpeg" | "svg";
}

const MAX_TEXT_SIZE = 500_000;
const MAX_EDGES = 1_500;
const SECURE_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "deterministicIds",
  "logLevel",
  "themeCSS",
] as const;

export const MERMAID_RUNTIME_CONFIG = {
  startOnLoad: false,
  layout: "dagre",
  look: "classic",
  theme: "default",
  suppressErrorRendering: true,
  securityLevel: "strict",
  secure: [...SECURE_CONFIG_KEYS],
  maxTextSize: MAX_TEXT_SIZE,
  maxEdges: MAX_EDGES,
  htmlLabels: false,
  deterministicIds: false,
  logLevel: "fatal",
} satisfies MermaidConfig;

type MermaidModule = typeof import("mermaid");

let initializedMermaidPromise: Promise<MermaidModule["default"]> | null = null;
let renderSequence = 0;

function getInitializedMermaid(): Promise<MermaidModule["default"]> {
  initializedMermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_RUNTIME_CONFIG);
    return mermaid;
  });
  return initializedMermaidPromise;
}

function withRenderTheme(source: string, theme: MermaidRenderTheme): string {
  const mermaidTheme = theme === "dark" ? "dark" : "neutral";
  return `%%{init: {"theme":"${mermaidTheme}"}}%%\n${source}`;
}

function removeMermaidTemporaryNodes(renderId: string): void {
  document.getElementById(renderId)?.remove();
  document.getElementById(`d${renderId}`)?.remove();
}

function sanitizeCss(css: string): string {
  return css
    .replace(/@import\s+[^;]+;?/giu, "")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (_match, _quote, value: string) =>
      value.trim().startsWith("#") ? `url(${value.trim()})` : "none",
    )
    .replace(/javascript\s*:/giu, "");
}

function isSafeLocalReference(value: string): boolean {
  return value.trim().startsWith("#");
}

function readSvgElementDimensions(root: Element): { width: number; height: number } | null {
  const viewBox = root.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length !== 4 || !viewBox.every(Number.isFinite)) return null;
  return { width: Math.max(1, viewBox[2]), height: Math.max(1, viewBox[3]) };
}

function cssPixelValue(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}

/**
 * Mermaid already sanitizes in strict mode. This second, app-owned boundary keeps
 * previews and exported SVGs safe even if a future diagram renderer regresses.
 */
export function sanitizeMermaidSvg(svg: string): string {
  const purified = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "audio", "video"],
  });
  const parsed = new DOMParser().parseFromString(purified, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    throw new MermaidRenderError("Mermaid returned an invalid SVG document");
  }

  root
    .querySelectorAll("script, foreignObject, iframe, object, embed, audio, video")
    .forEach((element) => element.remove());

  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && !isSafeLocalReference(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") element.setAttribute(attribute.name, sanitizeCss(value));
    }
    if (element.localName === "style") element.textContent = sanitizeCss(element.textContent ?? "");
  }

  root.removeAttribute("height");
  root.setAttribute("width", "100%");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "Mermaid diagram");
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const dimensions = readSvgElementDimensions(root);
  root.setAttribute(
    "style",
    dimensions
      ? `max-width:${cssPixelValue(dimensions.width)}px;height:auto;`
      : "max-width:100%;height:auto;",
  );
  return new XMLSerializer().serializeToString(root);
}

function normalizeSvg(svg: string): string {
  const sanitized = sanitizeMermaidSvg(svg);
  try {
    return sanitizeMermaidSvg(trimDiagramSVG(sanitized));
  } catch {
    return sanitized;
  }
}

function readSvgDimensions(svg: string): { width: number; height: number } {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  return readSvgElementDimensions(parsed.documentElement) ?? { width: 800, height: 600 };
}

function describeMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error:\s*/iu, "")
    .replace(/^Parse error[^\n]*\n?/iu, "Syntax error: ")
    .trim();
}

export class MermaidRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MermaidRenderError";
  }
}

export async function renderMermaidDiagram(input: {
  readonly source: string;
  readonly theme: MermaidRenderTheme;
  readonly requestId?: string;
}): Promise<MermaidRenderResult> {
  const source = input.source.trim();
  if (!source) throw new MermaidRenderError("Add Mermaid code to create a diagram");
  if (source.length > MAX_TEXT_SIZE) {
    throw new MermaidRenderError(
      `Diagram source exceeds ${MAX_TEXT_SIZE.toLocaleString()} characters`,
    );
  }

  const renderId = `nodex-mermaid-${input.requestId ?? "preview"}-${++renderSequence}`.replace(
    /[^a-zA-Z0-9_-]/gu,
    "-",
  );
  try {
    const mermaid = await getInitializedMermaid();
    const themedSource = withRenderTheme(source, input.theme);
    await mermaid.parse(themedSource);
    const result = await mermaid.render(renderId, themedSource);
    const normalizedSvg = normalizeSvg(result.svg);
    return { svg: normalizedSvg, ...readSvgDimensions(normalizedSvg) };
  } catch (error) {
    if (error instanceof MermaidRenderError) throw error;
    throw new MermaidRenderError(describeMermaidError(error), { cause: error });
  } finally {
    removeMermaidTemporaryNodes(renderId);
  }
}

function svgToObjectUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new MermaidRenderError("Could not rasterize the diagram")),
      { once: true },
    );
    image.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new MermaidRenderError("Could not encode JPEG"))),
      "image/jpeg",
      0.92,
    );
  });
}

export async function renderMermaidDownload(input: {
  readonly svg: string;
  readonly theme: MermaidRenderTheme;
}): Promise<MermaidDownloadResult> {
  const svg = sanitizeMermaidSvg(input.svg);
  const fallback = () => ({
    blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    format: "svg" as const,
  });
  if (typeof Image === "undefined") return fallback();

  const objectUrl = svgToObjectUrl(svg);
  try {
    const image = await loadImage(objectUrl);
    const dimensions = readSvgDimensions(svg);
    const padding = 40;
    const scale = Math.min(
      2,
      4_096 / Math.max(dimensions.width + padding * 2, dimensions.height + padding * 2),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil((dimensions.width + padding * 2) * scale));
    canvas.height = Math.max(1, Math.ceil((dimensions.height + padding * 2) * scale));
    const context = canvas.getContext("2d");
    if (!context) return fallback();
    context.fillStyle = input.theme === "dark" ? "#191919" : "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      padding * scale,
      padding * scale,
      dimensions.width * scale,
      dimensions.height * scale,
    );
    return { blob: await canvasToJpeg(canvas), format: "jpeg" };
  } catch {
    return fallback();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export const streamdownMermaidPlugin: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(config) {
    const theme: MermaidRenderTheme = config?.theme === "dark" ? "dark" : "light";
    return {
      initialize: () => undefined,
      render: async (id, source) => renderMermaidDiagram({ source, theme, requestId: id }),
    };
  },
};
