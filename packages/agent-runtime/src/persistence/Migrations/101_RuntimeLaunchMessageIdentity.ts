import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_message_admissions
    ADD COLUMN launch_message INTEGER NOT NULL DEFAULT 0 CHECK(launch_message IN (0,1))`;
  yield* sql`UPDATE orchestration_v2_message_admissions SET launch_message=1
    WHERE rowid IN (
      SELECT MIN(rowid) FROM orchestration_v2_message_admissions
      WHERE launch_json IS NOT NULL GROUP BY thread_id
    )`;
  yield* sql`CREATE UNIQUE INDEX orchestration_v2_message_admissions_launch
    ON orchestration_v2_message_admissions(thread_id) WHERE launch_message=1`;
});
