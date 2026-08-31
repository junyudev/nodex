export const MARKER_NAVIGATION_VIRTUALIZE_AFTER = 128;
export const MARKER_NAVIGATION_ROW_HEIGHT_PX = 10;
export const MARKER_NAVIGATION_OVERSCAN_ROWS = 12;
export const MARKER_NAVIGATION_MAX_VIRTUAL_VIEWPORT_PX = 640;

export interface MarkerNavigationVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly paddingBeforePx: number;
  readonly paddingAfterPx: number;
}

export function projectMarkerNavigationVirtualWindow(input: {
  readonly itemCount: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight?: number;
  readonly overscanRows?: number;
}): MarkerNavigationVirtualWindow {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const rowHeight = Math.max(1, input.rowHeight ?? MARKER_NAVIGATION_ROW_HEIGHT_PX);
  const overscanRows = Math.max(
    0,
    Math.floor(input.overscanRows ?? MARKER_NAVIGATION_OVERSCAN_ROWS),
  );
  const firstVisible = Math.max(0, Math.floor(Math.max(0, input.scrollTop) / rowHeight));
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, input.viewportHeight) / rowHeight));
  const startIndex = Math.max(0, firstVisible - overscanRows);
  const endIndex = Math.min(itemCount, firstVisible + visibleCount + overscanRows);
  return {
    startIndex,
    endIndex,
    paddingBeforePx: startIndex * rowHeight,
    paddingAfterPx: Math.max(0, itemCount - endIndex) * rowHeight,
  };
}
