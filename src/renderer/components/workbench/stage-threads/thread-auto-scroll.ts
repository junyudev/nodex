export interface ScrollPositionSnapshot {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface ThreadAutoScrollInput {
  position: ScrollPositionSnapshot;
  nearBottomThresholdPx?: number;
}

export interface ThreadCatchUpControlInput {
  hasThread: boolean;
  hasItems: boolean;
  isFollowingLatest: boolean;
}

const DEFAULT_NEAR_BOTTOM_THRESHOLD_PX = 120;

export function distanceFromBottom(position: ScrollPositionSnapshot): number {
  const rawDistance = position.scrollHeight - position.scrollTop - position.clientHeight;
  if (!Number.isFinite(rawDistance)) return Number.POSITIVE_INFINITY;
  return Math.max(0, rawDistance);
}

export function shouldAutoScrollThread({
  position,
  nearBottomThresholdPx = DEFAULT_NEAR_BOTTOM_THRESHOLD_PX,
}: ThreadAutoScrollInput): boolean {
  return distanceFromBottom(position) <= nearBottomThresholdPx;
}

export function shouldShowThreadCatchUpControl({
  hasThread,
  hasItems,
  isFollowingLatest,
}: ThreadCatchUpControlInput): boolean {
  if (!hasThread) return false;
  if (!hasItems) return false;
  return !isFollowingLatest;
}
