export const WORKSPACE_PDF_MIN_ZOOM = 0.3;
export const WORKSPACE_PDF_MAX_ZOOM = 8;

export const WORKSPACE_PDF_ZOOM_STEPS = [
  WORKSPACE_PDF_MIN_ZOOM,
  0.4,
  0.5,
  0.67,
  0.75,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5,
  6,
  7,
  WORKSPACE_PDF_MAX_ZOOM,
] as const;

export interface WorkspacePdfPageSize {
  width: number;
  height: number;
}

export function decodeWorkspacePdfDataUrl(dataUrl: string): Uint8Array | null {
  const base64Index = dataUrl.indexOf("base64,");
  if (!dataUrl.startsWith("data:") || base64Index < 0) return null;

  let decoded: string;
  try {
    decoded = window.atob(dataUrl.slice(base64Index + 7));
  } catch {
    return null;
  }

  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export function clampWorkspacePdfZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(WORKSPACE_PDF_MAX_ZOOM, Math.max(WORKSPACE_PDF_MIN_ZOOM, zoom));
}

export function stepWorkspacePdfZoom(zoom: number, direction: "in" | "out"): number {
  const current = clampWorkspacePdfZoom(zoom);
  if (direction === "in") {
    return WORKSPACE_PDF_ZOOM_STEPS.find((step) => step > current + 0.0001) ?? current;
  }
  return WORKSPACE_PDF_ZOOM_STEPS.findLast((step) => step < current - 0.0001) ?? current;
}

export function resolveWorkspacePdfPageSize(input: {
  baseSize: WorkspacePdfPageSize;
  availableWidth: number | null;
  fitToWidth: boolean;
  zoom: number;
}): WorkspacePdfPageSize {
  const { baseSize, availableWidth, fitToWidth } = input;
  const ratio = baseSize.width / baseSize.height;
  const fittedWidth =
    baseSize.width *
    resolveWorkspacePdfScale({
      baseWidth: baseSize.width,
      pageWidth: availableWidth,
      fitToWidth,
      zoom: input.zoom,
    });
  return {
    width: Math.round(fittedWidth),
    height: Math.round(fittedWidth / ratio),
  };
}

export function resolveWorkspacePdfZoomPercent(input: {
  baseWidth: number;
  pageWidth: number | null;
  fitToWidth: boolean;
  zoom: number;
}): number {
  return Math.round(resolveWorkspacePdfScale(input) * 100);
}

function resolveWorkspacePdfScale(
  input: Parameters<typeof resolveWorkspacePdfZoomPercent>[0],
): number {
  return input.fitToWidth && input.pageWidth !== null && input.pageWidth > 0 && input.baseWidth > 0
    ? input.pageWidth / input.baseWidth
    : clampWorkspacePdfZoom(input.zoom);
}

export function clampWorkspacePdfPage(page: number, totalPages: number): number {
  return Math.min(Math.max(page, 1), Math.max(totalPages, 1));
}

export function selectWorkspacePdfCurrentPage(input: {
  containerTop: number;
  pageTops: readonly number[];
  visibilityRatios: readonly number[];
}): number | null {
  if (input.pageTops.length === 0) return null;

  let mostVisibleIndex = 0;
  let mostVisibleRatio = -1;
  for (const [index, ratio] of input.visibilityRatios.entries()) {
    if (ratio <= mostVisibleRatio) continue;
    mostVisibleRatio = ratio;
    mostVisibleIndex = index;
  }
  if (mostVisibleRatio > 0) return mostVisibleIndex + 1;

  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const [index, top] of input.pageTops.entries()) {
    const distance = Math.abs(top - input.containerTop);
    if (distance >= closestDistance) continue;
    closestDistance = distance;
    closestIndex = index;
  }
  return closestIndex + 1;
}
