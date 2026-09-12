export const CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS = 16;
export const CODEX_FRAME_TEXT_DELTA_TARGET_CHARS_PER_FRAME = 24;
export const CODEX_FRAME_TEXT_DELTA_MAX_DRAIN_FRAMES = 8;

export type CodexFrameTextDeltaTarget =
  | { readonly type: "agentMessage" | "plan" }
  | { readonly type: "reasoningSummary"; readonly summaryIndex: number }
  | { readonly type: "reasoningContent"; readonly contentIndex: number };

export interface CodexFrameTextDeltaUpdate {
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly itemId: string;
  readonly target: CodexFrameTextDeltaTarget;
  readonly delta: string;
}

export interface CodexFrameTextDeltaScheduler {
  readonly canUseAnimationFrame: () => boolean;
  readonly scheduleAnimationFrame: (callback: () => void) => () => void;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
  readonly subscribeVisibilityChange?: (callback: () => void) => () => void;
}

export interface CodexFrameTextDeltaFlushContext {
  /** Lets the renderer synchronously commit the last provisional frame before completion. */
  readonly terminalDrainCommit: boolean;
}

export interface CodexFrameTextDeltaQueueOptions<TUpdate extends CodexFrameTextDeltaUpdate> {
  readonly onFlush: (updates: readonly TUpdate[], context: CodexFrameTextDeltaFlushContext) => void;
  readonly scheduler?: CodexFrameTextDeltaScheduler;
  readonly fallbackIntervalMs?: number;
  readonly targetCharsPerFrame?: number;
  readonly maxDrainFrames?: number;
}

interface CodexBrowserWindowLike {
  readonly requestAnimationFrame?: (callback: () => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

interface CodexDocumentLike {
  readonly visibilityState?: string;
  readonly addEventListener?: (type: string, callback: () => void) => void;
  readonly removeEventListener?: (type: string, callback: () => void) => void;
}

export function buildCodexFrameTextDeltaKey(update: CodexFrameTextDeltaUpdate): string {
  const targetKey = (() => {
    if (update.target.type === "reasoningSummary") {
      return `${update.target.type}:${update.target.summaryIndex}`;
    }
    if (update.target.type === "reasoningContent") {
      return `${update.target.type}:${update.target.contentIndex}`;
    }
    return update.target.type;
  })();
  return `${update.conversationId}:${update.turnId ?? "null"}:${update.itemId}:${targetKey}`;
}

function readBrowserWindow(): CodexBrowserWindowLike | null {
  const candidate = (globalThis as { window?: CodexBrowserWindowLike }).window;
  return candidate ?? null;
}

function readDocument(): CodexDocumentLike | null {
  const candidate = (globalThis as { document?: CodexDocumentLike }).document;
  return candidate ?? null;
}

export function createCodexFrameTextDeltaScheduler(): CodexFrameTextDeltaScheduler {
  return {
    canUseAnimationFrame: () => {
      const browserWindow = readBrowserWindow();
      if (typeof browserWindow?.requestAnimationFrame !== "function") {
        return false;
      }

      const documentLike = readDocument();
      return documentLike === null || documentLike.visibilityState === "visible";
    },
    scheduleAnimationFrame: (callback) => {
      const browserWindow = readBrowserWindow();
      if (typeof browserWindow?.requestAnimationFrame !== "function") {
        return () => {};
      }

      const handle = browserWindow.requestAnimationFrame(callback);
      return () => {
        readBrowserWindow()?.cancelAnimationFrame?.(handle);
      };
    },
    subscribeVisibilityChange: (callback) => {
      const documentLike = readDocument();
      documentLike?.addEventListener?.("visibilitychange", callback);
      return () => documentLike?.removeEventListener?.("visibilitychange", callback);
    },
    scheduleTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

/** Main-process fallback has no visual frame and therefore always uses the exact timeout path. */
export function createCodexFrameTextDeltaTimeoutScheduler(): CodexFrameTextDeltaScheduler {
  return {
    canUseAnimationFrame: () => false,
    scheduleAnimationFrame: () => () => {},
    scheduleTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

/** Manager-global prose/reasoning scheduler; command output has a separate lifecycle. */
export class CodexFrameTextDeltaQueue<
  TUpdate extends CodexFrameTextDeltaUpdate = CodexFrameTextDeltaUpdate,
> {
  private readonly buffers = new Map<string, TUpdate>();
  private readonly drainCallbacks: Array<{
    readonly callback: () => void;
    readonly scope?: string;
  }> = [];
  private readonly onFlush: CodexFrameTextDeltaQueueOptions<TUpdate>["onFlush"];
  private readonly scheduler: CodexFrameTextDeltaScheduler;
  private readonly fallbackIntervalMs: number;
  private readonly targetCharsPerFrame: number;
  private readonly maxDrainFrames: number;
  private stopWatchingVisibility: (() => void) | null = null;
  private cancelScheduledFlush: (() => void) | null = null;
  private drainFramesRemaining: number | null = null;
  private bufferedCodeUnits = 0;

  constructor(options: CodexFrameTextDeltaQueueOptions<TUpdate>) {
    this.onFlush = options.onFlush;
    this.scheduler = options.scheduler ?? createCodexFrameTextDeltaScheduler();
    this.fallbackIntervalMs =
      options.fallbackIntervalMs ?? CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS;
    this.targetCharsPerFrame =
      options.targetCharsPerFrame ?? CODEX_FRAME_TEXT_DELTA_TARGET_CHARS_PER_FRAME;
    this.maxDrainFrames = options.maxDrainFrames ?? CODEX_FRAME_TEXT_DELTA_MAX_DRAIN_FRAMES;
  }

  enqueue(update: TUpdate): void {
    const key = buildCodexFrameTextDeltaKey(update);
    const existing = this.buffers.get(key);
    this.buffers.set(key, {
      ...update,
      delta: `${existing?.delta ?? ""}${update.delta}`,
    });
    this.bufferedCodeUnits += update.delta.length;
    this.scheduleFlush();
  }

  flushNow(
    context: CodexFrameTextDeltaFlushContext = {
      terminalDrainCommit: this.drainCallbacks.length > 0,
    },
  ): void {
    this.cancelPendingFlush();
    if (this.buffers.size === 0) {
      this.finishDrainCallbacks();
      return;
    }

    const updates = [...this.buffers.values()];
    this.buffers.clear();
    this.bufferedCodeUnits = 0;
    this.onFlush(updates, context);
    this.finishDrainCallbacks();
  }

  drainBefore(callback: () => void, scope?: string): boolean {
    if (
      this.buffers.size === 0 ||
      !this.scheduler.canUseAnimationFrame() ||
      this.getBufferedDeltaLength() <= this.targetCharsPerFrame
    ) {
      this.flushNow({ terminalDrainCommit: true });
      return false;
    }

    this.drainCallbacks.push({ callback, scope });
    this.drainFramesRemaining ??= this.maxDrainFrames;
    this.scheduleFlush();
    return true;
  }

  /**
   * Transport-adapter teardown only. Normal reference scheduling remains global;
   * an owner that disappears must not force unrelated conversations to flush.
   */
  discardConversation(conversationId: string): void {
    for (const [key, update] of this.buffers) {
      if (update.conversationId !== conversationId) continue;
      this.buffers.delete(key);
      this.bufferedCodeUnits -= update.delta.length;
    }

    for (let index = this.drainCallbacks.length - 1; index >= 0; index -= 1) {
      if (this.drainCallbacks[index]?.scope !== conversationId) continue;
      this.drainCallbacks.splice(index, 1);
    }

    if (this.buffers.size > 0) {
      if (this.drainCallbacks.length === 0) {
        this.drainFramesRemaining = null;
      }
      return;
    }

    this.cancelPendingFlush();
    this.finishDrainCallbacks();
  }

  /** Manager-destruction only. Pending completion callbacks intentionally do not run. */
  dispose(): void {
    this.cancelPendingFlush();
    this.stopWatchingVisibility?.();
    this.stopWatchingVisibility = null;
    this.buffers.clear();
    this.bufferedCodeUnits = 0;
    this.drainCallbacks.length = 0;
    this.drainFramesRemaining = null;
  }

  private flushFrame(): void {
    if (this.buffers.size === 0) {
      this.finishDrainCallbacks();
      return;
    }

    const updates: TUpdate[] = [];
    for (const [key, update] of this.buffers.entries()) {
      const delta = update.delta.slice(0, this.getFrameDeltaLength(update));
      const remainingDelta = update.delta.slice(delta.length);
      this.bufferedCodeUnits -= delta.length;
      updates.push({
        ...update,
        delta,
      });

      if (remainingDelta.length === 0) {
        this.buffers.delete(key);
      } else {
        this.buffers.set(key, {
          ...update,
          delta: remainingDelta,
        });
      }
    }

    this.onFlush(updates, {
      terminalDrainCommit: this.drainCallbacks.length > 0 && this.buffers.size === 0,
    });
    if (this.drainFramesRemaining !== null) {
      this.drainFramesRemaining -= 1;
    }

    if (this.buffers.size > 0) {
      this.scheduleFlush();
      return;
    }

    this.finishDrainCallbacks();
  }

  private getFrameDeltaLength(update: TUpdate): number {
    const deltaLength = update.delta.length;
    if (update.target.type === "reasoningSummary") return deltaLength;
    if (this.drainFramesRemaining === null) {
      return this.targetCharsPerFrame;
    }

    return Math.max(this.targetCharsPerFrame, Math.ceil(deltaLength / this.drainFramesRemaining));
  }

  private getBufferedDeltaLength(): number {
    return this.bufferedCodeUnits;
  }

  private finishDrainCallbacks(): void {
    this.stopWatchingVisibility?.();
    this.stopWatchingVisibility = null;
    this.drainFramesRemaining = null;
    if (this.drainCallbacks.length === 0) return;

    const callbacks = this.drainCallbacks.splice(0);
    for (const { callback } of callbacks) {
      callback();
    }
  }

  private scheduleFlush(): void {
    if (this.cancelScheduledFlush !== null) return;

    if (this.scheduler.canUseAnimationFrame()) {
      this.stopWatchingVisibility ??=
        this.scheduler.subscribeVisibilityChange?.(() => {
          if (!this.scheduler.canUseAnimationFrame()) this.flushNow();
        }) ?? null;
      this.cancelScheduledFlush = this.scheduler.scheduleAnimationFrame(() => {
        this.cancelScheduledFlush = null;
        this.flushFrame();
      });
      return;
    }

    this.cancelScheduledFlush = this.scheduler.scheduleTimeout(() => {
      this.cancelScheduledFlush = null;
      this.flushNow();
    }, this.fallbackIntervalMs);
  }

  private cancelPendingFlush(): void {
    if (this.cancelScheduledFlush === null) return;
    this.cancelScheduledFlush();
    this.cancelScheduledFlush = null;
  }
}
