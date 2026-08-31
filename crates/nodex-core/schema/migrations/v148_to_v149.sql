ALTER TABLE codex_threads DROP COLUMN model_provider;
ALTER TABLE codex_threads DROP COLUMN harness_id;

CREATE TABLE codex_scheduled_automations_v149 (
  automation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_thread_id TEXT,
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
  definition_revision INTEGER NOT NULL DEFAULT 1 CHECK (definition_revision >= 1),
  CHECK (kind IN ('cron', 'heartbeat')),
  CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
  CHECK (execution_environment IN ('local', 'worktree')),
  CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
  CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
  CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
) WITHOUT ROWID;

INSERT INTO codex_scheduled_automations_v149(
  automation_id, kind, status, target_thread_id, name, prompt, rrule, model,
  reasoning_effort, service_tier, cwds_json, execution_environment,
  local_environment_config_path, next_run_at, last_run_at, created_at, updated_at,
  definition_revision
)
SELECT
  automation_id, kind, status, target_thread_id, name, prompt, rrule, model,
  reasoning_effort, service_tier, cwds_json, execution_environment,
  local_environment_config_path, next_run_at, last_run_at, created_at, updated_at,
  definition_revision
FROM codex_scheduled_automations;

DROP TABLE codex_scheduled_automations;
ALTER TABLE codex_scheduled_automations_v149 RENAME TO codex_scheduled_automations;

CREATE UNIQUE INDEX idx_codex_scheduled_automations_active_heartbeat
  ON codex_scheduled_automations(target_thread_id)
  WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_thread_id IS NOT NULL;
