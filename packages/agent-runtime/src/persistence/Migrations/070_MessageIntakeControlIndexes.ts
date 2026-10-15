import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_runs_started_head_idx
    ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.startedAt') DESC, ordinal DESC)
    WHERE json_extract(payload_json, '$.startedAt') IS NOT NULL`;
  yield* sql`CREATE INDEX orchestration_v2_runs_held_queue_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE status = 'queued' AND json_extract(payload_json, '$.queueHeld') = 1`;
  yield* sql`CREATE INDEX orchestration_v2_provider_root_ordinal_idx
    ON orchestration_v2_projection_provider_threads(thread_id, provider_instance_id,
      COALESCE(last_run_ordinal, 0) DESC, updated_at DESC)
    WHERE owner_node_id IS NULL`;
  yield* sql`CREATE INDEX orchestration_v2_provider_root_updated_idx
    ON orchestration_v2_projection_provider_threads(thread_id, provider_instance_id, updated_at DESC)
    WHERE owner_node_id IS NULL`;
  yield* sql`CREATE INDEX orchestration_v2_provider_turn_attempt_idx
    ON orchestration_v2_projection_provider_turns(thread_id, run_attempt_id, ordinal)`;
  yield* sql`CREATE INDEX orchestration_v2_subagent_run_count_idx
    ON orchestration_v2_projection_subagents(thread_id, run_id, origin)`;
});
