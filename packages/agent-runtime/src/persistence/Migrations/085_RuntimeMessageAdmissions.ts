import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_message_admissions (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    launch_json TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('auto','queue','steer','restart'))
  )`;
  for (const event of ["INSERT", "UPDATE"] as const)
    yield* sql.unsafe(`CREATE TRIGGER orchestration_v2_message_launch_accepted_${event.toLowerCase()}
      AFTER ${event} ON orchestration_command_receipts
      WHEN new.status='accepted' AND new.command_type='message.dispatch'
      BEGIN UPDATE orchestration_v2_message_admissions SET launch_json=NULL WHERE command_id=new.command_id; END`);
});
