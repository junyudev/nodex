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

/** Serializes loads against the latest viewport without permanently suppressing failed pages. */
export function createLocalConversationHistoryGapRequestCoordinator({
  requireUserScroll = false,
}: { readonly requireUserScroll?: boolean } = {}): LocalConversationHistoryGapRequestCoordinator {
  let viewport: HistoryViewport | null = null;
  let request: HistoryBoundaryLoader | undefined;
  let version = 0;
  let allowed = !requireUserScroll;
  let pending: Promise<void> | null = null;
  const run = async () => {
    let applied: CodexHistoryBoundaryRef | null = null;
    while (true) {
      if (viewport === null || !allowed || !request) return;
      const observedVersion = version;
      const boundary = selectLocalConversationHistoryGapBoundary(viewport);
      if (!boundary || sameHistoryBoundary(boundary, applied)) return;
      allowed = !requireUserScroll;
      try {
        if ((await request(boundary)) === "applied") applied = boundary;
      } catch {
        // A later viewport observation can retry a transient page failure.
      }
      if (observedVersion === version) return;
    }
  };
  return {
    allowNextFetch: () => {
      allowed = true;
    },
    observeViewport: (input, load) => {
      viewport = input;
      if (load) request = load;
      version += 1;
      pending ??= Promise.resolve()
        .then(run)
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}

function sameHistoryBoundary(
  left: CodexHistoryBoundaryRef,
  right: CodexHistoryBoundaryRef | null,
): boolean {
  return (
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
