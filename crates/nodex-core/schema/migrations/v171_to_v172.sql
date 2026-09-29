CREATE TEMP TABLE saved_codex_threads_backends AS SELECT thread_id, agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id FROM codex_threads;
ALTER TABLE codex_threads DROP COLUMN agent_backend_instance_config_id;
ALTER TABLE codex_threads DROP COLUMN agent_backend_definition_id;
ALTER TABLE codex_threads DROP COLUMN agent_backend_kind;
ALTER TABLE codex_threads ADD COLUMN agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude'));
ALTER TABLE codex_threads ADD COLUMN agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512));
ALTER TABLE codex_threads ADD COLUMN agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind = 'claude' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512))));
UPDATE codex_threads SET (agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id) = (SELECT agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id FROM saved_codex_threads_backends WHERE saved_codex_threads_backends.thread_id = codex_threads.thread_id);
DROP TABLE saved_codex_threads_backends;
CREATE TEMP TABLE saved_codex_scheduled_automations_backends AS SELECT automation_id, agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id FROM codex_scheduled_automations;
ALTER TABLE codex_scheduled_automations DROP COLUMN agent_backend_instance_config_id;
ALTER TABLE codex_scheduled_automations DROP COLUMN agent_backend_definition_id;
ALTER TABLE codex_scheduled_automations DROP COLUMN agent_backend_kind;
ALTER TABLE codex_scheduled_automations ADD COLUMN agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude'));
ALTER TABLE codex_scheduled_automations ADD COLUMN agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512));
ALTER TABLE codex_scheduled_automations ADD COLUMN agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind = 'claude' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512))));
UPDATE codex_scheduled_automations SET (agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id) = (SELECT agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id FROM saved_codex_scheduled_automations_backends WHERE saved_codex_scheduled_automations_backends.automation_id = codex_scheduled_automations.automation_id);
DROP TABLE saved_codex_scheduled_automations_backends;
CREATE TABLE thread_backend_sessions_next (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('acp', 'claude')),
  agent_definition_id TEXT CHECK ((backend_kind = 'claude' AND agent_definition_id IS NULL) OR (backend_kind = 'acp' AND agent_definition_id IS NOT NULL AND agent_definition_id = trim(agent_definition_id) AND length(agent_definition_id) BETWEEN 1 AND 512)),
  instance_config_id TEXT CHECK ((backend_kind = 'acp' AND instance_config_id IS NULL) OR (instance_config_id IS NOT NULL AND instance_config_id = trim(instance_config_id) AND length(instance_config_id) BETWEEN 1 AND 512)),
  backend_session_id TEXT NOT NULL CHECK (backend_session_id = trim(backend_session_id) AND length(backend_session_id) BETWEEN 1 AND 512),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) WITHOUT ROWID, STRICT;
INSERT INTO thread_backend_sessions_next SELECT * FROM thread_backend_sessions;
DROP TABLE thread_backend_sessions;
ALTER TABLE thread_backend_sessions_next RENAME TO thread_backend_sessions;
