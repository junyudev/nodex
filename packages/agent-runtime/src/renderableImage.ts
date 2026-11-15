/** The raster image types every Nodex surface draws as a picture; never SVG, which can carry script. */
export type RenderableImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** How many leading bytes `renderableImageType` reads. */
export const RENDERABLE_IMAGE_SIGNATURE_BYTES = 12;

/**
 * The renderable image type the bytes themselves begin with, whatever a name or a stored record
 * claims; null for anything else, including a picture format no surface draws.
 */
export function renderableImageType(head: Uint8Array): RenderableImageType | null {
  const at = (offset: number, ...bytes: readonly number[]) =>
    bytes.every((byte, index) => head[offset + index] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61)
    return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}
