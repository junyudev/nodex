const INLINE_ICON_MAX_PX = 40;

function declaredPixels(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^\d+(?:px)?$/u.test(value.trim())) return null;
  return Number.parseInt(value, 10);
}

/**
 * An image its author sized as a glyph or aligned into the line, as HTML from GitHub and bots
 * writes badges and status icons, reads inside the text rather than as a picture of its own.
 */
export function isMarkdownInlineIcon(props: {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly align?: unknown;
}): boolean {
  if (typeof props.align === "string" && props.align.trim()) return true;
  const sizes = [declaredPixels(props.width), declaredPixels(props.height)].filter(
    (size): size is number => size !== null,
  );
  return sizes.length > 0 && sizes.every((size) => size <= INLINE_ICON_MAX_PX);
}
