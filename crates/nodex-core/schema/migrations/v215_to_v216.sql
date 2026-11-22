-- Rebuild the three tables from the converted rows staged by the Store migration.

PRAGMA legacy_alter_table=ON;

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
    , forked_from_id TEXT, service_name TEXT, agent_path TEXT, model_id TEXT, reasoning_effort TEXT, service_tier TEXT, execution_host_id TEXT NOT NULL DEFAULT 'local' CHECK (execution_host_id = trim(execution_host_id) AND length(execution_host_id) BETWEEN 1 AND 512), recency_at INTEGER NOT NULL DEFAULT 0 CHECK (recency_at >= 0), agent_backend_driver TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_driver = trim(agent_backend_driver) AND length(agent_backend_driver) BETWEEN 1 AND 64), agent_backend_instance_id TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_instance_id = trim(agent_backend_instance_id) AND length(agent_backend_instance_id) BETWEEN 1 AND 64)) WITHOUT ROWID;

INSERT INTO codex_threads SELECT
  thread_id, project_id, parent_thread_id, thread_name, thread_source, agent_nickname, agent_role, thread_preview, cwd, managed_worktree_path, projectless_output_directory, projectless_workspace_browser_root, status_type, status_active_flags_json, archived, created_at, updated_at, linked_at, forked_from_id, service_name, agent_path, model_id, reasoning_effort, service_tier, execution_host_id, recency_at, agent_backend_kind, agent_backend_instance_config_id
FROM agent_identity_codex_threads;

DROP TABLE agent_identity_codex_threads;

CREATE INDEX idx_codex_threads_project_recency ON codex_threads(project_id, recency_at DESC);

CREATE TRIGGER session_search_codex_threads_update
AFTER UPDATE OF thread_name, parent_thread_id, archived, created_at, recency_at, agent_backend_driver, agent_backend_instance_id, execution_host_id ON codex_threads
WHEN (OLD.thread_name IS NOT NEW.thread_name OR OLD.parent_thread_id IS NOT NEW.parent_thread_id OR OLD.archived IS NOT NEW.archived OR OLD.created_at IS NOT NEW.created_at OR OLD.recency_at IS NOT NEW.recency_at OR OLD.agent_backend_driver IS NOT NEW.agent_backend_driver OR OLD.agent_backend_instance_id IS NOT NEW.agent_backend_instance_id OR OLD.execution_host_id IS NOT NEW.execution_host_id) AND EXISTS (SELECT 1 FROM project_session_threads WHERE thread_id = NEW.thread_id)
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;

CREATE TRIGGER codex_thread_session_activity AFTER UPDATE OF recency_at ON codex_threads
WHEN NEW.recency_at > OLD.recency_at
BEGIN
  UPDATE project_sessions SET activity_at = max(activity_at, NEW.recency_at) WHERE id IN (SELECT session_id FROM project_session_threads WHERE thread_id = NEW.thread_id);
END;

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
           notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only'), project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512)), agent_backend_driver TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_driver = trim(agent_backend_driver) AND length(agent_backend_driver) BETWEEN 1 AND 64), agent_backend_instance_id TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_instance_id = trim(agent_backend_instance_id) AND length(agent_backend_instance_id) BETWEEN 1 AND 64),
  mode TEXT NOT NULL DEFAULT 'run' CHECK (mode IN ('dry_run','ask_first','run')), runbook_page_id TEXT,
           CHECK (kind IN ('cron', 'heartbeat')),
           CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
           CHECK (execution_environment IN ('local', 'worktree')),
           CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
           CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
           CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
         ) WITHOUT ROWID;

INSERT INTO automations SELECT
  automation_id, owner_member_id, scope_project_id, condition_text, timezone, jitter_salt, schedule_revision, kind, status, target_session_id, name, prompt, rrule, model, reasoning_effort, service_tier, cwds_json, execution_environment, local_environment_config_path, next_run_at, last_run_at, created_at, updated_at, automation_revision, notification_policy, project_id, agent_backend_kind, agent_backend_instance_config_id, mode, runbook_page_id
FROM agent_identity_automations;

DROP TABLE agent_identity_automations;

CREATE UNIQUE INDEX idx_automations_active_heartbeat
           ON automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;

DROP TABLE thread_backend_sessions;

CREATE TABLE "thread_backend_sessions" (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  backend_driver TEXT NOT NULL CHECK (backend_driver = trim(backend_driver) AND length(backend_driver) BETWEEN 1 AND 64), backend_instance_id TEXT NOT NULL CHECK (backend_instance_id = trim(backend_instance_id) AND length(backend_instance_id) BETWEEN 1 AND 64),
  backend_session_id TEXT NOT NULL CHECK (backend_session_id = trim(backend_session_id) AND length(backend_session_id) BETWEEN 1 AND 512),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  native_state_json TEXT CHECK (native_state_json IS NULL OR (json_valid(native_state_json) AND length(native_state_json) <= 262144)),
  native_home TEXT CHECK (native_home IS NULL OR (length(native_home) BETWEEN 1 AND 16384 AND native_home = trim(native_home))),
  runtime_options_json TEXT CHECK (runtime_options_json IS NULL OR (json_valid(runtime_options_json) AND length(runtime_options_json) <= 262144))
) WITHOUT ROWID, STRICT;

INSERT INTO thread_backend_sessions SELECT
  thread_id, backend_kind, instance_config_id, backend_session_id, updated_at, native_state_json, native_home, runtime_options_json
FROM agent_identity_thread_backend_sessions;

DROP TABLE agent_identity_thread_backend_sessions;

CREATE UNIQUE INDEX thread_backend_sessions_native_identity
  ON thread_backend_sessions(backend_driver, native_home, backend_session_id)
  WHERE native_home IS NOT NULL;

ALTER TABLE agent_actor_labels ADD COLUMN driver TEXT CHECK (driver IS NULL OR (driver = trim(driver) AND length(driver) BETWEEN 1 AND 64));

-- Retain the names that older native Sessions derived from their Thread.
INSERT OR IGNORE INTO agent_actor_labels(session_id,run_key,label,driver)
SELECT link.session_id, '', CASE thread.agent_backend_driver
  WHEN 'codex' THEN 'Codex'
  WHEN 'claudeAgent' THEN 'Claude'
  WHEN 'opencode' THEN 'OpenCode'
  WHEN 'antigravity' THEN 'Antigravity'
  ELSE 'Agent'
END, thread.agent_backend_driver
FROM project_session_threads link JOIN codex_threads thread ON link.thread_id=thread.thread_id;
