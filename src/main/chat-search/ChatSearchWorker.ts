import { Worker } from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import {
  isChatSearchWorkerThreadMessage,
  type ChatSearchWorkerCall,
  type ChatSearchWorkerData,
  type ChatSearchWorkerHostMessage,
} from "../chat-search-worker/chat-search-worker-protocol";
import type { ChatCatalogItem } from "./ChatCatalogProjection";
import {
  ChatSearchEngine,
  ChatSearchEngineUnavailable,
  type ChatMessagesRanked,
  type ChatRanked,
  type SessionSearchRequest,
} from "./ChatSearchEngine";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;

export interface ChatSearchWorkerProcess {
  readonly send: (message: ChatSearchWorkerHostMessage) => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  readonly onExit: (listener: (code: number) => void) => () => void;
  readonly terminate: () => Promise<number>;
}

export type ChatSearchWorkerProcessFactory = (input: {
  readonly workerPath: string;
  readonly workerData: ChatSearchWorkerData;
}) => ChatSearchWorkerProcess;

export interface ChatSearchWorkerOptions {
  readonly workerPath: string;
  readonly createProcess?: ChatSearchWorkerProcessFactory;
  readonly shutdownTimeoutMs?: number;
}

interface WorkerSession {
  readonly epoch: number;
  readonly process: ChatSearchWorkerProcess;
  readonly exit: Deferred.Deferred<number>;
  /** The shared catalog this worker last received. */
  catalog: readonly ChatCatalogItem[] | null;
  releaseListeners: () => void;
}

interface PendingCall {
  readonly worker: WorkerSession;
  readonly reply: Deferred.Deferred<unknown, ChatSearchEngineUnavailable>;
}

const createNodeProcess: ChatSearchWorkerProcessFactory = (input) => {
  const worker = new Worker(input.workerPath, {
    name: "chat-search",
    workerData: input.workerData,
    // A full catalog and its index stay well below this; the ceiling stops a runaway worker
    // without touching Main, and the next search starts a new one.
    resourceLimits: { maxOldGenerationSizeMb: 512 },
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
 * One shared worker ranks every window's chat searches, so typing never blocks Main. Main keeps
 * the latest catalog, hands it to each worker it starts, and answers the worker's Runtime history
 * requests over the Runtime connection it owns.
 */
export const live = (
  options: ChatSearchWorkerOptions,
): Layer.Layer<ChatSearchEngine, never, AgentRuntimeApplication> =>
  Layer.effect(
    ChatSearchEngine,
    Effect.gen(function* () {
      const runtime = yield* AgentRuntimeApplication;
      const createProcess = options.createProcess ?? createNodeProcess;
      const startLock = yield* Semaphore.make(1);
      const callbacks = yield* FiberSet.make();
      const runCallback = yield* FiberSet.runtime(callbacks)();
      const calls = new Map<number, PendingCall>();
      let latest: readonly ChatCatalogItem[] | null = null;
      let current: WorkerSession | null = null;
      let nextEpoch = 1;
      let nextCall = 1;
      let closed = false;

      const handleFailure = (
        worker: WorkerSession,
        error: Error,
        phase: "error" | "exit" | "protocol",
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (current !== worker) return;
          current = null;
          worker.releaseListeners();
          yield* Effect.logWarning("Chat search worker stopped", {
            epoch: worker.epoch,
            phase,
            error: error.message,
          });
          // The next search starts another worker, which receives the latest catalog first.
          for (const [id, call] of calls) {
            if (call.worker !== worker) continue;
            calls.delete(id);
            yield* Deferred.fail(
              call.reply,
              new ChatSearchEngineUnavailable({ message: "Chat search stopped", cause: error }),
            );
          }
          yield* Effect.tryPromise(() => worker.process.terminate()).pipe(Effect.ignore);
        });

      const send = (worker: WorkerSession, message: ChatSearchWorkerHostMessage) =>
        Effect.try({
          try: () => worker.process.send(message),
          catch: (cause) =>
            new ChatSearchEngineUnavailable({ message: "Could not reach chat search", cause }),
        }).pipe(
          Effect.tapError((error) => handleFailure(worker, new Error(error.message), "error")),
        );

      const deliverCatalog = (worker: WorkerSession) =>
        Effect.gen(function* () {
          const entries = latest;
          if (!entries || worker.catalog === entries) return;
          yield* send(worker, { type: "publish", entries });
          worker.catalog = entries;
        });

      const answerHistory = (worker: WorkerSession, id: number, request: SessionSearchRequest) =>
        runtime.sessionSearch(request).pipe(
          Effect.provideService(CoreApplicationAgent, null),
          Effect.exit,
          Effect.flatMap((exit) =>
            current === worker
              ? send(worker, {
                  type: "history",
                  id,
                  outcome: Exit.isSuccess(exit)
                    ? { ok: true, value: exit.value }
                    : { ok: false, message: "Chat history is unavailable" },
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
        );

      const handleMessage = (worker: WorkerSession, raw: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (current !== worker) return;
          if (!isChatSearchWorkerThreadMessage(raw))
            return yield* handleFailure(
              worker,
              new Error("Chat search worker sent an invalid message"),
              "protocol",
            );
          if (raw.type === "ready") {
            if (raw.epoch === worker.epoch) return;
            return yield* handleFailure(
              worker,
              new Error("Chat search worker started in another generation"),
              "protocol",
            );
          }
          if (raw.type === "history") return yield* answerHistory(worker, raw.id, raw.request);
          const call = calls.get(raw.id);
          if (!call || call.worker !== worker) return;
          calls.delete(raw.id);
          yield* Deferred.done(
            call.reply,
            raw.outcome.ok
              ? Exit.succeed(raw.outcome.value)
              : Exit.fail(new ChatSearchEngineUnavailable({ message: raw.outcome.message })),
          );
        });

      const ensureWorker = startLock.withPermit(
        Effect.gen(function* () {
          if (closed)
            return yield* new ChatSearchEngineUnavailable({
              message: "Chat search is shutting down",
            });
          if (current) return current;
          const epoch = nextEpoch++;
          const process = yield* Effect.try({
            try: () => createProcess({ workerPath: options.workerPath, workerData: { epoch } }),
            catch: (cause) =>
              new ChatSearchEngineUnavailable({ message: "Could not start chat search", cause }),
          });
          const worker: WorkerSession = {
            epoch,
            process,
            exit: yield* Deferred.make<number>(),
            catalog: null,
            releaseListeners: () => undefined,
          };
          const releaseMessage = process.onMessage((message) => {
            void runCallback(handleMessage(worker, message));
          });
          const releaseError = process.onError((error) => {
            void runCallback(handleFailure(worker, error, "error"));
          });
          const releaseExit = process.onExit((code) => {
            void runCallback(
              Deferred.succeed(worker.exit, code).pipe(
                Effect.andThen(
                  handleFailure(
                    worker,
                    new Error(`Chat search worker exited with code ${String(code)}`),
                    "exit",
                  ),
                ),
              ),
            );
          });
          worker.releaseListeners = () => {
            releaseMessage();
            releaseError();
            releaseExit();
          };
          current = worker;
          yield* deliverCatalog(worker);
          return worker;
        }),
      );

      const call = <A>(
        message: ChatSearchWorkerCall,
      ): Effect.Effect<A, ChatSearchEngineUnavailable> =>
        Effect.gen(function* () {
          const worker = yield* ensureWorker;
          const id = nextCall++;
          const reply = yield* Deferred.make<unknown, ChatSearchEngineUnavailable>();
          calls.set(id, { worker, reply });
          return yield* send(worker, { type: "call", id, call: message }).pipe(
            Effect.andThen(Deferred.await(reply)),
            Effect.onInterrupt(() =>
              calls.has(id) && current === worker
                ? send(worker, { type: "cancel", id }).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.ensuring(Effect.sync(() => calls.delete(id))),
          );
          // Main and the worker ship together, so each method's answer has its declared shape.
        }).pipe(Effect.map((value) => value as A));

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          const worker = current;
          current = null;
          if (!worker) return;
          yield* Effect.try(() => worker.process.send({ type: "shutdown" })).pipe(Effect.ignore);
          yield* Effect.raceFirst(
            Deferred.await(worker.exit).pipe(Effect.asVoid),
            Effect.sleep(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS).pipe(
              Effect.andThen(Effect.tryPromise(() => worker.process.terminate())),
              Effect.ignore,
            ),
          );
          worker.releaseListeners();
        }),
      );

      return ChatSearchEngine.of({
        publish: (entries) =>
          Effect.gen(function* () {
            latest = entries;
            yield* deliverCatalog(yield* ensureWorker);
          }).pipe(
            // The next search starts another worker, which receives this catalog first.
            Effect.catch((error) => Effect.logWarning("Chat search worker is unavailable", error)),
          ),
        search: (request) => call<ChatRanked>({ method: "search", request }),
        searchMessages: (request) =>
          call<ChatMessagesRanked>({ method: "searchMessages", request }),
        rankSessionIds: (request) => call<readonly string[]>({ method: "rankSessionIds", request }),
      });
    }),
  );
