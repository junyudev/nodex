import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN request_fingerprint TEXT`;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN message_id TEXT`;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN message_fingerprint TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX orchestration_command_receipts_message_identity_idx
    ON orchestration_command_receipts(message_id)
    WHERE message_id IS NOT NULL
  `;
});
