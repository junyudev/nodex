import type { Rectangle } from "electron";
import {
  DEFAULT_MINI_ANCHOR,
  MINI_DOCK_HEIGHT,
  type MiniAnchor,
  type MiniContentLayout,
  type MiniPoint,
} from "../../shared/mini";
import {
  REMOTE_HOSTED_PIP_MINI_HOST_ID,
  type RemoteHostedPipAnchor,
  type RemoteHostedPipAnchorAlignment,
  type RemoteHostedPipHostLayout,
} from "../../shared/remote-hosted-pip";

export const MINI_WINDOW_WIDTH = 600;
const dockMargin = 12;

function dockLimits(workArea: Rectangle, dockWidth: number) {
  const insetX = Math.min(dockMargin + dockWidth / 2, workArea.width / 2);
  const insetY = Math.min(dockMargin + MINI_DOCK_HEIGHT / 2, workArea.height / 2);
  return {
    left: workArea.x + insetX,
    right: workArea.x + workArea.width - insetX,
    top: workArea.y + insetY,
    bottom: workArea.y + workArea.height - insetY,
  };
}

export function clampMiniDock(workArea: Rectangle, dock: MiniPoint, dockWidth: number): MiniPoint {
  const { left, right, top, bottom } = dockLimits(workArea, dockWidth);
  return {
    x: Math.min(right, Math.max(left, dock.x)),
    y: Math.min(bottom, Math.max(top, dock.y)),
  };
}

/** The dock's work-area half controls stack growth, and its third controls preview docking. */
export function miniAnchorForDock(workArea: Rectangle, dock: MiniPoint): MiniAnchor {
  const fractionX = (dock.x - workArea.x) / workArea.width;
  return {
    horizontal: fractionX < 1 / 3 ? "left" : fractionX < 2 / 3 ? "center" : "right",
    vertical: dock.y < workArea.y + workArea.height / 2 ? "top" : "bottom",
  };
}

export function miniDockAtAnchor(
  workArea: Rectangle,
  dockWidth: number,
  anchor = DEFAULT_MINI_ANCHOR,
): MiniPoint {
  const edges = dockLimits(workArea, dockWidth);
  return {
    x: anchor.horizontal === "center" ? workArea.x + workArea.width / 2 : edges[anchor.horizontal],
    y: edges[anchor.vertical],
  };
}

/** Option-drop uses the six regions of the work area to select a corner or edge. */
export function snapMiniDock(workArea: Rectangle, dock: MiniPoint, dockWidth: number): MiniPoint {
  return miniDockAtAnchor(workArea, dockWidth, miniAnchorForDock(workArea, dock));
}

export function miniWindowBounds(
  display: { readonly bounds: Rectangle; readonly workArea: Rectangle },
  dock: MiniPoint,
): Rectangle {
  const { bounds, workArea } = display;
  const width = Math.min(MINI_WINDOW_WIDTH, bounds.width);
  return {
    x: Math.min(
      bounds.x + bounds.width - width,
      Math.max(bounds.x, Math.round(dock.x - width / 2)),
    ),
    y: workArea.y,
    width,
    height: workArea.height,
  };
}

/** Use the origin of the viewport or work area to translate a screen point into its coordinates. */
export function miniRelativeDock(dock: MiniPoint, origin: MiniPoint): MiniPoint {
  return { x: dock.x - origin.x, y: dock.y - origin.y };
}

const previewGap = 8;
const previewSpring = { damping: 18.85, initialVelocity: 0, mass: 1, stiffness: 180 };

/** Place the native stack beside the drawn content, level with the dock or composer. */
export function miniPreviewHostLayout(
  { content, base }: MiniContentLayout,
  anchor: MiniAnchor,
  previousAlignment: RemoteHostedPipAnchorAlignment | undefined,
  reducedMotion: boolean,
): RemoteHostedPipHostLayout & { anchors: [RemoteHostedPipAnchor] } {
  const stackOnLeft = anchor.horizontal === "right";
  const alignment = `${anchor.vertical}-${stackOnLeft ? "right" : "left"}` as const;
  return {
    anchorRect: content,
    anchors: [
      {
        alignment,
        point: {
          x: stackOnLeft ? content.x - previewGap : content.x + content.width + previewGap,
          y: anchor.vertical === "bottom" ? base.y + base.height : base.y,
        },
      },
    ],
    animated: previousAlignment !== undefined && previousAlignment !== alignment && !reducedMotion,
    animationSpring: previewSpring,
    hostId: REMOTE_HOSTED_PIP_MINI_HOST_ID,
    interactionPassthroughRect: content,
    isCodexHomeAvailable: false,
    presentationScope: "all",
  };
}
