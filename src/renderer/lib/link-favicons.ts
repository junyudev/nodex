import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import { invokeRendererQuery } from "./renderer-command";

export function linkFaviconQueryOptions(host: string) {
  return queryOptions({
    queryKey: queryKeys.linkFavicons.host(host),
    queryFn: () => invokeRendererQuery("links:favicon", host),
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: false,
  });
}

/** The tone of a see-through icon's drawing, which a background of the same tone would swallow. */
export type FaviconInk = "dark" | "light";

/** Drawn pixels must leave this much of the icon see-through before its ink alone carries it. */
const OPAQUE_SHARE = 0.85;
const DARK_INK = 0.3;
const LIGHT_INK = 0.8;

/**
 * Reads an icon's RGBA pixels. A see-through icon drawn in near-black vanishes on a dark
 * background, and one drawn in near-white on a light one; an opaque or colorful icon carries
 * itself on either.
 */
export function faviconInk(pixels: ArrayLike<number>): FaviconInk | null {
  const total = pixels.length / 4;
  let drawn = 0;
  let lightness = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    drawn += 1;
    lightness +=
      (0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!) / 255;
  }
  if (drawn === 0 || drawn / total > OPAQUE_SHARE) return null;
  const mean = lightness / drawn;
  if (mean < DARK_INK) return "dark";
  if (mean > LIGHT_INK) return "light";
  return null;
}

/** Samples a loaded icon. Data URLs never taint the canvas; anything else reads as no ink. */
export function readFaviconInk(image: HTMLImageElement): FaviconInk | null {
  try {
    const size = 16;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, size, size);
    return faviconInk(context.getImageData(0, 0, size, size).data);
  } catch {
    return null;
  }
}
