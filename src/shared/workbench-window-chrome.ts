/** Logical shell dimensions shared by native window controls and renderer layout. */
export const WORKBENCH_TITLEBAR_HEIGHT_PX = 44;
export const WORKBENCH_APPLICATION_MENU_HEIGHT_PX = 36;
export const WORKBENCH_NAVIGATION_RAIL_WIDTH_PX = 52;
export const WORKBENCH_SURFACE_GUTTER_PX = 4;
export const WORKBENCH_SIDEBAR_WIDTH_DEFAULT_PX = 288;

const MAC_WINDOW_CONTROL_SIZE_PX = 14;
const MAC_WINDOW_CONTROL_LEFT_PX = 16;
const MAC_LEGACY_WINDOW_CONTROL_INSET_PX = 82;
const MAC_MODERN_WINDOW_CONTROL_INSET_PX = 92;
const NATIVE_WINDOW_CONTROL_GAP_PX = 6;
const NON_MAC_HEADER_INSET_PX = 12;

export interface WorkbenchWindowControlPosition {
  readonly x: number;
  readonly y: number;
}

/** Horizontal space reserved by native window controls, in device-independent pixels. */
export interface WorkbenchNativeControlInsets {
  readonly left: number;
  readonly right: number;
}

/** The subset of the Window Controls Overlay API that titlebar layout consumes. */
export interface WorkbenchWindowControlsOverlay {
  readonly visible: boolean;
  getTitlebarAreaRect(): { readonly x: number; readonly width: number; readonly height?: number };
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

/** Native caption buttons fill the scaled titlebar so their hover targets match its height. */
export function resolveWorkbenchWindowControlsOverlayHeight(windowZoom = 1): number {
  return Math.round(
    WORKBENCH_APPLICATION_MENU_HEIGHT_PX * normalizeWorkbenchWindowZoom(windowZoom),
  );
}

/**
 * Measure the caption-button reservation that the Window Controls Overlay leaves on each side of
 * the titlebar area. The overlay reports CSS pixels of the zoomed page; multiplying by the page
 * zoom factor recovers device-independent pixels, matching the macOS control reservation.
 */
export function measureWorkbenchWindowControlsOverlay(
  overlay: WorkbenchWindowControlsOverlay | null | undefined,
  viewportWidth: number,
  pageZoomFactor = 1,
): WorkbenchNativeControlInsets | null {
  if (!overlay?.visible) return null;
  const area = overlay.getTitlebarAreaRect();
  if (!(area.width > 0) || !(viewportWidth > 0)) return null;
  const zoom = normalizeWorkbenchWindowZoom(pageZoomFactor);
  return {
    left: Math.max(0, area.x) * zoom,
    right: Math.max(0, viewportWidth - area.x - area.width) * zoom,
  };
}

/** Convert the native control reservation into the scaled renderer's coordinate space. */
export function resolveWorkbenchHeaderSafeInsets({
  isMacPlatform,
  userAgent,
  windowZoom = 1,
  windowControlsOverlay = null,
  fullscreen = false,
  applicationMenu = false,
}: {
  readonly fullscreen?: boolean;
  readonly applicationMenu?: boolean;
  readonly isMacPlatform: boolean;
  readonly userAgent: string;
  readonly windowZoom?: number;
  /** Caption buttons drawn over the titlebar by the operating system, when present. */
  readonly windowControlsOverlay?: WorkbenchNativeControlInsets | null;
}): { readonly left: number; readonly right: number } {
  if (fullscreen) return { left: 0, right: 0 };
  if (applicationMenu) {
    const zoom = normalizeWorkbenchWindowZoom(windowZoom);
    return {
      left: (windowControlsOverlay?.left ?? 0) / zoom + 6,
      right: (windowControlsOverlay?.right ?? 0) / zoom,
    };
  }
  if (!isMacPlatform) {
    const zoom = normalizeWorkbenchWindowZoom(windowZoom);
    const reserve = (nativeInset: number) =>
      nativeInset > 0 ? nativeInset / zoom + NATIVE_WINDOW_CONTROL_GAP_PX : NON_MAC_HEADER_INSET_PX;
    return {
      left: reserve(windowControlsOverlay?.left ?? 0),
      right: reserve(windowControlsOverlay?.right ?? 0),
    };
  }

  const version = /mac os x (\d+)[_.](\d+)/i.exec(userAgent);
  const isLegacyMac = version?.[1] === "10" && Number(version[2]) <= 15;
  const nativeInset = isLegacyMac
    ? MAC_LEGACY_WINDOW_CONTROL_INSET_PX
    : MAC_MODERN_WINDOW_CONTROL_INSET_PX;
  return {
    left: nativeInset / normalizeWorkbenchWindowZoom(windowZoom) + NATIVE_WINDOW_CONTROL_GAP_PX,
    right: 0,
  };
}

/** Full-window previews clear caption controls vertically; ordinary workspace rows do not. */
export function resolveWindowContentCaptionClearance(
  rightInset: number,
  titlebarHeight: number,
  fullscreen = false,
): { readonly actionsTop: number; readonly contentTop: number } {
  if (fullscreen || !(rightInset > 0) || !(titlebarHeight > 0))
    return { actionsTop: 12, contentTop: 48 };
  return { actionsTop: titlebarHeight + 12, contentTop: titlebarHeight + 64 };
}
