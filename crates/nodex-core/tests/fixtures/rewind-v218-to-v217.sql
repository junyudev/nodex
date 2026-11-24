-- Recreate the v217 Automation table for synthetic predecessor fixtures.
PRAGMA legacy_alter_table=ON;

CREATE TEMP TABLE automation_trigger_rows AS SELECT * FROM automations;

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

INSERT INTO automations
SELECT
  automation_id, owner_member_id, scope_project_id, condition_text,
  coalesce(timezone, 'UTC'), coalesce(jitter_salt, 'v217-fixture'),
  schedule_revision, kind, status, target_session_id, name, prompt,
  coalesce(rrule, 'FREQ=DAILY'), model, reasoning_effort, service_tier, cwds_json,
  execution_environment, local_environment_config_path, next_run_at, last_run_at,
  created_at, updated_at, automation_revision, notification_policy, project_id,
  agent_backend_driver, agent_backend_instance_id, mode, runbook_page_id
FROM automation_trigger_rows;

CREATE TABLE automation_event_filters (
 automation_id TEXT PRIMARY KEY REFERENCES automations(automation_id) ON DELETE CASCADE,
 filter_json TEXT NOT NULL CHECK(json_valid(filter_json))
) WITHOUT ROWID, STRICT;

INSERT INTO automation_event_filters
SELECT automation_id,
  json_remove(json_set(event_filter_json, '$.kinds', json_extract(event_filter_json, '$.events')), '$.events')
FROM automation_trigger_rows WHERE trigger_kind = 'event';

DROP TABLE automation_trigger_rows;

CREATE UNIQUE INDEX idx_automations_active_heartbeat
           ON automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;
