import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_context_recovery_idx
    ON orchestration_v2_projection_runs(thread_id, run_id)
    WHERE status = 'completed' AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.contextRecovery.phase') = 'compact' ELSE 0 END`;
  yield* sql`CREATE INDEX orchestration_v2_handoff_transfer_idx
    ON orchestration_v2_projection_context_handoffs(thread_id, json_extract(payload_json, '$.transferId'))`;
});
