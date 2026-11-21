import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX orchestration_v2_subagent_overview_idx`;
  yield* sql`CREATE INDEX orchestration_v2_subagent_overview_idx
    ON orchestration_v2_projection_subagents(thread_id,
      CASE WHEN status IN ('pending', 'running', 'waiting') THEN 'active' ELSE 'terminal' END,
      updated_at DESC, subagent_id DESC)`;
});
