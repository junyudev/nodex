CREATE TABLE codex_thread_workspace_states (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
    CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
) WITHOUT ROWID, STRICT;
