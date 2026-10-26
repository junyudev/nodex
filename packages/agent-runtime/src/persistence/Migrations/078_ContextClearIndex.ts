import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Every context handoff reads where its conversation's context begins. The partial index holds
 * only context-clear markers, so that read stays proportional to clears rather than to history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_turn_items_context_cleared_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'context_cleared'`;
});
