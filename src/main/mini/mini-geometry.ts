import type { Rectangle } from "electron";
import { DEFAULT_MINI_ANCHOR, type MiniAnchor } from "../../shared/mini";

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
