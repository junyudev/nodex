import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_execution_pauses (root_thread_id TEXT PRIMARY KEY, revision TEXT NOT NULL, requested_at TEXT NOT NULL)`;
});
