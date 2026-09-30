import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  CodexWorktreeWorkerOperation,
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerRequest,
  CodexWorktreeWorkerSuccess,
} from "../codex/codex-worktree-worker-protocol";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  createCodexWorktreeWorkerRequestMessage,
  isCodexWorktreeWorkerThreadMessage,
  type CodexWorktreeWorkerHostMessage,
  type CodexWorktreeWorkerThreadMessage,
} from "../worktree-worker/worktree-worker-protocol";

export interface WorktreeWorkerProcess {
  readonly send: (message: CodexWorktreeWorkerHostMessage) => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  readonly onExit: (listener: (code: number) => void) => () => void;
  readonly terminate: () => Promise<number>;
}

export type WorktreeWorkerProcessFactory = (input: {
  readonly epoch: number;
  readonly hostId: string;
  readonly workerPath: string;
}) => WorktreeWorkerProcess;

interface WorkerSession {
  readonly epoch: number;
  readonly exit: Deferred.Deferred<number>;
  readonly process: WorktreeWorkerProcess;
  readonly releaseListeners: () => void;
  readonly enqueue: (message: unknown) => void;
}

type PendingMessage = Exclude<CodexWorktreeWorkerThreadMessage, { readonly type: "ready" }>;
interface QueuedPendingMessage {
  readonly bytes: number;
  readonly value: PendingMessage;
}

interface PendingRequest {
  readonly operation: CodexWorktreeWorkerOperation;
  readonly onEvent: (event: CodexWorktreeWorkerEvent) => Effect.Effect<void, Error>;
  readonly messages: Queue.Queue<QueuedPendingMessage>;
  readonly reply: Deferred.Deferred<CodexWorktreeWorkerSuccess, WorktreeWorkerError>;
  readonly session: WorkerSession;
  queuedBytes: number;
}

export type WorktreeWorkerSuccessValue<Operation extends CodexWorktreeWorkerOperation> = Extract<
  CodexWorktreeWorkerSuccess,
  { readonly operation: Operation }
>["value"];

export class WorktreeWorkerError extends Schema.TaggedError<WorktreeWorkerError>()(
  "WorktreeWorkerError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
    preparationRestored: Schema.optional(Schema.Boolean),
  },
) {}

export class WorktreeWorkerProcessStartError extends Schema.TaggedError<WorktreeWorkerProcessStartError>()(
  "WorktreeWorkerProcessStartError",
  { cause: Schema.Defect() },
) {}

export class WorktreeWorkerRuntime extends Context.Service<
  WorktreeWorkerRuntime,
  {
    readonly hostId: string;
    readonly request: <Operation extends CodexWorktreeWorkerOperation>(
      request: Extract<CodexWorktreeWorkerRequest, { readonly operation: Operation }>,
      options?: WorktreeWorkerRequestOptions,
    ) => Effect.Effect<WorktreeWorkerSuccessValue<Operation>, WorktreeWorkerError>;
  }
>()("nodex/main/host-runtime/WorktreeWorkerRuntime") {}

export interface WorktreeWorkerRequestOptions {
  readonly onEvent?: (event: CodexWorktreeWorkerEvent) => Effect.Effect<void, Error>;
}

export interface LocalWorktreeWorkerOptions {
  readonly hostId: string;
  readonly workerPath: string;
  readonly createProcess?: WorktreeWorkerProcessFactory;
  readonly onInfrastructureError?: (error: Error) => void;
  readonly shutdownTimeoutMs?: number;
  readonly sessionInboxCapacity?: number;
  readonly sessionInboxBytes?: number;
  readonly requestInboxCapacity?: number;
  readonly requestInboxBytes?: number;
  readonly maximumPendingRequests?: number;
}

export interface WorktreeWorkerClientOptions {
  readonly hostId: string;
  readonly createProcess: (input: {
    readonly epoch: number;
    readonly hostId: string;
  }) => Effect.Effect<WorktreeWorkerProcess, WorktreeWorkerProcessStartError>;
  readonly onInfrastructureError?: (error: Error) => void;
  readonly expectedReadyEpoch?: (sessionEpoch: number) => number;
  readonly shutdownTimeoutMs?: number;
  readonly sessionInboxCapacity?: number;
  readonly sessionInboxBytes?: number;
  readonly requestInboxCapacity?: number;
  readonly requestInboxBytes?: number;
  readonly maximumPendingRequests?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;
const DEFAULT_SESSION_INBOX_CAPACITY = 2_048;
const DEFAULT_SESSION_INBOX_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_INBOX_CAPACITY = 256;
const DEFAULT_REQUEST_INBOX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_PENDING_REQUESTS = 32;

const messageBytes = (message: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const createNodeProcess: WorktreeWorkerProcessFactory = (input) => {
  const worker = new Worker(input.workerPath, {
    name: `worktree:${input.hostId}`,
    workerData: { epoch: input.epoch, hostId: input.hostId },
  });
  return {
    send: (message) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads messages do not accept a target origin.
      worker.postMessage(message);
    },
    onMessage: (listener) => {
      worker.on("message", listener);
      return () => worker.off("message", listener);
    },
    onError: (listener) => {
      worker.on("error", listener);
      return () => worker.off("error", listener);
    },
    onExit: (listener) => {
      worker.on("exit", listener);
      return () => worker.off("exit", listener);
    },
    terminate: () => worker.terminate(),
  };
};

/**
 * Shared scoped client for both local worker_threads and remote SSH stdio workers.
 * Process adapters own framing only; this Effect owns generations, requests and shutdown.
 */
export const makeWorktreeWorkerClient = (options: WorktreeWorkerClientOptions) =>
  Effect.gen(function* () {
    const hostId = options.hostId.trim();
    if (!hostId) {
      return yield* Effect.die(
        new WorktreeWorkerError({
          operation: "configure",
          message: "Worktree worker host id is required",
          cause: new Error("Worktree worker host id is required"),
        }),
      );
    }
    const onInfrastructureError = options.onInfrastructureError ?? (() => undefined);
    const expectedReadyEpoch = options.expectedReadyEpoch ?? ((epoch: number) => epoch);
    const sessionInboxCapacity = Math.max(
      1,
      Math.floor(options.sessionInboxCapacity ?? DEFAULT_SESSION_INBOX_CAPACITY),
    );
    const sessionInboxBytes = Math.max(
      1,
      Math.floor(options.sessionInboxBytes ?? DEFAULT_SESSION_INBOX_BYTES),
    );
    const requestInboxCapacity = Math.max(
      1,
      Math.floor(options.requestInboxCapacity ?? DEFAULT_REQUEST_INBOX_CAPACITY),
    );
    const requestInboxBytes = Math.max(
      1,
      Math.floor(options.requestInboxBytes ?? DEFAULT_REQUEST_INBOX_BYTES),
    );
    const maximumPendingRequests = Math.max(
      1,
      Math.floor(options.maximumPendingRequests ?? DEFAULT_MAXIMUM_PENDING_REQUESTS),
    );
    const stateLock = yield* Semaphore.make(1);
    const current = yield* Ref.make<WorkerSession | null>(null);
    const nextEpoch = yield* Ref.make(1);
    const closed = yield* Ref.make(false);
    const requests = yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map());
    const callbackFibers = yield* FiberSet.make();
    const runCallback = yield* FiberSet.runtime(callbackFibers)();

    const failure = (operation: string, message: string, cause: unknown = new Error(message)) =>
      new WorktreeWorkerError({ operation, message, cause });
    const failPending = (
      pending: ReadonlyMap<string, PendingRequest>,
      error: WorktreeWorkerError,
    ) =>
      Effect.forEach(
        pending.values(),
        (entry) =>
          Queue.shutdown(entry.messages).pipe(Effect.andThen(Deferred.fail(entry.reply, error))),
        { discard: true },
      );
    const takePending = (id: string) =>
      Ref.modify(requests, (state) => {
        const pending = state.get(id);
        if (!pending) return [undefined, state] as const;
        const next = new Map(state);
        next.delete(id);
        return [pending, next] as const;
      });
    const takePendingIf = (id: string, expected: PendingRequest) =>
      Ref.modify(requests, (state) => {
        if (state.get(id) !== expected) return [false, state] as const;
        const next = new Map(state);
        next.delete(id);
        return [true, next] as const;
      });
    const sendBestEffort = (
      process: WorktreeWorkerProcess,
      message: CodexWorktreeWorkerHostMessage,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        try {
          process.send(message);
        } catch {
          // A concurrent worker failure owns request rejection and cleanup.
        }
      });

    const handleFailure = (error: Error, session: WorkerSession): Effect.Effect<void> =>
      stateLock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(current)) !== session) return;
          yield* Ref.set(current, null);
          session.releaseListeners();
          const pending = yield* Ref.getAndSet(requests, new Map());
          yield* Effect.sync(() => onInfrastructureError(error));
          yield* failPending(
            pending,
            failure("worker-failure", "Worktree worker is temporarily unavailable", error),
          );
          yield* Effect.tryPromise(() => session.process.terminate()).pipe(Effect.ignore);
        }),
      );

    const consumePending = (id: string, pending: PendingRequest): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const queued = yield* Queue.take(pending.messages);
          pending.queuedBytes = Math.max(0, pending.queuedBytes - queued.bytes);
          const message = queued.value;
          if (message.type === "event") {
            const delivered = yield* Effect.exit(pending.onEvent(message.event));
            if (Exit.isSuccess(delivered)) continue;
            const removed = yield* takePendingIf(id, pending);
            if (!removed) return;
            yield* Queue.shutdown(pending.messages);
            yield* sendBestEffort(pending.session.process, {
              type: "cancel",
              protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
              id,
              operation: pending.operation,
            });
            yield* Deferred.fail(
              pending.reply,
              failure("event-consumer", "Worktree worker event consumer failed", delivered.cause),
            );
            return;
          }
          const removed = yield* takePendingIf(id, pending);
          if (!removed) return;
          yield* Queue.shutdown(pending.messages);
          if (message.result.type === "error") {
            yield* Deferred.fail(
              pending.reply,
              new WorktreeWorkerError({
                operation: "worker-result",
                message: message.result.message,
                cause: new Error(message.result.message),
                ...(message.result.preparationRestored !== undefined
                  ? { preparationRestored: message.result.preparationRestored }
                  : {}),
              }),
            );
            return;
          }
          yield* Deferred.succeed(pending.reply, message.result.success);
          return;
        }
      });

    const handleMessage = (raw: unknown, session: WorkerSession): Effect.Effect<void> =>
      Effect.gen(function* () {
        if ((yield* Ref.get(current)) !== session) return;
        if (!isCodexWorktreeWorkerThreadMessage(raw)) {
          return yield* handleFailure(
            new Error("Worktree worker sent an invalid message"),
            session,
          );
        }
        if (raw.type === "ready") {
          if (raw.epoch === expectedReadyEpoch(session.epoch) && raw.hostId === hostId) return;
          return yield* handleFailure(new Error("Worktree worker identity mismatch"), session);
        }
        const pending = (yield* Ref.get(requests)).get(raw.id);
        if (!pending) return;
        if (raw.operation !== pending.operation) {
          return yield* handleFailure(new Error("Worktree worker operation mismatch"), session);
        }
        const bytes = messageBytes(raw);
        if (pending.queuedBytes + bytes > requestInboxBytes) {
          return yield* handleFailure(
            new Error(`Worktree request ingress exceeded ${requestInboxBytes} bytes`),
            session,
          );
        }
        pending.queuedBytes += bytes;
        const accepted = yield* Queue.offer(pending.messages, { bytes, value: raw });
        if (accepted) return;
        pending.queuedBytes = Math.max(0, pending.queuedBytes - bytes);
        return yield* handleFailure(
          new Error(`Worktree request ingress exceeded ${requestInboxCapacity} messages`),
          session,
        );
      });

    const ensureWorker = (): Effect.Effect<WorkerSession, WorktreeWorkerError> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing) return existing;
        const epoch = yield* Ref.getAndUpdate(nextEpoch, (value) => value + 1);
        const process = yield* options
          .createProcess({ epoch, hostId })
          .pipe(
            Effect.mapError((cause) =>
              failure("start-worker", "Could not start the Worktree worker", cause),
            ),
          );
        const exit = yield* Deferred.make<number>();
        let releaseListeners = () => undefined;
        const inbox: Array<{ readonly bytes: number; readonly value: unknown }> = [];
        let inboxBytes = 0;
        let draining = false;
        let session!: WorkerSession;
        const drain: Effect.Effect<void> = Effect.suspend(() => {
          const queued = inbox.shift();
          if (queued === undefined) {
            draining = false;
            return Effect.void;
          }
          inboxBytes = Math.max(0, inboxBytes - queued.bytes);
          return handleMessage(queued.value, session).pipe(Effect.andThen(drain));
        });
        session = {
          epoch,
          exit,
          process,
          releaseListeners: () => releaseListeners(),
          enqueue: (message) => {
            const bytes = messageBytes(message);
            if (inbox.length >= sessionInboxCapacity || inboxBytes + bytes > sessionInboxBytes) {
              runCallback(
                handleFailure(
                  new Error(
                    `Worktree worker ingress exceeded ${sessionInboxCapacity} messages or ${sessionInboxBytes} bytes`,
                  ),
                  session,
                ),
              );
              return;
            }
            inbox.push({ bytes, value: message });
            inboxBytes += bytes;
            if (draining) return;
            draining = true;
            runCallback(drain);
          },
        };
        const removeMessage = process.onMessage((message) => {
          session.enqueue(message);
        });
        const removeError = process.onError((error) => {
          void runCallback(handleFailure(error, session));
        });
        const removeExit = process.onExit((code) => {
          void runCallback(
            Deferred.succeed(exit, code).pipe(
              Effect.andThen(
                handleFailure(
                  new Error(`Worktree worker exited with code ${String(code)}`),
                  session,
                ),
              ),
            ),
          );
        });
        releaseListeners = () => {
          removeMessage();
          removeError();
          removeExit();
        };
        yield* Ref.set(current, session);
        return session;
      });

    const cancelPending = (id: string, pending: PendingRequest): Effect.Effect<void> =>
      Effect.gen(function* () {
        const removed = yield* Ref.modify(requests, (state) => {
          if (state.get(id) !== pending) return [false, state] as const;
          const next = new Map(state);
          next.delete(id);
          return [true, next] as const;
        });
        if (!removed) return;
        yield* Queue.shutdown(pending.messages);
        yield* sendBestEffort(pending.session.process, {
          type: "cancel",
          protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
          id,
          operation: pending.operation,
        });
      });

    const request = <Operation extends CodexWorktreeWorkerOperation>(
      request: Extract<CodexWorktreeWorkerRequest, { readonly operation: Operation }>,
      requestOptions: WorktreeWorkerRequestOptions = {},
    ): Effect.Effect<WorktreeWorkerSuccessValue<Operation>, WorktreeWorkerError> =>
      Effect.gen(function* () {
        if (request.input.hostId !== hostId) {
          return yield* failure(
            "validate-host",
            `Worktree request host ${request.input.hostId} does not match ${hostId}`,
          );
        }
        const id = `${request.operation}:${randomUUID()}`;
        const message = yield* Effect.try({
          try: () => createCodexWorktreeWorkerRequestMessage({ id, request }),
          catch: (cause) =>
            failure(
              "encode-request",
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
        });
        const reply = yield* Deferred.make<CodexWorktreeWorkerSuccess, WorktreeWorkerError>();
        let admittedSession: WorkerSession | null = null;
        const admission = yield* Effect.result(
          stateLock.withPermits(1)(
            Effect.gen(function* () {
              if (yield* Ref.get(closed)) {
                return yield* failure("admit-request", "Worktree worker is shutting down");
              }
              if ((yield* Ref.get(requests)).size >= maximumPendingRequests) {
                return yield* failure(
                  "admit-request",
                  `Worktree worker already has ${maximumPendingRequests} pending requests`,
                );
              }
              const session = yield* ensureWorker();
              admittedSession = session;
              const messages = yield* Queue.dropping<QueuedPendingMessage>(requestInboxCapacity);
              const pending: PendingRequest = {
                operation: request.operation,
                onEvent: requestOptions.onEvent ?? (() => Effect.void),
                messages,
                reply,
                session,
                queuedBytes: 0,
              };
              yield* Ref.update(requests, (state) => new Map(state).set(id, pending));
              yield* FiberSet.run(callbackFibers, consumePending(id, pending));
              yield* Effect.try({
                try: () => session.process.send(message),
                catch: (cause) =>
                  failure("send-request", "Could not send the Worktree worker request", cause),
              });
              return pending;
            }),
          ),
        );
        if (admission._tag === "Failure") {
          const session = admittedSession;
          if (session) {
            yield* takePending(id);
            yield* handleFailure(
              admission.failure.cause instanceof Error
                ? admission.failure.cause
                : new Error(admission.failure.message),
              session,
            );
          }
          return yield* admission.failure;
        }
        const pending = admission.success;
        const success = yield* Deferred.await(reply).pipe(
          Effect.ensuring(cancelPending(id, pending)),
        );
        if (success.operation !== request.operation) {
          return yield* failure("decode-result", "Worktree worker result mismatch");
        }
        return success.value as WorktreeWorkerSuccessValue<Operation>;
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const session = yield* stateLock.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(closed, true);
            const session = yield* Ref.getAndSet(current, null);
            const pending = yield* Ref.getAndSet(requests, new Map());
            yield* failPending(pending, failure("shutdown", "Worktree worker is shutting down"));
            return session;
          }),
        );
        if (!session) return;
        yield* sendBestEffort(session.process, {
          type: "shutdown",
          protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
        });
        const gracefulExit = Deferred.await(session.exit).pipe(Effect.asVoid);
        const forceExit = Effect.sleep(
          Math.max(0, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
        ).pipe(
          Effect.andThen(Effect.tryPromise(() => session.process.terminate())),
          Effect.ignore,
          Effect.asVoid,
        );
        yield* Effect.raceFirst(gracefulExit, forceExit);
        session.releaseListeners();
      }),
    );

    return WorktreeWorkerRuntime.of({ hostId, request });
  });

export const localLive = (
  options: LocalWorktreeWorkerOptions,
): Layer.Layer<WorktreeWorkerRuntime> => {
  const createProcess = options.createProcess ?? createNodeProcess;
  return Layer.effect(
    WorktreeWorkerRuntime,
    makeWorktreeWorkerClient({
      hostId: options.hostId,
      createProcess: (input) =>
        Effect.try({
          try: () => createProcess({ ...input, workerPath: options.workerPath }),
          catch: (cause) => new WorktreeWorkerProcessStartError({ cause }),
        }),
      onInfrastructureError: options.onInfrastructureError,
      maximumPendingRequests: options.maximumPendingRequests,
      requestInboxBytes: options.requestInboxBytes,
      requestInboxCapacity: options.requestInboxCapacity,
      sessionInboxBytes: options.sessionInboxBytes,
      sessionInboxCapacity: options.sessionInboxCapacity,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    }),
  );
};
