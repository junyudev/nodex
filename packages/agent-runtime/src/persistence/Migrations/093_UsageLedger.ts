import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_ledger_meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  ) WITHOUT ROWID`;
  // Rollups outlive their transcripts: a provider deleting old files must not shrink history.
  yield* sql`CREATE TABLE usage_ledger_files (
    file_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    resume_offset INTEGER NOT NULL,
    guard_length INTEGER NOT NULL,
    guard_hash INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    origin TEXT NOT NULL,
    subagent INTEGER NOT NULL,
    first_activity_ms INTEGER
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE usage_ledger_requests (
    file_key TEXT NOT NULL REFERENCES usage_ledger_files(file_key) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    model TEXT NOT NULL,
    speed TEXT NOT NULL,
    uncached_input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    PRIMARY KEY (file_key, slot, model, speed)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE usage_ledger_messages (
    file_key TEXT NOT NULL REFERENCES usage_ledger_files(file_key) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    messages INTEGER NOT NULL,
    PRIMARY KEY (file_key, slot)
  ) WITHOUT ROWID`;
  // Remembers the owning file so re-reading that file can release exactly its own keys.
  yield* sql`CREATE TABLE usage_ledger_seen (
    key TEXT PRIMARY KEY,
    file_key TEXT NOT NULL REFERENCES usage_ledger_files(file_key) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX usage_ledger_seen_file ON usage_ledger_seen(file_key)`;
  yield* sql`CREATE TABLE usage_ledger_turns (
    provider_turn_id TEXT PRIMARY KEY,
    started_ms INTEGER NOT NULL,
    completed_ms INTEGER NOT NULL
  ) WITHOUT ROWID`;
});
