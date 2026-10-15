/** Logical shell dimensions shared by native window controls and renderer layout. */
export const WORKBENCH_TITLEBAR_HEIGHT_PX = 44;
export const WORKBENCH_NAVIGATION_RAIL_WIDTH_PX = 52;
export const WORKBENCH_SURFACE_GUTTER_PX = 4;
export const WORKBENCH_SIDEBAR_WIDTH_DEFAULT_PX = 288;

const MAC_WINDOW_CONTROL_SIZE_PX = 14;
const MAC_WINDOW_CONTROL_LEFT_PX = 16;
const MAC_LEGACY_WINDOW_CONTROL_INSET_PX = 82;
const MAC_MODERN_WINDOW_CONTROL_INSET_PX = 92;
const MAC_WINDOW_CONTROL_GAP_PX = 6;
const NON_MAC_HEADER_INSET_PX = 12;

export interface WorkbenchWindowControlPosition {
  readonly x: number;
  readonly y: number;
}

export function normalizeWorkbenchWindowZoom(windowZoom: number): number {
  return Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
}

/** Native window buttons keep their physical size while the app titlebar scales. */
export function resolveWorkbenchMacWindowControlPosition(
  windowZoom = 1,
): WorkbenchWindowControlPosition {
  const zoom = normalizeWorkbenchWindowZoom(windowZoom);
  return {
    x: MAC_WINDOW_CONTROL_LEFT_PX,
    y: Math.round((WORKBENCH_TITLEBAR_HEIGHT_PX * zoom - MAC_WINDOW_CONTROL_SIZE_PX) / 2),
  };
}

/** Convert the native control reservation into the scaled renderer's coordinate space. */
export function resolveWorkbenchHeaderSafeInsets({
  isMacPlatform,
  userAgent,
  windowZoom = 1,
}: {
  readonly isMacPlatform: boolean;
  readonly userAgent: string;
  readonly windowZoom?: number;
}): { readonly left: number; readonly right: number } {
  if (!isMacPlatform) {
    return { left: NON_MAC_HEADER_INSET_PX, right: NON_MAC_HEADER_INSET_PX };
  }

  const version = /mac os x (\d+)[_.](\d+)/i.exec(userAgent);
  const isLegacyMac = version?.[1] === "10" && Number(version[2]) <= 15;
  const nativeInset = isLegacyMac
    ? MAC_LEGACY_WINDOW_CONTROL_INSET_PX
    : MAC_MODERN_WINDOW_CONTROL_INSET_PX;
  return {
    left: nativeInset / normalizeWorkbenchWindowZoom(windowZoom) + MAC_WINDOW_CONTROL_GAP_PX,
    right: 0,
  };
}
