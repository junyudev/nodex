import type { Rectangle } from "electron";
import {
  AVATAR_OVERLAY_HOST_ID,
  type AvatarOverlayLayout,
  type AvatarOverlayPlacement,
} from "../../shared/avatar-overlay";
import type {
  RemoteHostedPipAnchorAlignment,
  RemoteHostedPipHostLayout,
  RemoteHostedPipViewportRect,
} from "../../shared/remote-hosted-pip";

export const AVATAR_OVERLAY_DEFAULT_MASCOT_SIZE = { height: 121, width: 112 } as const;
export const AVATAR_OVERLAY_NATIVE_VIEWPORT_WIDTH = 384;
export const AVATAR_OVERLAY_VIEWPORT_MARGIN = 24;

const NATIVE_SPRING = {
  damping: 18.85,
  initialVelocity: 0,
  mass: 1,
  stiffness: 180,
} as const;

export interface AvatarOverlayDisplayGeometry {
  readonly bounds: Rectangle;
  readonly workArea: Rectangle;
}

export function resolveAvatarOverlayAnchor(
  display: AvatarOverlayDisplayGeometry,
  mascot = AVATAR_OVERLAY_DEFAULT_MASCOT_SIZE,
): Rectangle {
  return {
    x: display.workArea.x + display.workArea.width - mascot.width - AVATAR_OVERLAY_VIEWPORT_MARGIN,
    y:
      display.workArea.y + display.workArea.height - mascot.height - AVATAR_OVERLAY_VIEWPORT_MARGIN,
    width: mascot.width,
    height: mascot.height,
  };
}

export function resolveAvatarOverlayPlacement(
  anchor: Rectangle,
  display: AvatarOverlayDisplayGeometry,
): AvatarOverlayPlacement {
  const horizontal =
    anchor.x + anchor.width / 2 < display.workArea.x + display.workArea.width / 2 ? "start" : "end";
  const vertical =
    anchor.y + anchor.height / 2 < display.workArea.y + display.workArea.height / 2
      ? "top"
      : "bottom";
  return `${vertical}-${horizontal}`;
}

/**
 * Native draw mode keeps a narrow transparent window as tall as the selected
 * display. The mascot can move freely while the rest of the surface remains
 * click-through, and the native PiP child remains attached to this one host.
 */
export function resolveAvatarOverlayWindowBounds(
  display: AvatarOverlayDisplayGeometry,
  anchor: Rectangle,
): Rectangle {
  const height = display.bounds.y + display.bounds.height - display.workArea.y;
  const preferredX = Math.round(
    anchor.x + anchor.width / 2 - AVATAR_OVERLAY_NATIVE_VIEWPORT_WIDTH / 2,
  );
  return {
    x: Math.max(
      display.bounds.x,
      Math.min(
        preferredX,
        display.bounds.x + display.bounds.width - AVATAR_OVERLAY_NATIVE_VIEWPORT_WIDTH,
      ),
    ),
    y: display.workArea.y,
    width: Math.min(AVATAR_OVERLAY_NATIVE_VIEWPORT_WIDTH, display.bounds.width),
    height: Math.max(anchor.height, height),
  };
}

export function resolveAvatarOverlayLayout(input: {
  readonly anchor: Rectangle;
  readonly placement: AvatarOverlayPlacement;
  readonly stackDisplayHeight: number;
  readonly windowBounds: Rectangle;
}): AvatarOverlayLayout {
  return {
    mascot: {
      x: Math.round(input.anchor.x - input.windowBounds.x),
      y: Math.round(input.anchor.y - input.windowBounds.y),
      width: Math.round(input.anchor.width),
      height: Math.round(input.anchor.height),
    },
    placement: input.placement,
    stackDisplayHeight: Math.max(0, Math.round(input.stackDisplayHeight)),
    viewport: {
      width: input.windowBounds.width,
      height: input.windowBounds.height,
    },
  };
}

export function resolveAvatarOverlayHostAlignment(
  placement: AvatarOverlayPlacement,
): RemoteHostedPipAnchorAlignment {
  switch (placement) {
    case "top-start":
      return "bottom-left";
    case "top-end":
      return "bottom-right";
    case "bottom-start":
      return "top-left";
    case "bottom-end":
      return "top-right";
  }
}

export function buildAvatarOverlayHostLayout(
  layout: AvatarOverlayLayout,
  animated: boolean,
): RemoteHostedPipHostLayout {
  const alignment = resolveAvatarOverlayHostAlignment(layout.placement);
  const mascot: RemoteHostedPipViewportRect = layout.mascot;
  return {
    anchorRect: mascot,
    anchors: [
      {
        alignment,
        point: {
          x: mascot.x + mascot.width / 2,
          y: mascot.y + mascot.height / 2,
        },
      },
    ],
    animated,
    animationSpring: NATIVE_SPRING,
    hostId: AVATAR_OVERLAY_HOST_ID,
    interactionPassthroughRect: mascot,
    isCodexHomeAvailable: false,
    presentationScope: "all",
  };
}

export function shouldAnimateAvatarLayout(
  hasPublishedHost: boolean,
  prefersReducedMotion: boolean,
): boolean {
  return hasPublishedHost && !prefersReducedMotion;
}

export function clampAvatarOverlayAnchor(
  anchor: Rectangle,
  display: AvatarOverlayDisplayGeometry,
): Rectangle {
  return {
    ...anchor,
    x: Math.max(
      display.workArea.x,
      Math.min(anchor.x, display.workArea.x + display.workArea.width - anchor.width),
    ),
    y: Math.max(
      display.workArea.y,
      Math.min(anchor.y, display.workArea.y + display.workArea.height - anchor.height),
    ),
  };
}
