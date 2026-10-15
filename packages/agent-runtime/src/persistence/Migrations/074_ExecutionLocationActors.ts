import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_execution_retirement_targets(
    root_thread_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL)`;
  yield* sql`CREATE INDEX orchestration_v2_execution_retirement_targets_root_idx
    ON orchestration_v2_execution_retirement_targets(root_thread_id,thread_id,run_id)`;
  yield* sql`CREATE INDEX orchestration_v2_execution_root_idx ON orchestration_v2_projection_threads(
    json_extract(payload_json,'$.lineage.rootThreadId'), thread_id)`;
  yield* sql`CREATE INDEX orchestration_v2_execution_handoff_idx ON orchestration_v2_projection_threads(thread_id)
    WHERE json_extract(payload_json,'$.executionHandoff.operationId') IS NOT NULL`;
  yield* sql`CREATE INDEX orchestration_v2_execution_detach_barrier_idx ON orchestration_v2_effect_outbox(thread_id, effect_id)
    WHERE effect_type = 'provider-session.detach' AND status IN ('pending','running','failed','cancelled')`;
  yield* sql`CREATE INDEX orchestration_v2_execution_live_nodes_idx ON orchestration_v2_projection_nodes(thread_id,run_id,node_id)
    WHERE status IN ('pending','running','waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_execution_live_items_idx ON orchestration_v2_projection_turn_items(thread_id,run_id)
    WHERE status IN ('pending','running','waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_execution_streaming_messages_idx ON orchestration_v2_projection_messages(thread_id,run_id)
    WHERE streaming = 1`;
  yield* sql`CREATE INDEX orchestration_v2_execution_live_provider_turns_idx ON orchestration_v2_projection_provider_turns(thread_id,node_id)
    WHERE status IN ('pending','running')`;
  // Control indexes must not make unrelated historical bodies a write/read prerequisite.
  // CASE short-circuits JSON extraction; its predicate also matches the settlement query.
  yield* sql`CREATE INDEX orchestration_v2_execution_streaming_items_idx ON orchestration_v2_projection_turn_items(thread_id,run_id)
    WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.streaming') END = 1`;
  yield* sql`CREATE INDEX orchestration_v2_execution_live_native_tasks_idx ON orchestration_v2_projection_subagents(thread_id,run_id)
    WHERE origin = 'provider_native' AND status IN ('pending','running','waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_execution_live_tasks_idx ON orchestration_v2_projection_subagents(thread_id,run_id)
    WHERE status IN ('pending','running','waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_execution_pending_delivery_idx ON orchestration_v2_projection_subagents(thread_id,run_id)
    WHERE origin = 'app_owned' AND CASE WHEN json_valid(payload_json) THEN
      COALESCE(json_extract(payload_json,'$.completionDelivery.state'),'pending')
      NOT IN ('acknowledged','delivered','disposed') ELSE 0 END`;
});
