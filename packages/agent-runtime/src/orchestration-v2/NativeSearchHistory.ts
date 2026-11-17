import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A host-qualified key keeps native identities separate from Runtime execution roots. */
export const nativeSearchThreadId = (hostId: string, threadId: string) =>
  `native:${JSON.stringify([hostId, threadId])}`;
export const isNativeSearchThreadId = (id: string) => id.startsWith("native:[");
export interface NativeSearchItem {
  readonly itemId: string;
  readonly runId: string;
  readonly role: "user" | "assistant" | "command_execution" | "file_change";
  readonly text: string;
  readonly at: string;
}
export type NativeSearchHistoryInput =
  | { readonly kind: "admit"; readonly threadId: string; readonly revision: string }
  | {
      readonly kind: "page";
      readonly threadId: string;
      readonly revision: string;
      readonly cursor: string | null;
      readonly complete: boolean;
      readonly items: readonly NativeSearchItem[];
    }
  | { readonly kind: "reset"; readonly threadId: string }
  | { readonly kind: "prune"; readonly threadIds: readonly string[] };
export interface NativeSearchHistoryState {
  readonly cursor: string | null;
  readonly complete: boolean;
}
/** Persist read positions with their items. A changed conversation resumes at its last stable anchor. */
export const syncNativeSearchHistory = Effect.fn("SessionSearch.syncNative")(function* (
  input: NativeSearchHistoryInput,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (input.kind === "prune") {
        yield* sql`DELETE FROM session_search_native_items WHERE thread_id NOT IN (SELECT value FROM json_each(${JSON.stringify(input.threadIds)}))`;
        yield* sql`DELETE FROM session_search_native_threads WHERE thread_id NOT IN (SELECT value FROM json_each(${JSON.stringify(input.threadIds)}))`;
        return { cursor: null, complete: true };
      }
      if (input.kind === "reset") {
        yield* sql`DELETE FROM session_search_native_items WHERE thread_id=${input.threadId}`;
        yield* sql`UPDATE session_search_native_threads SET cursor=NULL,complete=0 WHERE thread_id=${input.threadId}`;
        return { cursor: null, complete: false };
      }
      if (input.kind === "admit") {
        yield* sql`INSERT INTO session_search_native_threads(thread_id,revision) VALUES(${input.threadId},${input.revision})
        ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,complete=0
          WHERE revision IS NOT excluded.revision`;
      } else {
        const [current] =
          yield* sql`SELECT 1 FROM session_search_native_threads WHERE thread_id=${input.threadId} AND revision=${input.revision}`;
        if (!current) return { cursor: null, complete: false };
        for (const item of input.items) {
          yield* sql`INSERT INTO session_search_native_items(thread_id,item_id,run_id,role,text,at)
          VALUES(${input.threadId},${item.itemId},${item.runId},${item.role},${item.text},${item.at})
          ON CONFLICT(thread_id,item_id) DO UPDATE SET run_id=excluded.run_id,role=excluded.role,text=excluded.text,at=excluded.at
          WHERE run_id IS NOT excluded.run_id OR role IS NOT excluded.role OR text IS NOT excluded.text OR at IS NOT excluded.at`;
        }
        yield* sql`UPDATE session_search_native_threads SET cursor=${input.cursor},complete=${Number(input.complete)} WHERE thread_id=${input.threadId}`;
      }
      const [row] = yield* sql<{
        cursor: string | null;
        complete: number;
      }>`SELECT cursor,complete FROM session_search_native_threads WHERE thread_id=${input.threadId}`;
      return { cursor: row!.cursor, complete: Boolean(row!.complete) };
    }),
  );
});
