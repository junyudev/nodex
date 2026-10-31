import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_mcp_tool_operations (
    caller TEXT NOT NULL, tool TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (caller,tool,idempotency_key)
  )`;
  yield* sql`CREATE INDEX orchestration_v2_mcp_tool_operations_expiry
    ON orchestration_v2_mcp_tool_operations(expires_at)`;
});
