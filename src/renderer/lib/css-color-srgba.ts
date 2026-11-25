/** sRGB channels and alpha, each from 0 to 1. */
export type SrgbaColor = readonly [red: number, green: number, blue: number, alpha: number];

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Resolves a CSS color to sRGB channels and alpha. Computed styles report colors in the space
 * they were written in, such as `oklab()`, `oklch()` or `color()`, so their numbers are not RGB
 * channels; the browser's own canvas conversion reads every syntax it can paint.
 */
export function resolveCssColorSrgba(color: string): SrgbaColor | null {
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  // An unparsable color leaves fillStyle unchanged, so it must not inherit the previous one.
  probe.fillStyle = "transparent";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 0] = probe.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return null;
  return [red / 255, green / 255, blue / 255, alpha / 255];
}
