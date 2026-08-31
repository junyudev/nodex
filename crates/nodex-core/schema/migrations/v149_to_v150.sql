ALTER TABLE codex_threads ADD COLUMN agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp'));
ALTER TABLE codex_threads ADD COLUMN agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512));
ALTER TABLE codex_threads ADD COLUMN agent_backend_instance_config_id TEXT CHECK (((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512)))));

ALTER TABLE codex_scheduled_automations ADD COLUMN agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp'));
ALTER TABLE codex_scheduled_automations ADD COLUMN agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512));
ALTER TABLE codex_scheduled_automations ADD COLUMN agent_backend_instance_config_id TEXT CHECK (((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512)))));

CREATE TABLE thread_backend_sessions (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  backend_kind TEXT NOT NULL CHECK (backend_kind = 'acp'),
  agent_definition_id TEXT NOT NULL CHECK (agent_definition_id = trim(agent_definition_id) AND length(agent_definition_id) BETWEEN 1 AND 512),
  instance_config_id TEXT CHECK (instance_config_id IS NULL OR (instance_config_id = trim(instance_config_id) AND length(instance_config_id) BETWEEN 1 AND 512)),
  backend_session_id TEXT NOT NULL CHECK (backend_session_id = trim(backend_session_id) AND length(backend_session_id) BETWEEN 1 AND 512),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) WITHOUT ROWID, STRICT;
