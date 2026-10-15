DROP TRIGGER nodex_agent_runtime_turn_admission_update_guard;
DROP INDEX nodex_agent_runtime_parent_admissions;
DROP INDEX nodex_agent_runtime_active_admissions;
ALTER TABLE nodex_agent_runtime_turn_admissions RENAME TO migrating_runtime_turn_admissions;

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
  native_provider_session_id TEXT,
  native_generation INTEGER,
  CHECK ((native_provider_session_id IS NULL) = (native_generation IS NULL)),
  CHECK (native_provider_session_id IS NULL OR (length(native_provider_session_id) BETWEEN 1 AND 512 AND native_provider_session_id = trim(native_provider_session_id))),
  CHECK (native_generation IS NULL OR native_generation BETWEEN 1 AND 4294967295),
  CHECK (active = 0 OR native_provider_session_id IS NOT NULL),
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

INSERT INTO nodex_agent_runtime_turn_admissions(
  admission_sequence,runtime_id,runtime_thread_id,runtime_run_id,runtime_lease_id,
  authority_thread_id,authority_turn_id,session_id,parent_runtime_thread_id,parent_runtime_run_id,parent_runtime_lease_id,active
) SELECT admission_sequence,runtime_id,runtime_thread_id,runtime_run_id,runtime_lease_id,
  authority_thread_id,authority_turn_id,session_id,parent_runtime_thread_id,parent_runtime_run_id,parent_runtime_lease_id,0
FROM migrating_runtime_turn_admissions;
DROP TABLE migrating_runtime_turn_admissions;

CREATE INDEX nodex_agent_runtime_parent_admissions
ON nodex_agent_runtime_turn_admissions(runtime_id, runtime_thread_id, runtime_run_id, admission_sequence DESC);

CREATE INDEX nodex_agent_runtime_active_admissions
ON nodex_agent_runtime_turn_admissions(runtime_id, runtime_lease_id) WHERE active = 1;

CREATE INDEX nodex_agent_runtime_active_turn_authorities
ON nodex_agent_runtime_turn_admissions(runtime_id, runtime_lease_id, authority_turn_id) WHERE active = 1;

CREATE INDEX nodex_agent_runtime_active_native_source_admissions
ON nodex_agent_runtime_turn_admissions(runtime_id, runtime_lease_id, native_provider_session_id, native_generation) WHERE active = 1;

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
  OR NEW.native_provider_session_id IS NOT OLD.native_provider_session_id
  OR NEW.native_generation IS NOT OLD.native_generation
  OR NEW.active > OLD.active
BEGIN
  SELECT RAISE(ABORT, 'Runtime Turn admission is immutable and cannot be reactivated');
END;

CREATE TABLE nodex_agent_runtime_native_session_admissions (
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  runtime_lease_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  native_generation INTEGER NOT NULL CHECK (native_generation BETWEEN 1 AND 4294967295),
  incarnation_id TEXT NOT NULL,
  authority_thread_id TEXT NOT NULL,
  authority_turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (runtime_id, incarnation_id),
  UNIQUE (authority_thread_id, authority_turn_id),
  FOREIGN KEY (authority_thread_id, authority_turn_id)
    REFERENCES nodex_agent_turn_authorities(thread_id, turn_id),
  CHECK (length(runtime_id) BETWEEN 1 AND 512 AND runtime_id = trim(runtime_id)),
  CHECK (length(runtime_thread_id) BETWEEN 1 AND 512 AND runtime_thread_id = trim(runtime_thread_id)),
  CHECK (length(runtime_lease_id) BETWEEN 1 AND 512 AND runtime_lease_id = trim(runtime_lease_id)),
  CHECK (length(provider_session_id) BETWEEN 1 AND 512 AND provider_session_id = trim(provider_session_id)),
  CHECK (length(incarnation_id) BETWEEN 1 AND 512 AND incarnation_id = trim(incarnation_id)),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (length(authority_thread_id) BETWEEN 1 AND 512),
  CHECK (length(authority_turn_id) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;

CREATE INDEX nodex_agent_runtime_native_session_admissions_session
ON nodex_agent_runtime_native_session_admissions(session_id) WHERE active = 1;

CREATE INDEX nodex_agent_runtime_active_native_session_admissions
ON nodex_agent_runtime_native_session_admissions(runtime_id, runtime_lease_id, incarnation_id) WHERE active = 1;

CREATE INDEX nodex_agent_runtime_active_native_session_source_admissions
ON nodex_agent_runtime_native_session_admissions(runtime_id, runtime_lease_id, provider_session_id, native_generation) WHERE active = 1;

CREATE TRIGGER nodex_agent_runtime_native_session_admission_update_guard
BEFORE UPDATE ON nodex_agent_runtime_native_session_admissions
WHEN NEW.runtime_id <> OLD.runtime_id
  OR NEW.runtime_thread_id <> OLD.runtime_thread_id
  OR NEW.runtime_lease_id <> OLD.runtime_lease_id
  OR NEW.provider_session_id <> OLD.provider_session_id
  OR NEW.native_generation <> OLD.native_generation
  OR NEW.incarnation_id <> OLD.incarnation_id
  OR NEW.authority_thread_id <> OLD.authority_thread_id
  OR NEW.authority_turn_id <> OLD.authority_turn_id
  OR NEW.session_id <> OLD.session_id
  OR NEW.active > OLD.active
BEGIN
  SELECT RAISE(ABORT, 'Native Session admission is immutable and cannot be reactivated');
END;

-- Source provenance and capture limits are separate: a native connection is not a Run.
ALTER TABLE inbox_entries ADD COLUMN source_budget_key TEXT;
UPDATE inbox_entries SET source_budget_key=json_array('native-turn',source_thread_id,source_turn_id)
WHERE source_kind='agent' AND source_thread_id IS NOT NULL AND source_turn_id IS NOT NULL;
DROP INDEX idx_inbox_entries_source_turn;
CREATE INDEX idx_inbox_entries_source_budget ON inbox_entries(library_id, source_budget_key)
  WHERE source_budget_key IS NOT NULL;
