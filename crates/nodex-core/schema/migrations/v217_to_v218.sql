-- The Store migration normalizes filter JSON before the table rebuild.
PRAGMA legacy_alter_table=ON;

CREATE TEMP TABLE automation_trigger_rows AS
SELECT automation.*, filter.filter_json
FROM automations automation LEFT JOIN automation_event_filters filter USING(automation_id);

DROP TABLE automation_event_filters;
DROP TABLE automations;

CREATE TABLE automations (
  automation_id TEXT PRIMARY KEY,
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  scope_project_id TEXT REFERENCES projects(id),
  condition_text TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('clock','event')),
  timezone TEXT,
  jitter_salt TEXT,
  schedule_revision INTEGER NOT NULL DEFAULT 1 CHECK (schedule_revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('cron','heartbeat')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','DELETED')),
  target_session_id TEXT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  rrule TEXT,
  event_filter_json TEXT CHECK (event_filter_json IS NULL OR json_valid(event_filter_json)),
  model TEXT CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
  reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
  service_tier TEXT CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64),
  cwds_json TEXT NOT NULL DEFAULT '[]',
  execution_environment TEXT NOT NULL DEFAULT 'worktree' CHECK (execution_environment IN ('local','worktree')),
  local_environment_config_path TEXT,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  automation_revision INTEGER NOT NULL DEFAULT 1 CHECK (automation_revision >= 1),
  notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only'),
  project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512)),
  agent_backend_driver TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_driver = trim(agent_backend_driver) AND length(agent_backend_driver) BETWEEN 1 AND 64),
  agent_backend_instance_id TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_instance_id = trim(agent_backend_instance_id) AND length(agent_backend_instance_id) BETWEEN 1 AND 64),
  mode TEXT NOT NULL DEFAULT 'run' CHECK (mode IN ('dry_run','ask_first','run')),
  runbook_page_id TEXT,
  CHECK (
    (trigger_kind = 'clock' AND rrule IS NOT NULL AND timezone IS NOT NULL
      AND jitter_salt IS NOT NULL AND event_filter_json IS NULL)
    OR
    (trigger_kind = 'event' AND kind = 'cron' AND event_filter_json IS NOT NULL
      AND rrule IS NULL AND timezone IS NULL AND jitter_salt IS NULL AND next_run_at IS NULL)
  )
) WITHOUT ROWID;

INSERT INTO automations(
  automation_id, owner_member_id, scope_project_id, condition_text, trigger_kind,
  timezone, jitter_salt, schedule_revision, kind, status, target_session_id, name,
  prompt, rrule, event_filter_json, model, reasoning_effort, service_tier, cwds_json,
  execution_environment, local_environment_config_path, next_run_at, last_run_at,
  created_at, updated_at, automation_revision, notification_policy, project_id,
  agent_backend_driver, agent_backend_instance_id, mode, runbook_page_id
)
SELECT
  automation_id, owner_member_id, scope_project_id, condition_text,
  CASE WHEN filter_json IS NULL THEN 'clock' ELSE 'event' END,
  CASE WHEN filter_json IS NULL THEN timezone END,
  CASE WHEN filter_json IS NULL THEN jitter_salt END,
  schedule_revision, kind, status, target_session_id, name, prompt,
  CASE WHEN filter_json IS NULL THEN rrule END,
  filter_json, model, reasoning_effort, service_tier, cwds_json,
  execution_environment, local_environment_config_path,
  CASE WHEN filter_json IS NULL THEN next_run_at END,
  last_run_at, created_at, updated_at, automation_revision, notification_policy, project_id,
  agent_backend_driver, agent_backend_instance_id, mode, runbook_page_id
FROM automation_trigger_rows;

DROP TABLE automation_trigger_rows;

CREATE UNIQUE INDEX idx_automations_active_heartbeat
           ON automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;
