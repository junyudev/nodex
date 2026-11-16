// @effect-diagnostics nodeBuiltinImport:off
import { parentPort, workerData } from "node:worker_threads";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";
import {
  prepareSearchIndexSlice,
  publishSearchIndexSlice,
  type SearchIndexSlice,
} from "./SessionSearchIndexer.ts";

export type SearchWorkerRequest = "prepare" | "publish";
export type SearchWorkerReply = { readonly more: boolean } | { readonly error: string };

/** The packaged entry dispatches here without starting another Runtime. */
export function runSessionSearchWorker(filename: string) {
  const port = parentPort;
  if (!port) throw new Error("Session search indexing requires a worker port");
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<SearchWorkerRequest>();
        const onMessage = (request: SearchWorkerRequest) => {
          Queue.offerUnsafe(queue, request);
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => port.on("message", onMessage)),
          () =>
            Effect.sync(() => {
              port.off("message", onMessage);
            }),
        );
        const reader = Context.get(
          yield* Layer.build(NodeSqliteClient.layer({ filename, readonly: true })),
          SqlClient.SqlClient,
        );
        const writer = Context.get(
          yield* Layer.build(NodeSqliteClient.layer({ filename })),
          SqlClient.SqlClient,
        );
        // The Runtime coordinates local writers asynchronously. A competing process may still hold SQLite.
        yield* writer`PRAGMA busy_timeout=25`;
        yield* reader`PRAGMA busy_timeout=25`;
        let slice: SearchIndexSlice | null = null;
        while (true) {
          const request = yield* Queue.take(queue);
          const result = yield* Effect.result(
            Effect.gen(function* () {
              if (request === "prepare") {
                slice = yield* prepareSearchIndexSlice(reader);
                return slice !== null;
              }
              if (!slice) return false;
              const publishing = slice;
              slice = null;
              yield* publishSearchIndexSlice(writer, publishing);
              return true;
            }),
          );
          const reply: SearchWorkerReply =
            result._tag === "Success"
              ? { more: result.success }
              : { error: String(result.failure) };
          port.postMessage(reply);
        }
      }),
    ),
  );
}

// Source-only Runtime tests start this module directly. The desktop build uses its single entrypoint.
if (import.meta.url.endsWith(".ts") && workerData?.kind === "session-search-index") {
  await runSessionSearchWorker(workerData.filename);
}
