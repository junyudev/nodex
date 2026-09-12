export const CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS = 50;
export const CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS = 20_000;
export const CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX = "[output truncated]\n";

export function stripCodexCommandOutputTruncationPrefix(value: string | null | undefined): {
  readonly text: string;
  readonly hadPrefix: boolean;
} {
  if (!value?.startsWith(CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX)) {
    return { text: value ?? "", hadPrefix: false };
  }

  return {
    text: value.slice(CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX.length),
    hadPrefix: true,
  };
}

export interface CodexCommandOutputTailInput {
  readonly current: string;
  readonly delta: string;
  readonly maxChars?: number;
}

export interface CodexCommandOutputTailResult {
  readonly next: string;
  readonly didTruncate: boolean;
  readonly retainedLength: number;
  readonly appended: string;
}

/** Exact bounded-tail transition used by command-output buffering and raw mutation. */
export function appendCodexCommandOutputTail({
  current,
  delta,
  maxChars = CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS,
}: CodexCommandOutputTailInput): CodexCommandOutputTailResult {
  if (maxChars <= 0) {
    return {
      next: "",
      didTruncate: current.length > 0 || delta.length > 0,
      retainedLength: 0,
      appended: "",
    };
  }

  if (delta.length === 0) {
    return {
      next: current,
      didTruncate: current.length > maxChars,
      retainedLength: current.length,
      appended: "",
    };
  }

  if (delta.length >= maxChars) {
    return {
      next: delta.slice(-maxChars),
      didTruncate: true,
      retainedLength: 0,
      appended: delta.slice(-maxChars),
    };
  }

  if (current.length + delta.length <= maxChars) {
    return {
      next: `${current}${delta}`,
      didTruncate: false,
      retainedLength: current.length,
      appended: delta,
    };
  }

  const retainedCurrentChars = maxChars - delta.length;
  return {
    next: `${retainedCurrentChars > 0 ? current.slice(-retainedCurrentChars) : ""}${delta}`,
    didTruncate: true,
    retainedLength: retainedCurrentChars > 0 ? current.slice(-retainedCurrentChars).length : 0,
    appended: delta,
  };
}

export interface CodexCommandOutputUpdate {
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly itemId: string;
  readonly delta: string;
}

export interface CodexCommandOutputScheduler {
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
}

export interface CodexCommandOutputQueueOptions<TUpdate extends CodexCommandOutputUpdate> {
  readonly onFlush: (updates: readonly TUpdate[]) => void;
  readonly scheduler?: CodexCommandOutputScheduler;
  readonly flushIntervalMs?: number;
  readonly maxBufferedChars?: number;
  /** Transport metadata only; the canonical queue otherwise retains newest metadata. */
  readonly mergeUpdate?: (
    existing: TUpdate | undefined,
    incoming: TUpdate,
    mergedDelta: string,
  ) => TUpdate;
}

export function buildCodexCommandOutputKey(update: CodexCommandOutputUpdate): string {
  return `${update.conversationId}:${update.turnId ?? "null"}:${update.itemId}`;
}

export function createCodexCommandOutputScheduler(): CodexCommandOutputScheduler {
  return {
    scheduleTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

/** Exact manager-global command-output queue; it is independent of completion drains. */
export class CodexCommandOutputQueue<
  TUpdate extends CodexCommandOutputUpdate = CodexCommandOutputUpdate,
> {
  private readonly buffers = new Map<string, TUpdate>();
  private readonly onFlush: CodexCommandOutputQueueOptions<TUpdate>["onFlush"];
  private readonly scheduler: CodexCommandOutputScheduler;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedChars: number;
  private readonly mergeUpdate: NonNullable<CodexCommandOutputQueueOptions<TUpdate>["mergeUpdate"]>;
  private cancelScheduledFlush: (() => void) | null = null;

  constructor(options: CodexCommandOutputQueueOptions<TUpdate>) {
    this.onFlush = options.onFlush;
    this.scheduler = options.scheduler ?? createCodexCommandOutputScheduler();
    this.flushIntervalMs = options.flushIntervalMs ?? CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS;
    this.maxBufferedChars = options.maxBufferedChars ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS;
    this.mergeUpdate =
      options.mergeUpdate ??
      ((_, incoming, mergedDelta) => ({
        ...incoming,
        delta: mergedDelta,
      }));
  }

  enqueue(update: TUpdate): void {
    const key = buildCodexCommandOutputKey(update);
    const existing = this.buffers.get(key);
    const { next } = appendCodexCommandOutputTail({
      current: existing?.delta ?? "",
      delta: update.delta,
      maxChars: this.maxBufferedChars,
    });
    this.buffers.set(key, this.mergeUpdate(existing, update, next));
    this.scheduleFlush();
  }

  /** A manual flush leaves the existing timer in place for later arrivals. */
  flushNow(): void {
    if (this.buffers.size === 0) return;

    const updates = [...this.buffers.values()];
    this.buffers.clear();
    this.onFlush(updates);
  }

  /** Transport-adapter teardown only; unrelated conversations keep their timer. */
  discardConversation(conversationId: string): void {
    let didDiscard = false;
    for (const [key, buffered] of this.buffers) {
      if (buffered.conversationId !== conversationId) continue;
      this.buffers.delete(key);
      didDiscard = true;
    }

    if (!didDiscard || this.buffers.size > 0) return;
    this.cancelPendingFlush();
  }

  /** Manager-destruction only. */
  dispose(): void {
    this.cancelPendingFlush();
    this.buffers.clear();
  }

  private scheduleFlush(): void {
    if (this.cancelScheduledFlush !== null) return;

    this.cancelScheduledFlush = this.scheduler.scheduleTimeout(() => {
      this.cancelScheduledFlush = null;
      this.flushNow();
    }, this.flushIntervalMs);
  }

  private cancelPendingFlush(): void {
    if (this.cancelScheduledFlush === null) return;
    this.cancelScheduledFlush();
    this.cancelScheduledFlush = null;
  }
}
