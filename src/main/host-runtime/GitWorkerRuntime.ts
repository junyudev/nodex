import {
  WebContentsDestructionSubscriptions,
  type WebContentsDestructionSource,
} from "../platform/electron/WebContentsDestructionSubscriptions";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  createGitWorkerInfrastructureErrorResponse,
  GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL,
  isGitWorkerMessageFromThread,
  type GitPerformanceOperationMetric,
  type GitWorkerMessageForView,
  type GitWorkerMessageFromHost,
  type GitWorkerMessageFromThread,
  type GitWorkerMessageFromView,
  type GitWorkerMethod,
  type GitWorkerMethodMap,
  type GitWorkerRequest,
} from "../../shared/git-worker-protocol";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;

export interface GitWorkerRendererTarget extends WebContentsDestructionSource {
  readonly id: number;
  send(channel: string, message: GitWorkerMessageForView): void;
}

export interface GitWorkerProcess {
  readonly send: (message: GitWorkerMessageFromHost) => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  readonly onExit: (listener: (code: number) => void) => () => void;
  readonly terminate: () => Promise<number>;
}

export type GitWorkerProcessFactory = (input: {
  readonly epoch: number;
  readonly workerPath: string;
}) => GitWorkerProcess;

interface RendererState {
  readonly target: GitWorkerRendererTarget;
  readonly requestIds: ReadonlySet<string>;
  readonly subscriptionIds: ReadonlySet<string>;
  readonly releaseDestruction: () => void;
}

interface WorkerSession {
  readonly epoch: number;
  readonly process: GitWorkerProcess;
  readonly exit: Deferred.Deferred<number>;
  readonly releaseListeners: () => void;
}

interface MainRequestState {
  readonly method: GitWorkerMethod;
  readonly reply: Deferred.Deferred<unknown, GitWorkerRuntimeError>;
  readonly session: WorkerSession;
}

interface GitWorkerState {
  readonly closed: boolean;
  readonly current: WorkerSession | null;
  readonly mainRequests: ReadonlyMap<string, MainRequestState>;
  readonly nextEpoch: number;
  readonly renderers: ReadonlyMap<number, RendererState>;
  readonly requestOwners: ReadonlyMap<
    string,
    { readonly ownerId: number; readonly method: GitWorkerMethod }
  >;
  readonly subscriptionOwners: ReadonlyMap<string, number>;
}

interface FailedRequests {
  readonly main: ReadonlyMap<string, MainRequestState>;
  readonly renderers: ReadonlyMap<number, RendererState>;
  readonly requests: ReadonlyMap<
    string,
    { readonly ownerId: number; readonly method: GitWorkerMethod }
  >;
}

type WorkerCompletion =
  | { readonly kind: "main"; readonly request: MainRequestState }
  | { readonly kind: "mismatch" }
  | { readonly kind: "missing" }
  | { readonly kind: "renderer"; readonly renderer: GitWorkerRendererTarget | null };

export class GitWorkerRuntimeError extends Schema.TaggedError<GitWorkerRuntimeError>()(
  "GitWorkerRuntimeError",
  {
    code: Schema.Literals(["protocol-error", "worker-unavailable"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class GitWorkerRuntime extends Context.Service<
  GitWorkerRuntime,
  {
    readonly handleRendererMessage: (
      target: GitWorkerRendererTarget,
      message: GitWorkerMessageFromView,
    ) => Effect.Effect<void, GitWorkerRuntimeError>;
    readonly request: <Method extends GitWorkerMethod>(input: {
      readonly method: Method;
      readonly params: GitWorkerMethodMap[Method]["params"];
      readonly signal?: AbortSignal;
    }) => Effect.Effect<GitWorkerMethodMap[Method]["result"], GitWorkerRuntimeError>;
  }
>()("nodex/main/host-runtime/GitWorkerRuntime") {}

export interface GitWorkerRuntimeOptions {
  readonly workerPath: string;
  readonly createProcess?: GitWorkerProcessFactory;
  readonly onInfrastructureError?: (
    error: Error,
    context: { readonly epoch: number; readonly phase: "error" | "exit" | "protocol" },
  ) => void;
  readonly onPerformanceOperation?: (metric: GitPerformanceOperationMetric) => void;
  readonly shutdownTimeoutMs?: number;
}

const initialState = (): GitWorkerState => ({
  closed: false,
  current: null,
  mainRequests: new Map(),
  nextEpoch: 1,
  renderers: new Map(),
  requestOwners: new Map(),
  subscriptionOwners: new Map(),
});

const createNodeProcess: GitWorkerProcessFactory = (input) => {
  const worker = new Worker(input.workerPath, {
    name: "git",
    workerData: { epoch: input.epoch },
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

export const live = (options: GitWorkerRuntimeOptions): Layer.Layer<GitWorkerRuntime> =>
  Layer.effect(
    GitWorkerRuntime,
    Effect.gen(function* () {
      const rendererDestruction = yield* WebContentsDestructionSubscriptions;
      const createProcess = options.createProcess ?? createNodeProcess;
      const onInfrastructureError = options.onInfrastructureError ?? (() => undefined);
      const onPerformanceOperation = options.onPerformanceOperation ?? (() => undefined);
      const state = yield* Ref.make<GitWorkerState>(initialState());
      const stateLock = yield* Semaphore.make(1);
      const callbackFibers = yield* FiberSet.make();
      const runCallback = yield* FiberSet.runtime(callbackFibers)();

      const failure = (
        code: GitWorkerRuntimeError["code"],
        message: string,
        cause: unknown = new Error(message),
      ) => new GitWorkerRuntimeError({ code, message, cause });
      const sendBestEffort = (
        process: GitWorkerProcess,
        message: GitWorkerMessageFromHost,
      ): void => {
        try {
          process.send(message);
        } catch {
          // The process failure callback owns generation teardown.
        }
      };
      const sendToRenderer = (
        target: GitWorkerRendererTarget,
        message: GitWorkerMessageForView,
      ): void => {
        if (target.isDestroyed()) return;
        target.send(GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL, message);
      };
      const sendInfrastructureError = (
        target: GitWorkerRendererTarget,
        request: Pick<GitWorkerRequest["request"], "id" | "method">,
        code: GitWorkerRuntimeError["code"],
        message: string,
      ): void => {
        if (target.isDestroyed()) return;
        target.send(
          GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL,
          createGitWorkerInfrastructureErrorResponse(request, { code, message }),
        );
      };
      const clearRequests = (current: GitWorkerState): [GitWorkerState, FailedRequests] => {
        const renderers = new Map<number, RendererState>();
        for (const [ownerId, renderer] of current.renderers) {
          renderers.set(ownerId, {
            ...renderer,
            requestIds: new Set(),
            subscriptionIds: new Set(),
          });
        }
        return [
          {
            ...current,
            current: null,
            mainRequests: new Map(),
            renderers,
            requestOwners: new Map(),
            subscriptionOwners: new Map(),
          },
          {
            main: current.mainRequests,
            renderers: current.renderers,
            requests: current.requestOwners,
          },
        ];
      };
      const rejectRequests = (
        failed: FailedRequests,
        error: GitWorkerRuntimeError,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const [requestId, owner] of failed.requests) {
            const renderer = failed.renderers.get(owner.ownerId);
            if (!renderer) continue;
            sendInfrastructureError(
              renderer.target,
              { id: requestId, method: owner.method },
              error.code,
              error.message,
            );
          }
          yield* Effect.forEach(
            failed.main.values(),
            (request) => Deferred.fail(request.reply, error),
            { discard: true },
          );
        });

      const handleFailure = (
        session: WorkerSession,
        error: Error,
        phase: "error" | "exit" | "protocol",
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const failed = yield* stateLock.withPermits(1)(
            Ref.modify(state, (current) => {
              if (current.current !== session) return [null, current] as const;
              const [next, requests] = clearRequests(current);
              return [requests, next] as const;
            }),
          );
          if (!failed) return;
          session.releaseListeners();
          yield* Effect.sync(() => onInfrastructureError(error, { epoch: session.epoch, phase }));
          yield* rejectRequests(
            failed,
            failure("worker-unavailable", "Git worker is temporarily unavailable", error),
          );
          yield* Effect.tryPromise(() => session.process.terminate()).pipe(Effect.ignore);
        });

      const releaseRenderer = (ownerId: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const released = yield* stateLock.withPermits(1)(
            Ref.modify(state, (current) => {
              const renderer = current.renderers.get(ownerId);
              if (!renderer) return [null, current] as const;
              const renderers = new Map(current.renderers);
              renderers.delete(ownerId);
              const requestOwners = new Map(current.requestOwners);
              for (const requestId of renderer.requestIds) requestOwners.delete(requestId);
              const subscriptionOwners = new Map(current.subscriptionOwners);
              for (const subscriptionId of renderer.subscriptionIds) {
                subscriptionOwners.delete(subscriptionId);
              }
              return [
                { renderer, process: current.current?.process ?? null },
                { ...current, renderers, requestOwners, subscriptionOwners },
              ] as const;
            }),
          );
          if (!released) return;
          released.renderer.releaseDestruction();
          if (!released.process) return;
          for (const requestId of released.renderer.requestIds) {
            sendBestEffort(released.process, {
              type: "worker-request-cancel",
              workerId: "git",
              id: requestId,
            });
          }
          const now = yield* Clock.currentTimeMillis;
          for (const subscriptionId of released.renderer.subscriptionIds) {
            sendBestEffort(released.process, {
              type: "worker-request",
              workerId: "git",
              request: {
                id: `host-cleanup:${randomUUID()}`,
                method: "unsubscribe-live-query",
                params: { subscriptionId },
                enqueuedAtMs: now,
              },
            });
          }
        });

      const handleMessage = (session: WorkerSession, raw: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          if ((yield* Ref.get(state)).current !== session) return;
          if (!isGitWorkerMessageFromThread(raw)) {
            return yield* handleFailure(
              session,
              new Error("Git worker sent an invalid protocol message"),
              "protocol",
            );
          }
          const message: GitWorkerMessageFromThread = raw;
          if (message.type === "worker-ready") {
            if (message.epoch !== session.epoch) {
              return yield* handleFailure(
                session,
                new Error("Git worker ready epoch did not match its host epoch"),
                "protocol",
              );
            }
            if (session.epoch === 1) return;
            for (const renderer of (yield* Ref.get(state)).renderers.values()) {
              sendToRenderer(renderer.target, {
                type: "worker-restarted",
                workerId: "git",
                epoch: session.epoch,
              });
            }
            return;
          }
          if (message.type === "git-live-query-event") {
            const current = yield* Ref.get(state);
            const ownerId = current.subscriptionOwners.get(message.event.subscriptionId);
            if (ownerId === undefined) return;
            const renderer = current.renderers.get(ownerId);
            if (renderer) sendToRenderer(renderer.target, message);
            return;
          }
          if (message.type === "git-performance-operation") {
            yield* Effect.sync(() => onPerformanceOperation(message.metric));
            return;
          }

          const completion = yield* stateLock.withPermits(1)(
            Ref.modify<GitWorkerState, WorkerCompletion>(state, (current) => {
              const owner = current.requestOwners.get(message.id);
              if (owner) {
                if (owner.method !== message.method) {
                  return [{ kind: "mismatch" as const }, current] as const;
                }
                const requestOwners = new Map(current.requestOwners);
                requestOwners.delete(message.id);
                const renderers = new Map(current.renderers);
                const renderer = renderers.get(owner.ownerId);
                if (renderer) {
                  const requestIds = new Set(renderer.requestIds);
                  requestIds.delete(message.id);
                  renderers.set(owner.ownerId, { ...renderer, requestIds });
                }
                return [
                  { kind: "renderer" as const, renderer: renderer?.target ?? null },
                  { ...current, renderers, requestOwners },
                ] as const;
              }
              const mainRequest = current.mainRequests.get(message.id);
              if (!mainRequest) return [{ kind: "missing" as const }, current] as const;
              if (mainRequest.method !== message.method) {
                return [{ kind: "mismatch" as const }, current] as const;
              }
              const mainRequests = new Map(current.mainRequests);
              mainRequests.delete(message.id);
              return [
                { kind: "main" as const, request: mainRequest },
                { ...current, mainRequests },
              ] as const;
            }),
          );
          if (completion.kind === "missing") return;
          if (completion.kind === "mismatch") {
            return yield* handleFailure(
              session,
              new Error("Git worker response method did not match its request"),
              "protocol",
            );
          }
          if (completion.kind === "renderer") {
            if (completion.renderer) sendToRenderer(completion.renderer, message);
            return;
          }
          if (message.result.type === "error") {
            yield* Deferred.fail(
              completion.request.reply,
              failure(message.result.error.code, message.result.error.message),
            );
            return;
          }
          yield* Deferred.succeed(completion.request.reply, message.result.value);
        });

      const ensureWorker = (): Effect.Effect<WorkerSession, GitWorkerRuntimeError> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.current) return current.current;
          const epoch = current.nextEpoch;
          const process = yield* Effect.try({
            try: () => createProcess({ epoch, workerPath: options.workerPath }),
            catch: (cause) =>
              failure("worker-unavailable", "Could not start the Git worker", cause),
          });
          const exit = yield* Deferred.make<number>();
          let releaseListeners = () => undefined;
          const session: WorkerSession = {
            epoch,
            process,
            exit,
            releaseListeners: () => releaseListeners(),
          };
          const removeMessage = process.onMessage((message) => {
            void runCallback(handleMessage(session, message));
          });
          const removeError = process.onError((error) => {
            void runCallback(handleFailure(session, error, "error"));
          });
          const removeExit = process.onExit((code) => {
            void runCallback(
              Deferred.succeed(exit, code).pipe(
                Effect.andThen(
                  handleFailure(
                    session,
                    new Error(`Git worker exited unexpectedly with code ${String(code)}`),
                    "exit",
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
          yield* Ref.set(state, { ...current, current: session, nextEpoch: epoch + 1 });
          return session;
        });

      const externalCancellation = (
        signal: AbortSignal,
      ): Effect.Effect<never, GitWorkerRuntimeError> =>
        Effect.callback((resume) => {
          const error = () =>
            failure(
              "worker-unavailable",
              "Git worker request was canceled",
              signal.reason ?? new Error("Git worker request was canceled"),
            );
          if (signal.aborted) {
            resume(Effect.fail(error()));
            return;
          }
          const cancel = () => resume(Effect.fail(error()));
          signal.addEventListener("abort", cancel, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", cancel));
        });

      const request = <Method extends GitWorkerMethod>(input: {
        readonly method: Method;
        readonly params: GitWorkerMethodMap[Method]["params"];
        readonly signal?: AbortSignal;
      }): Effect.Effect<GitWorkerMethodMap[Method]["result"], GitWorkerRuntimeError> =>
        Effect.gen(function* () {
          if (input.signal?.aborted) return yield* externalCancellation(input.signal);
          const id = `main:${randomUUID()}`;
          const reply = yield* Deferred.make<unknown, GitWorkerRuntimeError>();
          const now = yield* Clock.currentTimeMillis;
          let admittedSession: WorkerSession | null = null;
          const pending = yield* stateLock
            .withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                if (current.closed) {
                  return yield* failure("worker-unavailable", "Git worker is shutting down");
                }
                const session = yield* ensureWorker();
                admittedSession = session;
                const requestState: MainRequestState = { method: input.method, reply, session };
                yield* Ref.update(state, (current) => ({
                  ...current,
                  mainRequests: new Map(current.mainRequests).set(id, requestState),
                }));
                const message = {
                  type: "worker-request",
                  workerId: "git",
                  request: {
                    id,
                    method: input.method,
                    params: input.params,
                    enqueuedAtMs: now,
                  },
                } as GitWorkerRequest;
                yield* Effect.try({
                  try: () => session.process.send(message),
                  catch: (cause) =>
                    failure("worker-unavailable", "Could not send the Git worker request", cause),
                });
                return requestState;
              }),
            )
            .pipe(
              Effect.catch((error) => {
                const session = admittedSession;
                if (!session) return Effect.fail(error);
                return handleFailure(session, new Error(error.message), "error").pipe(
                  Effect.andThen(Effect.fail(error)),
                );
              }),
            );
          const cancel = Ref.modify(state, (current) => {
            if (current.mainRequests.get(id) !== pending) return [false, current] as const;
            const mainRequests = new Map(current.mainRequests);
            mainRequests.delete(id);
            return [true, { ...current, mainRequests }] as const;
          }).pipe(
            Effect.tap((removed) =>
              Effect.sync(() => {
                if (!removed) return;
                sendBestEffort(pending.session.process, {
                  type: "worker-request-cancel",
                  workerId: "git",
                  id,
                });
              }),
            ),
            Effect.asVoid,
          );
          const response = input.signal
            ? Effect.raceFirst(Deferred.await(reply), externalCancellation(input.signal))
            : Deferred.await(reply);
          return (yield* response.pipe(
            Effect.ensuring(cancel),
          )) as GitWorkerMethodMap[Method]["result"];
        });

      const handleRendererMessage = (
        target: GitWorkerRendererTarget,
        message: GitWorkerMessageFromView,
      ): Effect.Effect<void, GitWorkerRuntimeError> => {
        let admittedSession: WorkerSession | null = null;
        return stateLock
          .withPermits(1)(
            Effect.gen(function* () {
              let current = yield* Ref.get(state);
              if (message.type === "worker-request-cancel") {
                const renderer = current.renderers.get(target.id);
                if (!renderer || current.requestOwners.get(message.id)?.ownerId !== target.id) {
                  return;
                }
                const requestOwners = new Map(current.requestOwners);
                requestOwners.delete(message.id);
                const requestIds = new Set(renderer.requestIds);
                requestIds.delete(message.id);
                const renderers = new Map(current.renderers).set(target.id, {
                  ...renderer,
                  requestIds,
                });
                yield* Ref.set(state, { ...current, renderers, requestOwners });
                if (current.current) {
                  sendBestEffort(current.current.process, {
                    type: "worker-request-cancel",
                    workerId: "git",
                    id: message.id,
                  });
                }
                return;
              }
              let renderer = current.renderers.get(target.id);
              if (!renderer) {
                const onDestroyed = () => {
                  void runCallback(releaseRenderer(target.id));
                };
                renderer = {
                  target,
                  requestIds: new Set(),
                  subscriptionIds: new Set(),
                  releaseDestruction: rendererDestruction.subscribe(target, onDestroyed),
                };
                current = {
                  ...current,
                  renderers: new Map(current.renderers).set(target.id, renderer),
                };
                yield* Ref.set(state, current);
              }
              if (current.closed) {
                sendInfrastructureError(
                  target,
                  message.request,
                  "worker-unavailable",
                  "Git worker is shutting down",
                );
                return;
              }
              if (
                current.requestOwners.has(message.request.id) ||
                current.mainRequests.has(message.request.id)
              ) {
                sendInfrastructureError(
                  target,
                  message.request,
                  "protocol-error",
                  "Git worker request id is already active",
                );
                return;
              }

              const method = message.request.method;
              const isLiveMethod =
                method === "subscribe-live-query" ||
                method === "unsubscribe-live-query" ||
                method === "recover-live-query" ||
                method === "refresh-live-query";
              let subscriptionOwners = new Map(current.subscriptionOwners);
              let subscriptionIds = new Set(renderer.subscriptionIds);
              if (isLiveMethod) {
                const subscriptionId = (
                  message.request.params as { readonly subscriptionId: string }
                ).subscriptionId;
                const existingOwner = subscriptionOwners.get(subscriptionId);
                if (method === "subscribe-live-query") {
                  if (existingOwner !== undefined && existingOwner !== target.id) {
                    sendInfrastructureError(
                      target,
                      message.request,
                      "protocol-error",
                      "Git live subscription belongs to another renderer",
                    );
                    return;
                  }
                  subscriptionOwners.set(subscriptionId, target.id);
                  subscriptionIds.add(subscriptionId);
                } else {
                  if (existingOwner !== target.id) {
                    sendInfrastructureError(
                      target,
                      message.request,
                      "protocol-error",
                      "Git live subscription is not owned by this renderer",
                    );
                    return;
                  }
                  if (method === "unsubscribe-live-query") {
                    subscriptionOwners.delete(subscriptionId);
                    subscriptionIds.delete(subscriptionId);
                  }
                }
              }

              const session = yield* ensureWorker();
              admittedSession = session;
              const requestIds = new Set(renderer.requestIds).add(message.request.id);
              const renderers = new Map((yield* Ref.get(state)).renderers).set(target.id, {
                ...renderer,
                requestIds,
                subscriptionIds,
              });
              const latest = yield* Ref.get(state);
              yield* Ref.set(state, {
                ...latest,
                renderers,
                requestOwners: new Map(latest.requestOwners).set(message.request.id, {
                  ownerId: target.id,
                  method: message.request.method,
                }),
                subscriptionOwners,
              });
              yield* Effect.try({
                try: () => session.process.send(message),
                catch: (cause) =>
                  failure("worker-unavailable", "Could not send the Git worker request", cause),
              });
            }),
          )
          .pipe(
            Effect.catch((error) => {
              const session = admittedSession;
              if (!session) return Effect.fail(error);
              return handleFailure(session, new Error(error.message), "error").pipe(
                Effect.andThen(Effect.fail(error)),
              );
            }),
          );
      };

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const released = yield* stateLock.withPermits(1)(
            Ref.modify(state, (current) => {
              const [withoutRequests, failed] = clearRequests(current);
              return [
                { failed, renderers: current.renderers, session: current.current },
                {
                  ...withoutRequests,
                  closed: true,
                  renderers: new Map(),
                },
              ] as const;
            }),
          );
          for (const renderer of released.renderers.values()) {
            renderer.releaseDestruction();
          }
          yield* rejectRequests(
            released.failed,
            failure("worker-unavailable", "Git worker is shutting down"),
          );
          if (!released.session) return;
          sendBestEffort(released.session.process, { type: "worker-shutdown", workerId: "git" });
          const gracefulExit = Deferred.await(released.session.exit).pipe(Effect.asVoid);
          const forceExit = Effect.sleep(
            Math.max(0, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
          ).pipe(
            Effect.andThen(
              Effect.tryPromise(() => released.session?.process.terminate() ?? Promise.resolve(0)),
            ),
            Effect.ignore,
            Effect.asVoid,
          );
          yield* Effect.raceFirst(gracefulExit, forceExit);
          released.session.releaseListeners();
        }),
      );

      return GitWorkerRuntime.of({ handleRendererMessage, request });
    }),
  ).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
