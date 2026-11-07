import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The Runtime no longer generates titles, and an outbox row it cannot decode would stop the lane. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type = 'thread-title.generate'`;
});
