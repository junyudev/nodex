export interface InspectorBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface InspectorSize {
  readonly width: number;
  readonly height: number;
}
export interface InspectorPosition {
  readonly left: number;
  readonly bottom: number;
}
export interface InspectorViewport {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}
export type InspectorResizeEdge = "left" | "right" | "top" | "top-left" | "top-right";
const GAP = 8;
const candidates = [
  "right-middle",
  "bottom-right",
  "bottom-left",
  "bottom-center",
  "left-middle",
  "top-right",
  "top-left",
  "top-center",
  "center",
] as const;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
export const inspectorTopInset = ({ scale }: InspectorViewport) => 46 * scale + 16;

export function inspectorBoundsOverlap(
  left: InspectorBounds,
  right: InspectorBounds,
  gap = GAP,
): boolean {
  return (
    left.left < right.left + right.width + gap &&
    left.left + left.width + gap > right.left &&
    left.top < right.top + right.height + gap &&
    left.top + left.height + gap > right.top
  );
}

export function clampInspectorPosition(
  position: InspectorPosition,
  size: InspectorSize,
  viewport: InspectorViewport,
): InspectorPosition {
  return {
    left: clamp(position.left, GAP, Math.max(GAP, viewport.width - size.width - GAP)),
    bottom: clamp(
      position.bottom,
      Math.min(viewport.height - GAP, size.height + inspectorTopInset(viewport)),
      viewport.height - GAP,
    ),
  };
}

function candidatePoint(
  candidate: (typeof candidates)[number],
  size: InspectorSize,
  viewport: InspectorViewport,
) {
  const top = inspectorTopInset(viewport);
  const centerX = Math.round((viewport.width - size.width) / 2);
  const centerY = Math.round((top + viewport.height - 16 - size.height) / 2);
  return {
    left: candidate.includes("left")
      ? 16
      : candidate.includes("right")
        ? viewport.width - size.width - 16
        : centerX,
    top: candidate.startsWith("top")
      ? top
      : candidate.startsWith("bottom")
        ? viewport.height - size.height - 16
        : centerY,
  };
}
const distance = (left: { left: number; top: number }, right: { left: number; top: number }) =>
  (left.left - right.left) ** 2 + (left.top - right.top) ** 2;

/** Snap to a clear window location, retaining the nearest valid alternative after a gesture. */
export function placeInspector(
  bounds: InspectorBounds,
  viewport: InspectorViewport,
  obstacles: readonly InspectorBounds[],
  placement: "default" | "nearest",
): InspectorPosition {
  const ordered = candidates.map((candidate) => candidatePoint(candidate, bounds, viewport));
  if (placement === "nearest")
    ordered.sort((left, right) => distance(bounds, left) - distance(bounds, right));
  const chosen =
    ordered.find((point) =>
      obstacles.every((obstacle) => !inspectorBoundsOverlap({ ...bounds, ...point }, obstacle)),
    ) ?? ordered[0]!;
  const clamped = clampInspectorPosition(
    { left: chosen.left, bottom: chosen.top + bounds.height },
    bounds,
    viewport,
  );
  const base = { left: clamped.left, top: clamped.bottom - bounds.height };
  const proposals = [
    base,
    ...obstacles
      .flatMap((obstacle) => [
        { left: base.left, top: obstacle.top - bounds.height - GAP },
        { left: obstacle.left - bounds.width - GAP, top: base.top },
        { left: obstacle.left + obstacle.width + GAP, top: base.top },
        { left: base.left, top: obstacle.top + obstacle.height + GAP },
      ])
      .map((point) => {
        const next = clampInspectorPosition(
          { left: point.left, bottom: point.top + bounds.height },
          bounds,
          viewport,
        );
        return { left: next.left, top: next.bottom - bounds.height };
      }),
  ];
  const clear =
    proposals
      .filter((point) =>
        obstacles.every((obstacle) => !inspectorBoundsOverlap({ ...bounds, ...point }, obstacle)),
      )
      .sort((left, right) => distance(chosen, left) - distance(chosen, right))[0] ?? base;
  return { left: clear.left, bottom: clear.top + bounds.height };
}

export function inspectorMaximumSize(viewport: InspectorViewport): InspectorSize {
  return {
    width: Math.max(0, (viewport.width - 16) / viewport.scale),
    height: Math.max(0, (viewport.height - inspectorTopInset(viewport) - GAP) / viewport.scale),
  };
}

/** Size is expressed in the panel's CSS units; the captured bottom and opposite width edge remain fixed. */
export function resizeInspector(
  bounds: InspectorBounds,
  desired: InspectorSize,
  edge: InspectorResizeEdge,
  viewport: InspectorViewport,
): { position: InspectorPosition; size: InspectorSize } {
  const maximum = inspectorMaximumSize(viewport);
  const bottom = bounds.top + bounds.height;
  const leftEdge = edge === "left" || edge === "top-left";
  const width = Math.max(
    0,
    Math.min(
      desired.width,
      maximum.width,
      (leftEdge ? bounds.left + bounds.width - GAP : viewport.width - GAP - bounds.left) /
        viewport.scale,
    ),
  );
  const height = Math.max(
    0,
    Math.min(
      desired.height,
      maximum.height,
      (bottom - inspectorTopInset(viewport)) / viewport.scale,
    ),
  );
  return {
    position: {
      left: leftEdge ? bounds.left + bounds.width - width * viewport.scale : bounds.left,
      bottom,
    },
    size: { width, height },
  };
}

export function inspectorKeyboardSize(
  current: number,
  key: string,
  edge: "left" | "right" | "top",
  min: number,
  max: number,
): number | null {
  if (key === "Home") return min;
  if (key === "End") return max;
  if (edge === "top") {
    if (key === "ArrowUp") return clamp(current + 10, min, max);
    if (key === "ArrowDown") return clamp(current - 10, min, max);
    return null;
  }
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const direction = (key === "ArrowLeft") === (edge === "left") ? 1 : -1;
  return direction ? clamp(current + direction * 10, min, max) : null;
}

/** The popup editor accepts opaque HEX. Authored alpha values remain valid in the separate inline field. */
export function normalizeInspectorPopupHex(input: string): string | null {
  const value = input.trim().replace(/^#/, "");
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return null;
  return `#${(value.length === 3
    ? value
        .split("")
        .map((character) => character + character)
        .join("")
    : value
  ).toUpperCase()}`;
}

export function inspectorPickerColor(input: string): string {
  const value = input.trim().replace(/^#/, "");
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return "#000000";
  return normalizeInspectorPopupHex(value.length <= 4 ? value.slice(0, 3) : value.slice(0, 6))!;
}
