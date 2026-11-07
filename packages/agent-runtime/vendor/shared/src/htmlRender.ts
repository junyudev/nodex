/**
 * An Agent-authored HTML page published into a thread with the `html_render` tool. The page itself
 * is a thread attachment; the tool result carries this reference to it.
 */

export const HTML_RENDER_TOOL_NAME = "html_render";
const HTML_RENDER_MIN_HEIGHT = 80;
const HTML_RENDER_MAX_HEIGHT = 2000;
const HTML_RENDER_MAX_TITLE_LENGTH = 200;

/** What the `html_render` tool result carries so clients can show the page. */
export interface HtmlRenderReference {
  readonly attachmentId: string;
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs the server measured at publish, ascending by
   * width. Absent when the preview browser was not installed yet.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
}

const clampHtmlRenderHeight = (height: number): number =>
  Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));

const MAX_MEASURED_HEIGHTS = 24;

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights } = value as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
  };
}
