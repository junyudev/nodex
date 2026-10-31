import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_session_control_receipts (
    operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    result_json TEXT, expires_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_session_control_receipts_expiry ON orchestration_v2_session_control_receipts(expires_at)`;
});
