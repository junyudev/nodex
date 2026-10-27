import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Rebuildable conversation summaries stay with their Runtime history owner. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN conversation_recency_at TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN conversation_preview TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN conversation_preview_at TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN conversation_preview_id TEXT`;
  yield* sql`
    WITH messages AS MATERIALIZED (
      SELECT thread_id, MAX(updated_at) AS recency
      FROM orchestration_v2_projection_messages
      WHERE role IN ('user', 'assistant')
        AND json_extract(payload_json, '$.notification') IS NULL
      GROUP BY thread_id
    )
    UPDATE orchestration_v2_projection_threads AS thread
    SET conversation_recency_at = messages.recency
    FROM messages WHERE messages.thread_id = thread.thread_id`;
  yield* sql`
    WITH prompts AS MATERIALIZED (
      SELECT thread_id, message_id, created_at,
        substr(json_extract(payload_json, '$.text'), 1, 512) AS preview,
        row_number() OVER (PARTITION BY thread_id ORDER BY created_at, message_id) AS position
      FROM orchestration_v2_projection_messages
      WHERE role = 'user' AND json_extract(payload_json, '$.notification') IS NULL
    )
    UPDATE orchestration_v2_projection_threads AS thread
    SET conversation_preview = prompts.preview, conversation_preview_at = prompts.created_at,
      conversation_preview_id = prompts.message_id
    FROM prompts WHERE prompts.position = 1 AND prompts.thread_id = thread.thread_id`;
  yield* sql`CREATE INDEX orchestration_v2_conversation_discovery_idx
    ON orchestration_v2_projection_threads(
      COALESCE(conversation_recency_at, created_at) DESC, thread_id)
    WHERE deleted_at IS NULL`;
});
