import { Worker } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { FileSearchEvent } from "../../shared/file-search";
import { MainConfig } from "../app/MainConfig";
import {
  isFileIndexWorkerThreadMessage,
  type FileIndexWorkerData,
  type FileIndexWorkerHostMessage,
} from "../file-index-worker/file-index-worker-protocol";
import { RipgrepExecutionRuntime } from "../platform/node/RipgrepExecutionRuntime";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;

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
  query: string;
  /** The latest query has completed or failed. */
  settled: boolean;
}

const createNodeProcess: FileIndexWorkerProcessFactory = (input) => {
  const worker = new Worker(input.workerPath, {
    name: "file-index",
    workerData: input.workerData,
    // Indexes stay within their entry bounds (about 70 MiB when full); this ceiling stops a
    // runaway worker without touching Main, and the next search starts a new one.
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
      const searches = new Map<string, SearchSession>();
      let current: WorkerSession | null = null;
      let nextEpoch = 1;
      let closed = false;

      const failed = (search: SearchSession) =>
        search.onEvent({
          method: "file-search/sessionFailed",
          params: { sessionId: search.id, query: search.query },
        });

      const handleFailure = (
        worker: WorkerSession,
        error: Error,
        phase: "error" | "exit" | "protocol",
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (current !== worker) return;
          current = null;
          worker.releaseListeners();
          yield* Effect.logWarning("File search worker stopped", {
            epoch: worker.epoch,
            phase,
            error: error.message,
          });
          // The index died with the worker; the next query opens the session in a new one.
          for (const search of searches.values()) {
            if (search.openedIn !== worker) continue;
            search.openedIn = null;
            if (search.settled) continue;
            search.settled = true;
            yield* failed(search);
          }
          yield* Effect.tryPromise(() => worker.process.terminate()).pipe(Effect.ignore);
        });

      const send = (worker: WorkerSession, message: FileIndexWorkerHostMessage) =>
        Effect.try({
          try: () => worker.process.send(message),
          catch: (cause) =>
            new FileIndexWorkerUnavailable({ message: "Could not reach file search", cause }),
        }).pipe(
          Effect.tapError((error) => handleFailure(worker, new Error(error.message), "error")),
        );

      const handleMessage = (worker: WorkerSession, raw: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
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
          if (!search || search.openedIn !== worker || search.seq !== raw.seq || search.settled)
            return;
          const params = { sessionId: search.id, query: search.query };
          if (raw.outcome.kind === "updated")
            return yield* search.onEvent({
              method: "fuzzyFileSearch/sessionUpdated",
              params: { ...params, files: raw.outcome.files },
            });
          search.settled = true;
          yield* raw.outcome.kind === "completed"
            ? search.onEvent({ method: "fuzzyFileSearch/sessionCompleted", params })
            : failed(search);
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
          const epoch = nextEpoch++;
          const process = yield* Effect.try({
            try: () =>
              createProcess({
                workerPath: options.workerPath,
                workerData: { epoch, ripgrepPath, environment },
              }),
            catch: (cause) =>
              new FileIndexWorkerUnavailable({ message: "Could not start file search", cause }),
          });
          const worker: WorkerSession = {
            epoch,
            process,
            exit: yield* Deferred.make<number>(),
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
        }),
      );

      /** Opens the session in the current worker unless it closed while the worker started. */
      const attach = (search: SearchSession) =>
        Effect.gen(function* () {
          const worker = yield* ensureWorker;
          return yield* Effect.try({
            try: () => {
              if (searches.get(search.id) !== search) return null;
              if (search.openedIn !== worker) {
                search.openedIn = worker;
                worker.process.send({ type: "open", sessionId: search.id, roots: search.roots });
              }
              return worker;
            },
            catch: (cause) =>
              new FileIndexWorkerUnavailable({ message: "Could not reach file search", cause }),
          }).pipe(
            Effect.tapError((error) => handleFailure(worker, new Error(error.message), "error")),
          );
        });

      const update = (search: SearchSession, query: string) =>
        Effect.gen(function* () {
          if (searches.get(search.id) !== search) return;
          const seq = ++search.seq;
          search.query = query;
          search.settled = !query;
          if (!query) {
            if (search.openedIn && search.openedIn === current)
              yield* send(current, { type: "query", sessionId: search.id, seq, query }).pipe(
                Effect.ignore,
              );
            return;
          }
          const sent = yield* attach(search).pipe(
            Effect.flatMap((worker) =>
              worker
                ? send(worker, { type: "query", sessionId: search.id, seq, query })
                : Effect.void,
            ),
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Could not search workspace files", error).pipe(Effect.as(false)),
            ),
          );
          if (sent || search.seq !== seq || search.settled) return;
          search.settled = true;
          yield* failed(search);
        });

      const openSession = (
        input: { readonly sessionId: string; readonly roots: readonly string[] },
        onEvent: (event: FileSearchEvent) => Effect.Effect<void>,
      ) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const search: SearchSession = {
              id: input.sessionId,
              roots: [...input.roots],
              onEvent,
              openedIn: null,
              seq: 0,
              query: "",
              settled: true,
            };
            searches.set(search.id, search);
            return search;
          }),
          (search) =>
            Effect.gen(function* () {
              if (searches.get(search.id) === search) searches.delete(search.id);
              if (search.openedIn && search.openedIn === current)
                yield* send(current, { type: "close", sessionId: search.id }).pipe(Effect.ignore);
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

      return FileIndexWorkerRuntime.of({ openSession });
    }),
  );
