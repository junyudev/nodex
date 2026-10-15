import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN host_identity_json TEXT NOT NULL DEFAULT '{}'`;
  yield* sql`UPDATE orchestration_v2_projection_provider_threads SET host_identity_json = json_object(
    'id', provider_thread_id, 'providerSessionId', provider_session_id,
    'providerInstanceId', provider_instance_id, 'nativeThreadRef', json_extract(payload_json, '$.nativeThreadRef'),
    'hasPendingBackgroundWork', json(CASE WHEN COALESCE(json_array_length(json_extract(payload_json, '$.pendingBackgroundTasks')), 0) > 0 THEN 'true' ELSE 'false' END))`;
});
