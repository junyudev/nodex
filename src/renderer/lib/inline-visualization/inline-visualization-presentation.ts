export type InlineVisualizationMode = "narrow" | "wide";

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
