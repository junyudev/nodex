import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Refills the contentless session search index from canonical messages. It is keyed by message
 * rowid, so anything that may renumber rows rebuilds it rather than trusting it.
 */
export const rebuildSessionMessageSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One transaction: an interrupt between clear and refill would leave an empty index nothing repairs.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO orchestration_v2_session_message_search(orchestration_v2_session_message_search)
        VALUES('delete-all')`;
      yield* sql`INSERT INTO orchestration_v2_session_message_search(rowid,text,thread_scope)
        SELECT messages.rowid,
          replace(replace(json_extract(messages.payload_json,'$.text'),'’',char(39)),'‘',char(39)),
          'x'||hex(messages.thread_id)||'x'
        FROM orchestration_v2_projection_messages messages
        WHERE CASE WHEN json_valid(messages.payload_json) THEN
          messages.streaming=0 AND messages.role IN ('user','assistant')
          AND json_extract(messages.payload_json,'$.notification') IS NULL
          AND json_extract(messages.payload_json,'$.text') IS NOT NULL
          ELSE 0 END`;
    }),
  );
}).pipe(Effect.withSpan("SessionMessageSearchIndex.rebuild"));
