import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { PENDING_MESSAGE_DELIVERY_PREDICATE } from "../../orchestration-v2/MessageDelivery.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_messages_pending_delivery_idx
    ON orchestration_v2_projection_messages(thread_id, message_id)
    WHERE ${sql.literal(PENDING_MESSAGE_DELIVERY_PREDICATE)}`;
});
