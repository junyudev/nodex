import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Attachment files are shared by every message that names them and by forks that capture the
 * referencing Run. Cleanup proves the last live reference through these indexes instead of
 * decoding message bodies.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_attachment_refs(
    owner_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    PRIMARY KEY (owner_id, attachment_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX orchestration_v2_attachment_refs_attachment_idx
    ON orchestration_v2_projection_attachment_refs(attachment_id, thread_id)`;
  yield* sql`CREATE INDEX orchestration_v2_attachment_refs_thread_idx
    ON orchestration_v2_projection_attachment_refs(thread_id, run_id)`;
  yield* sql`CREATE INDEX orchestration_v2_thread_fork_source_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.forkedFrom.threadId'))`;
  yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_attachment_refs(
      owner_id, attachment_id, thread_id, run_id)
    SELECT message.message_id, json_extract(attachment.value, '$.id'), message.thread_id, message.run_id
    FROM orchestration_v2_projection_messages AS message,
      json_each(CASE WHEN json_valid(message.payload_json)
        THEN json_extract(message.payload_json, '$.attachments') END) AS attachment
    WHERE json_extract(attachment.value, '$.id') IS NOT NULL`;
});
