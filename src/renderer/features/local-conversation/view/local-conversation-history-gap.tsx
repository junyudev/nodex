import {
  CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
  type CodexHistoryBoundaryRef,
  type CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import type { CodexConversationTurnPagination } from "../../../lib/types";

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

export interface LocalConversationHistoryGapRequestCoordinator {
  readonly activeProgressKeys: () => ReadonlySet<string>;
  readonly observeViewport: (
    input: Omit<SelectLocalConversationHistoryGapBoundaryInput, "activeProgressKeys">,
    request: (boundary: CodexHistoryBoundaryRef) => Promise<unknown>,
  ) => CodexHistoryBoundaryRef | null;
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

/**
 * Owns request lifetime around the pure selector. A failed request releases its
 * progress key, but the consumed viewport revision remains fenced: retry needs a
 * later user/viewport revision instead of recursively draining in place.
 */
export function createLocalConversationHistoryGapRequestCoordinator(): LocalConversationHistoryGapRequestCoordinator {
  let state = createLocalConversationHistoryGapLoadControllerState();
  const activeProgressKeys = new Set<string>();

  return {
    activeProgressKeys: () => new Set(activeProgressKeys),
    observeViewport: (input, request) => {
      const selection = selectLocalConversationHistoryGapBoundary(state, {
        ...input,
        activeProgressKeys,
      });
      state = selection.state;
      const boundary = selection.boundary;
      if (!boundary) return null;

      activeProgressKeys.add(boundary.progressKey);
      const release = () => {
        activeProgressKeys.delete(boundary.progressKey);
      };
      try {
        void request(boundary).then(
          () => {
            release();
          },
          () => {
            release();
          },
        );
      } catch {
        release();
      }
      return boundary;
    },
  };
}

/**
 * Temporary projection for the current single-tail pagination contract. It is
 * renderer-only: the opaque compatibility boundary is never sent to Main. Once
 * canonical sparse rows arrive in the snapshot, callers can pass them through
 * unchanged and remove this projection.
 */
export function projectLocalConversationLegacyHistoryRows(input: {
  readonly conversationId: string;
  readonly pagination: CodexConversationTurnPagination | null;
  readonly turnKeys: readonly string[];
}): readonly CodexHistoryRow[] {
  const contentRows: CodexHistoryRow[] = input.turnKeys.map((turnKey) => ({
    kind: "content",
    key: `history-content:${turnKey}`,
    turnKey,
    entityKey: turnKey,
  }));
  const pagination = input.pagination;
  if (!pagination || pagination.hasLoadedOldest) return contentRows;

  return [
    {
      kind: "gap",
      key: `history-gap:legacy-tail:${input.conversationId}:older`,
      olderBoundary: null,
      newerBoundary: null,
      estimatedHeightPx: CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
    },
    ...contentRows,
  ];
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
