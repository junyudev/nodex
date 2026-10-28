import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_side_chat_contexts (
    thread_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_side_chat_lifetime_idx ON orchestration_v2_projection_threads(thread_id)
    WHERE json_extract(payload_json, '$.sideChat') IS NOT NULL AND deleted_at IS NULL`;
});
