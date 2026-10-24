import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_codex_imports (
    thread_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('prepared', 'history', 'complete')),
    boundary_item_id TEXT,
    boundary_turn_id TEXT,
    history_mode TEXT CHECK(history_mode IN ('legacy', 'paginated')),
    source_cwd TEXT,
    history_cursor TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
});
