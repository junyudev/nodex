export type InlineVisualizationMode = "narrow" | "wide";

/** Paint overflow stays outside the content's measured size and transcript placement. */
export const INLINE_VISUALIZATION_PAINT_GUTTER = 10;

export function inlineVisualizationContentWidth(nativeWidth: number): number {
  return Math.max(0, nativeWidth - INLINE_VISUALIZATION_PAINT_GUTTER);
}

export function inlineVisualizationContentBounds(viewport: {
  readonly width: number;
  readonly height: number;
}): { x: number; y: number; width: number; height: number } | null {
  if (![viewport.width, viewport.height].every(Number.isFinite)) return null;
  if (viewport.width <= INLINE_VISUALIZATION_PAINT_GUTTER) return null;
  if (viewport.height <= INLINE_VISUALIZATION_PAINT_GUTTER) return null;
  return {
    x: INLINE_VISUALIZATION_PAINT_GUTTER / 2,
    y: INLINE_VISUALIZATION_PAINT_GUTTER / 2,
    width: inlineVisualizationContentWidth(viewport.width),
    height: viewport.height - INLINE_VISUALIZATION_PAINT_GUTTER,
  };
}

export function resolveInlineVisualizationMode(value: unknown): InlineVisualizationMode {
  return value === "wide" ? "wide" : "narrow";
}

/** A completed wide inline document can open a preview without replacing its guest. */
export function canExpandInlineVisualization(input: {
  readonly mode: InlineVisualizationMode;
  readonly isStreaming: boolean;
}): boolean {
  return input.mode === "wide" && !input.isStreaming;
}
