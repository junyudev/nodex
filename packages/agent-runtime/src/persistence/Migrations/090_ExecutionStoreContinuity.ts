import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Host reconciliation and imported-store transitions share the execution transaction owner. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE execution_store_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), store_coordinate TEXT
  )`;
  yield* sql`INSERT INTO execution_store_state(singleton, store_coordinate) VALUES (1, NULL)`;
  yield* sql`CREATE TABLE execution_store_imports (import_key TEXT PRIMARY KEY)`;
  yield* sql`CREATE INDEX orchestration_v2_session_roots_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE json_extract(payload_json, '$.sideChat') IS NULL
      AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'`;
});
