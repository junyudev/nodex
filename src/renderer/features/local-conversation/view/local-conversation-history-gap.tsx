import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";

export const CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX = 800;

export type LocalConversationHistoryGapRow = Extract<CodexHistoryRow, { kind: "gap" }>;

export interface LocalConversationHistoryGapLayout {
  readonly row: LocalConversationHistoryGapRow;
  readonly startPx: number;
  readonly endPx: number;
}

export interface LocalConversationHistoryGapLoadControllerState {
  readonly lastRequestedViewportRevision: number | null;
}

export interface SelectLocalConversationHistoryGapBoundaryInput {
  readonly viewportRevision: number;
  readonly viewportStartPx: number;
  readonly viewportEndPx: number;
  readonly gaps: readonly LocalConversationHistoryGapLayout[];
  readonly activeProgressKeys: ReadonlySet<string>;
}

export interface LocalConversationHistoryGapBoundarySelection {
  readonly boundary: CodexHistoryBoundaryRef | null;
  readonly state: LocalConversationHistoryGapLoadControllerState;
}

interface BoundaryCandidate {
  readonly boundary: CodexHistoryBoundaryRef;
  readonly distanceFromViewportCenterPx: number;
  readonly gapIndex: number;
  readonly edgeOrder: number;
}

export function createLocalConversationHistoryGapLoadControllerState(): LocalConversationHistoryGapLoadControllerState {
  return { lastRequestedViewportRevision: null };
}

function isFiniteRange(startPx: number, endPx: number): boolean {
  return Number.isFinite(startPx) && Number.isFinite(endPx) && endPx >= startPx;
}

function distanceFromViewportPx(
  gapStartPx: number,
  gapEndPx: number,
  viewportStartPx: number,
  viewportEndPx: number,
): number {
  if (gapEndPx < viewportStartPx) return viewportStartPx - gapEndPx;
  if (gapStartPx > viewportEndPx) return gapStartPx - viewportEndPx;
  return 0;
}

function collectBoundaryCandidate(
  candidates: BoundaryCandidate[],
  boundary: CodexHistoryBoundaryRef | null,
  boundaryPositionPx: number,
  viewportCenterPx: number,
  gapIndex: number,
  edgeOrder: number,
  activeProgressKeys: ReadonlySet<string>,
): void {
  if (!boundary || activeProgressKeys.has(boundary.progressKey)) return;
  candidates.push({
    boundary,
    distanceFromViewportCenterPx: Math.abs(boundaryPositionPx - viewportCenterPx),
    gapIndex,
    edgeOrder,
  });
}

/**
 * Selects one loadable boundary for a viewport revision. Gap edges are treated as
 * the boundary positions, so an internal gap naturally loads from the island
 * closest to the viewport rather than preferring a fixed chronological direction.
 */
export function selectLocalConversationHistoryGapBoundary(
  state: LocalConversationHistoryGapLoadControllerState,
  input: SelectLocalConversationHistoryGapBoundaryInput,
): LocalConversationHistoryGapBoundarySelection {
  if (!Number.isSafeInteger(input.viewportRevision) || input.viewportRevision < 0) {
    return { boundary: null, state };
  }
  if (
    state.lastRequestedViewportRevision !== null &&
    input.viewportRevision <= state.lastRequestedViewportRevision
  ) {
    return { boundary: null, state };
  }
  if (!isFiniteRange(input.viewportStartPx, input.viewportEndPx)) {
    return { boundary: null, state };
  }

  const viewportCenterPx = (input.viewportStartPx + input.viewportEndPx) / 2;
  const candidates: BoundaryCandidate[] = [];
  for (const [gapIndex, gap] of input.gaps.entries()) {
    if (!isFiniteRange(gap.startPx, gap.endPx)) continue;
    if (
      distanceFromViewportPx(gap.startPx, gap.endPx, input.viewportStartPx, input.viewportEndPx) >
      CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX
    ) {
      continue;
    }
    collectBoundaryCandidate(
      candidates,
      gap.row.olderBoundary,
      gap.startPx,
      viewportCenterPx,
      gapIndex,
      0,
      input.activeProgressKeys,
    );
    collectBoundaryCandidate(
      candidates,
      gap.row.newerBoundary,
      gap.endPx,
      viewportCenterPx,
      gapIndex,
      1,
      input.activeProgressKeys,
    );
  }

  const selected = candidates.toSorted(
    (left, right) =>
      left.distanceFromViewportCenterPx - right.distanceFromViewportCenterPx ||
      left.gapIndex - right.gapIndex ||
      left.edgeOrder - right.edgeOrder,
  )[0];
  if (!selected) return { boundary: null, state };

  return {
    boundary: selected.boundary,
    state: { lastRequestedViewportRevision: input.viewportRevision },
  };
}

/** An unloaded history region is intentionally silent and visually inert. */
export function LocalConversationHistoryGap({
  row,
}: {
  readonly row: LocalConversationHistoryGapRow;
}) {
  return (
    <div
      aria-hidden="true"
      data-virtualized-turn-content
      style={{ height: row.estimatedHeightPx }}
    />
  );
}
