import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_recent_runs_idx
    ON orchestration_v2_projection_runs(completed_at DESC, run_id DESC)
    WHERE completed_at IS NOT NULL AND status IN ('completed', 'failed', 'cancelled', 'interrupted')`;
});
