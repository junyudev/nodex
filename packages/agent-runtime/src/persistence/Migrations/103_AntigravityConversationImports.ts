import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_native_imports RENAME TO previous_native_imports`;
  yield* sql`CREATE TABLE orchestration_v2_native_imports (
    thread_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    backend_kind TEXT NOT NULL CHECK(backend_kind IN ('codex', 'claude', 'antigravity')),
    source_home TEXT NOT NULL,
    source_native_thread_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('prepared', 'history', 'complete')),
    boundary_item_id TEXT,
    boundary_turn_id TEXT,
    history_mode TEXT CHECK(history_mode IN ('legacy', 'paginated', 'claude', 'antigravity')),
    source_cwd TEXT,
    source_revision TEXT,
    history_cursor TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO orchestration_v2_native_imports SELECT * FROM previous_native_imports`;
  yield* sql`DROP TABLE previous_native_imports`;
  yield* sql`CREATE INDEX orchestration_v2_native_imports_source ON orchestration_v2_native_imports
    (backend_kind, source_home, source_native_thread_id) WHERE phase = 'complete'`;
});
