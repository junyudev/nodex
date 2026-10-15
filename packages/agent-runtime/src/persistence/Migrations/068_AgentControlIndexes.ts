import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_pending_secret_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, turn_item_id DESC)
    WHERE type = 'secret_request' AND status = 'waiting'
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_delegated_task_idx
    ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.delegatedTaskId'), ordinal)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_completion_idx
    ON orchestration_v2_projection_runs(thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC)
  `;
});
