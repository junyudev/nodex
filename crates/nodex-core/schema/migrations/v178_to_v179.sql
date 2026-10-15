CREATE TABLE core_automation_runs (
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  read_at INTEGER,
  session_title TEXT,
  source_cwd TEXT,
  inbox_title TEXT,
  inbox_summary TEXT,
  archived_user_message TEXT,
  archived_assistant_message TEXT,
  archived_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  run_revision INTEGER NOT NULL DEFAULT 1 CHECK (run_revision >= 1),
  admission_hash TEXT NOT NULL CHECK (length(admission_hash) = 64 AND admission_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(run_id) BETWEEN 1 AND 512 AND run_id = trim(run_id)),
  CHECK (session_id IS NULL OR (length(session_id) BETWEEN 1 AND 512 AND session_id = trim(session_id))),
  CHECK (status IN ('IN_PROGRESS', 'PENDING_REVIEW', 'ACCEPTED', 'ARCHIVED'))
) WITHOUT ROWID, STRICT;

INSERT INTO core_automation_runs
SELECT runs.thread_id, runs.automation_id,
  (SELECT session_id FROM project_session_threads WHERE thread_id = runs.thread_id),
  runs.status, runs.read_at, runs.thread_title, runs.source_cwd, runs.inbox_title,
  runs.inbox_summary, runs.archived_user_message, runs.archived_assistant_message,
  runs.archived_reason, runs.created_at, runs.updated_at, runs.run_revision,
  '0000000000000000000000000000000000000000000000000000000000000000'
FROM codex_automation_runs runs;
DROP TABLE codex_automation_runs;

CREATE INDEX core_automation_runs_definition_status_created
  ON core_automation_runs(automation_id, status, created_at DESC);
CREATE INDEX core_automation_runs_unread ON core_automation_runs(read_at, status, updated_at);
CREATE INDEX core_automation_runs_session_created
  ON core_automation_runs(session_id, created_at DESC, run_id);
CREATE TRIGGER core_automation_run_identity_guard
BEFORE UPDATE ON core_automation_runs
WHEN NEW.run_id <> OLD.run_id OR NEW.automation_id <> OLD.automation_id
  OR NEW.admission_hash <> OLD.admission_hash
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Automation Run admission and Session binding are immutable');
END;

ALTER TABLE core_automation_leases RENAME TO core_automation_leases_previous;
CREATE TABLE core_automation_leases (
  lease_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES codex_scheduled_automations(automation_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL CHECK (length(dispatch_id) BETWEEN 1 AND 512 AND dispatch_id = trim(dispatch_id)),
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  scheduled_for_ms INTEGER NOT NULL CHECK (scheduled_for_ms >= 0),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4294967295),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed', 'cancelled')),
  claimed_at_ms INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > claimed_at_ms),
  settled_at_ms INTEGER,
  retry_at_ms INTEGER,
  reason_code TEXT,
  UNIQUE (dispatch_id, attempt),
  CHECK (length(lease_id) BETWEEN 1 AND 512),
  CHECK (settled_at_ms IS NULL OR settled_at_ms >= claimed_at_ms),
  CHECK (retry_at_ms IS NULL OR retry_at_ms >= 0),
  CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  CHECK ((status = 'claimed' AND settled_at_ms IS NULL) OR (status <> 'claimed' AND settled_at_ms IS NOT NULL))
) WITHOUT ROWID, STRICT;
INSERT INTO core_automation_leases
SELECT lease.lease_id, lease.automation_id, lease.lease_id, definition.definition_revision,
  lease.scheduled_for_ms, lease.attempt, lease.status, lease.claimed_at_ms,
  lease.expires_at_ms, lease.settled_at_ms, lease.retry_at_ms, lease.reason_code
FROM core_automation_leases_previous lease
JOIN codex_scheduled_automations definition ON definition.automation_id = lease.automation_id;
DROP TABLE core_automation_leases_previous;
CREATE UNIQUE INDEX idx_core_automation_leases_active_occurrence
  ON core_automation_leases(automation_id, scheduled_for_ms) WHERE status = 'claimed';
CREATE INDEX idx_core_automation_leases_inbox
  ON core_automation_leases(status, expires_at_ms, scheduled_for_ms, lease_id);
CREATE INDEX core_automation_leases_retry
  ON core_automation_leases(automation_id, definition_revision, retry_at_ms, status, claimed_at_ms DESC, attempt DESC);
CREATE INDEX core_automation_leases_expiry
  ON core_automation_leases(automation_id, definition_revision, scheduled_for_ms, status, reason_code, claimed_at_ms DESC, attempt DESC);

CREATE TABLE nodex_agent_runtime_execution_cleanups (
  cleanup_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT,
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  UNIQUE (runtime_id, runtime_thread_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX nodex_agent_runtime_execution_cleanups_runtime
  ON nodex_agent_runtime_execution_cleanups(runtime_id, library_id, cleanup_id);
