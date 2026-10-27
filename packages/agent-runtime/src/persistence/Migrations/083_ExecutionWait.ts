import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Exact waits walk only the selected Run's restart chain and request one Run's progress. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_runs_restart_parent_idx ON orchestration_v2_projection_runs(
    thread_id, json_extract(payload_json, '$.restartContinuationOfRunId'), ordinal DESC)`;
  yield* sql`CREATE INDEX orchestration_v2_items_run_type_idx ON orchestration_v2_projection_turn_items(
    thread_id, run_id, type, ordinal DESC)`;
});
