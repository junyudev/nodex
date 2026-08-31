export const CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS = 50;
export const CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS = 20_000;
export const CODEX_COMMAND_OUTPUT_MAX_BUFFERED_KEYS = 1_024;
export const CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UPDATES = 16_384;
export const CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UTF8_BYTES = 4 * 1_024 * 1_024;
export const CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX = "[output truncated]\n";

const utf8Encoder = new TextEncoder();

function countUtf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

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
    };
  }

  if (delta.length === 0) {
    return {
      next: current,
      didTruncate: current.length > maxChars,
    };
  }

  if (delta.length >= maxChars) {
    return {
      next: delta.slice(-maxChars),
      didTruncate: true,
    };
  }

  if (current.length + delta.length <= maxChars) {
    return {
      next: `${current}${delta}`,
      didTruncate: false,
    };
  }

  const retainedCurrentChars = maxChars - delta.length;
  return {
    next: `${retainedCurrentChars > 0 ? current.slice(-retainedCurrentChars) : ""}${delta}`,
    didTruncate: true,
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
  readonly maxBufferedKeys?: number;
  readonly maxBufferedUpdates?: number;
  readonly maxBufferedUtf8Bytes?: number;
  /** Transport metadata only; the canonical queue otherwise retains newest metadata. */
  readonly mergeUpdate?: (
    existing: TUpdate | undefined,
    incoming: TUpdate,
    mergedDelta: string,
  ) => TUpdate;
}

export interface CodexCommandOutputEnqueueResult {
  /** A pressure boundary synchronously published the previous bounded batch. */
  readonly forcedFlush: boolean;
  /** An individually over-budget update was published without retaining it in the queue. */
  readonly deliveredInline: boolean;
}

interface BufferedCodexCommandOutput<TUpdate extends CodexCommandOutputUpdate> {
  readonly update: TUpdate;
  readonly updateCount: number;
  readonly utf8Bytes: number;
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
  private readonly buffers = new Map<string, BufferedCodexCommandOutput<TUpdate>>();
  private readonly onFlush: CodexCommandOutputQueueOptions<TUpdate>["onFlush"];
  private readonly scheduler: CodexCommandOutputScheduler;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedChars: number;
  private readonly maxBufferedKeys: number;
  private readonly maxBufferedUpdates: number;
  private readonly maxBufferedUtf8Bytes: number;
  private readonly mergeUpdate: NonNullable<CodexCommandOutputQueueOptions<TUpdate>["mergeUpdate"]>;
  private cancelScheduledFlush: (() => void) | null = null;
  private bufferedUpdateCount = 0;
  private bufferedUtf8Bytes = 0;

  constructor(options: CodexCommandOutputQueueOptions<TUpdate>) {
    this.onFlush = options.onFlush;
    this.scheduler = options.scheduler ?? createCodexCommandOutputScheduler();
    this.flushIntervalMs = options.flushIntervalMs ?? CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS;
    this.maxBufferedChars = options.maxBufferedChars ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS;
    this.maxBufferedKeys = Math.max(
      0,
      options.maxBufferedKeys ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_KEYS,
    );
    this.maxBufferedUpdates = Math.max(
      0,
      options.maxBufferedUpdates ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UPDATES,
    );
    this.maxBufferedUtf8Bytes = Math.max(
      0,
      options.maxBufferedUtf8Bytes ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UTF8_BYTES,
    );
    this.mergeUpdate =
      options.mergeUpdate ??
      ((_, incoming, mergedDelta) => ({
        ...incoming,
        delta: mergedDelta,
      }));
  }

  enqueue(update: TUpdate): CodexCommandOutputEnqueueResult {
    const key = buildCodexCommandOutputKey(update);
    let existing = this.buffers.get(key);
    let next = appendCodexCommandOutputTail({
      current: existing?.update.delta ?? "",
      delta: update.delta,
      maxChars: this.maxBufferedChars,
    }).next;
    let nextUtf8Bytes = countUtf8Bytes(next);
    const exceedsBudget = (): boolean =>
      this.buffers.size + (existing === undefined ? 1 : 0) > this.maxBufferedKeys ||
      this.bufferedUpdateCount + 1 > this.maxBufferedUpdates ||
      this.bufferedUtf8Bytes - (existing?.utf8Bytes ?? 0) + nextUtf8Bytes >
        this.maxBufferedUtf8Bytes;

    const forcedFlush = this.buffers.size > 0 && exceedsBudget();
    if (forcedFlush) {
      this.flushNow();
      existing = undefined;
      next = appendCodexCommandOutputTail({
        current: "",
        delta: update.delta,
        maxChars: this.maxBufferedChars,
      }).next;
      nextUtf8Bytes = countUtf8Bytes(next);
    }

    const merged = this.mergeUpdate(existing?.update, update, next);
    if (exceedsBudget()) {
      this.onFlush([merged]);
      return { forcedFlush, deliveredInline: true };
    }

    const updateCount = (existing?.updateCount ?? 0) + 1;
    this.buffers.set(key, {
      update: merged,
      updateCount,
      utf8Bytes: nextUtf8Bytes,
    });
    this.bufferedUpdateCount += 1;
    this.bufferedUtf8Bytes = this.bufferedUtf8Bytes - (existing?.utf8Bytes ?? 0) + nextUtf8Bytes;
    this.scheduleFlush();
    return { forcedFlush, deliveredInline: false };
  }

  /** A manual flush leaves the existing timer in place for later arrivals. */
  flushNow(): void {
    if (this.buffers.size === 0) return;

    const updates = [...this.buffers.values()].map(({ update }) => update);
    this.buffers.clear();
    this.bufferedUpdateCount = 0;
    this.bufferedUtf8Bytes = 0;
    this.onFlush(updates);
  }

  /** Transport-adapter teardown only; unrelated conversations keep their timer. */
  discardConversation(conversationId: string): void {
    let didDiscard = false;
    for (const [key, buffered] of this.buffers) {
      if (buffered.update.conversationId !== conversationId) continue;
      this.buffers.delete(key);
      this.bufferedUpdateCount -= buffered.updateCount;
      this.bufferedUtf8Bytes -= buffered.utf8Bytes;
      didDiscard = true;
    }

    if (!didDiscard || this.buffers.size > 0) return;
    this.cancelPendingFlush();
  }

  /** Manager-destruction only. */
  dispose(): void {
    this.cancelPendingFlush();
    this.buffers.clear();
    this.bufferedUpdateCount = 0;
    this.bufferedUtf8Bytes = 0;
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
