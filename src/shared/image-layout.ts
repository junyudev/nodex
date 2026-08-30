export interface ImageSourceDimensions {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export function normalizeImageSourceDimensions(
  width: unknown,
  height: unknown,
): ImageSourceDimensions | null {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;

  return {
    sourceWidth: Math.max(1, Math.round(width)),
    sourceHeight: Math.max(1, Math.round(height)),
  };
}
