import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_native_message_receipts (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('pending','confirmed','unconfirmed','rejected')),
    result_json TEXT,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_native_message_receipts_expiry
    ON orchestration_v2_native_message_receipts(expires_at)`;
});
