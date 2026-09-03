export const REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID = "codex-main-thread";
export const REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE = "data-pip-anchor-host";
export const REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE = "data-pip-home-surface";
export const REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE = "data-pip-obstacle";

export type RemoteHostedPipActivitySource = "browser-use" | "computer-use";
export type RemoteHostedPipTaskVisibility = "hidden" | "shown";

/** Canonical, bounded Main-owned state consumed by every renderer window. */
export interface RemoteHostedPipTaskStateSnapshot {
  readonly activeTaskIds: readonly string[];
  readonly alwaysHidden: boolean;
  readonly retainedPresentationCount: number;
  readonly revision: number;
  /** Main-derived capability; activity alone never promises a working native action. */
  readonly taskVisibilityActionAvailable: boolean;
  readonly taskVisibilities: Readonly<Record<string, RemoteHostedPipTaskVisibility>>;
}

export interface RemoteHostedPipRevisionEvent {
  readonly revision: number;
}

export interface RemoteHostedPipTaskVisibilityInput {
  readonly taskId: string;
  readonly visibility: RemoteHostedPipTaskVisibility;
}

export type RemoteHostedPipPresentationScope = "thread" | "all";
export type RemoteHostedPipAnchorAlignment =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface RemoteHostedPipViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RemoteHostedPipPoint {
  x: number;
  y: number;
}

export interface RemoteHostedPipAnchor {
  alignment: RemoteHostedPipAnchorAlignment;
  point: RemoteHostedPipPoint;
}

export interface RemoteHostedPipAnimationSpring {
  damping: number;
  initialVelocity: number;
  mass: number;
  stiffness: number;
}

export interface RemoteHostedPipHostLayout {
  anchors: RemoteHostedPipAnchor[] | null;
  anchorRect: RemoteHostedPipViewportRect | null;
  animated: boolean;
  animationSpring?: RemoteHostedPipAnimationSpring;
  hostId: string;
  interactionPassthroughRect?: RemoteHostedPipViewportRect | null;
  isCodexHomeAvailable?: boolean;
  presentationScope: RemoteHostedPipPresentationScope;
}

export interface RemoteHostedPipHostLayoutInput {
  homeSurfaceRect?: RemoteHostedPipViewportRect | null;
  hostId?: string;
  hostRect: RemoteHostedPipViewportRect;
  isCodexHomeAvailable?: boolean;
  obstacleRects: RemoteHostedPipViewportRect[];
  presentationScope?: RemoteHostedPipPresentationScope;
}

interface RemoteHostedPipRelativeRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface RemoteHostedPipAnchorCandidate {
  priority: number;
  rect: RemoteHostedPipRelativeRect;
}

const REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX = 24;
const REMOTE_HOSTED_PIP_OBSTACLE_MARGIN_PX = 12;
const REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT = {
  height: 250,
  width: 250,
};
const REMOTE_HOSTED_PIP_MAX_ADJUSTMENTS = 6;
const REMOTE_HOSTED_PIP_OVERLAP_PENALTY = 1_000_000_000;
const REMOTE_HOSTED_PIP_OVERLAP_AREA_WEIGHT = 10_000;
const REMOTE_HOSTED_PIP_PRIORITY_WEIGHT = 1_000_000;

const REMOTE_HOSTED_PIP_ANCHOR_ALIGNMENTS: RemoteHostedPipAnchorAlignment[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export function buildRemoteHostedPipHiddenHostLayout({
  hostId = REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  presentationScope = "thread",
}: {
  hostId?: string;
  presentationScope?: RemoteHostedPipPresentationScope;
} = {}): RemoteHostedPipHostLayout {
  return {
    anchors: null,
    anchorRect: null,
    animated: false,
    hostId,
    interactionPassthroughRect: null,
    isCodexHomeAvailable: false,
    presentationScope,
  };
}

export function buildRemoteHostedPipHostLayout({
  homeSurfaceRect = null,
  hostId = REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  hostRect,
  isCodexHomeAvailable = false,
  obstacleRects,
  presentationScope = "thread",
}: RemoteHostedPipHostLayoutInput): RemoteHostedPipHostLayout {
  const paddedObstacleRects = obstacleRects.map((rect) => buildPaddedObstacleRect(hostRect, rect));
  const homeTopRightRect =
    isCodexHomeAvailable && homeSurfaceRect !== null
      ? buildHomeTopRightContentRect(hostRect, homeSurfaceRect)
      : null;

  return {
    anchorRect: hostRect,
    anchors: REMOTE_HOSTED_PIP_ANCHOR_ALIGNMENTS.map((alignment) =>
      buildRemoteHostedPipAnchor(
        alignment,
        hostRect,
        paddedObstacleRects,
        alignment === "top-right" ? homeTopRightRect : null,
      ),
    ),
    animated: false,
    hostId,
    interactionPassthroughRect: null,
    isCodexHomeAvailable,
    presentationScope,
  };
}

export function serializeRemoteHostedPipHostLayoutIdentity(
  layout: RemoteHostedPipHostLayout,
): string {
  return JSON.stringify({
    anchors: layout.anchors,
    anchorRect: layout.anchorRect,
    hostId: layout.hostId,
    isCodexHomeAvailable: layout.isCodexHomeAvailable,
    presentationScope: layout.presentationScope,
  });
}

function buildRemoteHostedPipAnchor(
  alignment: RemoteHostedPipAnchorAlignment,
  hostRect: RemoteHostedPipViewportRect,
  obstacleRects: RemoteHostedPipRelativeRect[],
  preferredSourceRect: RemoteHostedPipRelativeRect | null,
): RemoteHostedPipAnchor {
  const sourceRect = clampRelativeRectToHost(
    preferredSourceRect ?? getDefaultAnchorContentRect(alignment, hostRect),
    hostRect,
  );
  let currentRect = sourceRect;

  for (let index = 0; index < REMOTE_HOSTED_PIP_MAX_ADJUSTMENTS; index += 1) {
    const obstacle = findIntersectingObstacle(currentRect, obstacleRects);
    if (obstacle === null) break;

    currentRect = resolveNextAnchorContentRect({
      alignment,
      hostRect,
      obstacle,
      obstacles: obstacleRects,
      rect: currentRect,
      sourceRect,
    });
  }

  return {
    alignment,
    point: getAnchorPoint(alignment, hostRect, currentRect),
  };
}

function buildHomeTopRightContentRect(
  hostRect: RemoteHostedPipViewportRect,
  homeSurfaceRect: RemoteHostedPipViewportRect,
): RemoteHostedPipRelativeRect {
  const homeRight = homeSurfaceRect.x - hostRect.x + homeSurfaceRect.width;
  const homeBottom = homeSurfaceRect.y - hostRect.y + homeSurfaceRect.height;

  return createRelativeRect(
    homeRight - REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT.width,
    homeBottom + REMOTE_HOSTED_PIP_OBSTACLE_MARGIN_PX,
    REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT,
  );
}

function getDefaultAnchorContentRect(
  alignment: RemoteHostedPipAnchorAlignment,
  hostRect: RemoteHostedPipViewportRect,
): RemoteHostedPipRelativeRect {
  switch (alignment) {
    case "top-left":
      return createRelativeRect(
        REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT,
      );
    case "top-right":
      return createRelativeRect(
        hostRect.width -
          REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT.width -
          REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT,
      );
    case "bottom-left":
      return createRelativeRect(
        REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        hostRect.height -
          REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT.height -
          REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT,
      );
    case "bottom-right":
      return createRelativeRect(
        hostRect.width -
          REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT.width -
          REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        hostRect.height -
          REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT.height -
          REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        REMOTE_HOSTED_PIP_DEFAULT_CONTENT_RECT,
      );
  }
}

function resolveNextAnchorContentRect({
  alignment,
  hostRect,
  obstacle,
  obstacles,
  rect,
  sourceRect,
}: {
  alignment: RemoteHostedPipAnchorAlignment;
  hostRect: RemoteHostedPipViewportRect;
  obstacle: RemoteHostedPipRelativeRect;
  obstacles: RemoteHostedPipRelativeRect[];
  rect: RemoteHostedPipRelativeRect;
  sourceRect: RemoteHostedPipRelativeRect;
}): RemoteHostedPipRelativeRect {
  const candidates = buildAnchorCandidates(alignment, rect, obstacle).map((candidate) => ({
    priority: candidate.priority,
    rect: clampRelativeRectToHost(candidate.rect, hostRect),
  }));
  let bestCandidate = candidates[0];
  let bestScore = bestCandidate
    ? scoreAnchorCandidate(bestCandidate, obstacles, sourceRect)
    : Number.POSITIVE_INFINITY;

  for (const candidate of candidates.slice(1)) {
    const score = scoreAnchorCandidate(candidate, obstacles, sourceRect);
    if (score >= bestScore) continue;

    bestCandidate = candidate;
    bestScore = score;
  }

  return bestCandidate?.rect ?? rect;
}

function buildAnchorCandidates(
  alignment: RemoteHostedPipAnchorAlignment,
  rect: RemoteHostedPipRelativeRect,
  obstacle: RemoteHostedPipRelativeRect,
): RemoteHostedPipAnchorCandidate[] {
  const below = createRelativeRect(rect.left, obstacle.bottom, rect);
  const above = createRelativeRect(rect.left, obstacle.top - rect.height, rect);
  const right = createRelativeRect(obstacle.right, rect.top, rect);
  const left = createRelativeRect(obstacle.left - rect.width, rect.top, rect);

  switch (alignment) {
    case "top-left":
      return [
        { priority: 0, rect: below },
        { priority: 1, rect: right },
        { priority: 2, rect: left },
        { priority: 3, rect: above },
      ];
    case "top-right":
      return [
        { priority: 0, rect: below },
        { priority: 1, rect: left },
        { priority: 2, rect: right },
        { priority: 3, rect: above },
      ];
    case "bottom-left":
      return [
        { priority: 0, rect: above },
        { priority: 1, rect: right },
        { priority: 2, rect: left },
        { priority: 3, rect: below },
      ];
    case "bottom-right":
      return [
        { priority: 0, rect: above },
        { priority: 1, rect: left },
        { priority: 2, rect: right },
        { priority: 3, rect: below },
      ];
  }
}

function scoreAnchorCandidate(
  candidate: RemoteHostedPipAnchorCandidate,
  obstacles: RemoteHostedPipRelativeRect[],
  sourceRect: RemoteHostedPipRelativeRect,
): number {
  const overlapArea = obstacles.reduce(
    (sum, obstacle) => sum + getIntersectionArea(candidate.rect, obstacle),
    0,
  );

  return (
    (overlapArea > 0 ? REMOTE_HOSTED_PIP_OVERLAP_PENALTY : 0) +
    overlapArea * REMOTE_HOSTED_PIP_OVERLAP_AREA_WEIGHT +
    candidate.priority * REMOTE_HOSTED_PIP_PRIORITY_WEIGHT +
    (candidate.rect.left - sourceRect.left) ** 2 +
    (candidate.rect.top - sourceRect.top) ** 2
  );
}

function findIntersectingObstacle(
  rect: RemoteHostedPipRelativeRect,
  obstacles: RemoteHostedPipRelativeRect[],
): RemoteHostedPipRelativeRect | null {
  for (const obstacle of obstacles) {
    if (getIntersectionArea(rect, obstacle) > 0) return obstacle;
  }

  return null;
}

function buildPaddedObstacleRect(
  hostRect: RemoteHostedPipViewportRect,
  obstacleRect: RemoteHostedPipViewportRect,
): RemoteHostedPipRelativeRect {
  return createRelativeRectFromEdges({
    bottom:
      obstacleRect.y - hostRect.y + obstacleRect.height + REMOTE_HOSTED_PIP_OBSTACLE_MARGIN_PX,
    left: obstacleRect.x - hostRect.x - REMOTE_HOSTED_PIP_OBSTACLE_MARGIN_PX,
    right: obstacleRect.x - hostRect.x + obstacleRect.width + REMOTE_HOSTED_PIP_OBSTACLE_MARGIN_PX,
    top: obstacleRect.y - hostRect.y - REMOTE_HOSTED_PIP_OBSTACLE_MARGIN_PX,
  });
}

function getAnchorPoint(
  alignment: RemoteHostedPipAnchorAlignment,
  hostRect: RemoteHostedPipViewportRect,
  rect: RemoteHostedPipRelativeRect,
): RemoteHostedPipPoint {
  switch (alignment) {
    case "top-left":
      return {
        x: hostRect.x + rect.left,
        y: hostRect.y + rect.top,
      };
    case "top-right":
      return {
        x: hostRect.x + rect.right,
        y: hostRect.y + rect.top,
      };
    case "bottom-left":
      return {
        x: hostRect.x + rect.left,
        y: hostRect.y + rect.bottom,
      };
    case "bottom-right":
      return {
        x: hostRect.x + rect.right,
        y: hostRect.y + rect.bottom,
      };
  }
}

function clampRelativeRectToHost(
  rect: RemoteHostedPipRelativeRect,
  hostRect: RemoteHostedPipViewportRect,
): RemoteHostedPipRelativeRect {
  return createRelativeRect(
    clamp(
      rect.left,
      REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
      Math.max(
        REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        hostRect.width - rect.width - REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
      ),
    ),
    clamp(
      rect.top,
      REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
      Math.max(
        REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
        hostRect.height - rect.height - REMOTE_HOSTED_PIP_VIEWPORT_MARGIN_PX,
      ),
    ),
    rect,
  );
}

function createRelativeRect(
  left: number,
  top: number,
  size: Pick<RemoteHostedPipRelativeRect, "height" | "width">,
): RemoteHostedPipRelativeRect {
  return {
    bottom: top + size.height,
    height: size.height,
    left,
    right: left + size.width,
    top,
    width: size.width,
  };
}

function createRelativeRectFromEdges({
  bottom,
  left,
  right,
  top,
}: {
  bottom: number;
  left: number;
  right: number;
  top: number;
}): RemoteHostedPipRelativeRect {
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
  };
}

function getIntersectionArea(
  leftRect: RemoteHostedPipRelativeRect,
  rightRect: RemoteHostedPipRelativeRect,
): number {
  const width = Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left);
  const height =
    Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top);
  return width <= 0 || height <= 0 ? 0 : width * height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
