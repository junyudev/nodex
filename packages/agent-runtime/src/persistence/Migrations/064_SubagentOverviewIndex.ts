import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_subagent_overview_idx
    ON orchestration_v2_projection_subagents(thread_id,
      CASE WHEN status IN ('completed', 'failed', 'cancelled', 'interrupted') THEN 'terminal' ELSE 'active' END,
      updated_at DESC, subagent_id DESC)`;
});
