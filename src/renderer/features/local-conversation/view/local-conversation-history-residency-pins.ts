import {
  CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS,
  type CodexHistoryResidencyPinsInput,
  type CodexHistoryResidencyPinsResult,
} from "../../../../shared/codex-history-residency-pins";

export const LOCAL_CONVERSATION_HISTORY_RESIDENCY_PIN_DEBOUNCE_MS = 120;

export interface LocalConversationHistoryResidencyRowGeometry {
  readonly turnId: string | null;
  readonly startPx: number;
  readonly endPx: number;
}

/** Selects only content intersecting the viewport and caps pathological tiny-row layouts. */
export function resolveVisibleHistoryTurnIds(input: {
  readonly rows: readonly LocalConversationHistoryResidencyRowGeometry[];
  readonly viewportStartPx: number;
  readonly viewportEndPx: number;
  readonly maximum?: number;
}): readonly string[] {
  const viewportStartPx = Math.max(0, input.viewportStartPx);
  const viewportEndPx = Math.max(viewportStartPx, input.viewportEndPx);
  if (viewportEndPx <= viewportStartPx) return [];
  const maximum = Math.max(
    0,
    Math.min(
      CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS,
      Math.floor(input.maximum ?? CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS),
    ),
  );
  if (maximum === 0) return [];

  const viewportCenterPx = (viewportStartPx + viewportEndPx) / 2;
  const candidates = input.rows.flatMap((row, index) => {
    if (!row.turnId || row.endPx <= viewportStartPx || row.startPx >= viewportEndPx) return [];
    return [
      {
        turnId: row.turnId,
        index,
        distanceFromCenterPx: Math.abs((row.startPx + row.endPx) / 2 - viewportCenterPx),
      },
    ];
  });
  const nearest = candidates
    .toSorted(
      (left, right) =>
        left.distanceFromCenterPx - right.distanceFromCenterPx || left.index - right.index,
    )
    .slice(0, maximum)
    .toSorted((left, right) => left.index - right.index);
  return [...new Set(nearest.map((candidate) => candidate.turnId))];
}

interface ActivePinTarget {
  readonly threadId: string;
  readonly conversationGeneration: number;
  readonly generation: number;
  readonly historyMutationRevision: number;
  pendingFingerprint: string | null;
  deliveredFingerprint: string | null;
  queuedFingerprint: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface LocalConversationHistoryResidencyPinPublisher {
  readonly setTarget: (input: {
    readonly threadId: string;
    readonly conversationGeneration: number;
    readonly generation: number;
    readonly historyMutationRevision: number;
  }) => void;
  readonly observe: (input: {
    readonly threadId: string;
    readonly conversationGeneration: number;
    readonly generation: number;
    readonly historyMutationRevision: number;
    readonly turnIds: readonly string[];
  }) => void;
  readonly flush: () => void;
  readonly clear: () => void;
  readonly dispose: () => void;
  readonly settle: () => Promise<void>;
}

function boundedTurnIds(turnIds: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of turnIds) {
    const turnId = value.trim();
    if (!turnId) continue;
    normalized.add(turnId);
    if (normalized.size >= CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS) break;
  }
  return [...normalized];
}

function targetIdentity(
  target: Pick<
    ActivePinTarget,
    "threadId" | "conversationGeneration" | "generation" | "historyMutationRevision"
  >,
): string {
  return JSON.stringify([
    target.threadId,
    target.conversationGeneration,
    target.generation,
    target.historyMutationRevision,
  ]);
}

/**
 * Coalesces scroll-frequency viewport observations into one bounded IPC write. Delivery remains
 * ordered so a target cleanup cannot be overtaken by an already queued non-empty update.
 */
export function createLocalConversationHistoryResidencyPinPublisher(input: {
  readonly publish: (
    pins: CodexHistoryResidencyPinsInput,
  ) => Promise<CodexHistoryResidencyPinsResult>;
  readonly debounceMs?: number;
}): LocalConversationHistoryResidencyPinPublisher {
  const debounceMs = Math.max(
    0,
    Math.floor(input.debounceMs ?? LOCAL_CONVERSATION_HISTORY_RESIDENCY_PIN_DEBOUNCE_MS),
  );
  let active: ActivePinTarget | null = null;
  let delivery = Promise.resolve();
  let inFlightIdentity: string | null = null;
  const queued: Array<{
    readonly target: ActivePinTarget;
    readonly turnIds: readonly string[];
    readonly fingerprint: string;
  }> = [];
  let disposed = false;

  const pump = () => {
    if (inFlightIdentity !== null) return;
    const next = queued.shift();
    if (!next) return;
    const identity = targetIdentity(next.target);
    inFlightIdentity = identity;
    delivery = input
      .publish({
        threadId: next.target.threadId,
        expectedConversationGeneration: next.target.conversationGeneration,
        expectedTopologyGeneration: next.target.generation,
        expectedHistoryMutationRevision: next.target.historyMutationRevision,
        turnIds: next.turnIds,
        islandIds: [],
      })
      .then(() => {
        next.target.deliveredFingerprint = next.fingerprint;
      })
      .catch(() => undefined)
      .finally(() => {
        if (next.target.queuedFingerprint === next.fingerprint) {
          next.target.queuedFingerprint = null;
        }
        inFlightIdentity = null;
        pump();
      });
  };

  const enqueue = (target: ActivePinTarget, turnIds: readonly string[], fingerprint: string) => {
    const identity = targetIdentity(target);
    const queuedIndex = queued.findIndex(
      (candidate) => targetIdentity(candidate.target) === identity,
    );
    const next = { target, turnIds, fingerprint };
    if (queuedIndex >= 0) queued[queuedIndex] = next;
    else queued.push(next);
    target.queuedFingerprint = fingerprint;
    pump();
  };

  const clearTimer = (target: ActivePinTarget) => {
    if (target.timer === null) return;
    clearTimeout(target.timer);
    target.timer = null;
  };

  const flush = () => {
    const target = active;
    if (!target || target.pendingFingerprint === null) return;
    clearTimer(target);
    const fingerprint = target.pendingFingerprint;
    target.pendingFingerprint = null;
    const turnIds = JSON.parse(fingerprint) as readonly string[];
    enqueue(target, turnIds, fingerprint);
  };

  const cleanup = (target: ActivePinTarget) => {
    clearTimer(target);
    target.pendingFingerprint = null;
    const emptyFingerprint = "[]";
    if (
      target.deliveredFingerprint === emptyFingerprint ||
      target.queuedFingerprint === emptyFingerprint
    ) {
      return;
    }
    const identity = targetIdentity(target);
    if (target.deliveredFingerprint === null && inFlightIdentity !== identity) {
      // This target was superseded before its coalesced observation reached IPC. Dropping that
      // unsent observation requires no cleanup and keeps the publisher at active + latest-only.
      const queuedIndex = queued.findIndex(
        (candidate) => targetIdentity(candidate.target) === identity,
      );
      if (queuedIndex >= 0) queued.splice(queuedIndex, 1);
      target.queuedFingerprint = null;
      return;
    }
    enqueue(target, [], emptyFingerprint);
  };

  const activate = (
    threadId: string,
    conversationGeneration: number,
    generation: number,
    historyMutationRevision: number,
  ): ActivePinTarget | null => {
    if (
      disposed ||
      !threadId ||
      !Number.isSafeInteger(conversationGeneration) ||
      conversationGeneration < 1 ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(historyMutationRevision) ||
      historyMutationRevision < 0
    ) {
      return null;
    }
    const identity = JSON.stringify([
      threadId,
      conversationGeneration,
      generation,
      historyMutationRevision,
    ]);
    if (active && targetIdentity(active) === identity) return active;
    if (active) cleanup(active);
    active = {
      threadId,
      conversationGeneration,
      generation,
      historyMutationRevision,
      pendingFingerprint: null,
      deliveredFingerprint: null,
      queuedFingerprint: null,
      timer: null,
    };
    return active;
  };

  const settle = async (): Promise<void> => {
    await delivery;
    if (inFlightIdentity === null && queued.length === 0) return;
    await settle();
  };

  return {
    setTarget: ({ threadId, conversationGeneration, generation, historyMutationRevision }) => {
      activate(threadId.trim(), conversationGeneration, generation, historyMutationRevision);
    },
    observe: ({
      threadId: rawThreadId,
      conversationGeneration,
      generation,
      historyMutationRevision,
      turnIds: rawTurnIds,
    }) => {
      const threadId = rawThreadId.trim();
      const target = activate(
        threadId,
        conversationGeneration,
        generation,
        historyMutationRevision,
      );
      if (!target) return;

      const fingerprint = JSON.stringify(boundedTurnIds(rawTurnIds));
      if (target.pendingFingerprint === fingerprint || target.queuedFingerprint === fingerprint)
        return;
      if (target.deliveredFingerprint === fingerprint && target.queuedFingerprint === null) {
        clearTimer(target);
        target.pendingFingerprint = null;
        return;
      }
      clearTimer(target);
      target.pendingFingerprint = fingerprint;
      target.timer = setTimeout(flush, debounceMs);
    },
    flush,
    clear: () => {
      if (!active) return;
      cleanup(active);
      active = null;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (active) {
        cleanup(active);
        active = null;
      }
    },
    settle,
  };
}
