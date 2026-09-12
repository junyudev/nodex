import { randomUUID } from "node:crypto";
import {
  CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES,
  CODEX_HOST_CHUNK_TARGET_BYTES,
  codexHostMessageParts,
  shouldChunkCodexHostMessage,
  type CodexHostMessagePart,
} from "../../shared/codex-host-chunked-message";

interface QueuedMessage<Message> {
  readonly chunked: boolean;
  readonly message: Message;
}

interface ActiveTransfer<Message> {
  readonly critical: boolean;
  delivered: boolean;
  readonly id: string;
  readonly iterator: Generator<CodexHostMessagePart>;
  readonly message: Message;
  part: CodexHostMessagePart | null;
}

interface TargetState<Target, Message> {
  readonly criticalMessages: QueuedMessage<Message>[];
  draining: boolean;
  loading: boolean;
  readonly messages: QueuedMessage<Message>[];
  retryTimer: (() => void) | null;
  sending: boolean;
  readonly target: Target;
  transfer: ActiveTransfer<Message> | null;
  unsubscribe: (() => void) | null;
}

export interface CodexHostChunkedMessageSenderOptions<Target extends object, Message> {
  readonly batchTargetBytes?: number;
  readonly inlineThresholdBytes?: number;
  readonly deliver: (target: Target, message: Message, part: CodexHostMessagePart | null) => void;
  readonly getPayload: (message: Message) => unknown;
  readonly isAvailable?: (target: Target) => boolean;
  readonly isLoading?: (target: Target) => boolean;
  readonly onSendError: (target: Target, error: unknown) => void;
  readonly retryDelayMs?: number;
  readonly scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
  readonly subscribe?: (
    target: Target,
    callbacks: {
      readonly onDestroyed: () => void;
      readonly onLoaded: () => void;
      readonly onLoading: () => void;
    },
  ) => (() => void) | null;
}

/**
 * One FIFO lane per renderer target with the same chunk, ACK, loading, retry, and critical-message
 * semantics as the desktop host transport.
 */
export class CodexHostChunkedMessageSender<Target extends object, Message> {
  private readonly batchTargetBytes: number;
  private readonly inlineThresholdBytes: number;
  private readonly targets = new Map<Target, TargetState<Target, Message>>();

  constructor(private readonly options: CodexHostChunkedMessageSenderOptions<Target, Message>) {
    this.batchTargetBytes = options.batchTargetBytes ?? CODEX_HOST_CHUNK_TARGET_BYTES;
    this.inlineThresholdBytes =
      options.inlineThresholdBytes ?? CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES;
  }

  send(target: Target, message: Message): void {
    const chunked = this.shouldChunk(message);
    const existing = this.targets.get(target);
    if (!existing && !chunked) {
      this.options.deliver(target, message, null);
      return;
    }
    const state = existing ?? this.createTarget(target);
    state.messages.push({ chunked, message });
    this.drain(state);
  }

  sendInline(target: Target, message: Message): void {
    const existing = this.targets.get(target);
    if (!existing) {
      this.options.deliver(target, message, null);
      return;
    }
    existing.messages.push({ chunked: false, message });
    this.drain(existing);
  }

  sendCritical(target: Target, message: Message): void {
    const chunked = this.shouldChunk(message);
    const existing = this.targets.get(target);
    if (!chunked && !existing) {
      try {
        this.options.deliver(target, message, null);
        return;
      } catch (error) {
        const state = this.createTarget(target);
        state.criticalMessages.push({ chunked: false, message });
        this.handleSendError(state, error);
        return;
      }
    }
    const state = existing ?? this.createTarget(target);
    state.criticalMessages.push({ chunked, message });
    if (!chunked) this.drainCritical(state);
    this.drain(state);
  }

  acknowledge(target: Target, transferId: string, sequence: number): void {
    const state = this.targets.get(target);
    const transfer = state?.transfer;
    if (
      !state ||
      state.sending ||
      !transfer ||
      !transfer.delivered ||
      transfer.id !== transferId ||
      transfer.part?.sequence !== sequence
    ) {
      return;
    }
    if (transfer.part.kind === "end") {
      state.transfer = null;
      this.drain(state);
      return;
    }
    this.sendNextPart(state, transfer);
  }

  dispose(target: Target): void {
    const state = this.targets.get(target);
    if (state) this.cleanup(state);
  }

  private shouldChunk(message: Message): boolean {
    return shouldChunkCodexHostMessage(this.options.getPayload(message), this.inlineThresholdBytes);
  }

  private createTarget(target: Target): TargetState<Target, Message> {
    const state: TargetState<Target, Message> = {
      criticalMessages: [],
      draining: false,
      loading: this.options.isLoading?.(target) === true,
      messages: [],
      retryTimer: null,
      sending: false,
      target,
      transfer: null,
      unsubscribe: null,
    };
    this.targets.set(target, state);
    state.unsubscribe =
      this.options.subscribe?.(target, {
        onDestroyed: () => this.cleanup(state),
        onLoaded: () => this.handleLoaded(state),
        onLoading: () => this.handleLoading(state),
      }) ?? null;
    return state;
  }

  private drain(state: TargetState<Target, Message>): void {
    if (
      state.draining ||
      state.loading ||
      state.sending ||
      state.transfer !== null ||
      this.targets.get(state.target) !== state
    ) {
      return;
    }

    state.draining = true;
    try {
      this.drainCritical(state);
      if (state.retryTimer !== null) return;
      while (state.transfer === null) {
        const critical = state.criticalMessages.shift();
        const next = critical ?? state.messages.shift();
        if (!next) break;
        if (!next.chunked) {
          try {
            this.options.deliver(state.target, next.message, null);
          } catch (error) {
            state.messages.unshift(next);
            this.handleSendError(state, error);
            break;
          }
          continue;
        }
        const id = randomUUID();
        const transfer: ActiveTransfer<Message> = {
          critical: critical !== undefined,
          delivered: false,
          id,
          iterator: codexHostMessageParts(this.options.getPayload(next.message), {
            batchTargetBytes: this.batchTargetBytes,
            transferId: id,
          }),
          message: next.message,
          part: null,
        };
        state.transfer = transfer;
        this.sendNextPart(state, transfer);
      }
    } finally {
      state.draining = false;
    }
    if (
      state.transfer === null &&
      state.messages.length === 0 &&
      state.criticalMessages.length === 0
    ) {
      this.cleanup(state);
    }
  }

  private drainCritical(state: TargetState<Target, Message>): void {
    if (
      state.loading ||
      state.sending ||
      state.transfer?.critical === true ||
      state.retryTimer !== null ||
      this.targets.get(state.target) !== state
    ) {
      return;
    }
    while (state.criticalMessages.length > 0) {
      const next = state.criticalMessages[0];
      if (!next || next.chunked) return;
      state.criticalMessages.shift();
      state.sending = true;
      try {
        this.options.deliver(state.target, next.message, null);
      } catch (error) {
        state.criticalMessages.unshift(next);
        this.handleSendError(state, error);
        return;
      } finally {
        state.sending = false;
      }
    }
  }

  private sendNextPart(
    state: TargetState<Target, Message>,
    transfer: ActiveTransfer<Message>,
  ): void {
    let next: IteratorResult<CodexHostMessagePart>;
    try {
      next = transfer.iterator.next();
    } catch (error) {
      state.transfer = null;
      this.requeueTransfer(state, transfer);
      this.handleSendError(state, error);
      return;
    }
    if (next.done) {
      state.transfer = null;
      this.requeueTransfer(state, transfer);
      this.handleSendError(state, new Error("Chunked message transfer ended without an end part"));
      return;
    }
    transfer.part = next.value;
    transfer.delivered = false;
    this.sendCurrentPart(state, transfer);
  }

  private sendCurrentPart(
    state: TargetState<Target, Message>,
    transfer: ActiveTransfer<Message>,
  ): void {
    const part = transfer.part;
    if (!part || state.transfer !== transfer || this.targets.get(state.target) !== state) return;
    if (this.options.isAvailable?.(state.target) === false) {
      this.cleanup(state);
      return;
    }
    state.sending = true;
    try {
      this.options.deliver(state.target, transfer.message, part);
      transfer.delivered = true;
    } catch (error) {
      this.handleSendError(state, error);
    } finally {
      state.sending = false;
    }
  }

  private handleSendError(state: TargetState<Target, Message>, error: unknown): void {
    this.options.onSendError(state.target, error);
    const retryDelayMs = this.options.retryDelayMs;
    if (retryDelayMs === undefined || !this.options.scheduleRetry) {
      this.cleanup(state);
      return;
    }
    state.retryTimer ??= this.options.scheduleRetry(() => {
      state.retryTimer = null;
      this.drainCritical(state);
      if (state.retryTimer !== null) return;
      if (state.transfer && !state.transfer.delivered) {
        this.sendCurrentPart(state, state.transfer);
        return;
      }
      if (!state.transfer) this.drain(state);
    }, retryDelayMs);
  }

  private handleLoading(state: TargetState<Target, Message>): void {
    if (this.targets.get(state.target) !== state) return;
    state.loading = true;
    if (state.retryTimer !== null) {
      state.retryTimer();
      state.retryTimer = null;
    }
    const transfer = state.transfer;
    if (transfer) {
      state.transfer = null;
      this.requeueTransfer(state, transfer);
    }
  }

  private handleLoaded(state: TargetState<Target, Message>): void {
    if (this.targets.get(state.target) !== state) return;
    state.loading = false;
    this.drainCritical(state);
    this.drain(state);
  }

  private cleanup(state: TargetState<Target, Message>): void {
    if (!this.targets.delete(state.target)) return;
    state.retryTimer?.();
    state.messages.length = 0;
    state.criticalMessages.length = 0;
    state.transfer = null;
    state.unsubscribe?.();
    state.unsubscribe = null;
  }

  private requeueTransfer(
    state: TargetState<Target, Message>,
    transfer: ActiveTransfer<Message>,
  ): void {
    const queued = { chunked: true, message: transfer.message } satisfies QueuedMessage<Message>;
    if (transfer.critical) state.criticalMessages.unshift(queued);
    else state.messages.unshift(queued);
  }
}
