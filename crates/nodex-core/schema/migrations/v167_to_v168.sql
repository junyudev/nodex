CREATE TABLE codex_queued_message_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
