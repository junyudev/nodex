import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Retire request/message fingerprinting; stable command receipts remain the execution boundary. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS orchestration_command_receipts_message_identity_idx`;
  yield* sql`ALTER TABLE orchestration_command_receipts DROP COLUMN request_fingerprint`;
  yield* sql`ALTER TABLE orchestration_command_receipts DROP COLUMN message_id`;
  yield* sql`ALTER TABLE orchestration_command_receipts DROP COLUMN message_fingerprint`;
});
