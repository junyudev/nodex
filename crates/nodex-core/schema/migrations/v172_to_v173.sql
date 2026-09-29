CREATE TABLE thread_backend_sessions_next (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('acp', 'claude')),
  agent_definition_id TEXT CHECK ((backend_kind = 'claude' AND agent_definition_id IS NULL) OR (backend_kind = 'acp' AND agent_definition_id IS NOT NULL AND agent_definition_id = trim(agent_definition_id) AND length(agent_definition_id) BETWEEN 1 AND 512)),
  instance_config_id TEXT CHECK ((backend_kind = 'acp' AND instance_config_id IS NULL) OR (instance_config_id IS NOT NULL AND instance_config_id = trim(instance_config_id) AND length(instance_config_id) BETWEEN 1 AND 512)),
  backend_session_id TEXT NOT NULL CHECK (backend_session_id = trim(backend_session_id) AND length(backend_session_id) BETWEEN 1 AND 512),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  native_state_json TEXT CHECK (native_state_json IS NULL OR (json_valid(native_state_json) AND length(native_state_json) <= 262144))
) WITHOUT ROWID, STRICT;
INSERT INTO thread_backend_sessions_next (thread_id, backend_kind, agent_definition_id, instance_config_id, backend_session_id, updated_at)
SELECT thread_id, backend_kind, agent_definition_id, instance_config_id, backend_session_id, updated_at FROM thread_backend_sessions;
DROP TABLE thread_backend_sessions;
ALTER TABLE thread_backend_sessions_next RENAME TO thread_backend_sessions;
