CREATE TABLE project_session_execution_bindings (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  launch_request_id TEXT NOT NULL,
  launch_request_hash TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  UNIQUE (runtime_id, runtime_thread_id),
  UNIQUE (runtime_id, launch_request_id),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (length(runtime_id) BETWEEN 1 AND 512 AND runtime_id = trim(runtime_id)),
  CHECK (length(runtime_thread_id) BETWEEN 1 AND 512 AND runtime_thread_id = trim(runtime_thread_id)),
  CHECK (length(launch_request_id) BETWEEN 1 AND 512 AND launch_request_id = trim(launch_request_id)),
  CHECK (length(launch_request_hash) = 64 AND launch_request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(bound_at) > 0)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER project_session_execution_binding_insert_guard
BEFORE INSERT ON project_session_execution_bindings
WHEN EXISTS (SELECT 1 FROM project_session_threads WHERE session_id = NEW.session_id)
  OR EXISTS (SELECT 1 FROM project_sessions WHERE id = NEW.session_id AND is_default_draft = 1)
BEGIN
  SELECT RAISE(ABORT, 'Session already has execution ownership or is a default draft');
END;

CREATE TABLE nodex_agent_runtime_turn_admissions (
  admission_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  runtime_run_id TEXT NOT NULL,
  runtime_lease_id TEXT NOT NULL,
  authority_thread_id TEXT NOT NULL,
  authority_turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES project_session_execution_bindings(session_id) ON DELETE CASCADE,
  parent_runtime_thread_id TEXT,
  parent_runtime_run_id TEXT,
  parent_runtime_lease_id TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  UNIQUE (runtime_id, runtime_thread_id, runtime_run_id, runtime_lease_id),
  UNIQUE (authority_thread_id, authority_turn_id),
  FOREIGN KEY (authority_thread_id, authority_turn_id)
    REFERENCES nodex_agent_turn_authorities(thread_id, turn_id),
  CHECK (length(runtime_id) BETWEEN 1 AND 512 AND runtime_id = trim(runtime_id)),
  CHECK (length(runtime_thread_id) BETWEEN 1 AND 512 AND runtime_thread_id = trim(runtime_thread_id)),
  CHECK (length(runtime_run_id) BETWEEN 1 AND 512 AND runtime_run_id = trim(runtime_run_id)),
  CHECK (length(runtime_lease_id) BETWEEN 1 AND 512 AND runtime_lease_id = trim(runtime_lease_id)),
  CHECK (length(authority_thread_id) BETWEEN 1 AND 512),
  CHECK (length(authority_turn_id) BETWEEN 1 AND 512),
  CHECK ((parent_runtime_thread_id IS NULL) = (parent_runtime_run_id IS NULL)),
  CHECK ((parent_runtime_thread_id IS NULL) = (parent_runtime_lease_id IS NULL))
) STRICT;

CREATE INDEX nodex_agent_runtime_parent_admissions
ON nodex_agent_runtime_turn_admissions(runtime_id, runtime_thread_id, runtime_run_id, admission_sequence DESC);

CREATE INDEX nodex_agent_runtime_active_admissions
ON nodex_agent_runtime_turn_admissions(runtime_id, runtime_lease_id) WHERE active = 1;

CREATE TRIGGER nodex_agent_runtime_turn_admission_update_guard
BEFORE UPDATE ON nodex_agent_runtime_turn_admissions
WHEN NEW.admission_sequence <> OLD.admission_sequence
  OR NEW.runtime_id <> OLD.runtime_id
  OR NEW.runtime_thread_id <> OLD.runtime_thread_id
  OR NEW.runtime_run_id <> OLD.runtime_run_id
  OR NEW.runtime_lease_id <> OLD.runtime_lease_id
  OR NEW.authority_thread_id <> OLD.authority_thread_id
  OR NEW.authority_turn_id <> OLD.authority_turn_id
  OR NEW.session_id <> OLD.session_id
  OR NEW.parent_runtime_thread_id IS NOT OLD.parent_runtime_thread_id
  OR NEW.parent_runtime_run_id IS NOT OLD.parent_runtime_run_id
  OR NEW.parent_runtime_lease_id IS NOT OLD.parent_runtime_lease_id
  OR NEW.active > OLD.active
BEGIN
  SELECT RAISE(ABORT, 'Runtime Turn admission is immutable and cannot be reactivated');
END;

CREATE TRIGGER project_session_execution_binding_update_guard
BEFORE UPDATE ON project_session_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'Agent Runtime Session binding is immutable');
END;

CREATE TRIGGER project_session_native_binding_insert_guard
BEFORE INSERT ON project_session_threads
WHEN EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Session execution belongs to Agent Runtime');
END;

CREATE TRIGGER project_session_native_binding_update_guard
BEFORE UPDATE ON project_session_threads
WHEN EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Session execution belongs to Agent Runtime');
END;

CREATE TRIGGER project_session_execution_scope_update_guard
BEFORE UPDATE OF project_id, is_default_draft ON project_sessions
WHEN (NEW.project_id IS NOT OLD.project_id OR NEW.is_default_draft = 1)
  AND EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Agent Runtime Session execution scope is immutable');
END;
