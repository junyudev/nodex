import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Project moves settle the execution tree using metadata only. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_threads_root_routing_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.lineage.rootThreadId'))`;
});
