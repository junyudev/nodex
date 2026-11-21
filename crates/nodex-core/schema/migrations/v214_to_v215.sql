-- Add Antigravity without changing existing conversation or Automation identities.

PRAGMA legacy_alter_table=ON;

CREATE TEMP TABLE antigravity_rows AS SELECT * FROM codex_threads;

DROP TABLE codex_threads;

CREATE TABLE codex_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      parent_thread_id TEXT,
      thread_name TEXT,
      thread_source TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      thread_preview TEXT NOT NULL DEFAULT '',
      cwd TEXT,
      managed_worktree_path TEXT,
      projectless_output_directory TEXT,
      projectless_workspace_browser_root TEXT,
      status_type TEXT NOT NULL DEFAULT 'notLoaded',
      status_active_flags_json TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      linked_at TEXT NOT NULL
    , forked_from_id TEXT, service_name TEXT, agent_path TEXT, model_id TEXT, reasoning_effort TEXT, service_tier TEXT, execution_host_id TEXT NOT NULL DEFAULT 'local' CHECK (execution_host_id = trim(execution_host_id) AND length(execution_host_id) BETWEEN 1 AND 512), recency_at INTEGER NOT NULL DEFAULT 0 CHECK (recency_at >= 0), agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude', 'opencode', 'antigravity')), agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512)), agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind IN ('claude', 'opencode', 'antigravity') AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512))))) WITHOUT ROWID;

INSERT INTO codex_threads SELECT * FROM antigravity_rows;

DROP TABLE antigravity_rows;

CREATE INDEX idx_codex_threads_project_recency ON codex_threads(project_id, recency_at DESC);

CREATE TRIGGER session_search_codex_threads_update
AFTER UPDATE OF thread_name, parent_thread_id, archived, created_at, recency_at, agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id, execution_host_id ON codex_threads
WHEN (OLD.thread_name IS NOT NEW.thread_name OR OLD.parent_thread_id IS NOT NEW.parent_thread_id OR OLD.archived IS NOT NEW.archived OR OLD.created_at IS NOT NEW.created_at OR OLD.recency_at IS NOT NEW.recency_at OR OLD.agent_backend_kind IS NOT NEW.agent_backend_kind OR OLD.agent_backend_definition_id IS NOT NEW.agent_backend_definition_id OR OLD.agent_backend_instance_config_id IS NOT NEW.agent_backend_instance_config_id OR OLD.execution_host_id IS NOT NEW.execution_host_id) AND EXISTS (SELECT 1 FROM project_session_threads WHERE thread_id = NEW.thread_id)
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;

CREATE TRIGGER codex_thread_session_activity AFTER UPDATE OF recency_at ON codex_threads
WHEN NEW.recency_at > OLD.recency_at
BEGIN
  UPDATE project_sessions SET activity_at = max(activity_at, NEW.recency_at) WHERE id IN (SELECT session_id FROM project_session_threads WHERE thread_id = NEW.thread_id);
END;

CREATE TEMP TABLE antigravity_rows AS SELECT * FROM automations;

DROP TABLE automations;

CREATE TABLE automations (
           automation_id TEXT PRIMARY KEY,
           owner_member_id TEXT NOT NULL REFERENCES members(id),
           scope_project_id TEXT REFERENCES projects(id),
           condition_text TEXT NOT NULL,
           timezone TEXT NOT NULL,
           jitter_salt TEXT NOT NULL,
           schedule_revision INTEGER NOT NULL DEFAULT 1 CHECK(schedule_revision>=1),
           kind TEXT NOT NULL,
           status TEXT NOT NULL,
           target_session_id TEXT,
           name TEXT NOT NULL,
           prompt TEXT NOT NULL DEFAULT '',
           rrule TEXT,
           model TEXT,
           reasoning_effort TEXT,
           service_tier TEXT,
           cwds_json TEXT NOT NULL DEFAULT '[]',
           execution_environment TEXT NOT NULL DEFAULT 'worktree',
           local_environment_config_path TEXT,
           next_run_at INTEGER,
           last_run_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           automation_revision INTEGER NOT NULL DEFAULT 1 CHECK (automation_revision >= 1),
           notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only'), project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512)), agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude', 'opencode', 'antigravity')), agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512)), agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind IN ('claude', 'opencode', 'antigravity') AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512)))),
  mode TEXT NOT NULL DEFAULT 'run' CHECK (mode IN ('dry_run','ask_first','run')), runbook_page_id TEXT,
           CHECK (kind IN ('cron', 'heartbeat')),
           CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
           CHECK (execution_environment IN ('local', 'worktree')),
           CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
           CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
           CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
         ) WITHOUT ROWID;

INSERT INTO automations SELECT * FROM antigravity_rows;

DROP TABLE antigravity_rows;

CREATE UNIQUE INDEX idx_automations_active_heartbeat
           ON automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;

CREATE TEMP TABLE antigravity_rows AS SELECT * FROM thread_backend_sessions;

DROP TABLE thread_backend_sessions;

CREATE TABLE "thread_backend_sessions" (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('acp', 'claude', 'opencode', 'antigravity')),
  agent_definition_id TEXT CHECK ((backend_kind IN ('claude', 'opencode', 'antigravity') AND agent_definition_id IS NULL) OR (backend_kind = 'acp' AND agent_definition_id IS NOT NULL AND agent_definition_id = trim(agent_definition_id) AND length(agent_definition_id) BETWEEN 1 AND 512)),
  instance_config_id TEXT CHECK ((backend_kind = 'acp' AND instance_config_id IS NULL) OR (instance_config_id IS NOT NULL AND instance_config_id = trim(instance_config_id) AND length(instance_config_id) BETWEEN 1 AND 512)),
  backend_session_id TEXT NOT NULL CHECK (backend_session_id = trim(backend_session_id) AND length(backend_session_id) BETWEEN 1 AND 512),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  native_state_json TEXT CHECK (native_state_json IS NULL OR (json_valid(native_state_json) AND length(native_state_json) <= 262144)),
  native_home TEXT CHECK (native_home IS NULL OR (backend_kind IN ('claude', 'opencode', 'antigravity') AND length(native_home) BETWEEN 1 AND 16384 AND native_home = trim(native_home))),
  runtime_options_json TEXT CHECK (runtime_options_json IS NULL OR (json_valid(runtime_options_json) AND length(runtime_options_json) <= 262144))
) WITHOUT ROWID, STRICT;

INSERT INTO thread_backend_sessions SELECT * FROM antigravity_rows;

DROP TABLE antigravity_rows;

CREATE UNIQUE INDEX thread_backend_sessions_native_identity
  ON thread_backend_sessions(backend_kind, native_home, backend_session_id)
  WHERE native_home IS NOT NULL;
