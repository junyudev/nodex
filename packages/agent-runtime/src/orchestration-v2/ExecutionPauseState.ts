import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ThreadId } from "@nodex/runtime-contracts";
/** Includes delegated descendants, even those created after the root was paused. */
export const heldSql = (
  sql: SqlClient.SqlClient,
  thread: ReturnType<SqlClient.SqlClient["literal"]>,
) => sql`EXISTS (
  SELECT 1 FROM orchestration_v2_execution_pauses pause WHERE pause.root_thread_id = ${thread}
  OR pause.root_thread_id = (SELECT json_extract(payload_json,'$.lineage.rootThreadId') FROM orchestration_v2_projection_threads WHERE thread_id = ${thread}))`;
export const isHeld = Effect.fn("ExecutionPauseState.isHeld")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ held: number }>`SELECT ${heldSql(sql, sql`${threadId}`)} AS held`;
  return rows[0]?.held === 1;
});
export const initialize = Effect.fn("ExecutionPauseState.initialize")(function* (
  roots: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  // Bootstrap policy comes from Core before any recovery or native worker is activated.
  for (const root of roots)
    yield* sql`INSERT INTO orchestration_v2_execution_pauses VALUES(${root},'bootstrap',datetime('now')) ON CONFLICT DO NOTHING`;
});
