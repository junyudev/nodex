import type {
  AvatarOverlayElementSize,
  AvatarOverlayLayout,
  AvatarOverlayNativeLayoutState,
} from "../../../shared/avatar-overlay";
import { AVATAR_OVERLAY_HOST_ID } from "../../../shared/avatar-overlay";
import type { RemoteHostedPipViewportRect } from "../../../shared/remote-hosted-pip";

const TRAY_WIDTH = 184;
const TRAY_HEIGHT = 58;
const TRAY_GAP = 12;
const VIEWPORT_MARGIN = 8;

export const DEFAULT_AVATAR_OVERLAY_LAYOUT: AvatarOverlayLayout = {
  mascot: { height: 121, width: 112, x: 248, y: 175 },
  placement: "top-end",
  stackDisplayHeight: 0,
  viewport: { height: 320, width: 384 },
};

export function resolveAvatarOverlayStackReserve(
  layout: AvatarOverlayLayout,
  nativeState: AvatarOverlayNativeLayoutState,
): number {
  if (nativeState.currentHostID !== AVATAR_OVERLAY_HOST_ID) return 0;
  return Math.max(0, layout.stackDisplayHeight, nativeState.stackDisplayHeight);
}

export function resolveAvatarOverlayTrayPosition(
  layout: AvatarOverlayLayout,
  nativeState: AvatarOverlayNativeLayoutState,
): { readonly left: number; readonly top: number } {
  const { mascot, placement, viewport } = layout;
  const reserve = resolveAvatarOverlayStackReserve(layout, nativeState);
  const preferredLeft = placement.endsWith("end") ? mascot.x + mascot.width - TRAY_WIDTH : mascot.x;
  const preferredTop = placement.startsWith("top")
    ? mascot.y - reserve - TRAY_HEIGHT - TRAY_GAP
    : mascot.y + mascot.height + reserve + TRAY_GAP;
  return {
    left: Math.round(
      Math.max(
        VIEWPORT_MARGIN,
        Math.min(preferredLeft, viewport.width - TRAY_WIDTH - VIEWPORT_MARGIN),
      ),
    ),
    top: Math.round(
      Math.max(
        VIEWPORT_MARGIN,
        Math.min(preferredTop, viewport.height - TRAY_HEIGHT - VIEWPORT_MARGIN),
      ),
    ),
  };
}

export function measureAvatarOverlayElement(
  element: Element | null,
): AvatarOverlayElementSize | null {
  if (!(element instanceof HTMLElement)) return null;
  const style = getComputedStyle(element);
  if (style.display === "none") return null;
  const rect = element.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { height: Math.ceil(rect.height), width: Math.ceil(rect.width) };
}

function hasVisiblePointerSurface(element: HTMLElement): boolean {
  if (element.closest("[inert]")) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.pointerEvents === "none"
  ) {
    return false;
  }
  let opacity = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity || 1);
  }
  return opacity > 0.01;
}

function clipRectToViewport(rect: DOMRect): RemoteHostedPipViewportRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return null;
  const x = Math.floor(left);
  const y = Math.floor(top);
  return {
    x,
    y,
    width: Math.ceil(right) - x,
    height: Math.ceil(bottom) - y,
  };
}

export function collectAvatarOverlayPointerRegions(
  root: HTMLElement | null,
): readonly RemoteHostedPipViewportRect[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-avatar-overlay-hit-region]"))
    .filter(hasVisiblePointerSurface)
    .flatMap((element) => {
      const rect = clipRectToViewport(element.getBoundingClientRect());
      return rect ? [rect] : [];
    })
    .slice(0, 64);
}

export function pointIntersectsAvatarOverlayRegions(
  point: { readonly x: number; readonly y: number },
  regions: readonly RemoteHostedPipViewportRect[],
): boolean {
  return regions.some(
    (region) =>
      point.x >= region.x &&
      point.x <= region.x + region.width &&
      point.y >= region.y &&
      point.y <= region.y + region.height,
  );
}
