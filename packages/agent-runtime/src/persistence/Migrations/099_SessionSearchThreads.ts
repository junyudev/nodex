import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import { searchableThread } from "../SessionSearchSources.ts";

/** Install the derived tables and queue existing history without analyzing it at startup. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const operation of ["insert", "update", "delete"])
    yield* sql`DROP TRIGGER ${sql(`orchestration_v2_session_search_${operation}`)}`;
  yield* sql`DROP TABLE orchestration_v2_session_message_search`;
  yield* sql`DROP INDEX orchestration_v2_session_search_thread_messages_idx`;
  yield* sql`CREATE TABLE session_search_dirty(
    thread_id TEXT PRIMARY KEY, revision TEXT NOT NULL DEFAULT (hex(randomblob(16))),
    scan INTEGER NOT NULL DEFAULT 2, message_at TEXT NOT NULL DEFAULT '',
    action_ordinal INTEGER NOT NULL DEFAULT -1, source_id TEXT NOT NULL DEFAULT '') WITHOUT ROWID`;
  yield* sql`CREATE INDEX session_search_dirty_priority ON session_search_dirty(scan DESC,thread_id)`;
  yield* sql`CREATE TABLE session_search_changes(
    thread_id TEXT NOT NULL, lane INTEGER NOT NULL, source_id TEXT NOT NULL,
    PRIMARY KEY(thread_id,lane,source_id)) WITHOUT ROWID`;
  yield* sql`CREATE TABLE session_search_threads(
    id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, terms TEXT NOT NULL,
    at TEXT NOT NULL, message_max INTEGER NOT NULL, action_max INTEGER NOT NULL,
    analyzer_version INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE session_search_items(
    thread_id TEXT NOT NULL, lane INTEGER NOT NULL, source_id TEXT NOT NULL, row_id INTEGER NOT NULL,
    user_role INTEGER NOT NULL, at TEXT NOT NULL, digest TEXT NOT NULL, segments BLOB NOT NULL,
    PRIMARY KEY(thread_id,lane,source_id)) WITHOUT ROWID`;
  yield* sql`CREATE VIRTUAL TABLE session_search_words USING fts5(
    message, action, content='', contentless_delete=1, tokenize="ascii tokenchars '#*'")`;
  yield* sql`CREATE VIRTUAL TABLE session_search_inventory USING fts5(
    tokens, content='', contentless_delete=1, detail=none, tokenize="ascii tokenchars '#*'")`;
  yield* sql`CREATE TABLE session_search_terms(term TEXT PRIMARY KEY, chats INTEGER NOT NULL) WITHOUT ROWID`;
  yield* sql`INSERT INTO session_search_dirty(thread_id,scan)
    SELECT thread_id,0 FROM orchestration_v2_projection_threads thread WHERE ${searchableThread(sql, "thread")}`;

  const ref = (alias: "old" | "new", field: string) => sql.literal(`${alias}.${field}`);
  const isRoot = (alias: "old" | "new") => sql`EXISTS(
    SELECT 1 FROM orchestration_v2_projection_threads thread
    WHERE thread.thread_id=${ref(alias, "thread_id")} AND ${searchableThread(sql, "thread")})`;
  const enqueueThread = (alias: "old" | "new") =>
    sql`INSERT INTO session_search_dirty(thread_id)
      SELECT ${ref(alias, "thread_id")} WHERE ${isRoot(alias)}
      ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision;`;
  const enqueueItem = (alias: "old" | "new", lane: number, key: Fragment, where = sql`1`) =>
    sql`INSERT INTO session_search_changes(thread_id,lane,source_id)
      SELECT ${ref(alias, "thread_id")},${sql.literal(String(lane))},${key}
      WHERE ${where} AND ${key} IS NOT NULL AND ${isRoot(alias)}
      ON CONFLICT DO NOTHING;`;
  const linkedMessage = (payload: Fragment) =>
    sql`CASE WHEN json_valid(${payload}) THEN json_extract(${payload},'$.messageId') END`;
  // Run status can change visibility in forks as well as in the owning Thread.
  const enqueueRun = (alias: "old" | "new") => {
    const affected = sql`FROM orchestration_v2_projection_turn_items item
      JOIN orchestration_v2_projection_threads thread ON thread.thread_id=item.thread_id
      WHERE item.run_id=${ref(alias, "run_id")} AND ${searchableThread(sql, "thread")}
        AND item.type IN ('user_message','assistant_message','command_execution','file_change')`;
    return sql`INSERT INTO session_search_dirty(thread_id)
      SELECT DISTINCT item.thread_id ${affected}
      ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision;
    INSERT INTO session_search_changes(thread_id,lane,source_id)
      SELECT item.thread_id,
        CASE WHEN item.type IN ('user_message','assistant_message') THEN 0 ELSE 1 END,
        CASE WHEN item.type IN ('user_message','assistant_message') THEN ${linkedMessage(sql`item.payload_json`)}
          ELSE item.turn_item_id END
      ${affected} AND (item.type IN ('command_execution','file_change') OR ${linkedMessage(sql`item.payload_json`)} IS NOT NULL)
      ON CONFLICT DO NOTHING;`;
  };
  const message = (alias: "old" | "new") =>
    sql`${ref(alias, "streaming")}=0 AND ${ref(alias, "role")} IN ('user','assistant')`;
  const action = (alias: "old" | "new") =>
    sql`${ref(alias, "type")} IN ('command_execution','file_change') AND ${ref(alias, "status")}='completed'`;
  const messageItem = (alias: "old" | "new") =>
    sql`${ref(alias, "type")} IN ('user_message','assistant_message')`;
  const run = (alias: "old" | "new") => sql`${ref(alias, "status")} IN ('cancelled','rolled_back')`;
  const markMessage = (alias: "old" | "new") =>
    sql`${enqueueThread(alias)} ${enqueueItem(alias, 0, ref(alias, "message_id"))}`;
  const markItem = (alias: "old" | "new") => {
    const messageId = linkedMessage(ref(alias, "payload_json"));
    return sql`${enqueueThread(alias)}
      ${enqueueItem(alias, 1, ref(alias, "turn_item_id"), sql`${ref(alias, "type")} IN ('command_execution','file_change')`)}
      ${enqueueItem(alias, 0, messageId, messageItem(alias))}`;
  };
  // A newly admitted root needs a scan because earlier invisible items were never retained.
  const markThread = (alias: "old" | "new") => sql`INSERT INTO session_search_dirty(thread_id,scan)
    VALUES(${ref(alias, "thread_id")},0)
    ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,scan=0,message_at='',action_ordinal=-1,source_id='';`;

  for (const [name, table, relevant, update, changed, mark] of [
    [
      "message",
      "messages",
      message,
      "thread_id,message_id,role,streaming,created_at,payload_json",
      sql`(${message("old")}) OR (${message("new")})`,
      markMessage,
    ],
    [
      "item",
      "turn_items",
      (ref: "old" | "new") => sql`(${action(ref)}) OR (${messageItem(ref)})`,
      "thread_id,run_id,type,status,ordinal,turn_item_id,updated_at,payload_json",
      sql`(${action("old")}) OR (${action("new")}) OR (
        ((${messageItem("old")}) OR (${messageItem("new")})) AND (
          old.thread_id IS NOT new.thread_id OR old.run_id IS NOT new.run_id OR old.type IS NOT new.type
          OR old.ordinal IS NOT new.ordinal OR old.turn_item_id IS NOT new.turn_item_id
          OR (CASE WHEN json_valid(old.payload_json) THEN json_extract(old.payload_json,'$.messageId') END)
             IS NOT (CASE WHEN json_valid(new.payload_json) THEN json_extract(new.payload_json,'$.messageId') END)
          OR (CASE WHEN json_valid(old.payload_json) THEN json_extract(old.payload_json,'$.inputIntent') END)
             IS NOT (CASE WHEN json_valid(new.payload_json) THEN json_extract(new.payload_json,'$.inputIntent') END)))`,
      markItem,
    ],
    [
      "run",
      "runs",
      run,
      "thread_id,run_id,status",
      sql`((${run("old")}) OR (${run("new")})) AND
        (old.status IS NOT new.status OR old.thread_id IS NOT new.thread_id OR old.run_id IS NOT new.run_id)`,
      enqueueRun,
    ],
    [
      "thread",
      "threads",
      (alias: "old" | "new") => searchableThread(sql, alias),
      "thread_id,deleted_at,payload_json",
      sql`old.thread_id IS NOT new.thread_id
        OR (${searchableThread(sql, "old")}) IS NOT (${searchableThread(sql, "new")})`,
      markThread,
    ],
  ] as const) {
    const source = sql(`orchestration_v2_projection_${table}`);
    yield* sql`CREATE TRIGGER ${sql(`session_search_${name}_insert`)} AFTER INSERT ON ${source}
      WHEN ${relevant("new")} BEGIN ${mark("new")} END`;
    yield* sql`CREATE TRIGGER ${sql(`session_search_${name}_delete`)} AFTER DELETE ON ${source}
      WHEN ${relevant("old")} BEGIN ${mark("old")} END`;
    yield* sql`CREATE TRIGGER ${sql(`session_search_${name}_update`)} AFTER UPDATE OF ${sql.literal(update)} ON ${source}
      WHEN ${changed} BEGIN ${mark("old")} ${mark("new")} END`;
  }
});
