import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_user_message_identity_idx
    ON orchestration_v2_projection_turn_items(thread_id, json_extract(payload_json, '$.messageId'), ordinal, turn_item_id)
    WHERE type = 'user_message'`;
});
