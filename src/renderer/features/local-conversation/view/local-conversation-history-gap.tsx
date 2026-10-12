import { ActivitySpinnerIcon } from "@/components/shared/icons";
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

export interface HistoryViewport {
  readonly viewportStartPx: number;
  readonly viewportEndPx: number;
  readonly gaps: readonly LocalConversationHistoryGapLayout[];
}

type HistoryBoundaryLoader = (boundary: CodexHistoryBoundaryRef) => Promise<unknown>;

export interface LocalConversationHistoryGapRequestCoordinator {
  readonly allowNextFetch: () => void;
  readonly retryBoundary: (boundary: CodexHistoryBoundaryRef) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly readState: () => LocalConversationHistoryGapRequestState;
  readonly observeViewport: (
    input: HistoryViewport | null,
    request?: HistoryBoundaryLoader,
  ) => Promise<void>;
}

/** Failed or stale cursors stay stopped until the owning boundary changes or the view reopens. */
export function createLocalConversationHistoryRequestGate() {
  const active = new Set<string>();
  const stopped = new Set<string>();
  return {
    unavailableKeys: () => new Set([...active, ...stopped]),
    retain: (keys: ReadonlySet<string>) => {
      for (const key of stopped) if (!keys.has(key)) stopped.delete(key);
    },
    request: (key: string, load: () => Promise<unknown>) => {
      if (active.has(key) || stopped.has(key)) return false;
      active.add(key);
      const fail = () => {
        active.delete(key);
        stopped.add(key);
      };
      try {
        void load().then((result) => {
          active.delete(key);
          if (result === "stale" || result === "stop") stopped.add(key);
        }, fail);
      } catch {
        fail();
      }
      return true;
    },
  };
}

export interface LocalConversationHistoryGapRequestState {
  readonly failed: readonly CodexHistoryBoundaryRef[];
  readonly loading: CodexHistoryBoundaryRef | null;
}

/** Serializes automatic loads and explicit retries against the current gap topology. */
export function createLocalConversationHistoryGapRequestCoordinator({
  requireUserScroll = false,
}: { readonly requireUserScroll?: boolean } = {}): LocalConversationHistoryGapRequestCoordinator {
  let viewport: HistoryViewport | null = null;
  let request: HistoryBoundaryLoader | undefined;
  let version = 0;
  let epoch = 0;
  let allowed = !requireUserScroll;
  let pending: Promise<void> | null = null;
  let state: LocalConversationHistoryGapRequestState = { failed: [], loading: null };
  const retries: CodexHistoryBoundaryRef[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: LocalConversationHistoryGapRequestState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const isCurrent = (boundary: CodexHistoryBoundaryRef): boolean =>
    viewport?.gaps.some(
      ({ row }) =>
        sameHistoryBoundary(boundary, row.olderBoundary) ||
        sameHistoryBoundary(boundary, row.newerBoundary),
    ) === true;
  const run = async () => {
    let applied: CodexHistoryBoundaryRef | null = null;
    while (true) {
      if (viewport === null || !request) return;
      const observedVersion = version;
      const observedEpoch = epoch;
      let boundary: CodexHistoryBoundaryRef | undefined;
      while (retries.length > 0 && !boundary) {
        const candidate = retries.shift()!;
        if (isCurrent(candidate)) boundary = candidate;
      }
      if (!boundary) {
        if (!allowed) return;
        boundary =
          selectLocalConversationHistoryGapBoundary({
            ...viewport,
            gaps: viewport.gaps.map((gap) => ({
              ...gap,
              row: {
                ...gap.row,
                olderBoundary: state.failed.some((failed) =>
                  sameHistoryBoundary(failed, gap.row.olderBoundary),
                )
                  ? null
                  : gap.row.olderBoundary,
                newerBoundary: state.failed.some((failed) =>
                  sameHistoryBoundary(failed, gap.row.newerBoundary),
                )
                  ? null
                  : gap.row.newerBoundary,
              },
            })),
          }) ?? undefined;
        if (!boundary || sameHistoryBoundary(boundary, applied)) return;
        allowed = !requireUserScroll;
      }
      publish({ ...state, loading: boundary });
      try {
        if ((await request(boundary)) === "applied") applied = boundary;
      } catch {
        if (
          observedEpoch === epoch &&
          isCurrent(boundary) &&
          !state.failed.some((failed) => sameHistoryBoundary(boundary!, failed))
        )
          publish({ ...state, failed: [...state.failed, boundary] });
      } finally {
        if (observedEpoch === epoch) publish({ ...state, loading: null });
      }
      if (observedVersion === version && retries.length === 0) return;
    }
  };
  const schedule = () => {
    pending ??= Promise.resolve()
      .then(run)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return {
    allowNextFetch: () => {
      allowed = true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readState: () => state,
    retryBoundary: (boundary) => {
      if (!isCurrent(boundary)) return Promise.resolve();
      publish({
        ...state,
        failed: state.failed.filter((failed) => !sameHistoryBoundary(boundary, failed)),
      });
      retries.push(boundary);
      version += 1;
      return schedule();
    },
    observeViewport: (input, load) => {
      viewport = input;
      if (load) request = load;
      version += 1;
      if (!input) {
        epoch += 1;
        retries.length = 0;
        if (state.failed.length > 0 || state.loading !== null)
          publish({ failed: [], loading: null });
      } else {
        const failed = state.failed.filter(isCurrent);
        if (failed.length !== state.failed.length) publish({ ...state, failed });
      }
      return schedule();
    },
  };
}

export function sameHistoryBoundary(
  left: CodexHistoryBoundaryRef | null,
  right: CodexHistoryBoundaryRef | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.generation === right.generation &&
    left.islandId === right.islandId &&
    left.edge === right.edge &&
    left.boundaryId === right.boundaryId &&
    left.progressKey === right.progressKey
  );
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

/** Selects the closest edge of a nearby gap; equal distances preserve gap and edge order. */
export function selectLocalConversationHistoryGapBoundary(
  input: HistoryViewport,
): CodexHistoryBoundaryRef | null {
  if (!isFiniteRange(input.viewportStartPx, input.viewportEndPx)) return null;
  const center = (input.viewportStartPx + input.viewportEndPx) / 2;
  let selected: CodexHistoryBoundaryRef | null = null;
  let distance = Infinity;
  for (const gap of input.gaps) {
    if (!isFiniteRange(gap.startPx, gap.endPx)) continue;
    if (
      distanceFromViewportPx(gap.startPx, gap.endPx, input.viewportStartPx, input.viewportEndPx) >
      CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX
    )
      continue;
    for (const [boundary, position] of [
      [gap.row.olderBoundary, gap.startPx],
      [gap.row.newerBoundary, gap.endPx],
    ] as const) {
      const nextDistance = Math.abs(position - center);
      if (!boundary || nextDistance >= distance) continue;
      selected = boundary;
      distance = nextDistance;
    }
  }
  return selected;
}

/** Failures belong to their gap, so retry does not replace the rest of the transcript. */
export function LocalConversationHistoryGap({
  row,
  state,
  onRetry,
}: {
  readonly row: LocalConversationHistoryGapRow;
  readonly state?: LocalConversationHistoryGapRequestState;
  readonly onRetry?: (boundary: CodexHistoryBoundaryRef) => void;
}) {
  const failure = state?.failed.find(
    (boundary) =>
      sameHistoryBoundary(boundary, row.olderBoundary) ||
      sameHistoryBoundary(boundary, row.newerBoundary),
  );
  const loading =
    state?.loading &&
    (sameHistoryBoundary(state.loading, row.olderBoundary) ||
      sameHistoryBoundary(state.loading, row.newerBoundary));
  return (
    <div
      aria-hidden={!failure && !loading ? true : undefined}
      data-virtualized-turn-content
      style={{ height: row.estimatedHeightPx }}
      className="flex items-center justify-center"
    >
      {failure ? (
        <button
          type="button"
          onClick={() => onRetry?.(failure)}
          className="text-size-chat-sm text-token-text-secondary hover:text-token-foreground"
        >
          Try again
        </button>
      ) : loading ? (
        <span role="status" className="text-token-text-secondary">
          <ActivitySpinnerIcon className="icon-xs" />
          <span className="sr-only">Loading history</span>
        </span>
      ) : null}
    </div>
  );
}
