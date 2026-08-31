export type ThreadScrollMode = "stickToBottom" | "user" | "programmaticFind";

export type ThreadLatestTurnPhase = "idle" | "prework" | "final_answer";
export type ThreadLatestTurnFollowMode =
  | "static"
  | "prework_watch"
  | "prework_follow"
  | "user_follow";

export const DEFAULT_VIRTUALIZED_TURN_HEIGHT_PX = 280;
export const THREAD_NEAR_BOTTOM_THRESHOLD_PX = 24;
export const LATEST_TURN_SUBMIT_PLACEMENT_THRESHOLD_PX = 300;

export interface VirtualizedTurnLayoutEntry {
  turnKey: string;
  estimatedHeightPx?: number | null;
}

export interface VirtualizedTurnLayoutInput {
  entries?: readonly VirtualizedTurnLayoutEntry[];
  gapPx: number;
  heightsPx?: readonly number[];
  measuredHeightsByKey?: Readonly<Record<string, number>>;
}

export interface VirtualizedTurnLayout {
  bottomOffsetsPx: number[];
  heightsPx: number[];
  topOffsetsPx: number[];
  totalHeightPx: number;
  turnIndexByKey: Map<string, number>;
  turnKeys: string[];
}

export interface VisibleTurnRange {
  startIndex: number;
  endIndex: number;
}

export interface VisibleTurnRangeFromBottomDistanceInput {
  distanceFromBottomPx: number;
  layout: VirtualizedTurnLayout;
  overscanCount: number;
  viewportHeightPx: number;
}

export interface TurnRevealDistanceInput {
  layout: VirtualizedTurnLayout;
  turnIndex?: number;
  viewportHeightPx: number;
}

export interface TargetRevealDistanceInput extends TurnRevealDistanceInput {
  targetHeightPx: number;
  targetTopWithinTurnPx: number;
  turnIndex: number;
  windowZoom?: number;
}

export interface MeasuredTurnHeightDeltaInput {
  currentScrollDistanceFromBottomPx: number;
  heightDeltaPx: number;
  scrollMode: ThreadScrollMode;
  turnTopDistanceFromBottomPx: number;
  viewportBottomDistanceFromBottomPx: number;
}

export interface VirtualizedTurnRenderedWindow {
  anchorKey: string;
  count: number;
}

export interface VirtualizedTurnListRestoreState {
  renderedWindow: VirtualizedTurnRenderedWindow;
  turnHeightsByKey: Record<string, number>;
}

export interface VirtualizedTurnViewportState {
  distanceFromBottomPx: number;
  renderedRange: VisibleTurnRange;
  turnKeys: string[];
  viewportHeightPx: number;
}

export interface InitialVirtualizedTurnViewportStateInput {
  distanceFromBottomPx: number;
  initialRestoreState?: VirtualizedTurnListRestoreState | null;
  layout: VirtualizedTurnLayout;
  overscanCount: number;
  viewportHeightPx: number;
}

export interface ResolveVirtualizedTurnViewportStateInput {
  current: VirtualizedTurnViewportState;
  distanceFromBottomPx: number;
  layout: VirtualizedTurnLayout;
  overscanCount: number;
  viewportHeightPx: number;
}

export interface VirtualizedTurnRestoreStateInput {
  measuredHeightsByKey: Readonly<Record<string, number>>;
  renderedRange: VisibleTurnRange;
  turnKeys: readonly string[];
}

export interface AnchorPreservedDistanceInput {
  anchorKey: string;
  distanceFromBottomPx: number;
  nextLayout: VirtualizedTurnLayout;
  previousLayout: VirtualizedTurnLayout;
}

export interface MeasuredVisibleAnchorInput {
  distanceFromBottomPx: number;
  layout: VirtualizedTurnLayout;
  measuredHeightsByKey: Readonly<Record<string, number>>;
  nextLayout: VirtualizedTurnLayout;
  viewportHeightPx: number;
}

export interface PendingVirtualizedTurnScrollTarget {
  complete: () => void;
  getTargetElement?: (turnElement: HTMLElement) => HTMLElement | null;
  requestId: number;
  turnKey: string;
}

export interface ThreadLatestTurnFollowState {
  followMode: ThreadLatestTurnFollowMode;
}

export interface VirtualizedLatestTurnRestoreState {
  followMode: ThreadLatestTurnFollowMode;
  isLatestTurnInProgress: boolean;
  latestTurnFollowContentHeightPx: number | null;
  latestTurnHeightPx: number | null;
  latestTurnPhase: ThreadLatestTurnPhase;
  turnKey: string;
}

export type ThreadLatestTurnFollowEvent =
  | {
      type: "latest_turn_follow_content_changed";
      followContentOverflowPx: number;
      latestTurnPhase: ThreadLatestTurnPhase;
    }
  | {
      type: "latest_turn_phase_changed";
      latestTurnPhase: ThreadLatestTurnPhase;
      previousLatestTurnPhase: ThreadLatestTurnPhase;
    }
  | { type: "latest_turn_placed" }
  | { type: "latest_turn_removed" }
  | {
      type: "scroll_distance_changed";
      distanceFromBottomPx: number;
      latestTurnPhase: ThreadLatestTurnPhase;
    }
  | {
      type: "scroll_to_bottom";
      latestTurnPhase: ThreadLatestTurnPhase;
    };

export interface ThreadLatestTurnPhaseInput {
  finalAssistantStartedAtMs?: number | null;
  firstTurnWorkItemStartedAtMs?: number | null;
  items: readonly {
    assistantPhase?: string | null;
    kind?: string | null;
    normalizedKind?: string | null;
    role?: string | null;
    semanticKind?: string | null;
    type?: string | null;
  }[];
  status: string;
}

export interface PendingLatestTurnSubmitPlacement {
  distanceFromBottomPx: number;
  scrollHeightPx: number | null;
  shouldPlaceLatestTurn: boolean;
}

function finitePositiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveLayoutEntries(input: VirtualizedTurnLayoutInput): {
  heightsPx: number[];
  turnKeys: string[];
} {
  if (input.entries) {
    const measuredHeightsByKey = input.measuredHeightsByKey ?? {};
    return {
      heightsPx: input.entries.map(
        (entry) =>
          finitePositiveOrNull(measuredHeightsByKey[entry.turnKey]) ??
          finitePositiveOrNull(entry.estimatedHeightPx) ??
          DEFAULT_VIRTUALIZED_TURN_HEIGHT_PX,
      ),
      turnKeys: input.entries.map((entry) => entry.turnKey),
    };
  }

  const heightsPx = (input.heightsPx ?? []).map(
    (heightPx) => finitePositiveOrNull(heightPx) ?? DEFAULT_VIRTUALIZED_TURN_HEIGHT_PX,
  );
  return {
    heightsPx,
    turnKeys: heightsPx.map((_, index) => String(index)),
  };
}

export function buildVirtualizedTurnLayout(
  input: VirtualizedTurnLayoutInput,
): VirtualizedTurnLayout {
  const { heightsPx, turnKeys } = resolveLayoutEntries(input);
  const turnIndexByKey = new Map<string, number>();
  const topOffsetsPx: number[] = [];
  let totalHeightPx = 0;

  for (let index = 0; index < heightsPx.length; index += 1) {
    const turnKey = turnKeys[index] ?? String(index);
    turnIndexByKey.set(turnKey, index);
    topOffsetsPx.push(totalHeightPx);
    totalHeightPx += heightsPx[index] ?? DEFAULT_VIRTUALIZED_TURN_HEIGHT_PX;
    if (index < heightsPx.length - 1) {
      totalHeightPx += input.gapPx;
    }
  }

  return {
    bottomOffsetsPx: topOffsetsPx.map(
      (topOffsetPx, index) => totalHeightPx - topOffsetPx - (heightsPx[index] ?? 0),
    ),
    heightsPx,
    topOffsetsPx,
    totalHeightPx,
    turnIndexByKey,
    turnKeys,
  };
}

function findStartIndexFromBottomDistance({
  bottomOffsetsPx,
  targetPx,
}: {
  bottomOffsetsPx: readonly number[];
  targetPx: number;
}): number {
  let start = 0;
  let end = bottomOffsetsPx.length;

  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if ((bottomOffsetsPx[middle] ?? 0) < targetPx) {
      end = middle;
      continue;
    }
    start = middle + 1;
  }

  return start;
}

function findEndIndexFromBottomDistance({
  bottomOffsetsPx,
  heightsPx,
  targetPx,
}: {
  bottomOffsetsPx: readonly number[];
  heightsPx: readonly number[];
  targetPx: number;
}): number {
  let start = 0;
  let end = bottomOffsetsPx.length;

  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const turnTopDistanceFromBottomPx = (bottomOffsetsPx[middle] ?? 0) + (heightsPx[middle] ?? 0);
    if (turnTopDistanceFromBottomPx <= targetPx) {
      end = middle;
      continue;
    }
    start = middle + 1;
  }

  return start;
}

export function resolveVisibleTurnRangeFromBottomDistance({
  distanceFromBottomPx,
  layout,
  overscanCount,
  viewportHeightPx,
}: VisibleTurnRangeFromBottomDistanceInput): VisibleTurnRange {
  if (layout.turnKeys.length === 0) {
    return { startIndex: 0, endIndex: 0 };
  }

  const viewportBottomDistancePx = Math.min(
    Math.max(0, distanceFromBottomPx),
    layout.totalHeightPx,
  );
  const viewportTopDistancePx = Math.min(
    viewportBottomDistancePx + Math.max(0, viewportHeightPx),
    layout.totalHeightPx,
  );
  const firstVisibleIndex = findStartIndexFromBottomDistance({
    bottomOffsetsPx: layout.bottomOffsetsPx,
    targetPx: viewportTopDistancePx,
  });
  const endIndex = findEndIndexFromBottomDistance({
    bottomOffsetsPx: layout.bottomOffsetsPx,
    heightsPx: layout.heightsPx,
    targetPx: viewportBottomDistancePx,
  });

  return {
    startIndex: Math.max(0, firstVisibleIndex - overscanCount),
    endIndex: Math.min(
      layout.turnKeys.length,
      Math.max(endIndex, firstVisibleIndex + 1) + overscanCount,
    ),
  };
}

export function resolveRenderedRangeFromAnchor({
  anchorKey,
  layout,
  previousRange,
}: {
  anchorKey: string;
  layout: VirtualizedTurnLayout;
  previousRange: VisibleTurnRange;
}): VisibleTurnRange | null {
  const anchorIndex = layout.turnIndexByKey.get(anchorKey);
  if (anchorIndex == null) return null;

  return {
    startIndex: anchorIndex,
    endIndex: Math.min(
      layout.turnKeys.length,
      anchorIndex + Math.max(0, previousRange.endIndex - previousRange.startIndex),
    ),
  };
}

function rangesAreEqual(left: VisibleTurnRange, right: VisibleTurnRange): boolean {
  return left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

export function visibleTurnRangeContainsRange(
  containingRange: VisibleTurnRange,
  containedRange: VisibleTurnRange,
): boolean {
  return (
    containingRange.startIndex <= containedRange.startIndex &&
    containingRange.endIndex >= containedRange.endIndex
  );
}

function stringArraysAreEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function resolveInitialVirtualizedTurnViewportState({
  distanceFromBottomPx,
  initialRestoreState,
  layout,
  overscanCount,
  viewportHeightPx,
}: InitialVirtualizedTurnViewportStateInput): VirtualizedTurnViewportState {
  const nextDistanceFromBottomPx = Math.min(
    Math.max(0, distanceFromBottomPx),
    layout.totalHeightPx,
  );
  const bottomDistanceRange = resolveVisibleTurnRangeFromBottomDistance({
    distanceFromBottomPx: nextDistanceFromBottomPx,
    layout,
    overscanCount,
    viewportHeightPx,
  });
  const restoredRange = initialRestoreState?.renderedWindow
    ? resolveRenderedRangeFromAnchor({
        anchorKey: initialRestoreState.renderedWindow.anchorKey,
        layout,
        previousRange: {
          startIndex: 0,
          endIndex: Math.min(
            initialRestoreState.renderedWindow.count,
            bottomDistanceRange.endIndex - bottomDistanceRange.startIndex,
          ),
        },
      })
    : null;

  return {
    distanceFromBottomPx: nextDistanceFromBottomPx,
    renderedRange: restoredRange ?? bottomDistanceRange,
    turnKeys: layout.turnKeys,
    viewportHeightPx,
  };
}

export function resolveVirtualizedTurnViewportState({
  current,
  distanceFromBottomPx,
  layout,
  overscanCount,
  viewportHeightPx,
}: ResolveVirtualizedTurnViewportStateInput): VirtualizedTurnViewportState {
  const nextDistanceFromBottomPx = Math.min(
    Math.max(0, distanceFromBottomPx),
    layout.totalHeightPx,
  );
  const nextRange = resolveVisibleTurnRangeFromBottomDistance({
    distanceFromBottomPx: nextDistanceFromBottomPx,
    layout,
    overscanCount,
    viewportHeightPx,
  });
  const renderedRange = visibleTurnRangeContainsRange(current.renderedRange, nextRange)
    ? current.renderedRange
    : nextRange;

  if (
    current.distanceFromBottomPx === nextDistanceFromBottomPx &&
    current.viewportHeightPx === viewportHeightPx &&
    rangesAreEqual(current.renderedRange, renderedRange) &&
    stringArraysAreEqual(current.turnKeys, layout.turnKeys)
  ) {
    return current;
  }

  return {
    distanceFromBottomPx: nextDistanceFromBottomPx,
    renderedRange,
    turnKeys: layout.turnKeys,
    viewportHeightPx,
  };
}

export function resolveRenderedRangeForPendingScrollTarget({
  currentRange,
  layout,
  overscanCount,
  pendingTurnKey,
  viewportHeightPx,
}: {
  currentRange: VisibleTurnRange;
  layout: VirtualizedTurnLayout;
  overscanCount: number;
  pendingTurnKey: string;
  viewportHeightPx: number;
}): VisibleTurnRange {
  const distanceFromBottomPx = resolveTurnCenterDistanceFromBottom({
    layout,
    turnKey: pendingTurnKey,
    viewportHeightPx,
  });
  if (distanceFromBottomPx === null) return currentRange;

  return resolveVisibleTurnRangeFromBottomDistance({
    distanceFromBottomPx,
    layout,
    overscanCount,
    viewportHeightPx,
  });
}

export function buildVirtualizedTurnListRestoreState({
  measuredHeightsByKey,
  renderedRange,
  turnKeys,
}: VirtualizedTurnRestoreStateInput): VirtualizedTurnListRestoreState | null {
  const anchorKey = turnKeys[renderedRange.startIndex];
  if (anchorKey == null) return null;

  const turnHeightsByKey: Record<string, number> = {};
  for (const turnKey of turnKeys) {
    const heightPx = finitePositiveOrNull(measuredHeightsByKey[turnKey]);
    if (heightPx !== null) {
      turnHeightsByKey[turnKey] = heightPx;
    }
  }

  if (Object.keys(turnHeightsByKey).length === 0) return null;

  return {
    renderedWindow: {
      anchorKey,
      count: Math.max(0, renderedRange.endIndex - renderedRange.startIndex),
    },
    turnHeightsByKey,
  };
}

export function resolveAnchorPreservedDistanceFromBottom({
  anchorKey,
  distanceFromBottomPx,
  nextLayout,
  previousLayout,
}: AnchorPreservedDistanceInput): number | null {
  const previousIndex = previousLayout.turnIndexByKey.get(anchorKey);
  const nextIndex = nextLayout.turnIndexByKey.get(anchorKey);
  if (previousIndex == null || nextIndex == null) return null;

  const previousAnchorTopDistanceFromBottomPx =
    (previousLayout.bottomOffsetsPx[previousIndex] ?? 0) +
    (previousLayout.heightsPx[previousIndex] ?? 0);
  const nextAnchorTopDistanceFromBottomPx =
    (nextLayout.bottomOffsetsPx[nextIndex] ?? 0) + (nextLayout.heightsPx[nextIndex] ?? 0);

  return Math.max(
    0,
    distanceFromBottomPx +
      nextAnchorTopDistanceFromBottomPx -
      previousAnchorTopDistanceFromBottomPx,
  );
}

export function resolveMeasuredVisibleAnchorKey({
  distanceFromBottomPx,
  layout,
  measuredHeightsByKey,
  nextLayout,
  viewportHeightPx,
}: MeasuredVisibleAnchorInput): string | null {
  const visibleRange = resolveVisibleTurnRangeFromBottomDistance({
    distanceFromBottomPx,
    layout,
    overscanCount: 0,
    viewportHeightPx,
  });

  for (let index = visibleRange.startIndex; index < visibleRange.endIndex; index += 1) {
    const turnKey = layout.turnKeys[index];
    if (
      turnKey != null &&
      measuredHeightsByKey[turnKey] != null &&
      nextLayout.turnIndexByKey.has(turnKey)
    ) {
      return turnKey;
    }
  }

  return null;
}

export function resolveTurnCenterDistanceFromBottom({
  layout,
  turnIndex,
  turnKey,
  viewportHeightPx,
}: TurnRevealDistanceInput & { turnKey?: string }): number | null {
  const resolvedTurnIndex = turnKey == null ? turnIndex : layout.turnIndexByKey.get(turnKey);
  if (resolvedTurnIndex == null) return null;

  const bottomOffsetPx = layout.bottomOffsetsPx[resolvedTurnIndex];
  const heightPx = layout.heightsPx[resolvedTurnIndex];
  if (bottomOffsetPx == null || heightPx == null) return null;

  return Math.max(0, bottomOffsetPx - viewportHeightPx / 2 + heightPx / 2);
}

export function resolveTargetCenterDistanceFromBottom({
  layout,
  targetHeightPx,
  targetTopWithinTurnPx,
  turnIndex,
  viewportHeightPx,
  windowZoom = 1,
}: TargetRevealDistanceInput): number | null {
  const bottomOffsetPx = layout.bottomOffsetsPx[turnIndex];
  const heightPx = layout.heightsPx[turnIndex];
  if (bottomOffsetPx == null || heightPx == null) return null;

  const normalizedWindowZoom = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
  const normalizedTargetTopWithinTurnPx = targetTopWithinTurnPx / normalizedWindowZoom;
  const normalizedTargetHeightPx = targetHeightPx / normalizedWindowZoom;

  return Math.max(
    0,
    bottomOffsetPx +
      heightPx -
      normalizedTargetTopWithinTurnPx -
      normalizedTargetHeightPx / 2 -
      viewportHeightPx / 2,
  );
}

export function resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta({
  currentScrollDistanceFromBottomPx,
  heightDeltaPx,
  turnTopDistanceFromBottomPx,
  viewportBottomDistanceFromBottomPx,
  scrollMode,
}: MeasuredTurnHeightDeltaInput): number | null {
  if (heightDeltaPx === 0 || scrollMode === "programmaticFind") {
    return null;
  }

  if (scrollMode === "stickToBottom") {
    return 0;
  }

  if (turnTopDistanceFromBottomPx <= viewportBottomDistanceFromBottomPx) {
    return Math.max(0, currentScrollDistanceFromBottomPx + heightDeltaPx);
  }

  return null;
}

export function createThreadLatestTurnFollowState(
  input: Partial<ThreadLatestTurnFollowState> = {},
): ThreadLatestTurnFollowState {
  return {
    followMode: input.followMode ?? "static",
  };
}

function withFollowMode(
  state: ThreadLatestTurnFollowState,
  followMode: ThreadLatestTurnFollowMode,
): ThreadLatestTurnFollowState {
  return state.followMode === followMode ? state : { ...state, followMode };
}

export function shouldAllowResponseSpacerGrowth(followMode: ThreadLatestTurnFollowMode): boolean {
  return followMode === "static" || followMode === "prework_watch";
}

export function resolveThreadLatestTurnFollowState(
  state: ThreadLatestTurnFollowState,
  event: ThreadLatestTurnFollowEvent,
): ThreadLatestTurnFollowState {
  if (event.type === "latest_turn_follow_content_changed") {
    if (event.latestTurnPhase !== "prework" || state.followMode !== "prework_watch") {
      return state;
    }
    return event.followContentOverflowPx > 0 ? withFollowMode(state, "prework_follow") : state;
  }

  if (event.type === "latest_turn_phase_changed") {
    let nextState = state;
    if (event.previousLatestTurnPhase !== "prework" && event.latestTurnPhase === "prework") {
      if (nextState.followMode === "static") {
        nextState = withFollowMode(nextState, "prework_watch");
      } else if (nextState.followMode === "user_follow") {
        nextState = withFollowMode(nextState, "prework_follow");
      }
    }
    if (event.previousLatestTurnPhase === "prework" && event.latestTurnPhase === "final_answer") {
      nextState = withFollowMode(
        nextState,
        nextState.followMode === "prework_follow" ? "user_follow" : "static",
      );
    }
    if (
      event.previousLatestTurnPhase !== "idle" &&
      event.latestTurnPhase === "idle" &&
      nextState.followMode !== "user_follow"
    ) {
      nextState = withFollowMode(nextState, "static");
    }
    return nextState;
  }

  if (event.type === "latest_turn_placed" || event.type === "latest_turn_removed") {
    return withFollowMode(state, "static");
  }

  if (event.type === "scroll_distance_changed") {
    if (event.distanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
      return state;
    }
    if (state.followMode === "prework_follow") {
      return withFollowMode(state, "prework_watch");
    }
    if (state.followMode === "user_follow") {
      return withFollowMode(
        state,
        event.latestTurnPhase === "prework" ? "prework_watch" : "static",
      );
    }
    return state;
  }

  return withFollowMode(
    state,
    event.latestTurnPhase === "prework" ? "prework_follow" : "user_follow",
  );
}

function isAssistantLikeItem(item: ThreadLatestTurnPhaseInput["items"][number]): boolean {
  return (
    item.normalizedKind === "assistantMessage" ||
    item.semanticKind === "assistantMessage" ||
    item.kind === "assistantMessage" ||
    item.type === "assistantMessage" ||
    item.type === "assistant_message" ||
    item.type === "agentMessage" ||
    item.role === "assistant"
  );
}

export function resolveThreadLatestTurnPhase(
  turn: ThreadLatestTurnPhaseInput | null,
): ThreadLatestTurnPhase {
  if (!turn || turn.status !== "inProgress") return "idle";

  let hasCommentaryAssistant = false;
  for (const item of turn.items) {
    if (!isAssistantLikeItem(item)) continue;
    if (item.assistantPhase === "commentary") {
      hasCommentaryAssistant = true;
      continue;
    }
    return "final_answer";
  }

  if (hasCommentaryAssistant || turn.firstTurnWorkItemStartedAtMs != null) {
    return "prework";
  }

  return turn.finalAssistantStartedAtMs == null ? "idle" : "final_answer";
}

export function buildPendingLatestTurnSubmitPlacement({
  distanceFromBottomPx,
  responseSpacerHeightPx,
  scrollHeightPx,
}: {
  distanceFromBottomPx: number;
  responseSpacerHeightPx: number;
  scrollHeightPx: number | null;
}): PendingLatestTurnSubmitPlacement {
  return {
    distanceFromBottomPx,
    scrollHeightPx,
    shouldPlaceLatestTurn:
      distanceFromBottomPx - responseSpacerHeightPx <= LATEST_TURN_SUBMIT_PLACEMENT_THRESHOLD_PX,
  };
}

export function resolveResponseSpacerBottomViewportOverflowPx({
  distanceFromBottomPx,
  responseSpacerHeightPx,
  scrollPaddingBottomPx,
}: {
  distanceFromBottomPx: number;
  responseSpacerHeightPx: number;
  scrollPaddingBottomPx: number;
}): number {
  return Math.max(0, responseSpacerHeightPx - distanceFromBottomPx - scrollPaddingBottomPx);
}

export function resolveResponseSpacerHeightPx({
  scrollPaddingBottomPx,
  viewportHeightPx,
}: {
  scrollPaddingBottomPx: number;
  viewportHeightPx: number;
}): number {
  const availableViewportHeightPx = Math.max(0, viewportHeightPx - scrollPaddingBottomPx);
  return Math.max(
    0,
    Math.min((availableViewportHeightPx * 2) / 3, availableViewportHeightPx - 240),
  );
}

export function resolveRestoredDistanceWithoutResponseSpacer({
  distanceFromBottomPx,
  latestTurnPhase,
  responseSpacerHeightPx,
  scrollPaddingBottomPx,
  scrollState,
}: {
  distanceFromBottomPx: number;
  latestTurnPhase: ThreadLatestTurnPhase;
  responseSpacerHeightPx: number;
  scrollPaddingBottomPx: number;
  scrollState: ThreadLatestTurnFollowState;
}): {
  distanceFromBottomPx: number;
  scrollState: ThreadLatestTurnFollowState;
} {
  return resolveResponseSpacerBottomViewportOverflowPx({
    distanceFromBottomPx,
    responseSpacerHeightPx,
    scrollPaddingBottomPx,
  }) > THREAD_NEAR_BOTTOM_THRESHOLD_PX
    ? {
        distanceFromBottomPx: 0,
        scrollState: resolveThreadLatestTurnFollowState(scrollState, {
          type: "scroll_to_bottom",
          latestTurnPhase,
        }),
      }
    : {
        distanceFromBottomPx: Math.max(0, distanceFromBottomPx - responseSpacerHeightPx),
        scrollState,
      };
}

export function shouldShowThreadScrollToBottomControl({
  isScrollToTopEnabled,
  isScrolledFromBottom,
  responseSpacerHeightPx,
  scrollDistanceFromBottomPx,
}: {
  isScrollToTopEnabled: boolean;
  isScrolledFromBottom: boolean;
  responseSpacerHeightPx: number | null;
  scrollDistanceFromBottomPx: number;
}): boolean {
  return !isScrollToTopEnabled || responseSpacerHeightPx == null
    ? isScrolledFromBottom
    : scrollDistanceFromBottomPx > responseSpacerHeightPx + THREAD_NEAR_BOTTOM_THRESHOLD_PX;
}
