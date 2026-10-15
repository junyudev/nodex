import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_queued_run_window_idx
    ON orchestration_v2_projection_runs(thread_id, COALESCE(json_extract(payload_json, '$.queuePosition'), ordinal), ordinal, run_id)
    WHERE status = 'queued'`;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_queued_user_item_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id, turn_item_id) WHERE type = 'user_message'`;
});
