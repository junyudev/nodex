export interface AdaptiveMarkdownInput {
  readonly source: string;
  readonly streamId: string;
  readonly active: boolean;
  readonly arrivalIntervalFloorSeconds?: number;
}

export interface AdaptiveMarkdownSnapshot {
  readonly source: string;
  readonly streamId: string;
  readonly text: string;
  readonly isComplete: boolean;
}

export interface AdaptiveMarkdownScheduler {
  readonly nowSeconds: () => number;
  readonly timeout: (callback: () => void, delayMs: number) => () => void;
  readonly frame: (callback: () => void) => () => void;
}

/** Owns presentation length only. History, search and full-message copy retain the source. */
export function createAdaptiveMarkdownBuffer(
  initial: AdaptiveMarkdownInput,
  scheduler: AdaptiveMarkdownScheduler,
) {
  let source = initial.source;
  let streamId = initial.streamId;
  let active = initial.active;
  let floorSeconds = initial.arrivalIntervalFloorSeconds ?? 10;
  let length = source.length;
  let targetLength = length;
  let rate = 1;
  let lastArrival: number | null = null;
  let lastDrain: number | null = null;
  let carry = 0;
  let epoch = 0;
  let cancelFrame: (() => void) | null = null;
  let cancelTimeout: (() => void) | null = null;
  const listeners = new Set<() => void>();
  let snapshot: AdaptiveMarkdownSnapshot = {
    source,
    streamId,
    text: source,
    isComplete: !active,
  };

  const isComplete = () => !active && length === source.length;
  const shouldUpdate = () => length < source.length || snapshot.isComplete !== isComplete();
  const publish = () => {
    const text = source.slice(0, length);
    const complete = isComplete();
    if (
      text === snapshot.text &&
      source === snapshot.source &&
      streamId === snapshot.streamId &&
      complete === snapshot.isComplete
    )
      return;
    snapshot = { source, streamId, text, isComplete: complete };
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    epoch++;
    cancelFrame?.();
    cancelTimeout?.();
    cancelFrame = null;
    cancelTimeout = null;
  };
  const drain = () => {
    const now = scheduler.nowSeconds();
    const arrived = source.length - targetLength;
    targetLength = source.length;
    if (arrived > 0) {
      rate =
        lastArrival === null
          ? arrived
          : Math.max(1, 0.1 * (arrived / Math.max(now - lastArrival, floorSeconds)) + 0.9 * rate);
      lastArrival = now;
    }
    const elapsed = lastDrain === null ? 0 : now - lastDrain;
    lastDrain = now;
    const backlog = source.length - length;
    for (let index = 0; index < (elapsed + carry) / 0.05; index++) {
      if (backlog > 0 && backlog < rate * 1.5) rate = (backlog + rate * 1.5) / 2;
      if (backlog > rate / 1.2) rate = (backlog + rate / 1.2) / 2;
    }
    rate = Math.max(1, rate);
    const progress = elapsed * rate + carry;
    const wholeCharacters = Math.floor(progress);
    carry = progress - wholeCharacters;
    if (wholeCharacters >= 1) length = Math.min(length + wholeCharacters, source.length);
    if (length === source.length) {
      lastDrain = null;
      carry = 0;
    }
    const scheduledEpoch = epoch;
    if (!cancelFrame && (snapshot.text.length !== length || snapshot.isComplete !== isComplete())) {
      cancelFrame = scheduler.frame(() => {
        if (scheduledEpoch !== epoch) return;
        cancelFrame = null;
        publish();
      });
    }
    if (cancelTimeout) return;
    cancelTimeout = scheduler.timeout(() => {
      if (scheduledEpoch !== epoch) return;
      cancelTimeout = null;
      if (shouldUpdate()) drain();
    }, 50);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(input: AdaptiveMarkdownInput) {
      const reset =
        input.streamId !== streamId ||
        !input.source.startsWith(source) ||
        (!active && input.active);
      source = input.source;
      streamId = input.streamId;
      active = input.active;
      floorSeconds = input.arrivalIntervalFloorSeconds ?? 10;
      if (reset) {
        cancel();
        length = source.length;
        rate = 1;
        lastArrival = null;
        lastDrain = null;
        carry = 0;
        targetLength = source.length;
        publish();
        return;
      }
      if (active) {
        if (shouldUpdate()) drain();
        return;
      }
      cancel();
      length = source.length;
      publish();
    },
    // Cancellation is restartable so layout-effect replay can reuse the same mounted owner.
    cancel,
  };
}
