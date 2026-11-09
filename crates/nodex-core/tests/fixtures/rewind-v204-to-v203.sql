-- Test support: restore the published v203 schema from the current one, keeping the content a
-- v203 Store can hold, so a test can exercise the production upgrade from data written by today's
-- Modules. rewind_v204_to_v203 runs it with foreign keys off and legacy ALTER TABLE semantics.
DROP VIEW activity_facts;
DROP VIEW inbox_member_rows;
DROP VIEW inbox_rows;
DROP VIEW activity_page_scopes;
DROP TRIGGER automation_clock_triggers_immutable;
DROP TRIGGER automation_decision_page_deleted;
DROP TRIGGER automation_decision_page_inactive;
DROP TRIGGER automation_decisions_capture_actor;
DROP TRIGGER automation_decisions_name_immutable;
DROP TRIGGER automation_run_identity_guard;
DROP TRIGGER automations_owner_removed;
DROP TRIGGER channel_outbox_capture_actor;
DROP TRIGGER channel_outbox_capture_state_actor;
DROP TRIGGER channel_outbox_frozen;
DROP TRIGGER chat_message_handbacks_capture_actor;
DROP TRIGGER data_source_relation_edges_validate_insert;
DROP TRIGGER intake_dispositions_capture_actor;
DROP TRIGGER libraries_initialize_local_member;
DROP TRIGGER local_commit_actor_is_immutable;
DROP TRIGGER local_commits_require_actor;
DROP TRIGGER member_session_pin_clears_manual_rank;
DROP TRIGGER member_session_unpin_clears_manual_rank;
DROP TRIGGER members_name_insert;
DROP TRIGGER members_name_update;
DROP TRIGGER mutation_actors_are_immutable;
DROP TRIGGER page_turn_notes_capture_actor;
DROP TRIGGER page_work_captures_grant;
DROP TRIGGER page_work_captures_initial_grant;
DROP TRIGGER page_work_launches_require_actor;
DROP TRIGGER page_work_retires_grant;
DROP TRIGGER pages_initialize_work;
DROP TRIGGER personal_space_kind_update;
DROP TRIGGER personal_space_member_delete;
DROP TRIGGER personal_space_member_insert;
DROP TRIGGER personal_space_member_update;
DROP TRIGGER source_triggers_immutable;
DROP TRIGGER turn_block_properties_delete;
DROP TRIGGER turn_block_properties_insert;
DROP TRIGGER turn_block_properties_update;
DROP TRIGGER turn_blocks_delete;
DROP TRIGGER turn_blocks_insert;
DROP TRIGGER turn_blocks_update;
DROP TRIGGER turn_data_source_page_memberships_delete;
DROP TRIGGER turn_data_source_page_memberships_insert;
DROP TRIGGER turn_data_source_page_memberships_update;
DROP TRIGGER turn_data_source_properties_delete;
DROP TRIGGER turn_data_source_properties_insert;
DROP TRIGGER turn_data_source_properties_update;
DROP TRIGGER turn_data_source_property_values_delete;
DROP TRIGGER turn_data_source_property_values_insert;
DROP TRIGGER turn_data_source_property_values_update;
DROP TRIGGER turn_data_source_relation_edges_delete;
DROP TRIGGER turn_data_source_relation_edges_insert;
DROP TRIGGER turn_data_source_relation_edges_update;
DROP TRIGGER turn_data_sources_update;
DROP TRIGGER turn_database_containers_update;
DROP TRIGGER turn_members_update;
DROP TRIGGER turn_page_active_chats_delete;
DROP TRIGGER turn_page_active_chats_insert;
DROP TRIGGER turn_page_active_chats_update;
DROP TRIGGER turn_page_key_namespaces_update;
DROP TRIGGER turn_page_pull_requests_delete;
DROP TRIGGER turn_page_pull_requests_insert;
DROP TRIGGER turn_page_pull_requests_update;
DROP TRIGGER turn_page_workspaces_delete;
DROP TRIGGER turn_page_workspaces_insert;
DROP TRIGGER turn_page_workspaces_update;
DROP TRIGGER turn_pages_delete;
DROP TRIGGER turn_pages_insert;
DROP TRIGGER turn_pages_update;
DROP TRIGGER turn_project_database_bindings_delete;
DROP TRIGGER turn_project_database_bindings_insert;
DROP TRIGGER turn_project_database_bindings_update;
DROP TRIGGER turn_project_session_pages_delete;
DROP TRIGGER turn_project_session_pages_insert;
DROP TRIGGER turn_project_session_pages_update;
DROP TRIGGER turn_projects_delete;
DROP TRIGGER turn_projects_insert;
DROP TRIGGER turn_projects_update;
DROP TRIGGER turn_session_execution_observations_delete;
DROP TRIGGER turn_session_execution_observations_insert;
DROP TRIGGER turn_session_execution_observations_update;
DROP INDEX document_recovery_drafts_member;
DROP INDEX idx_page_work_reports_latest;

-- Automations return to Scheduled tasks; only decisions waiting on a Page were firings.
CREATE TABLE "codex_scheduled_automations" (
           automation_id TEXT PRIMARY KEY,
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
           definition_revision INTEGER NOT NULL DEFAULT 1 CHECK (definition_revision >= 1),
           notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only'), project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512)), agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude', 'opencode')), agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512)), agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind IN ('claude', 'opencode') AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512)))),
  launch TEXT NOT NULL DEFAULT 'automatic' CHECK (launch IN ('automatic','ask')), runbook_page_id TEXT,
           CHECK (kind IN ('cron', 'heartbeat')),
           CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
           CHECK (execution_environment IN ('local', 'worktree')),
           CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
           CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
           CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
         ) WITHOUT ROWID;
INSERT INTO codex_scheduled_automations(automation_id,kind,status,target_session_id,name,prompt,rrule,model,
    reasoning_effort,service_tier,cwds_json,execution_environment,local_environment_config_path,next_run_at,last_run_at,
    created_at,updated_at,definition_revision,notification_policy,project_id,agent_backend_kind,agent_backend_definition_id,
    agent_backend_instance_config_id,launch,runbook_page_id)
  SELECT automation_id,kind,status,target_session_id,name,prompt,rrule,model,reasoning_effort,service_tier,cwds_json,
    execution_environment,local_environment_config_path,next_run_at,last_run_at,created_at,updated_at,automation_revision,
    notification_policy,project_id,agent_backend_kind,agent_backend_definition_id,agent_backend_instance_config_id,
    CASE mode WHEN 'run' THEN 'automatic' ELSE 'ask' END,runbook_page_id
  FROM automations;
CREATE TABLE core_automation_runtime_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  jitter_salt TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
  CHECK (length(jitter_salt) BETWEEN 1 AND 512)
) STRICT;
INSERT INTO core_automation_runtime_metadata(id,jitter_salt,created_at_unix_ms)
  SELECT id,jitter_salt,created_at_unix_ms FROM automation_clock_metadata;
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
  purpose TEXT NOT NULL DEFAULT 'run' CHECK (purpose IN ('run','hold')),
  UNIQUE (dispatch_id, attempt),
  CHECK (length(lease_id) BETWEEN 1 AND 512),
  CHECK (settled_at_ms IS NULL OR settled_at_ms >= claimed_at_ms),
  CHECK (retry_at_ms IS NULL OR retry_at_ms >= 0),
  CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  CHECK ((status = 'claimed' AND settled_at_ms IS NULL) OR (status <> 'claimed' AND settled_at_ms IS NOT NULL))
) WITHOUT ROWID, STRICT;
INSERT INTO core_automation_leases(lease_id,automation_id,dispatch_id,definition_revision,scheduled_for_ms,attempt,status,
    claimed_at_ms,expires_at_ms,settled_at_ms,retry_at_ms,reason_code,purpose)
  SELECT lease_id,automation_id,dispatch_id,automation_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,
    settled_at_ms,retry_at_ms,reason_code,purpose
  FROM automation_execution_leases;
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
  dispatch_id TEXT,
  CHECK (length(run_id) BETWEEN 1 AND 512 AND run_id = trim(run_id)),
  CHECK (session_id IS NULL OR (length(session_id) BETWEEN 1 AND 512 AND session_id = trim(session_id))),
  CHECK (status IN ('IN_PROGRESS', 'PENDING_REVIEW', 'ACCEPTED', 'ARCHIVED'))
) WITHOUT ROWID, STRICT;
INSERT INTO core_automation_runs(run_id,automation_id,session_id,status,read_at,session_title,source_cwd,inbox_title,
    inbox_summary,archived_user_message,archived_assistant_message,archived_reason,created_at,updated_at,run_revision,
    admission_hash,dispatch_id)
  SELECT run_id,automation_id,session_id,status,read_at,session_title,source_cwd,inbox_title,inbox_summary,
    archived_user_message,archived_assistant_message,archived_reason,created_at,updated_at,run_revision,admission_hash,
    dispatch_id
  FROM automation_execution_runs;
CREATE TABLE core_automation_firings (
  dispatch_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES codex_scheduled_automations(automation_id),
  status TEXT NOT NULL CHECK (status IN ('held','admitted','completed','failed','skipped','withdrawn')),
  page_id TEXT NOT NULL,
  inbox_project_id TEXT,
  first_scheduled_for_ms INTEGER NOT NULL CHECK (first_scheduled_for_ms >= 0),
  last_scheduled_for_ms INTEGER NOT NULL CHECK (last_scheduled_for_ms >= first_scheduled_for_ms),
  missed_count INTEGER NOT NULL DEFAULT 0 CHECK (missed_count BETWEEN 0 AND 4294967295),
  hold_basis_json TEXT NOT NULL CHECK (json_valid(hold_basis_json)),
  admission_prompt TEXT,
  admission_agent_json TEXT CHECK (admission_agent_json IS NULL OR json_valid(admission_agent_json)),
  admitted_at_ms INTEGER,
  due_at_ms INTEGER,
  failure_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
, waiting_in_inbox INTEGER NOT NULL DEFAULT 0
  CHECK (waiting_in_inbox IN (0,1) AND (waiting_in_inbox=0 OR status IN ('held','failed')))) WITHOUT ROWID, STRICT;
INSERT INTO core_automation_firings(dispatch_id,automation_id,status,page_id,inbox_project_id,first_scheduled_for_ms,
    last_scheduled_for_ms,missed_count,hold_basis_json,admission_prompt,admission_agent_json,admitted_at_ms,due_at_ms,
    failure_message,created_at_ms,updated_at_ms,waiting_in_inbox)
  SELECT dispatch_id,automation_id,status,page_id,inbox_project_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,
    hold_basis_json,admission_prompt,admission_agent_json,admitted_at_ms,due_at_ms,failure_message,created_at_ms,
    updated_at_ms,waiting_in_inbox
  FROM automation_decisions WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX idx_core_automation_leases_active_occurrence
  ON core_automation_leases(automation_id, scheduled_for_ms)
  WHERE status = 'claimed';
CREATE INDEX idx_core_automation_leases_inbox
  ON core_automation_leases(status, expires_at_ms, scheduled_for_ms, lease_id);
CREATE UNIQUE INDEX idx_codex_scheduled_automations_active_heartbeat
           ON codex_scheduled_automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;
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
CREATE INDEX core_automation_leases_retry
  ON core_automation_leases(automation_id, definition_revision, retry_at_ms, status, claimed_at_ms DESC, attempt DESC);
CREATE INDEX core_automation_leases_expiry
  ON core_automation_leases(automation_id, definition_revision, scheduled_for_ms, status, reason_code, claimed_at_ms DESC, attempt DESC);
CREATE UNIQUE INDEX idx_core_automation_firings_waiting ON core_automation_firings(automation_id) WHERE waiting_in_inbox=1;
CREATE UNIQUE INDEX idx_core_automation_firings_page ON core_automation_firings(page_id);
CREATE INDEX idx_core_automation_firings_due ON core_automation_firings(due_at_ms) WHERE status='admitted';
CREATE INDEX idx_core_automation_runs_dispatch ON core_automation_runs(dispatch_id,created_at,run_id);

ALTER TABLE inbox_entries RENAME TO inbox_entries_v204;
CREATE TABLE inbox_entries (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  submitted_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'agent', 'command_line', 'scheduled_task')),
  source_session_id TEXT CHECK (source_session_id IS NULL OR length(source_session_id) BETWEEN 1 AND 512),
  source_thread_id TEXT CHECK (source_thread_id IS NULL OR length(source_thread_id) BETWEEN 1 AND 512),
  source_turn_id TEXT CHECK (source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 512),
  source_project_id TEXT CHECK (source_project_id IS NULL OR length(source_project_id) BETWEEN 1 AND 512),
  source_label TEXT CHECK (source_label IS NULL OR length(source_label) BETWEEN 1 AND 512),
  provisional_title TEXT CHECK (provisional_title IS NULL OR length(provisional_title) BETWEEN 1 AND 512),
  kind TEXT CHECK (kind IS NULL OR kind IN ('note', 'todo', 'question')),
  kind_set_by_user INTEGER NOT NULL DEFAULT 0 CHECK (kind_set_by_user IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'kept', 'done')),
  suggestion_state TEXT NOT NULL DEFAULT 'none' CHECK (suggestion_state IN ('none', 'waiting', 'pending', 'settled', 'failed')),
  suggestion_error TEXT CHECK (suggestion_error IS NULL OR length(suggestion_error) BETWEEN 1 AND 2000),
  current_proposal_id TEXT CHECK (current_proposal_id IS NULL OR length(current_proposal_id) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  source_budget_key TEXT,
  scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE CHECK (scope_project_id IS NULL OR length(scope_project_id) BETWEEN 1 AND 512),
  outcome TEXT CHECK (outcome IN ('kept','done','moved','chat')),
  suggestion_request_id TEXT,
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  source_automation_id TEXT,
  source_dispatch_id TEXT,
  UNIQUE (library_id, seq),
  CHECK (source_kind = 'agent' OR (source_session_id IS NULL AND source_thread_id IS NULL AND source_turn_id IS NULL)),
  CHECK (source_kind <> 'user' OR (source_project_id IS NULL AND source_label IS NULL)),
  CHECK (source_kind = 'user' OR source_label IS NOT NULL),
  CHECK (suggestion_state = 'failed' OR suggestion_error IS NULL)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,source_session_id,source_thread_id,
    source_turn_id,source_project_id,source_label,provisional_title,kind,kind_set_by_user,state,suggestion_state,
    suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,scope_project_id,outcome,
    suggestion_request_id,important,source_automation_id,source_dispatch_id)
  SELECT page_id,library_id,seq,submitted_at,CASE source_kind WHEN 'automation' THEN 'scheduled_task' ELSE source_kind END,
    source_session_id,source_thread_id,source_turn_id,source_project_id,source_label,provisional_title,kind,
    kind_set_by_user,state,suggestion_state,suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,
    scope_project_id,outcome,suggestion_request_id,important,source_automation_id,source_dispatch_id
  FROM inbox_entries_v204;
DROP TABLE inbox_entries_v204;
ALTER TABLE inbox_proposals RENAME TO inbox_proposals_v204;
CREATE TABLE inbox_proposals (
  proposal_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user', 'schedule')),
  state TEXT NOT NULL CHECK (state IN ('open', 'superseded', 'dismissed', 'dispatching', 'completed', 'failed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  action_json TEXT NOT NULL CHECK (json_valid(action_json) AND length(action_json) <= 65536),
  kind TEXT CHECK (kind IS NULL OR kind IN ('note', 'todo', 'question')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  rationale TEXT CHECK (rationale IS NULL OR length(rationale) BETWEEN 1 AND 4000),
  produced_by TEXT CHECK (produced_by IS NULL OR length(produced_by) BETWEEN 1 AND 256),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'array'),
  dispatch_session_id TEXT CHECK (dispatch_session_id IS NULL OR length(dispatch_session_id) BETWEEN 1 AND 512),
  dispatch_thread_id TEXT CHECK (dispatch_thread_id IS NULL OR length(dispatch_thread_id) BETWEEN 1 AND 512),
  confirmed_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  failure_message TEXT CHECK (failure_message IS NULL OR length(failure_message) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failure_kind TEXT CHECK (failure_kind IN ('rejected','unavailable','unknown')),
  CHECK (state <> 'dispatching' OR (dispatch_session_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_message IS NOT NULL)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,revision,action_json,kind,summary,rationale,produced_by,
    basis_json,dispatch_session_id,dispatch_thread_id,confirmed_at,attempt,failure_message,created_at,updated_at,
    failure_kind)
  SELECT proposal_id,library_id,CASE origin WHEN 'automation' THEN 'schedule' ELSE origin END,state,revision,
    CASE WHEN json_extract(action_json,'$.type')='execute_decision'
      THEN json_remove(json_set(action_json,'$.type','run_task',
          '$.automation_id',(SELECT automation_id FROM automation_decisions WHERE dispatch_id=json_extract(action_json,'$.decision_id')),
          '$.dispatch_id',json_extract(action_json,'$.decision_id')),'$.decision_id')
      ELSE action_json END,
    kind,summary,rationale,produced_by,basis_json,dispatch_session_id,dispatch_thread_id,confirmed_at,attempt,
    failure_message,created_at,updated_at,failure_kind
  FROM inbox_proposals_v204;
DROP TABLE inbox_proposals_v204;

-- The local Member's attention returns to the chat.
CREATE TABLE project_session_reminder_deliveries (
  delivery_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES project_sessions(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
INSERT INTO project_session_reminder_deliveries(delivery_id,session_id,remind_at,next_attempt_at)
  SELECT delivery.delivery_id,delivery.session_id,delivery.remind_at,delivery.next_attempt_at
  FROM member_session_reminder_deliveries delivery JOIN local_profile_members local ON local.member_id=delivery.member_id;
ALTER TABLE project_sessions RENAME TO project_sessions_v204;
CREATE TABLE "project_sessions" (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  no_thread_fallback_title TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_order INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, is_default_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_default_draft IN (0, 1)), remind_at TEXT,
  activity_at INTEGER NOT NULL,
  manual_rank INTEGER,
  CHECK (activity_at >= CAST(round(unixepoch(created_at, 'subsec') * 1000) AS INTEGER)),
  CHECK (pinned IN (0, 1)),
  CHECK (archived IN (0, 1)),
  CHECK (unread IN (0, 1))
);
INSERT INTO project_sessions(id,project_id,no_thread_fallback_title,pinned,pinned_order,archived,archived_at,unread,
    created_at,updated_at,is_default_draft,remind_at,activity_at,manual_rank)
  SELECT session.id,session.project_id,session.no_thread_fallback_title,
    EXISTS(SELECT 1 FROM member_session_pins pin JOIN local_profile_members local ON local.member_id=pin.member_id
      WHERE pin.session_id=session.id),
    (SELECT pin.pinned_order FROM member_session_pins pin JOIN local_profile_members local ON local.member_id=pin.member_id
      WHERE pin.session_id=session.id),
    session.archived,session.archived_at,
    EXISTS(SELECT 1 FROM member_session_unread unread JOIN local_profile_members local ON local.member_id=unread.member_id
      WHERE unread.session_id=session.id),
    session.created_at,session.updated_at,session.is_default_draft,
    (SELECT reminder.remind_at FROM member_session_reminders reminder
      JOIN local_profile_members local ON local.member_id=reminder.member_id WHERE reminder.session_id=session.id),
    session.activity_at,session.manual_rank
  FROM project_sessions_v204 session;
DROP TABLE project_sessions_v204;

ALTER TABLE page_file_entries RENAME TO page_file_entries_v204;
CREATE TABLE page_file_entries (
  page_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  logical_path TEXT NOT NULL CHECK (length(logical_path) BETWEEN 1 AND 1024),
  path_key TEXT NOT NULL CHECK (length(path_key) BETWEEN 1 AND 1024),
  attached_by_json TEXT NOT NULL DEFAULT '{"kind":"unknown"}'
    CHECK (json_valid(attached_by_json) AND COALESCE(json_extract(attached_by_json, '$.kind') IN ('person', 'agent', 'external', 'unknown'), 0)),
  attached_at TEXT CHECK (
    (json_extract(attached_by_json, '$.kind') = 'unknown' AND attached_at IS NULL) OR
    (json_extract(attached_by_json, '$.kind') <> 'unknown' AND attached_at IS NOT NULL AND length(attached_at) > 0)
  ),
  PRIMARY KEY (page_id, file_id),
  UNIQUE (page_id, path_key),
  FOREIGN KEY (page_id, library_id) REFERENCES pages(block_id, library_id)
    ON DELETE CASCADE,
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;
INSERT INTO page_file_entries(page_id,library_id,file_id,logical_path,path_key,attached_by_json,attached_at)
  SELECT page_id,library_id,file_id,logical_path,path_key,
    CASE json_extract(attached_by_json,'$.type')
      WHEN 'agent' THEN json_object('kind','agent','session_id',json_extract(attached_by_json,'$.session_id'),'backend','codex')
      WHEN 'service' THEN json_object('kind','unknown')
      ELSE json_object('kind','person') END,
    CASE WHEN json_extract(attached_by_json,'$.type')='service' THEN NULL ELSE attached_at END
  FROM page_file_entries_v204;
DROP TABLE page_file_entries_v204;
ALTER TABLE library_files RENAME TO library_files_v204;
CREATE TABLE library_files (
  file_id TEXT PRIMARY KEY CHECK (length(file_id) BETWEEN 1 AND 512),
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  default_name TEXT NOT NULL CHECK (length(default_name) BETWEEN 1 AND 255),
  head_version INTEGER NOT NULL CHECK (head_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('live', 'trashed')),
  created_by_actor_id TEXT CHECK (length(created_by_actor_id) BETWEEN 1 AND 512),
  created_by_turn_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  UNIQUE (file_id, library_id),
  FOREIGN KEY (file_id, head_version, library_id)
    REFERENCES file_versions(file_id, version, library_id)
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID, STRICT;
INSERT INTO library_files(file_id,library_id,default_name,head_version,revision,lifecycle,created_by_turn_id,created_at,
    updated_at)
  SELECT file_id,library_id,default_name,head_version,revision,lifecycle,created_by_turn_id,created_at,updated_at
  FROM library_files_v204;
DROP TABLE library_files_v204;
ALTER TABLE file_versions RENAME TO file_versions_v204;
CREATE TABLE file_versions (
  file_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  library_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES managed_blobs(content_hash) ON DELETE RESTRICT,
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 255),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  actor_id TEXT CHECK (length(actor_id) BETWEEN 1 AND 512),
  turn_id TEXT,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
  PRIMARY KEY (file_id, version),
  UNIQUE (file_id, version, library_id),
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID, STRICT;
INSERT INTO file_versions(file_id,version,library_id,blob_hash,mime_type,byte_length,turn_id,operation_id,occurred_at)
  SELECT file_id,version,library_id,blob_hash,mime_type,byte_length,turn_id,operation_id,occurred_at FROM file_versions_v204;
DROP TABLE file_versions_v204;

ALTER TABLE database_view_personal_preferences RENAME TO database_view_personal_preferences_v204;
CREATE TABLE database_view_personal_preferences (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          preferences_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, view_id),
          CHECK (
            json_valid(preferences_json)
            AND json_type(preferences_json) = 'object'
          )
        ) WITHOUT ROWID, STRICT;
INSERT INTO database_view_personal_preferences(profile_id,view_id,preferences_json,revision,created_at,updated_at)
  SELECT local.profile_id,old.view_id,old.preferences_json,old.revision,old.created_at,old.updated_at
  FROM database_view_personal_preferences_v204 old JOIN local_profile_members local ON local.member_id=old.member_id;
DROP TABLE database_view_personal_preferences_v204;
ALTER TABLE database_view_collapsed_occurrences RENAME TO database_view_collapsed_occurrences_v204;
CREATE TABLE database_view_collapsed_occurrences (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          target_kind TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          collapsed_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, view_id, target_kind, occurrence_key),
          CHECK (target_kind IN ('group', 'page')),
          CHECK (length(occurrence_key) BETWEEN 1 AND 1024),
          CHECK (
            (target_kind = 'group' AND substr(occurrence_key, 1, 6) = 'GROUP_')
            OR (target_kind = 'page' AND substr(occurrence_key, 1, 5) = 'ITEM_')
          )
        ) WITHOUT ROWID, STRICT;
INSERT INTO database_view_collapsed_occurrences(profile_id,view_id,target_kind,occurrence_key,collapsed_at)
  SELECT local.profile_id,old.view_id,old.target_kind,old.occurrence_key,old.collapsed_at
  FROM database_view_collapsed_occurrences_v204 old JOIN local_profile_members local ON local.member_id=old.member_id;
DROP TABLE database_view_collapsed_occurrences_v204;

ALTER TABLE core_module_receipts RENAME TO core_module_receipts_v204;
CREATE TABLE "core_module_receipts" (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  adapter_kind TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  store_epoch TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  event_sequence INTEGER REFERENCES change_log(seq) ON DELETE RESTRICT,
  local_commit_seq INTEGER,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (module_name, operation_id),
  FOREIGN KEY (store_epoch, local_commit_seq)
    REFERENCES "local_commits"(store_epoch, commit_seq),
  CHECK (module_name IN (
    'library', 'database', 'owned_document', 'project_workspace',
    'automation', 'store_administration'
  )),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (length(profile_id) BETWEEN 1 AND 512),
  CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 512),
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
INSERT INTO core_module_receipts SELECT * FROM core_module_receipts_v204;
DROP TABLE core_module_receipts_v204;
ALTER TABLE detached_module_receipts RENAME TO detached_module_receipts_v204;
-- Receipts are detached before their replay-only LocalCommit is pruned. This
-- preserves exact idempotent responses without retaining the full delivery
-- graph or weakening the authoritative receipt table's foreign keys.
CREATE TABLE detached_module_receipts (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  project_id TEXT,
  adapter_kind TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  store_epoch TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  event_sequence INTEGER,
  local_commit_seq INTEGER NOT NULL CHECK (local_commit_seq >= 1),
  commit_manifest_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  detached_at_ms INTEGER NOT NULL CHECK (detached_at_ms >= 0),
  PRIMARY KEY (module_name, operation_id),
  CHECK (module_name IN (
    'library', 'database', 'owned_document', 'project_workspace',
    'automation', 'store_administration'
  )),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (length(profile_id) BETWEEN 1 AND 512),
  CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 512),
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (event_sequence IS NULL OR event_sequence >= 1),
  CHECK (length(commit_manifest_hash) = 64 AND commit_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
INSERT INTO detached_module_receipts SELECT * FROM detached_module_receipts_v204;
DROP TABLE detached_module_receipts_v204;
CREATE TRIGGER project_session_execution_draft_update_guard
BEFORE UPDATE OF is_default_draft ON project_sessions
WHEN NEW.is_default_draft = 1
  AND EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'A running Session cannot become a default draft');
END;
CREATE INDEX idx_library_files_catalog
  ON library_files(library_id, lifecycle, default_name COLLATE NOCASE, file_id);
CREATE INDEX idx_file_versions_blob ON file_versions(blob_hash);
CREATE INDEX idx_page_file_entries_file ON page_file_entries(file_id, page_id);
CREATE TRIGGER library_files_retain_document_history BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM document_version_file_refs reference WHERE reference.file_id = OLD.file_id AND reference.library_id = OLD.library_id)
BEGIN
  SELECT RAISE(ABORT, 'File is retained by Document history');
END;
CREATE TRIGGER library_files_validate_insert
BEFORE INSERT ON library_files
WHEN EXISTS (SELECT 1 FROM retired_file_ids retired WHERE retired.file_id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'Retired File identities cannot be reused');
END;
CREATE TRIGGER library_files_validate_update
BEFORE UPDATE ON library_files
WHEN NEW.file_id <> OLD.file_id OR NEW.library_id <> OLD.library_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.head_version < OLD.head_version
  OR NEW.created_by_actor_id <> OLD.created_by_actor_id
  OR NEW.created_by_turn_id IS NOT OLD.created_by_turn_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'File updates must preserve identity and advance revision');
END;
CREATE TRIGGER library_files_validate_trash BEFORE UPDATE OF lifecycle ON library_files
WHEN NEW.lifecycle = 'trashed' AND (
  EXISTS (SELECT 1 FROM page_file_entries WHERE file_id = NEW.file_id AND library_id = NEW.library_id)
  OR EXISTS (SELECT 1 FROM block_asset_refs WHERE file_id = NEW.file_id AND library_id = NEW.library_id)
  OR EXISTS (SELECT 1 FROM canvas_scene_file_refs WHERE target_file_id = NEW.file_id AND library_id = NEW.library_id)
)
BEGIN SELECT RAISE(ABORT, 'Current or recoverable content prevents File trash'); END;
CREATE TRIGGER library_files_require_retirement BEFORE DELETE ON library_files
WHEN NOT EXISTS (SELECT 1 FROM retired_file_ids WHERE file_id = OLD.file_id AND library_id = OLD.library_id)
BEGIN SELECT RAISE(ABORT, 'Permanent File deletion must retire its identity'); END;
CREATE TRIGGER file_versions_retain_while_file_exists BEFORE DELETE ON file_versions
WHEN EXISTS (SELECT 1 FROM library_files WHERE file_id = OLD.file_id)
BEGIN SELECT RAISE(ABORT, 'File versions remain retained while the File exists'); END;
CREATE TRIGGER file_versions_validate_insert
BEFORE INSERT ON file_versions
WHEN NOT EXISTS (
  SELECT 1 FROM managed_blobs blob
  WHERE blob.content_hash = NEW.blob_hash AND blob.byte_length = NEW.byte_length
)
BEGIN
  SELECT RAISE(ABORT, 'File version bytes must match a published Blob');
END;
CREATE TRIGGER file_versions_reject_update
BEFORE UPDATE ON file_versions
BEGIN
  SELECT RAISE(ABORT, 'File versions are immutable');
END;
CREATE TRIGGER library_files_retain_structural_evidence BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM structural_retention_members member
  WHERE member.library_id = OLD.library_id AND member.member_kind = 'file' AND member.member_id = OLD.file_id)
BEGIN SELECT RAISE(ABORT, 'File is retained by structural evidence'); END;
CREATE INDEX idx_core_module_receipts_local_commit
  ON core_module_receipts(store_epoch, local_commit_seq);
CREATE INDEX idx_core_module_receipts_event_sequence
  ON core_module_receipts(event_sequence)
  WHERE event_sequence IS NOT NULL;
CREATE INDEX idx_core_module_receipts_retention
  ON core_module_receipts(committed_at, module_name, operation_id);
CREATE INDEX idx_detached_module_receipts_retention
  ON detached_module_receipts(detached_at_ms, local_commit_seq);
CREATE INDEX idx_detached_module_receipts_expiry
  ON detached_module_receipts(operation_kind, committed_at, module_name, operation_id);
CREATE INDEX idx_database_view_collapsed_occurrences_age
          ON database_view_collapsed_occurrences(
            profile_id, view_id, collapsed_at, target_kind, occurrence_key
          );
CREATE UNIQUE INDEX idx_project_sessions_default_draft_project ON project_sessions(project_id) WHERE is_default_draft = 1 AND project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_project_sessions_default_draft_projectless ON project_sessions(is_default_draft) WHERE is_default_draft = 1 AND project_id IS NULL;
CREATE INDEX idx_inbox_entries_suggestion ON inbox_entries(library_id, suggestion_state, seq);
CREATE INDEX idx_inbox_entries_source_budget ON inbox_entries(library_id, source_budget_key)
  WHERE source_budget_key IS NOT NULL;
CREATE INDEX idx_inbox_entries_scope ON inbox_entries(library_id, scope_project_id, seq);
CREATE INDEX idx_inbox_proposals_state ON inbox_proposals(library_id, state, confirmed_at);
CREATE INDEX idx_project_sessions_reminder ON project_sessions(remind_at,id) WHERE remind_at IS NOT NULL AND archived = 0;
CREATE INDEX idx_project_session_reminder_delivery_due ON project_session_reminder_deliveries(next_attempt_at,delivery_id);
CREATE TRIGGER project_session_archive_cancels_reminder AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived = 1
BEGIN
  UPDATE project_sessions SET remind_at = NULL WHERE id = NEW.id;
  DELETE FROM project_session_reminder_deliveries WHERE session_id = NEW.id;
END;
CREATE TRIGGER library_files_retain_recovery BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM document_recovery_file_refs reference WHERE reference.library_id = OLD.library_id AND reference.file_id = OLD.file_id)
  OR EXISTS (SELECT 1 FROM document_recovery_drafts draft LEFT JOIN document_recovery_file_snapshots snapshot
      ON snapshot.library_id = draft.library_id AND snapshot.draft_id = draft.draft_id
      WHERE draft.library_id = OLD.library_id AND (snapshot.draft_id IS NULL OR json_extract(snapshot.snapshot_json, '$.complete') <> 1))
BEGIN
    SELECT RAISE(ABORT, 'File is retained by recovery drafts');
END;
CREATE TRIGGER session_search_project_sessions_insert
AFTER INSERT ON project_sessions
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_sessions_delete
AFTER DELETE ON project_sessions
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_sessions_update
AFTER UPDATE OF project_id, no_thread_fallback_title, archived, created_at ON project_sessions
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.no_thread_fallback_title IS NOT NEW.no_thread_fallback_title OR OLD.archived IS NOT NEW.archived OR OLD.created_at IS NOT NEW.created_at
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE INDEX idx_project_sessions_project_activity ON project_sessions(project_id, archived, activity_at DESC, id);
CREATE INDEX idx_project_sessions_project_identity ON project_sessions(project_id, id);
CREATE INDEX idx_project_sessions_project_manual ON project_sessions(project_id, archived, manual_rank, activity_at DESC, id);
CREATE INDEX idx_project_sessions_project_sidebar ON project_sessions(project_id, archived, pinned, pinned_order, id);
CREATE TRIGGER project_sessions_clear_manual_rank AFTER UPDATE OF project_id, pinned, archived ON project_sessions
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.pinned <> OLD.pinned OR NEW.archived <> OLD.archived
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.id;
END;

-- Work belongs to the current schema.
DELETE FROM block_properties WHERE property_key='work';
ALTER TABLE libraries DROP COLUMN name;
ALTER TABLE libraries DROP COLUMN hosted;
ALTER TABLE libraries DROP COLUMN space_kind;
ALTER TABLE pages DROP COLUMN status_person_revision;
ALTER TABLE project_session_pages DROP COLUMN report_status_moved;
ALTER TABLE project_session_pages DROP COLUMN status_moved;
ALTER TABLE project_session_pages DROP COLUMN status_fence;
ALTER TABLE project_session_pages DROP COLUMN report_revision;
ALTER TABLE project_session_pages DROP COLUMN report_run_id;
ALTER TABLE project_session_pages DROP COLUMN report_at;
ALTER TABLE project_session_pages DROP COLUMN report_summary;
ALTER TABLE project_session_pages DROP COLUMN report_outcome;
ALTER TABLE data_source_relation_edges DROP COLUMN target_data_source_id;
ALTER TABLE inbox_handoffs DROP COLUMN question_response_json;
ALTER TABLE local_commits DROP COLUMN authorizing_member_id;
ALTER TABLE local_commits DROP COLUMN actor_json;
ALTER TABLE document_recovery_drafts DROP COLUMN member_id;
DROP TABLE inbox_routing_deliveries;
DROP TABLE coordinator;
DROP TABLE coordinator_managed_sessions;
DROP TABLE coordinator_event_batches;
DROP TABLE coordinator_work_events;
DROP TABLE page_work_launches;
DROP TABLE inbox_plan_results;
DROP TABLE page_active_chats;
DROP TABLE page_workspaces;
DROP TABLE session_workspaces;
DROP TABLE page_pull_requests;
DROP TABLE members;
DROP TABLE local_profile_members;
DROP TABLE sources;
DROP TABLE source_positions;
DROP TABLE external_threads;
DROP TABLE source_triggers;
DROP TABLE trigger_threads;
DROP TABLE problems;
DROP TABLE channel_outbox;
DROP TABLE page_thread_follows;
DROP TABLE thread_delivery_batches;
DROP TABLE thread_deliveries;
DROP TABLE github_intakes;
DROP TABLE github_entry_provenance;
DROP TABLE github_intake_triggers;
DROP TABLE thread_milestones;
DROP TABLE execution_holds;
DROP TABLE execution_hold_routing_clocks;
DROP TABLE session_execution_observations;
DROP TABLE page_turn_episodes;
DROP TABLE page_turn_dirty;
DROP TABLE space_invites;
DROP TABLE member_devices;
DROP TABLE member_device_push_registrations;
DROP TABLE member_sessions;
DROP TABLE remote_operation_members;
DROP TABLE page_turn_notes;
DROP TABLE page_turn_note_events;
DROP TABLE inbox_answers;
DROP TABLE page_turn_replies;
DROP TABLE page_turn_notification_intents;
DROP TABLE chat_message_deliveries;
DROP TABLE chat_message_delivery_pages;
DROP TABLE chat_message_delivery_origins;
DROP TABLE chat_message_inbounds;
DROP TABLE chat_message_handbacks;
DROP TABLE chat_message_handback_pages;
DROP TABLE intake_dispositions;
DROP TABLE automations;
DROP TABLE automation_execution_leases;
DROP TABLE automation_execution_runs;
DROP TABLE automation_decisions;
DROP TABLE automation_clock_metadata;
DROP TABLE automation_clock_triggers;
DROP TABLE automation_decision_triggers;
DROP TABLE automation_event_filters;
DROP TABLE automation_assessment_requests;
DROP TABLE automation_assessment_triggers;
DROP TABLE automation_decision_source_triggers;
DROP TABLE mutation_actors;
DROP TABLE agent_actor_labels;
DROP TABLE session_requesting_members;
DROP TABLE member_session_unread;
DROP TABLE member_inbox_preferences;
DROP TABLE session_run_members;
DROP TABLE page_work_grants;
DROP TABLE member_session_pins;
DROP TABLE member_session_reminders;
DROP TABLE member_session_reminder_deliveries;
CREATE TRIGGER core_automation_firing_page_deleted
BEFORE DELETE ON blocks
BEGIN
  UPDATE core_automation_firings SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)
  WHERE page_id=OLD.id AND waiting_in_inbox=1;
END;
-- Page lifecycle is shared by Library, document ownership and erasure paths.
CREATE TRIGGER core_automation_firing_page_inactive
AFTER UPDATE OF lifecycle ON blocks WHEN NEW.lifecycle<>'active' AND OLD.lifecycle='active'
BEGIN
  UPDATE core_automation_firings SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch(NEW.updated_at,'subsec')*1000 AS INTEGER)
  WHERE page_id=NEW.id AND waiting_in_inbox=1;
END;
CREATE TRIGGER data_source_relation_edges_validate_insert
BEFORE INSERT ON data_source_relation_edges
WHEN NOT EXISTS (
  SELECT 1
  FROM data_source_relation_properties relation
  JOIN data_source_property_values value
    ON value.data_source_id = NEW.source_data_source_id
   AND value.membership_id = NEW.source_membership_id
   AND value.property_id = NEW.property_id
  JOIN blocks target_block ON target_block.id = NEW.target_page_block_id
  JOIN pages target_page
    ON target_page.block_id = target_block.id
   AND target_page.library_id = target_block.library_id
  JOIN data_source_page_memberships target_membership
    ON target_membership.page_block_id = target_block.id
   AND target_membership.data_source_id = relation.target_data_source_id
   AND target_membership.removed_at IS NULL
  WHERE relation.data_source_id = NEW.source_data_source_id
    AND relation.property_id = NEW.property_id
    AND value.value_type = 'relation'
    AND json_type(value.value_json) = 'null'
    AND target_block.type = 'page'
    AND target_block.lifecycle = 'active'
) BEGIN
  SELECT RAISE(ABORT, 'Relation edge requires an active target Page in the configured Data Source');
END;
DELETE FROM core_store_migration_history WHERE target_revision > 203;
PRAGMA user_version = 203;
