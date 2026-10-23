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

export interface LocalConversationHistoryRequestGateState {
  readonly failed: ReadonlySet<string>;
  readonly loading: ReadonlySet<string>;
}

/** A current failed item boundary retries explicitly; obsolete or exhausted cursors remain stopped. */
export function createLocalConversationHistoryRequestGate() {
  const active = new Set<string>();
  const stopped = new Set<string>();
  const failed = new Set<string>();
  const listeners = new Set<() => void>();
  let retained: ReadonlySet<string> | null = null;
  let lastViewportRevision: number | null = null;
  let state: LocalConversationHistoryRequestGateState = { failed: new Set(), loading: new Set() };
  const isCurrent = (key: string) => retained === null || retained.has(key);
  const publish = () => {
    const loading = new Set([...active].filter(isCurrent));
    if (
      loading.size === state.loading.size &&
      [...loading].every((key) => state.loading.has(key)) &&
      failed.size === state.failed.size &&
      [...failed].every((key) => state.failed.has(key))
    )
      return;
    state = { failed: new Set(failed), loading };
    for (const listener of listeners) listener();
  };
  const request = (key: string, load: () => Promise<unknown>, viewportRevision?: number) => {
    if (!isCurrent(key) || active.has(key) || stopped.has(key)) return false;
    if (
      viewportRevision !== undefined &&
      lastViewportRevision !== null &&
      viewportRevision <= lastViewportRevision
    )
      return false;
    if (viewportRevision !== undefined) lastViewportRevision = viewportRevision;
    active.add(key);
    publish();
    const fail = () => {
      active.delete(key);
      if (isCurrent(key)) {
        stopped.add(key);
        failed.add(key);
      }
      publish();
    };
    try {
      void load().then((result) => {
        active.delete(key);
        if (result === "stale" || result === "stop") stopped.add(key);
        publish();
      }, fail);
    } catch {
      fail();
    }
    return true;
  };
  return {
    unavailableKeys: () => new Set([...active, ...stopped]),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readState: () => state,
    retain: (keys: ReadonlySet<string>) => {
      retained = new Set(keys);
      for (const key of stopped) if (!keys.has(key)) stopped.delete(key);
      for (const key of failed) if (!keys.has(key)) failed.delete(key);
      publish();
    },
    request,
    retry: (key: string, load: () => Promise<unknown>) => {
      if (!isCurrent(key) || !failed.has(key)) return false;
      failed.delete(key);
      stopped.delete(key);
      return request(key, load);
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
      data-history-gap-key={row.key}
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
