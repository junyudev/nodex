// @effect-diagnostics nodeBuiltinImport:off
import { Worker } from "node:worker_threads";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import { searchKernel } from "@nodex/search-kernel/node";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  prepareSearchIndexSlice,
  publishSearchIndexSlice,
  searchThreadAdmission,
} from "./SessionSearchIndexer.ts";
import { searchableThread } from "./SessionSearchSources.ts";
import type { SearchWorkerReply, SearchWorkerRequest } from "./SessionSearchWorkerEntry.ts";

export { searchThreadAdmission } from "./SessionSearchIndexer.ts";
const backgroundWriters = new WeakSet<SqlClient.SqlClient>();

/** A VACUUM may renumber canonical rowids. Scan stable source IDs and reuse their folded text. */
export const invalidateSessionSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO session_search_dirty(thread_id,scan) SELECT thread_id,0 FROM orchestration_v2_projection_threads thread WHERE ${searchableThread(sql, "thread")}
    ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,scan=0,message_at='',action_ordinal=-1,source_id=''`;
  yield* sql`INSERT INTO session_search_dirty(thread_id,scan) SELECT thread_id,0 FROM session_search_native_threads WHERE 1
    ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,scan=0,message_at='',action_ordinal=-1,source_id=''`;
});

/** Queue a model change once, keeping an interrupted rebuild's scan positions on restart. */
export const reconcileSessionSearchAnalyzer = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const version = searchKernel().analyzerVersion();
  const key = "session-search-analyzer";
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [previous] = yield* sql<{ readonly schema_version: number }>`
        SELECT schema_version FROM orchestration_v2_projection_metadata WHERE projection_name=${key}`;
      if (previous?.schema_version === version) return;
      yield* invalidateSessionSearch;
      yield* sql`INSERT INTO orchestration_v2_projection_metadata(projection_name,schema_version,last_sequence,updated_at)
        VALUES(${key},${version},0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(projection_name) DO UPDATE SET schema_version=excluded.schema_version,updated_at=excluded.updated_at`;
    }),
  );
});

/** Isolated Stores apply the same slices locally. Live Stores index on a dedicated worker. */
export const indexSessionSearchBatch = Effect.fn("SessionSearch.indexBatch")(function* (
  threadIds?: readonly string[],
) {
  const sql = yield* SqlClient.SqlClient;
  const slice = yield* prepareSearchIndexSlice(sql, threadIds);
  if (!slice) return false;
  yield* publishSearchIndexSlice(sql, slice);
  return true;
});

export const refreshSessionSearch = Effect.fn("SessionSearch.refresh")(function* (
  threadIds?: readonly string[],
) {
  const sql = yield* SqlClient.SqlClient;
  if (backgroundWriters.has(sql)) return;
  const [dirty] =
    yield* sql`SELECT 1 FROM session_search_dirty WHERE ${searchThreadAdmission(sql, threadIds)} LIMIT 1`;
  if (!dirty) return;
  while (yield* indexSessionSearchBatch(threadIds)) yield* Effect.yieldNow;
});

class SearchWorkerError extends Schema.TaggedError<SearchWorkerError>()("SearchWorkerError", {
  message: Schema.String,
}) {}

const openSearchWorker = Effect.fn("SessionSearch.openIndexWorker")(function* (filename: string) {
  const source = import.meta.url.endsWith(".ts");
  // The packaged daemon is a split chunk under chunks/. Its entrypoint also dispatches worker jobs.
  const entry = new URL(source ? "./SessionSearchWorkerEntry.ts" : "../entry.mjs", import.meta.url);
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new Worker(entry, {
          workerData: { kind: "session-search-index", filename },
          execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
        }),
      catch: (cause) => new SearchWorkerError({ message: String(cause) }),
    }),
    (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
  );
  let failure: SearchWorkerError | undefined;
  let notifyFailure: ((error: SearchWorkerError) => void) | undefined;
  const fail = (message: string) => {
    failure = new SearchWorkerError({ message });
    notifyFailure?.(failure);
  };
  worker.on("error", (error) => fail(error.message));
  worker.on("exit", (code) => fail(`Session search worker exited (${code})`));
  return (request: SearchWorkerRequest) =>
    Effect.callback<boolean, SearchWorkerError>((resume) => {
      if (failure) {
        resume(Effect.fail(failure));
        return;
      }
      const clean = () => {
        worker.off("message", reply);
        notifyFailure = undefined;
      };
      const reply = (value: SearchWorkerReply) => {
        clean();
        resume(
          "error" in value
            ? Effect.fail(new SearchWorkerError({ message: value.error }))
            : Effect.succeed(value.more),
        );
      };
      notifyFailure = (error) => {
        clean();
        resume(Effect.fail(error));
      };
      worker.once("message", reply);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not use browser origins.
      worker.postMessage(request);
      return Effect.sync(clean);
    });
});

export const startSessionSearchIndex = Effect.fn("SessionSearch.startIndex")(function* (
  filename: string,
) {
  const sql = yield* SqlClient.SqlClient;
  backgroundWriters.add(sql);
  yield* Effect.gen(function* () {
    const command = yield* openSearchWorker(filename);
    let active = false;
    while (true) {
      yield* Effect.sleep(active ? "1 millis" : "50 millis");
      active = yield* command("prepare");
      if (active) yield* NodeSqliteClient.withExternalWriter(sql, command("publish"));
    }
  }).pipe(
    Effect.scoped,
    Effect.tapError((error) => Effect.logWarning("Session search indexing will retry", { error })),
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.forkScoped,
  );
});
