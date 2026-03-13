export interface DragOverlayGeometry {
  width: number;
  height: number;
}

export function resolveDragOverlayGeometry(input: {
  width?: number;
  height?: number;
} | null | undefined): DragOverlayGeometry | null {
  if (!input) return null;

  const width = typeof input.width === "number" ? input.width : 0;
  const height = typeof input.height === "number" ? input.height : 0;
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}
