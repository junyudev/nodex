import { createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { VisualRenderReply, VisualRenderRequest } from "../shared/visual/bridge";
import { visualRowKey, type VisualRow } from "../shared/visual/contract";

const container = document.getElementById("visual")!;
let current: Root | undefined;
let currentRevision = 0;

function figureInputs(request: VisualRenderRequest) {
  return request.sources.map((sources, figure) => {
    const identity = new WeakMap<
      VisualRow,
      { source: string; key: NonNullable<ReturnType<typeof visualRowKey>> | null }
    >();
    for (const [source, rows] of Object.entries(sources)) {
      for (const row of rows) {
        const key = visualRowKey(row, request.keys[figure][source]);
        if (key !== undefined) identity.set(row, { source, key });
      }
    }
    const datum = (row: VisualRow, field?: string): Record<string, string> => {
      const binding = identity.get(row);
      if (!binding) return {};
      const token = JSON.stringify([figure, binding.source, binding.key, field]);
      return { "data-nodex-datum": token };
    };
    const variables = Object.keys(request.theme.variables);
    const theme = Object.fromEntries(variables.map((name) => [name.slice(2), `var(${name})`]));
    return { ...sources, datum, theme, params: request.params[figure] };
  });
}

function locationOf(error: Error, path: string) {
  for (const line of error.stack?.split("\n") ?? []) {
    const match = line.match(/:\d+:\d+\)?$/u);
    if (!match || !line.includes(path)) continue;
    const [, row, column] = match[0].replace(/\)$/u, "").split(":");
    return { line: Number(row), column: Number(column) };
  }
  return undefined;
}

function validOutput(element: Element): boolean {
  if (element instanceof SVGSVGElement) return true;
  return (
    element.localName === "div" &&
    element.childElementCount > 0 &&
    [...element.childNodes].every((child) =>
      child instanceof Element ? validOutput(child) : !child.textContent?.trim(),
    )
  );
}

async function renderVisual(
  request: VisualRenderRequest,
): Promise<null | Extract<VisualRenderReply, { status: "error" }>> {
  currentRevision = request.revision;
  const failure = (cause: unknown): Extract<VisualRenderReply, { status: "error" }> => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return {
      status: "error",
      revision: request.revision,
      message: error.message.slice(0, 500),
      location: locationOf(error, request.modulePath),
    };
  };
  try {
    const module: { default: (nodex: { Visualize: ComponentType<FigureProps> }) => ReactNode } =
      await import(request.modulePath);
    if (currentRevision !== request.revision) return failure("Visual render was superseded");
    document.documentElement.removeAttribute("style");
    document.documentElement.style.colorScheme = request.theme.appearance;
    for (const [name, value] of Object.entries(request.theme.variables))
      if (/^--[\w-]+$/u.test(name)) document.documentElement.style.setProperty(name, value);
    const inputs = figureInputs(request);
    type FigureProps = { figure: number; children: ComponentType<(typeof inputs)[number]> };
    function Visualize({ figure, children }: FigureProps) {
      return createElement(children, inputs[figure]);
    }
    let renderError: unknown;
    current?.unmount();
    current = createRoot(container, {
      onUncaughtError: (error) => {
        renderError = error;
      },
    });
    flushSync(() => current!.render(module.default({ Visualize })));
    if (renderError) return failure(renderError);
    if (!validOutput(container))
      return failure("The render function must return SVG or a div of SVGs");
    // A viewBox supplies an aspect ratio. An outer SVG can still collapse in the
    // shrink-wrapped guest, so give it a width that the guest can scale down.
    for (const svg of container.querySelectorAll<SVGSVGElement>(
      "svg[viewBox]:not([width]):not([height])",
    )) {
      if (svg.ownerSVGElement || svg.getBoundingClientRect().width > 0) continue;
      const { width, height } = svg.viewBox.baseVal;
      if (width > 0 && height > 0) svg.setAttribute("width", String(width));
    }
    // A fixed-size SVG without a viewBox would be cropped in a narrow Page column; the viewBox
    // lets it scale down with its aspect ratio instead.
    for (const svg of container.querySelectorAll<SVGSVGElement>(
      "svg[width][height]:not([viewBox])",
    )) {
      if (svg.ownerSVGElement) continue;
      const width = Number(svg.getAttribute("width"));
      const height = Number(svg.getAttribute("height"));
      if (width > 0 && height > 0) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    await document.fonts.ready;
    if (currentRevision !== request.revision) return failure("Visual render was superseded");
    return null;
  } catch (error) {
    return failure(error);
  }
}

Object.defineProperty(globalThis, "renderNodexVisual", { value: renderVisual });
