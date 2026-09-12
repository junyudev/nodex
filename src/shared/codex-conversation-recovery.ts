import type { CodexCanonicalConversationState } from "./types";
import { encodeCodexNativeRequestFailure } from "./codex-native-request-outcome";

type RecoveryConversation = Pick<CodexCanonicalConversationState, "id" | "resumeState">;

export interface ConversationReconnectOptions {
  readonly restoreStreams?: boolean;
  readonly foregroundConversationId?: string | null;
}

export interface ConversationRecoveryDependencies<Conversation extends RecoveryConversation> {
  conversations(): Iterable<Conversation>;
  getConversation(conversationId: string): Conversation | undefined;
  streamingConversationIds(): readonly string[];
  ownsHistory(conversationId: string): boolean;
  hasResumeInFlight(conversationId: string): boolean;
  isSuppressed(conversationId: string): boolean;
  isDisposed(): boolean;
  cancelResumes(): void;
  resetHistory(): void;
  resetStreams(preserveStreams: boolean): void;
  markNeedsResume(conversationId: string): void;
  resume(conversation: Conversation): Promise<unknown>;
  schedule(callback: () => void, delayMs: number): () => void;
  onError(conversationId: string, error: unknown): void;
}

function isMissingConversation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error && error.code === "thread_not_found") ||
    ("jsonRpcCode" in error && error.jsonRpcCode === "thread_not_found") ||
    /^thread not (?:found|loaded):/i.test(error.message) ||
    /^no rollout found for thread id /i.test(error.message) ||
    /^invalid thread id:/i.test(error.message)
  );
}

function hasWriterConflict(error: unknown): boolean {
  const message = encodeCodexNativeRequestFailure(error).message.toLowerCase();
  return (
    message.includes("already has an active writer") ||
    message.includes("already has a live local writer")
  );
}

/** Restores retained owners without letting one unavailable conversation stall the other streams. */
export class ConversationStreamRecovery<Conversation extends RecoveryConversation> {
  private generation: symbol | null = null;
  private readonly pending = new Set<string>();
  private readonly recoverable = new Set<string>();
  private readonly retryTimers = new Map<string, () => void>();
  private readonly retryDelays = new Map<string, number>();
  private readonly unconfirmedMissing = new Set<string>();
  private activeResumes = 0;

  constructor(private readonly deps: ConversationRecoveryDependencies<Conversation>) {}

  dispose(): void {
    this.generation = null;
    for (const cancel of this.retryTimers.values()) cancel();
    this.retryTimers.clear();
    this.retryDelays.clear();
    this.unconfirmedMissing.clear();
    this.pending.clear();
    this.recoverable.clear();
  }

  markAllConversationsNeedResumeAfterReconnect(options: ConversationReconnectOptions = {}): void {
    this.dispose();
    const generation = Symbol();
    this.generation = generation;
    this.activeResumes = 0;
    this.deps.cancelResumes();
    const owned = options.restoreStreams
      ? this.deps.streamingConversationIds().filter((id) => this.deps.ownsHistory(id))
      : [];
    for (const id of owned) {
      this.recoverable.add(id);
      if (id !== options.foregroundConversationId) this.pending.add(id);
    }
    this.deps.resetHistory();
    this.deps.resetStreams(options.restoreStreams === true);
    for (const conversation of this.deps.conversations()) {
      if (conversation.resumeState !== "needs_resume") this.deps.markNeedsResume(conversation.id);
    }
    const foreground = options.foregroundConversationId;
    if (foreground != null && this.recoverable.has(foreground))
      this.scheduleRetry(foreground, generation, 10_000);
    this.restorePending();
  }

  /** Called by the current manager attempt, including view/executor attempts that join recovery. */
  onResumeAttemptSettled(conversationId: string, ready: boolean, error?: unknown): void {
    if (!this.recoverable.has(conversationId)) return;
    const missing = isMissingConversation(error);
    if (
      ready ||
      this.deps.isSuppressed(conversationId) ||
      hasWriterConflict(error) ||
      (missing && this.unconfirmedMissing.has(conversationId))
    ) {
      this.stopRetrying(conversationId);
      return;
    }
    if (missing) this.unconfirmedMissing.add(conversationId);
    else this.unconfirmedMissing.delete(conversationId);
    if (this.deps.isDisposed() || !this.canRestore(conversationId)) {
      this.stopRetrying(conversationId);
      return;
    }
    this.pending.delete(conversationId);
    const delay = missing
      ? 60_000
      : Math.min((this.retryDelays.get(conversationId) ?? 1_000) * 2, 60_000);
    this.retryDelays.set(conversationId, delay);
    this.retryTimers.get(conversationId)?.();
    this.retryTimers.delete(conversationId);
    this.scheduleRetry(conversationId, this.generation, delay);
  }

  private canRestore(conversationId: string): boolean {
    return (
      this.deps.getConversation(conversationId)?.resumeState === "needs_resume" &&
      this.deps.ownsHistory(conversationId)
    );
  }

  private scheduleRetry(conversationId: string, generation: symbol | null, delayMs: number): void {
    if (generation === null || this.retryTimers.has(conversationId)) return;
    this.retryTimers.set(
      conversationId,
      this.deps.schedule(() => {
        this.retryTimers.delete(conversationId);
        if (this.generation !== generation || this.deps.isDisposed()) return;
        if (!this.recoverable.has(conversationId) || !this.canRestore(conversationId)) {
          this.stopRetrying(conversationId);
          return;
        }
        if (this.deps.hasResumeInFlight(conversationId)) return;
        this.pending.add(conversationId);
        this.restorePending();
      }, delayMs),
    );
  }

  private restorePending(): void {
    while (this.activeResumes < 2 && this.pending.size > 0) {
      const id = this.pending.values().next().value;
      if (id === undefined) return;
      this.pending.delete(id);
      const conversation = this.deps.getConversation(id);
      if (!conversation || !this.canRestore(id)) {
        this.stopRetrying(id);
        continue;
      }
      if (this.deps.hasResumeInFlight(id)) continue;
      const generation = this.generation;
      this.activeResumes += 1;
      void Promise.resolve()
        .then(() => {
          if (
            this.generation !== generation ||
            this.deps.isDisposed() ||
            this.deps.hasResumeInFlight(id)
          )
            return;
          return this.deps.resume(conversation);
        })
        .catch((error: unknown) => {
          if (!this.deps.isDisposed() && this.generation === generation)
            this.deps.onError(id, error);
        })
        .finally(() => {
          if (this.generation !== generation) return;
          this.activeResumes -= 1;
          this.restorePending();
        });
    }
  }

  private stopRetrying(conversationId: string): void {
    this.recoverable.delete(conversationId);
    this.pending.delete(conversationId);
    this.retryTimers.get(conversationId)?.();
    this.retryTimers.delete(conversationId);
    this.retryDelays.delete(conversationId);
    this.unconfirmedMissing.delete(conversationId);
  }
}
