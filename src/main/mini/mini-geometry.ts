import type { Rectangle } from "electron";
import { DEFAULT_MINI_ANCHOR, type MiniAnchor, type MiniContentLayout } from "../../shared/mini";
import {
  REMOTE_HOSTED_PIP_MINI_HOST_ID,
  type RemoteHostedPipAnchor,
  type RemoteHostedPipAnchorAlignment,
  type RemoteHostedPipHostLayout,
} from "../../shared/remote-hosted-pip";

export const MINI_WINDOW_SIZE = { width: 600, height: 720 } as const;
const margin = 12;

export function miniBounds(workArea: Rectangle, anchor: MiniAnchor): Rectangle {
  const insetX = Math.min(margin, Math.floor((workArea.width - 1) / 2));
  const insetY = Math.min(margin, Math.floor((workArea.height - 1) / 2));
  const width = Math.min(MINI_WINDOW_SIZE.width, workArea.width - 2 * insetX);
  const height = Math.min(MINI_WINDOW_SIZE.height, workArea.height - 2 * insetY);
  const x = {
    left: workArea.x + insetX,
    center: workArea.x + Math.round((workArea.width - width) / 2),
    right: workArea.x + workArea.width - insetX - width,
  }[anchor.horizontal];
  const y =
    anchor.vertical === "top"
      ? workArea.y + insetY
      : workArea.y + workArea.height - insetY - height;
  return { x, y, width, height };
}

const anchors = (["bottom", "top"] as const).flatMap((vertical) =>
  (["center", "left", "right"] as const).map((horizontal) => ({ vertical, horizontal })),
);

/** Pick the placement nearest to the dropped window's center, keeping the current edge on ties. */
export function nearestMiniAnchor(
  workArea: Rectangle,
  dropped: Rectangle,
  current = DEFAULT_MINI_ANCHOR,
): MiniAnchor {
  const distance = (anchor: MiniAnchor): number => {
    const bounds = miniBounds(workArea, anchor);
    const dx = bounds.x + bounds.width / 2 - (dropped.x + dropped.width / 2);
    const dy = bounds.y + bounds.height / 2 - (dropped.y + dropped.height / 2);
    return dx * dx + dy * dy;
  };
  let nearest = current;
  let best = distance(current);
  for (const candidate of anchors) {
    const delta = distance(candidate);
    if (delta >= best) continue;
    nearest = candidate;
    best = delta;
  }
  return nearest;
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
