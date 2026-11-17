import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Native history is a disposable read projection, never a Runtime execution binding. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE session_search_native_threads(
    thread_id TEXT PRIMARY KEY, revision TEXT NOT NULL, cursor TEXT, complete INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE session_search_native_items(
    id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, item_id TEXT NOT NULL, run_id TEXT NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(thread_id,item_id))`;
  yield* sql`CREATE INDEX session_search_native_scan ON session_search_native_items(thread_id,at,item_id)`;
  for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
    const row = operation === "DELETE" ? "old" : "new";
    yield* sql`CREATE TRIGGER ${sql(`session_search_native_${operation.toLowerCase()}`)}
      AFTER ${sql.literal(operation)} ON session_search_native_items BEGIN
      INSERT INTO session_search_dirty(thread_id) VALUES(${sql.literal(row + ".thread_id")})
        ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision;
      INSERT INTO session_search_changes(thread_id,lane,source_id)
        VALUES(${sql.literal(row + ".thread_id")},CASE WHEN ${sql.literal(row + ".role")} IN ('user','assistant') THEN 0 ELSE 1 END,${sql.literal(row + ".item_id")}) ON CONFLICT DO NOTHING;
      ${
        operation === "UPDATE"
          ? sql`INSERT INTO session_search_changes(thread_id,lane,source_id)
        VALUES(old.thread_id,CASE WHEN old.role IN ('user','assistant') THEN 0 ELSE 1 END,old.item_id) ON CONFLICT DO NOTHING;`
          : sql``
      }
    END`;
  }
});
