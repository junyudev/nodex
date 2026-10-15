-- Profile access uses authenticated identity; Project remains execution and presentation context.
DROP TRIGGER IF EXISTS "visibility_dirty_projects_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_projects_update";
DROP TRIGGER IF EXISTS "visibility_dirty_projects_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_project_database_bindings_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_project_database_bindings_update";
DROP TRIGGER IF EXISTS "visibility_dirty_project_database_bindings_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_database_containers_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_database_containers_update";
DROP TRIGGER IF EXISTS "visibility_dirty_database_containers_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_data_sources_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_data_sources_update";
DROP TRIGGER IF EXISTS "visibility_dirty_data_sources_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_canvas_owners_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_canvas_owners_update";
DROP TRIGGER IF EXISTS "visibility_dirty_canvas_owners_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_database_views_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_database_views_update";
DROP TRIGGER IF EXISTS "visibility_dirty_database_views_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_data_source_page_memberships_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_data_source_page_memberships_update";
DROP TRIGGER IF EXISTS "visibility_dirty_data_source_page_memberships_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_blocks_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_blocks_update";
DROP TRIGGER IF EXISTS "visibility_dirty_blocks_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_documents_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_documents_update";
DROP TRIGGER IF EXISTS "visibility_dirty_documents_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_block_documents_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_block_documents_update";
DROP TRIGGER IF EXISTS "visibility_dirty_block_documents_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_pages_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_pages_update";
DROP TRIGGER IF EXISTS "visibility_dirty_pages_delete";
DROP TRIGGER IF EXISTS "project_resource_grants_validate_active_root_insert";
DROP TRIGGER IF EXISTS "project_resource_grants_validate_active_root_update";
DROP TRIGGER IF EXISTS "visibility_dirty_project_resource_grants_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_project_resource_grants_update";
DROP TRIGGER IF EXISTS "visibility_dirty_project_resource_grants_delete";
DROP TRIGGER IF EXISTS "visibility_dirty_library_files_insert";
DROP TRIGGER IF EXISTS "visibility_dirty_library_files_delete";
DELETE FROM core_module_receipts;
DELETE FROM detached_module_receipts;
DELETE FROM module_receipt_retention_metadata;
DELETE FROM nodex_agent_runtime_turn_admissions;
DROP TRIGGER nodex_agent_turn_authorities_are_immutable;
DROP TRIGGER nodex_agent_turn_authorities_cannot_delete;
DROP TABLE nodex_agent_turn_authorities;
CREATE TABLE nodex_agent_turn_authorities (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  root_thread_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  store_epoch TEXT NOT NULL,
  authority_fingerprint TEXT NOT NULL CHECK (length(authority_fingerprint) = 64),
  provenance_version INTEGER NOT NULL CHECK (provenance_version = 2),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, turn_id),
  CHECK (length(trim(thread_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(turn_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(root_thread_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(library_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(profile_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(store_epoch)) BETWEEN 1 AND 512)
) WITHOUT ROWID;

CREATE TRIGGER nodex_agent_turn_authorities_are_immutable
    BEFORE UPDATE ON nodex_agent_turn_authorities
    BEGIN
      SELECT RAISE(ABORT, 'Nodex Agent Turn authorities are immutable');
    END;

CREATE TRIGGER nodex_agent_turn_authorities_cannot_delete
    BEFORE DELETE ON nodex_agent_turn_authorities
    BEGIN
      SELECT RAISE(ABORT, 'Nodex Agent Turn authorities are immutable');
    END;

CREATE TEMP TABLE saved_execution_bindings AS SELECT session_id,runtime_id,runtime_thread_id,launch_request_id,bound_at FROM project_session_execution_bindings;
DROP TABLE project_session_execution_bindings;
CREATE TABLE project_session_execution_bindings (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  launch_request_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  UNIQUE (runtime_id, runtime_thread_id),
  UNIQUE (runtime_id, launch_request_id),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (length(runtime_id) BETWEEN 1 AND 512 AND runtime_id = trim(runtime_id)),
  CHECK (length(runtime_thread_id) BETWEEN 1 AND 512 AND runtime_thread_id = trim(runtime_thread_id)),
  CHECK (length(launch_request_id) BETWEEN 1 AND 512 AND launch_request_id = trim(launch_request_id)),
  CHECK (length(bound_at) > 0)
) WITHOUT ROWID, STRICT;

INSERT INTO project_session_execution_bindings SELECT * FROM saved_execution_bindings;
DROP TABLE saved_execution_bindings;

CREATE TRIGGER project_session_execution_binding_insert_guard
BEFORE INSERT ON project_session_execution_bindings
WHEN EXISTS (SELECT 1 FROM project_session_threads WHERE session_id = NEW.session_id)
  OR EXISTS (SELECT 1 FROM project_sessions WHERE id = NEW.session_id AND is_default_draft = 1)
BEGIN
  SELECT RAISE(ABORT, 'Session already has execution ownership or is a default draft');
END;


CREATE TRIGGER project_session_execution_binding_update_guard
BEFORE UPDATE ON project_session_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'Agent Runtime Session binding is immutable');
END;

DROP TABLE local_commit_visibility_dirty_facts;
DROP TABLE local_commit_visibility_deltas;
DROP TABLE local_commit_visibility_context;
DROP TABLE local_commit_revocations;
DROP TABLE project_resource_grants;
DROP TABLE codex_project_permission_mode_selections;
DROP TABLE codex_projectless_permission_mode_selection;
DELETE FROM local_commit_delivery_atoms;
DELETE FROM local_commit_sealed_projection_effects;
DELETE FROM local_commit_library_effects;
DELETE FROM local_commit_documents;
DELETE FROM local_commit_effects;
DELETE FROM local_commit_retention_metadata;
DELETE FROM local_commit_relocation_obligations;
DELETE FROM local_commits;
DELETE FROM projection_scope_heads;
UPDATE operational_journal_state SET replay_floor_seq=CASE WHEN commit_head_seq=0 THEN 0 ELSE commit_head_seq+1 END,retained_commit_count=0,retained_delivery_bytes=0,delivery_pressure_active=0,pending_metadata_count=0,metadata_backfill_cursor_seq=0,retained_receipt_count=0,retained_receipt_bytes=0,receipt_pressure_active=0;

DROP TRIGGER project_session_execution_scope_update_guard;
CREATE TRIGGER project_session_execution_draft_update_guard
BEFORE UPDATE OF is_default_draft ON project_sessions
WHEN NEW.is_default_draft = 1
  AND EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'A running Session cannot become a default draft');
END;

CREATE INDEX idx_project_sessions_project_identity ON project_sessions(project_id,id);

-- Retained Document deletion history uses owner lifecycle terminology.
DROP TRIGGER change_log_is_immutable;
UPDATE change_log SET payload_json=json_set(payload_json,'$.reason','owner_deleted')
WHERE kind='owned_document.document_invalidated' AND json_extract(payload_json,'$.module')='owned_document' AND json_extract(payload_json,'$.reason')='access_changed';

CREATE TRIGGER change_log_is_immutable
      BEFORE UPDATE ON change_log
      BEGIN
        SELECT RAISE(ABORT, 'change log entries are immutable');
      END;

ALTER TABLE database_containers DROP COLUMN access_revision;
