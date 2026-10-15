import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Startup recovery and delegated delivery select only live control rows. Each partial index
 * holds just the rows its predicate matches, so the work stays proportional to live delivery,
 * unresolved tasks and live provider state instead of the Profile's whole history. Queries
 * repeat these predicates verbatim so SQLite can prove the index applies.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_runs_open_delivery_idx
    ON orchestration_v2_projection_runs(thread_id, run_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object' ELSE 0 END`;
  yield* sql`CREATE INDEX orchestration_v2_subagents_unresolved_child_idx
    ON orchestration_v2_projection_subagents(child_thread_id, subagent_id)
    WHERE origin = 'app_owned' AND child_thread_id IS NOT NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.result') IS NULL ELSE 0 END`;
  yield* sql`CREATE INDEX orchestration_v2_provider_threads_live_idx
    ON orchestration_v2_projection_provider_threads(thread_id, provider_thread_id, owner_node_id)
    WHERE status = 'active' OR CASE WHEN json_valid(payload_json)
      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 0 END`;
  yield* sql`CREATE INDEX orchestration_v2_provider_sessions_live_idx
    ON orchestration_v2_projection_provider_sessions(provider_session_id)
    WHERE status NOT IN ('stopped', 'error')`;
});
