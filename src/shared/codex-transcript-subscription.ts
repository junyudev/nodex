import type {
  CodexTranscriptChange,
  CodexTranscriptEvent,
  CodexTranscriptSnapshot,
  CodexTranscriptUpdate,
} from "./codex-transcript-projection";

export const CODEX_TRANSCRIPT_RESET_PART_ENTRIES = 256;
export const CODEX_TRANSCRIPT_PENDING_CODE_UNITS = 262_144;

/** Parts are counted across all three maps; even one large item remains one entry. */
export function* chunkCodexTranscriptReset(
  value: CodexTranscriptSnapshot,
): Generator<CodexTranscriptEvent> {
  let part = newResetPart();
  let count = 0;
  let started = false;
  for (const map of ["itemsByKey", "turnsByKey", "realtimeItems"] as const) {
    for (const key of Object.keys(value[map])) {
      if (map === "itemsByKey") part.itemsByKey[key] = value.itemsByKey[key]!;
      else if (map === "turnsByKey") part.turnsByKey[key] = value.turnsByKey[key]!;
      else part.realtimeItems[key] = value.realtimeItems[key]!;
      count += 1;
      if (count < CODEX_TRANSCRIPT_RESET_PART_ENTRIES) continue;
      if (!started) {
        started = true;
        yield {
          type: "reset-start",
          value: {
            resumeState: value.resumeState,
            historyComplete: value.historyComplete,
            itemTimeline: value.itemTimeline,
            timeline: value.timeline,
            turnEntityKeys: value.turnEntityKeys,
          },
        };
      }
      yield part;
      part = newResetPart();
      count = 0;
    }
  }
  if (!started) {
    yield { type: "reset", value };
    return;
  }
  if (count > 0) yield part;
  yield { type: "reset-commit" };
}

function newResetPart() {
  return {
    type: "reset-part" as const,
    itemsByKey: {} as Record<string, CodexTranscriptSnapshot["itemsByKey"][string]>,
    turnsByKey: {} as Record<string, CodexTranscriptSnapshot["turnsByKey"][string]>,
    realtimeItems: {} as Record<string, CodexTranscriptSnapshot["realtimeItems"][string]>,
  };
}

export type CodexTranscriptListenerCompletion = void | (PromiseLike<void> & Partial<Disposable>);

export interface CodexTranscriptSubscriptionOptions {
  readonly getSnapshot: () => CodexTranscriptSnapshot | null;
  /** The source registers before emitting its initial reset, closing the subscribe/read race. */
  readonly subscribe: (listener: (update: CodexTranscriptUpdate) => void) => () => void;
  readonly listener: (event: CodexTranscriptEvent) => CodexTranscriptListenerCompletion;
  readonly onDispose?: () => void;
}
export interface CodexTranscriptSubscription extends Disposable {
  readonly completion: Promise<void>;
  dispose(): void;
}

/** A serial async listener is the admission boundary for a normalized read subscription. */
export function createCodexTranscriptSubscription(
  options: CodexTranscriptSubscriptionOptions,
): CodexTranscriptSubscription {
  let alive = true;
  let draining = false;
  let needsReset = false;
  let pendingCodeUnits = 0;
  let currentCompletion: CodexTranscriptListenerCompletion;
  let unsubscribe: (() => void) | undefined;
  const pending: CodexTranscriptUpdate[] = [];
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });

  function clearPending(): void {
    pending.length = 0;
    pendingCodeUnits = 0;
  }

  function dispose(): void {
    if (!alive) return;
    alive = false;
    clearPending();
    const release = unsubscribe;
    unsubscribe = undefined;
    try {
      release?.();
    } finally {
      try {
        currentCompletion?.[Symbol.dispose]?.();
      } finally {
        currentCompletion = undefined;
        try {
          options.onDispose?.();
        } finally {
          finish();
        }
      }
    }
  }

  async function drain(initial: CodexTranscriptUpdate): Promise<void> {
    draining = true;
    let update: CodexTranscriptUpdate | undefined = initial;
    try {
      while (update) {
        if (!alive) break;
        try {
          const events =
            update.type === "reset" && update.value
              ? chunkCodexTranscriptReset(update.value)
              : [update];
          for (const event of events) {
            const callback = options.listener(event);
            currentCompletion = callback;
            try {
              await callback;
            } finally {
              if (currentCompletion === callback) {
                currentCompletion = undefined;
                callback?.[Symbol.dispose]?.();
              }
            }
            if (!alive) break;
          }
        } catch (error) {
          if (!alive || update.type === "reset") throw error;
          clearPending();
          needsReset = true;
        }
        if (!alive) break;
        if (needsReset) {
          needsReset = false;
          update = { type: "reset", value: options.getSnapshot() };
        } else {
          update = pending.shift();
          if (pending.length === 0) pendingCodeUnits = 0;
        }
      }
    } catch {
      dispose();
    } finally {
      draining = false;
    }
  }

  function receive(update: CodexTranscriptUpdate): void {
    if (!alive || needsReset) return;
    if (!draining) {
      void drain(update);
      return;
    }
    const codeUnits = update.type === "reset" ? 0 : JSON.stringify(update).length;
    if (
      update.type === "reset" ||
      pendingCodeUnits + codeUnits > CODEX_TRANSCRIPT_PENDING_CODE_UNITS
    ) {
      clearPending();
      needsReset = true;
      return;
    }
    const previous = pending.at(-1);
    if (previous?.type === "changes" && update.type === "changes") {
      (previous.changes as CodexTranscriptChange[]).push(...update.changes);
    } else {
      pending.push(
        update.type === "changes" ? { type: "changes", changes: [...update.changes] } : update,
      );
    }
    pendingCodeUnits += codeUnits;
  }

  try {
    const release = options.subscribe(receive);
    // A synchronous source may dispose the subscription before registration returns.
    if (alive) unsubscribe = release;
    else release();
  } catch (error) {
    dispose();
    throw error;
  }
  return { completion, dispose, [Symbol.dispose]: dispose };
}
