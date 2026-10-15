import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Deferred configuration reads only live owners, regardless of transcript length.
  yield* sql`CREATE INDEX orchestration_v2_projection_runs_active_provider_idx
    ON orchestration_v2_projection_runs(status, provider_instance_id)
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')`;
});
