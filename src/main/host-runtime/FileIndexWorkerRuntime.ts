import { Worker } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { FileSearchEvent, FileSearchIncomplete } from "../../shared/file-search";
import { MainConfig } from "../app/MainConfig";
import { FILE_INDEX_TIMINGS } from "../file-index-worker/file-index-timings";
import {
  isFileIndexWorkerThreadMessage,
  type FileIndexWorkerData,
  type FileIndexWorkerHostMessage,
} from "../file-index-worker/file-index-worker-protocol";
import { RipgrepExecutionRuntime } from "../platform/node/RipgrepExecutionRuntime";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;
const WORKER_IDLE_RETIREMENT = Duration.sum(FILE_INDEX_TIMINGS.idleRelease, Duration.minutes(1));

export interface LocalFileSearchSession {
  readonly update: (query: string) => Effect.Effect<void>;
}

/**
 * Local file-name search sessions. Indexing and ranking run in one worker that shares an index
 * per root across sessions; Main only routes queries and delivers results.
 */
export class FileIndexWorkerRuntime extends Context.Service<
  FileIndexWorkerRuntime,
  {
    /** Closing the Scope ends the session; the worker keeps the root warm for later searches. */
    readonly openSession: (
      input: { readonly sessionId: string; readonly roots: readonly string[] },
      onEvent: (event: FileSearchEvent) => Effect.Effect<void>,
    ) => Effect.Effect<LocalFileSearchSession, never, Scope.Scope>;
  }
>()("nodex/main/host-runtime/FileIndexWorkerRuntime") {}

export interface FileIndexWorkerProcess {
  readonly send: (message: FileIndexWorkerHostMessage) => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  readonly onExit: (listener: (code: number) => void) => () => void;
  readonly terminate: () => Promise<number>;
}

export type FileIndexWorkerProcessFactory = (input: {
  readonly workerPath: string;
  readonly workerData: FileIndexWorkerData;
}) => FileIndexWorkerProcess;

export interface FileIndexWorkerRuntimeOptions {
  readonly workerPath: string;
  readonly createProcess?: FileIndexWorkerProcessFactory;
  readonly shutdownTimeoutMs?: number;
}

class FileIndexWorkerUnavailable extends Schema.TaggedError<FileIndexWorkerUnavailable>()(
  "FileIndexWorkerUnavailable",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

interface WorkerSession {
  readonly epoch: number;
  readonly process: FileIndexWorkerProcess;
  readonly exit: Deferred.Deferred<number>;
  releaseListeners: () => void;
}

interface SearchSession {
  readonly id: string;
  readonly roots: readonly string[];
  readonly onEvent: (event: FileSearchEvent) => Effect.Effect<void>;
  /** The worker generation that holds this session, if any. */
  openedIn: WorkerSession | null;
  seq: number;
  pending: SearchQuery | null;
}

interface SearchQuery {
  readonly seq: number;
  readonly text: string;
  sentTo: WorkerSession | null;
  replayed: boolean;
}

const UNAVAILABLE = { reason: "unavailable" } as const;

const createNodeProcess: FileIndexWorkerProcessFactory = (input) => {
  const worker = new Worker(input.workerPath, {
    name: "file-index",
    workerData: input.workerData,
    // The worker bounds Rust index storage separately. This ceiling applies to the
    // JavaScript heap, including directory checks and search sessions.
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

export const live = (
  options: FileIndexWorkerRuntimeOptions,
): Layer.Layer<FileIndexWorkerRuntime, never, MainConfig | RipgrepExecutionRuntime> =>
  Layer.effect(
    FileIndexWorkerRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const ripgrep = yield* RipgrepExecutionRuntime;
      const createProcess = options.createProcess ?? createNodeProcess;
      const environment = Object.fromEntries(
        Object.entries({
          ...config.environment,
          PATH: config.environmentPath ?? config.environment.PATH,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const startLock = yield* Semaphore.make(1);
      const callbacks = yield* FiberSet.make();
      const runCallback = yield* FiberSet.runtime(callbacks)();
      const retiring = yield* FiberSet.make();
      const idleRetirement = yield* FiberHandle.make();
      const searches = new Map<string, SearchSession>();
      let current: WorkerSession | null = null;
      let nextEpoch = 1;
      let closed = false;

      const stopWorker = Effect.fnUntraced(function* (worker: WorkerSession) {
        yield* Effect.try(() => worker.process.send({ type: "shutdown" })).pipe(Effect.ignore);
        yield* Effect.raceFirst(
          Deferred.await(worker.exit).pipe(Effect.asVoid),
          Effect.sleep(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS).pipe(
            Effect.andThen(Effect.tryPromise(() => worker.process.terminate())),
            Effect.ignore,
          ),
        );
        worker.releaseListeners();
      }, Effect.uninterruptible);

      const retireWorker = Effect.fnUntraced(function* (worker: WorkerSession) {
        if (closed || searches.size > 0 || current !== worker) return;
        // Detach before stopping so a new search can start a worker immediately.
        current = null;
        yield* FiberSet.run(retiring, stopWorker(worker));
      }, Effect.uninterruptible);

      const scheduleIdleRetirement = Effect.fnUntraced(function* () {
        const worker = current;
        if (closed || searches.size > 0 || !worker) return;
        yield* FiberHandle.run(
          idleRetirement,
          Effect.sleep(WORKER_IDLE_RETIREMENT).pipe(
            Effect.andThen(retireWorker(worker)),
            Effect.interruptible,
          ),
        );
      });

      const isPending = (search: SearchSession, query: SearchQuery) =>
        searches.get(search.id) === search && search.pending === query;

      const settle = Effect.fnUntraced(function* (
        search: SearchSession,
        query: SearchQuery,
        incomplete?: FileSearchIncomplete,
      ) {
        if (!isPending(search, query)) return;
        search.pending = null;
        yield* search.onEvent({
          method: "fuzzyFileSearch/sessionCompleted",
          params: {
            sessionId: search.id,
            query: query.text,
            ...(incomplete ? { incomplete } : {}),
          },
        });
      });

      const handleFailure = Effect.fnUntraced(function* (
        worker: WorkerSession,
        error: Error,
        phase: "error" | "exit" | "protocol" | "send",
      ): Effect.fn.Return<void> {
        if (current !== worker) return;
        current = null;
        const recoveries: Effect.Effect<void>[] = [];
        for (const search of searches.values()) {
          if (search.openedIn === worker) search.openedIn = null;
          const query = search.pending;
          if (!query || query.sentTo !== worker) continue;
          query.sentTo = null;
          if (query.replayed) recoveries.push(settle(search, query, UNAVAILABLE));
          else {
            query.replayed = true;
            recoveries.push(dispatch(search, query));
          }
        }
        yield* Effect.logWarning("File search worker stopped", {
          epoch: worker.epoch,
          phase,
          error: error.message,
        }).pipe(
          Effect.andThen(Effect.all(recoveries, { concurrency: "unbounded", discard: true })),
          Effect.ensuring(
            Effect.tryPromise(() => worker.process.terminate()).pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(worker.releaseListeners)),
            ),
          ),
        );
      });

      const send = (worker: WorkerSession, message: FileIndexWorkerHostMessage) =>
        Effect.try(() => worker.process.send(message)).pipe(
          Effect.catch(() =>
            handleFailure(worker, new Error("Could not reach file search"), "send"),
          ),
        );

      const handleMessage = Effect.fnUntraced(function* (worker: WorkerSession, raw: unknown) {
        if (current !== worker) return;
        if (!isFileIndexWorkerThreadMessage(raw))
          return yield* handleFailure(
            worker,
            new Error("File index worker sent an invalid message"),
            "protocol",
          );
        if (raw.type === "ready") {
          if (raw.epoch === worker.epoch) return;
          return yield* handleFailure(
            worker,
            new Error("File index worker started in another generation"),
            "protocol",
          );
        }
        const search = searches.get(raw.sessionId);
        const query = search?.pending;
        if (!search || !query || query.sentTo !== worker || query.seq !== raw.seq) return;
        if (raw.outcome.kind === "completed")
          return yield* settle(search, query, raw.outcome.incomplete);
        yield* search.onEvent({
          method: "fuzzyFileSearch/sessionUpdated",
          params: { sessionId: search.id, query: query.text, files: raw.outcome.files },
        });
      });

      const ensureWorker = startLock.withPermit(
        Effect.gen(function* () {
          if (closed)
            return yield* new FileIndexWorkerUnavailable({
              message: "File search is shutting down",
            });
          if (current) return current;
          const ripgrepPath = yield* ripgrep.resolve.pipe(
            Effect.mapError(
              (cause) =>
                new FileIndexWorkerUnavailable({ message: "File search is unavailable", cause }),
            ),
          );
          const exit = yield* Deferred.make<number>();
          return yield* Effect.try({
            try: () => {
              if (closed) throw new Error("File search is shutting down");
              const epoch = nextEpoch++;
              const process = createProcess({
                workerPath: options.workerPath,
                workerData: { epoch, ripgrepPath, environment },
              });
              const worker: WorkerSession = {
                epoch,
                process,
                exit,
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
                        new Error(`File index worker exited with code ${String(code)}`),
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
              return worker;
            },
            catch: (cause) =>
              new FileIndexWorkerUnavailable({ message: "Could not start file search", cause }),
          });
        }).pipe(
          // A session can close while startup still awaits ripgrep.
          Effect.tap(scheduleIdleRetirement),
        ),
      );

      const dispatch = Effect.fnUntraced(function* (
        search: SearchSession,
        query: SearchQuery,
      ): Effect.fn.Return<void> {
        if (!isPending(search, query)) return;
        const started = yield* Effect.result(ensureWorker);
        if (!isPending(search, query)) return;
        if (started._tag === "Failure") {
          yield* Effect.logWarning("Could not search workspace files", started.failure);
          return yield* settle(search, query, UNAVAILABLE);
        }
        const worker = started.success;
        const sent = yield* Effect.result(
          Effect.try(() => {
            if (!isPending(search, query) || worker !== current) return false;
            if (search.openedIn !== worker) {
              worker.process.send({ type: "open", sessionId: search.id, roots: search.roots });
              search.openedIn = worker;
            }
            worker.process.send({
              type: "query",
              sessionId: search.id,
              seq: query.seq,
              query: query.text,
            });
            query.sentTo = worker;
            return true;
          }),
        );
        if (sent._tag === "Success") {
          if (!sent.success) yield* settle(search, query, UNAVAILABLE);
          return;
        }
        // A query that could not be sent settles here. Other searches may have lost a worker.
        yield* handleFailure(worker, new Error("Could not reach file search"), "send").pipe(
          Effect.ensuring(settle(search, query, UNAVAILABLE)),
        );
      });

      const update = Effect.fnUntraced(function* (search: SearchSession, text: string) {
        if (searches.get(search.id) !== search) return;
        const seq = ++search.seq;
        if (!text) {
          search.pending = null;
          if (search.openedIn && search.openedIn === current)
            yield* send(current, { type: "query", sessionId: search.id, seq, query: text });
          return;
        }
        const query: SearchQuery = { seq, text, sentTo: null, replayed: false };
        search.pending = query;
        yield* dispatch(search, query);
      });

      const openSession = (
        input: { readonly sessionId: string; readonly roots: readonly string[] },
        onEvent: (event: FileSearchEvent) => Effect.Effect<void>,
      ) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const search: SearchSession = {
              id: input.sessionId,
              roots: [...input.roots],
              onEvent,
              openedIn: null,
              seq: 0,
              pending: null,
            };
            searches.set(search.id, search);
            yield* FiberHandle.clear(idleRetirement);
            return search;
          }),
          (search) =>
            Effect.gen(function* () {
              if (searches.get(search.id) !== search) return;
              searches.delete(search.id);
              if (search.openedIn && search.openedIn === current)
                yield* send(current, { type: "close", sessionId: search.id });
              yield* scheduleIdleRetirement();
            }),
        ).pipe(
          Effect.map((search): LocalFileSearchSession => ({
            update: (query) => update(search, query),
          })),
        );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          const worker = current;
          current = null;
          for (const search of searches.values()) {
            if (search.pending) yield* settle(search, search.pending, UNAVAILABLE);
          }
          if (worker) yield* stopWorker(worker);
        }),
      );

      return FileIndexWorkerRuntime.of({ openSession });
    }),
  );
