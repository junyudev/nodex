import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Derived from canonical messages; triggers keep replay, deletion and rollback rebuilds atomic. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE VIRTUAL TABLE orchestration_v2_session_message_search USING fts5(
    text,thread_scope, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1')`;
  const eligible = (alias: string) =>
    sql.literal(`CASE WHEN json_valid(${alias}.payload_json) THEN
    ${alias}.streaming=0 AND ${alias}.role IN ('user','assistant')
    AND json_extract(${alias}.payload_json,'$.notification') IS NULL
    AND json_extract(${alias}.payload_json,'$.text') IS NOT NULL
    ELSE 0 END`);
  yield* sql`CREATE TRIGGER orchestration_v2_session_search_insert AFTER INSERT ON orchestration_v2_projection_messages
    WHEN ${eligible("new")} BEGIN
      INSERT INTO orchestration_v2_session_message_search(rowid,text,thread_scope)
      VALUES(new.rowid,replace(replace(json_extract(new.payload_json,'$.text'),'’',char(39)),'‘',char(39)),'x'||hex(new.thread_id)||'x');
    END`;
  yield* sql`CREATE TRIGGER orchestration_v2_session_search_update AFTER UPDATE OF payload_json,streaming,role,thread_id
    ON orchestration_v2_projection_messages WHEN old.streaming=0 OR new.streaming=0 BEGIN
      DELETE FROM orchestration_v2_session_message_search WHERE rowid=old.rowid;
      INSERT INTO orchestration_v2_session_message_search(rowid,text,thread_scope)
      SELECT new.rowid,replace(replace(json_extract(new.payload_json,'$.text'),'’',char(39)),'‘',char(39)),'x'||hex(new.thread_id)||'x' WHERE ${eligible("new")};
    END`;
  yield* sql`CREATE TRIGGER orchestration_v2_session_search_delete AFTER DELETE ON orchestration_v2_projection_messages BEGIN
    DELETE FROM orchestration_v2_session_message_search WHERE rowid=old.rowid;
    END`;
  yield* sql`INSERT INTO orchestration_v2_session_message_search(rowid,text,thread_scope)
    SELECT messages.rowid,replace(replace(json_extract(messages.payload_json,'$.text'),'’',char(39)),'‘',char(39)),'x'||hex(messages.thread_id)||'x'
    FROM orchestration_v2_projection_messages messages WHERE ${eligible("messages")}`;
  yield* sql`CREATE INDEX orchestration_v2_message_item_identity_idx ON orchestration_v2_projection_turn_items(
    thread_id,CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.messageId') END,ordinal,turn_item_id)
    WHERE type IN ('user_message','assistant_message')`;
  yield* sql`CREATE INDEX orchestration_v2_session_search_thread_messages_idx
    ON orchestration_v2_projection_messages(thread_id)`;
});
