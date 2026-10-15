import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_historical_role_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id,
      (CASE WHEN type = 'user_message' THEN 1 ELSE 0 END), ordinal, turn_item_id)
    WHERE type IN ('user_message','assistant_message','command_execution','error',
      'run_interrupt_result','file_change','proposed_plan')`;
  yield* sql`CREATE INDEX orchestration_v2_provider_run_ordinal_idx
    ON orchestration_v2_projection_runs(thread_id, provider_thread_id, ordinal)`;
  yield* sql`CREATE INDEX orchestration_v2_delivered_native_handoff_idx
    ON orchestration_v2_projection_context_handoffs(thread_id, to_provider_thread_id,
      json_extract(payload_json, '$.delivery.nativeThreadId'))`;
});
