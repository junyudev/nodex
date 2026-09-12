import type {
  QueuedMessageCoordinator,
  QueuedMessageRole,
} from "./codex-queued-message-coordinator";
import { CODEX_INTERRUPTED_STEER_REASON } from "./codex-queued-follow-up-state";

export interface QueueSubmission<Resume, Start, Steer> {
  conversationId: string;
  executionHostId?: string;
  resume: Resume & { conversationId: string };
  start?: Start;
  steer: Steer;
  requiresIdle?: boolean;
  afterInactiveTurnId?: string;
  allowStartAfterNoActiveTurn?: boolean;
}
export type QueueSendResult =
  | { status: "sent"; kind: "start" | "steer"; turnId: string }
  | { status: "deferred" };
type SubmissionResult =
  | QueueSendResult
  | { status: "needs-start-preparation"; afterInactiveTurnId: string | undefined };
export type QueuePreparation<Submission> =
  | { status: "ready"; submission: Submission }
  | { status: "paused"; reason: string };
export interface QueueOperation<Message, Submission> {
  prepare(
    conversationId: string,
    message: Message,
    mode: "start" | "steer",
  ): Promise<QueuePreparation<Submission>>;
  onAttempt?(conversationId: string, message: Message): void;
  onResult?(
    conversationId: string,
    message: Message,
    result: QueueSendResult | { status: "paused"; reason: string },
  ): void;
  onError?(conversationId: string, message: Message, error: unknown): void;
}
export interface QueueExecutionRuntime<Message, Submission> extends QueueOperation<
  Message,
  Submission
> {
  isClientReady(conversationId: string): boolean;
  canAcquireOwnership(conversationId: string): boolean;
  tryAcquireStartTurn(conversationId: string): boolean;
  releaseStartTurn(conversationId: string): void;
  waitUntilReady?(conversationId: string): Promise<void>;
  acquireSendLock(
    conversationId: string,
    messageId: string,
  ): Promise<{ release(sent: boolean): Promise<void> } | null>;
  errorReason(error: unknown): string;
}
export interface QueueSubmissionHost<Resume, Start, Steer> {
  needsResume(conversationId: string): boolean;
  resume(
    request: Resume,
    automatic: boolean,
  ): Promise<{ status: "ready"; activeTurnId: string | null } | { status: "not-ready" }>;
  getActiveTurnId(conversationId: string): string | null;
  hasPendingTurnStart(conversationId: string): boolean;
  start(conversationId: string, request: Start): Promise<string>;
  steer(conversationId: string, request: Steer): Promise<string>;
  canStartAfterSteerError(
    conversationId: string,
    error: unknown,
    executionHostId?: string,
  ): boolean;
  isNoActiveTurnError(error: unknown): boolean;
}
interface QueueExecutionClient<Message, Resume, Start, Steer> {
  coordinator: QueuedMessageCoordinator<Message>;
  runtime: QueueExecutionRuntime<Message, QueueSubmission<Resume, Start, Steer>>;
  submissionHost: QueueSubmissionHost<Resume, Start, Steer>;
  role(conversationId: string): QueuedMessageRole;
  canSend(conversationId: string, message: Message): boolean;
  validate(messages: readonly Message[]): void;
  error(operation: string, error: unknown): void;
}
export class QueueNotReady extends Error {}
/** Runs the owner's queued submissions while preserving message identity across every await. */
export class QueuedMessageExecution<
  Message extends { id: string; pausedReason?: string | null },
  Resume,
  Start,
  Steer,
> implements Disposable {
  private disposed = false;
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly deferrals = new Map<string, number>();
  constructor(private readonly client: QueueExecutionClient<Message, Resume, Start, Steer>) {}
  deferAutomaticTurns(id: string): Disposable {
    this.deferrals.set(id, (this.deferrals.get(id) ?? 0) + 1);
    let released = false;
    return {
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        const count = (this.deferrals.get(id) ?? 1) - 1;
        if (count) this.deferrals.set(id, count);
        else {
          this.deferrals.delete(id);
          this.wake(id);
        }
      },
    };
  }
  turnCompleted(id: string, interrupted: boolean): void {
    if (this.disposed || this.client.role(id)?.role === "follower") return;
    if (!interrupted) {
      this.wake(id);
      return;
    }
    this.client.coordinator.mutate(id, (messages) =>
      messages.map((message) => ({
        ...message,
        pausedReason: message.pausedReason ?? CODEX_INTERRUPTED_STEER_REASON,
      })),
    );
  }
  wake(id: string): void {
    const { coordinator, runtime } = this.client;
    if (this.disposed || coordinator.isPending(id) || this.deferrals.has(id)) return;
    if (coordinator.isRefreshing(id)) {
      if (runtime.isClientReady(id) && this.client.role(id)?.role !== "follower")
        coordinator.requestExecutionWake();
      return;
    }
    const head = coordinator.readMessages(id)?.[0];
    if (!head || head.pausedReason != null) return;
    if (this.running.has(id)) {
      this.rerun.add(id);
      return;
    }
    this.running.add(id);
    void this.run(id).finally(() => {
      this.running.delete(id);
      if (this.rerun.delete(id)) this.wake(id);
    });
  }
  async sendNow(
    id: string,
    messageId: string,
    operation?: QueueOperation<Message, QueueSubmission<Resume, Start, Steer>>,
  ): Promise<void> {
    using _deferral = this.deferAutomaticTurns(id);
    await this.client.coordinator.loadMessages(id);
    await this.client.coordinator.waitForRefresh();
    if (this.disposed) throw new Error("Queued message execution is unavailable");
    await this.run(id, { messageId, operation });
  }
  async sendPreparedNow(
    id: string,
    message: Message,
    operation: QueueOperation<Message, QueueSubmission<Resume, Start, Steer>>,
  ): Promise<{ status: "sent"; turnId: string }> {
    using _deferral = this.deferAutomaticTurns(id);
    const current = () => !this.disposed;
    let prepared = await operation.prepare(id, message, "steer");
    if (prepared.status === "paused") throw new Error(prepared.reason);
    if (prepared.submission.conversationId !== id)
      throw new Error("Prepared submission belongs to another thread");

    let result = await this.submit(prepared.submission, false, current);
    if (result.status === "needs-start-preparation") {
      const afterInactiveTurnId = result.afterInactiveTurnId;
      prepared = await operation.prepare(id, message, "start");
      if (prepared.status === "paused") throw new Error(prepared.reason);
      if (prepared.submission.conversationId !== id || prepared.submission.start == null)
        throw new Error("Start preparation did not produce a matching turn request");
      result = await this.submit({ ...prepared.submission, afterInactiveTurnId }, false, current);
    }
    if (result.status !== "sent") throw new Error("Explicit message submission was not sent");
    return { status: "sent", turnId: result.turnId };
  }
  private async submit(
    submission: QueueSubmission<Resume, Start, Steer>,
    automatic: boolean,
    current: () => boolean,
  ): Promise<SubmissionResult> {
    if (this.disposed) throw new Error("Turn coordinator retired");
    const host = this.client.submissionHost;
    const id = submission.conversationId;
    if (submission.resume.conversationId !== id)
      throw new Error("Resume request does not match the submission thread");
    let resumedActive: string | null = null;
    if (host.needsResume(id)) {
      const result = await host.resume(submission.resume, automatic);
      if (result.status === "not-ready") throw new QueueNotReady("Thread is not ready");
      resumedActive = result.activeTurnId;
    }
    if (this.disposed) throw new Error("Turn coordinator retired");
    if (!current()) return { status: "deferred" };
    const active = host.getActiveTurnId(id) ?? resumedActive;
    const pending = host.hasPendingTurnStart(id);
    let afterInactiveTurnId = submission.afterInactiveTurnId;
    if ((automatic || submission.requiresIdle) && (active != null || pending))
      return { status: "deferred" };
    if (active == null ? pending : active !== afterInactiveTurnId) {
      try {
        return { status: "sent", kind: "steer", turnId: await host.steer(id, submission.steer) };
      } catch (error) {
        if (
          this.disposed ||
          (!host.canStartAfterSteerError(id, error, submission.executionHostId) &&
            !(submission.allowStartAfterNoActiveTurn && host.isNoActiveTurnError(error)))
        )
          throw error;
        afterInactiveTurnId = active ?? undefined;
      }
    }
    if (submission.start == null) return { status: "needs-start-preparation", afterInactiveTurnId };
    if (!current()) return { status: "deferred" };
    return { status: "sent", kind: "start", turnId: await host.start(id, submission.start) };
  }
  private async run(
    id: string,
    manual?: {
      messageId: string;
      operation?: QueueOperation<Message, QueueSubmission<Resume, Start, Steer>>;
    },
  ): Promise<void> {
    const { coordinator, runtime } = this.client;
    try {
      this.client.validate(coordinator.readMessages(id) ?? []);
    } catch (error) {
      if (manual) throw error;
      return;
    }
    let message: Message | undefined;
    let acquired = false;
    let lock: Awaited<ReturnType<typeof runtime.acquireSendLock>> = null;
    let sent = false;
    let attempted = false;
    const operation = manual?.operation ?? runtime;
    const current = (): boolean =>
      !this.disposed &&
      !coordinator.isPending(id) &&
      !coordinator.isRefreshing(id) &&
      message != null &&
      (manual
        ? coordinator.readMessages(id)?.find((candidate) => candidate.id === manual.messageId) ===
          message
        : coordinator.readMessages(id)?.[0] === message &&
          !this.deferrals.has(id) &&
          runtime.isClientReady(id) &&
          this.client.canSend(id, message));
    try {
      if (!manual && this.client.role(id)?.role !== "owner" && !runtime.canAcquireOwnership(id))
        return;
      if (!manual && (this.deferrals.has(id) || !runtime.isClientReady(id))) return;
      message = manual
        ? coordinator.readMessages(id)?.find((candidate) => candidate.id === manual.messageId)
        : coordinator.readMessages(id)?.[0];
      if (!message || !current() || !runtime.tryAcquireStartTurn(id)) return;
      acquired = true;
      if (manual) {
        await runtime.waitUntilReady?.(id);
        if (!current()) return;
      }
      lock = await runtime.acquireSendLock(id, message.id);
      if (!lock || !current()) return;
      let prepared = await operation.prepare(id, message, manual ? "steer" : "start");
      if (!current()) return;
      if (prepared.status === "paused") {
        this.pause(id, message.id, prepared.reason);
        return;
      }
      if (!manual && this.client.role(id)?.role !== "owner") return;
      if (prepared.submission.conversationId !== id)
        throw new Error("Prepared submission belongs to another thread");
      attempted = true;
      operation.onAttempt?.(id, message);
      let result = await this.submit(prepared.submission, !manual, current);
      if (result.status === "needs-start-preparation") {
        const afterInactiveTurnId = result.afterInactiveTurnId;
        prepared = await operation.prepare(id, message, "start");
        if (!current()) {
          operation.onResult?.(id, message, { status: "deferred" });
          return;
        }
        if (prepared.status === "paused") {
          this.pause(id, message.id, prepared.reason);
          operation.onResult?.(id, message, prepared);
          return;
        }
        if (prepared.submission.conversationId !== id || prepared.submission.start == null)
          throw new Error("Start preparation did not produce a matching turn request");
        result = await this.submit(
          { ...prepared.submission, afterInactiveTurnId },
          !manual,
          current,
        );
      }
      if (result.status === "needs-start-preparation")
        throw new Error("Start preparation did not produce a turn request");
      if (result.status === "sent") {
        sent = true;
        if (!this.disposed)
          coordinator.mutate(id, (messages) =>
            messages.filter((candidate) => candidate.id !== message?.id),
          );
      }
      operation.onResult?.(id, message, result);
    } catch (error) {
      if (!manual && error instanceof QueueNotReady) {
        if (attempted && message) operation.onResult?.(id, message, { status: "deferred" });
        return;
      }
      if (!sent && attempted && message) {
        try {
          operation.onError?.(id, message, error);
        } catch (reportError) {
          this.client.error("report", reportError);
        }
      }
      if (!sent && !this.disposed && message && (manual || this.client.role(id)?.role === "owner"))
        this.pause(id, message.id, runtime.errorReason(error));
      this.client.error("execute", error);
      if (manual && !sent) throw error;
    } finally {
      try {
        await lock?.release(sent);
      } catch (error) {
        this.client.error("release", error);
      }
      if (acquired) runtime.releaseStartTurn(id);
      if (manual) this.wake(id);
    }
  }
  private pause(id: string, messageId: string, reason: string): void {
    this.client.coordinator.mutate(id, (messages) =>
      messages.map((message) =>
        message.id === messageId ? { ...message, pausedReason: reason } : message,
      ),
    );
  }
  [Symbol.dispose](): void {
    this.disposed = true;
    this.rerun.clear();
    this.deferrals.clear();
  }
}
