import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Native occupancy is a metadata aggregate; startup never rereads old text or attachments.
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN historical_text_bytes INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN native_attachment_allowance INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE orchestration_v2_projection_turn_items SET historical_text_bytes = COALESCE(length(CAST(
    CASE type WHEN 'user_message' THEN json_extract(payload_json,'$.text')
      WHEN 'assistant_message' THEN json_extract(payload_json,'$.text')
      WHEN 'command_execution' THEN 'Command: ' || json_extract(payload_json,'$.input') || char(10) || 'Exit code: ' || COALESCE(json_extract(payload_json,'$.exitCode'),'unknown') || char(10) || COALESCE(json_extract(payload_json,'$.output'),'')
      WHEN 'error' THEN json_extract(payload_json,'$.failure.message')
      WHEN 'run_interrupt_result' THEN json_extract(payload_json,'$.message')
      WHEN 'file_change' THEN 'File change: ' || json_extract(payload_json,'$.fileName')
      WHEN 'proposed_plan' THEN json_extract(payload_json,'$.markdown') ELSE '' END AS BLOB)),0),
    native_attachment_allowance = CASE WHEN type = 'user_message' THEN
      (SELECT COALESCE(SUM(CASE json_extract(a.value,'$.type') WHEN 'image' THEN 8192 ELSE 4096 END),0)
        FROM json_each(payload_json,'$.attachments') a) ELSE 0 END`;
  yield* sql`CREATE INDEX orchestration_v2_restart_work_marker_idx ON orchestration_v2_projection_runs(thread_id)
    WHERE json_array_length(payload_json,'$.restartCancelledBackgroundWork') > 0`;
  yield* sql`CREATE INDEX orchestration_v2_attempt_native_identity_idx ON orchestration_v2_projection_run_attempts(
    thread_id, provider_thread_id, json_extract(payload_json,'$.nativeThreadId'), run_id, attempt_id)`;
  yield* sql`CREATE INDEX orchestration_v2_ready_handoff_bytes_idx ON orchestration_v2_projection_context_handoffs(
    thread_id, status, to_provider_thread_id, target_run_id, length(CAST(payload_json AS BLOB)),
    json_extract(payload_json,'$.delivery.nativeThreadId'), json_extract(payload_json,'$.delivery.status'), json_type(payload_json,'$.delivery'))`;
  yield* sql`CREATE INDEX orchestration_v2_handoff_delivery_metadata_idx ON orchestration_v2_projection_context_handoffs(
    thread_id, to_provider_thread_id, json_extract(payload_json,'$.delivery.nativeThreadId'),
    json_extract(payload_json,'$.delivery.status'), json_extract(payload_json,'$.delivery.itemIds'),
    json_extract(payload_json,'$.delivery.omittedItemIds'), json_extract(payload_json,'$.fromProviderThreadIds'),
    json_extract(payload_json,'$.coveredRunOrdinals.from'), json_extract(payload_json,'$.coveredRunOrdinals.to'), strategy)`;
  yield* sql`CREATE INDEX orchestration_v2_native_usage_head_idx ON orchestration_v2_projection_provider_turns(
    provider_thread_id, json_extract(payload_json,'$.tokenUsage.updatedAt') DESC, ordinal ASC, run_attempt_id, node_id)
    WHERE json_extract(payload_json,'$.tokenUsage') IS NOT NULL`;
  yield* sql`CREATE INDEX orchestration_v2_native_rollback_boundary_idx ON orchestration_v2_projection_provider_turns(provider_thread_id, ordinal)
    WHERE status IN ('completed','interrupted','failed','cancelled') AND json_extract(payload_json,'$.nativeTurnRef') IS NOT NULL`;
  yield* sql`CREATE INDEX orchestration_v2_native_fork_boundary_idx ON orchestration_v2_projection_provider_turns(
    provider_thread_id, ordinal, json_extract(payload_json,'$.nativeTurnRef.nativeId'), provider_turn_id)`;
  yield* sql`CREATE INDEX orchestration_v2_native_item_occupancy_idx ON orchestration_v2_projection_turn_items(
    thread_id, provider_thread_id, run_id, type, turn_item_id, historical_text_bytes, native_attachment_allowance)`;
});
