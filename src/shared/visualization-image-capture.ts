/** CSS coordinates supplied by the owning visualization surface. */
export interface VisualizationImageCaptureInput {
  readonly sandboxId: string;
  readonly initId: string;
  readonly captureRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly viewportSize: { readonly width: number; readonly height: number };
}

export function resolveVisualizationImageCrop(
  image: { readonly width: number; readonly height: number },
  rect: VisualizationImageCaptureInput["captureRect"],
  viewport: VisualizationImageCaptureInput["viewportSize"],
): { x: number; y: number; width: number; height: number } | null {
  if (
    ![image.width, image.height, viewport.width, viewport.height, rect.width, rect.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  if (![rect.x, rect.y].every((value) => Number.isFinite(value) && value >= 0)) return null;
  if (rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) return null;
  const padding = Math.min(rect.x, rect.y);
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;
  const x = Math.max(0, Math.floor((rect.x - padding) * scaleX));
  const y = Math.max(0, Math.floor((rect.y - padding) * scaleY));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width + padding) * scaleX));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height + padding) * scaleY));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
