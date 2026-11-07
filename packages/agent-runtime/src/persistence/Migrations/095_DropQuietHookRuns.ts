import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Drops hook runs that never reported anything a person can read. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TEMP TABLE quiet_hook_runs AS
    SELECT turn_item_id, node_id FROM orchestration_v2_projection_turn_items
    WHERE type = 'hook_run'
      -- One unreadable row is reported where it is read; it must not stop every later start.
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.hookStatus') IN ('running', 'completed')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.entries')
          WHERE json_extract(value, '$.kind') <> 'context'
        )
      ELSE 0 END`;
  yield* sql`DELETE FROM orchestration_v2_turn_item_positions
    WHERE turn_item_id IN (SELECT turn_item_id FROM temp.quiet_hook_runs)`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id IN (SELECT turn_item_id FROM temp.quiet_hook_runs)`;
  yield* sql`DELETE FROM orchestration_v2_projection_nodes
    WHERE node_id IN (SELECT node_id FROM temp.quiet_hook_runs WHERE node_id IS NOT NULL)`;
  yield* sql`DROP TABLE temp.quiet_hook_runs`;
});
