-- v203 -> v204: a Space gains its people. Its existing person becomes its Owner Member; Scheduled
-- tasks become clock Automations; a chat's unread state, pin and reminder become that Member's own;
-- every Page gains Work and a Turn; attribution names a Member, an Agent or a Service.
--
-- migrate_v203_to_v204 runs this script with foreign keys off and legacy ALTER TABLE semantics:
-- renaming a reshaped table away leaves the references other tables hold on its name in place.
-- It then completes the step with Core's decoders: Owner names, Status labels, Assignee filters,
-- Automation snapshots, historical actors and each Page's first Turn.

-- New tables, exactly as the current schema declares them.
CREATE TABLE inbox_routing_deliveries (
  request_id TEXT PRIMARY KEY REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation>=1),
  coordinator_session_id TEXT NOT NULL,
  handed_over_at_ms INTEGER NOT NULL CHECK(handed_over_at_ms>=0)
, run_started_at_ms INTEGER
  CHECK (run_started_at_ms IS NULL OR run_started_at_ms >= 0), last_refusal TEXT
  CHECK (last_refusal IS NULL OR length(last_refusal) <= 2048)) WITHOUT ROWID, STRICT;
CREATE TABLE coordinator (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE coordinator_managed_sessions (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  observed_json TEXT CHECK(observed_json IS NULL OR json_valid(observed_json)),
  observed_revision INTEGER NOT NULL DEFAULT 0 CHECK(observed_revision >= 0)
) STRICT;
CREATE TABLE coordinator_event_batches (
  batch_id TEXT PRIMARY KEY,
  coordinator_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT
, invalidated_at TEXT, discarded_at TEXT) STRICT;
CREATE TABLE coordinator_work_events (
  event_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('report','attention','turn_ended','failed','stalled','ready_to_start','started')),
  session_id TEXT,
  page_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  batch_id TEXT REFERENCES coordinator_event_batches(batch_id)
, resolved_at TEXT) STRICT;
CREATE TABLE page_work_launches (
  launch_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES project_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
  brief TEXT NOT NULL CHECK(length(CAST(brief AS BLOB)) BETWEEN 1 AND 256000),
  again INTEGER NOT NULL CHECK(again IN (0,1)),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  rejection TEXT, status_fence INTEGER NOT NULL DEFAULT 0 CHECK(status_fence >= 0), status_moved INTEGER NOT NULL DEFAULT 0 CHECK(status_moved IN (0,1)), automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)),
  CHECK(accepted_at IS NULL OR rejection IS NULL)
) STRICT;
CREATE TABLE inbox_plan_results (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  page_ids_json TEXT NOT NULL CHECK(json_valid(page_ids_json) AND json_type(page_ids_json) = 'array' AND json_array_length(page_ids_json) BETWEEN 2 AND 8)
) STRICT;
CREATE TABLE page_active_chats (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  set_at TEXT NOT NULL,
  FOREIGN KEY(session_id,page_id) REFERENCES project_session_pages(session_id,page_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE page_workspaces (
  workspace_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_url TEXT,
  repository_root TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_commit_oid TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('preparing','ready','cleanup_requested','removed','failed')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  allocation_operation_id TEXT NOT NULL UNIQUE,
  worktree_path TEXT,
  failure TEXT
) STRICT;
CREATE TABLE session_workspaces (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES page_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE page_pull_requests (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES page_workspaces(workspace_id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','MERGED')),
  observed_at TEXT NOT NULL
) STRICT;
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1), role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  UNIQUE (id, library_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE local_profile_members (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL UNIQUE REFERENCES libraries(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL,
  FOREIGN KEY (member_id, library_id) REFERENCES members(id, library_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  kind TEXT NOT NULL CHECK(kind='github'),
  revision INTEGER NOT NULL CHECK(revision>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  enabled_at_ms INTEGER,
  config_json TEXT NOT NULL CHECK(json_valid(config_json))
) STRICT;
CREATE TABLE source_positions (
  source_id TEXT NOT NULL REFERENCES sources(id),
  partition TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0 CHECK(baseline IN (0,1)),
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  next_poll_at_ms INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  last_success_at_ms INTEGER,
  PRIMARY KEY(source_id,partition)
) WITHOUT ROWID, STRICT;
CREATE TABLE external_threads (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  provider TEXT NOT NULL CHECK(provider='github'),
  host TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number>0),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  UNIQUE(library_id,provider,host,repository_id,number)
) STRICT;
CREATE TABLE source_triggers (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  library_id TEXT NOT NULL REFERENCES libraries(id),
  provider TEXT NOT NULL CHECK(provider='github'),
  semantic_key TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('recorded','followed','intake')),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  UNIQUE(library_id,provider,semantic_key)
) STRICT;
CREATE TABLE trigger_threads (
  trigger_id TEXT NOT NULL REFERENCES source_triggers(id),
  thread_id TEXT NOT NULL REFERENCES external_threads(id),
  role TEXT NOT NULL CHECK(role='primary'),
  PRIMARY KEY(trigger_id,thread_id),
  UNIQUE(trigger_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id),
  page_id TEXT REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source_failing','delivery_failing','delivery_unresolved','channel_failing','credential_invalid')),
  first_failure_at_ms INTEGER NOT NULL,
  last_failure_at_ms INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL CHECK(consecutive_failures>0),
  summary TEXT NOT NULL,
  fix TEXT NOT NULL CHECK(fix IN ('reconnect','retry','open_card')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  opened_at_ms INTEGER,
  resolved_at_ms INTEGER
) STRICT;
CREATE TABLE channel_outbox (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_thread_id TEXT NOT NULL REFERENCES external_threads(id),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  episode TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 16384),
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  marker TEXT NOT NULL UNIQUE,
  thread_order INTEGER NOT NULL CHECK(thread_order>0),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','dropped')),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  remote_comment_id TEXT,
  remote_url TEXT,
  terminal_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)),
  UNIQUE(page_id,body_hash,episode),
  UNIQUE(external_thread_id,thread_order)
) STRICT;
CREATE TABLE page_thread_follows (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  external_thread_id TEXT NOT NULL REFERENCES external_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('own_pr','origin','context')),
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status_fence INTEGER NOT NULL CHECK(status_fence >= 0),
  last_fact_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(page_id,external_thread_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE thread_delivery_batches (
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  message_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  execution_ref_json TEXT NOT NULL CHECK(json_valid(execution_ref_json)),
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  created_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected')),
  receipt TEXT
, consecutive_failures INTEGER NOT NULL DEFAULT 0, retry_at_ms INTEGER NOT NULL DEFAULT 0, last_failure TEXT, settled_at_ms INTEGER) WITHOUT ROWID, STRICT;
CREATE TABLE thread_deliveries (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES source_triggers(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  session_id TEXT,
  binding_revision INTEGER,
  execution_ref_json TEXT CHECK(execution_ref_json IS NULL OR json_valid(execution_ref_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','unresolved','suppressed','batched','accepted','rejected')),
  reason TEXT,
  message_id TEXT REFERENCES thread_delivery_batches(message_id) ON DELETE SET NULL,
  UNIQUE(trigger_id,page_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE github_intakes (
  external_thread_id TEXT PRIMARY KEY REFERENCES external_threads(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE github_entry_provenance (
  page_id TEXT PRIMARY KEY REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
) WITHOUT ROWID, STRICT;
CREATE TABLE github_intake_triggers (
  trigger_id TEXT PRIMARY KEY REFERENCES source_triggers(id) ON DELETE CASCADE,
  external_thread_id TEXT NOT NULL REFERENCES github_intakes(external_thread_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE thread_milestones (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES source_triggers(id) ON DELETE CASCADE,
  fact_identity TEXT NOT NULL,
  destination TEXT NOT NULL,
  status_moved INTEGER NOT NULL CHECK(status_moved IN (0,1)), reason TEXT, stage TEXT,
  PRIMARY KEY(page_id,fact_identity)
) WITHOUT ROWID, STRICT;
CREATE TABLE execution_holds (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('page','project','space')),
  scope_id TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES members(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  paused_at TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id)
) STRICT;
CREATE TABLE execution_hold_routing_clocks (
  request_id TEXT NOT NULL REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  paused_at_ms INTEGER,
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  PRIMARY KEY (request_id, generation)
) STRICT;
CREATE TABLE session_execution_observations (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  observed_json TEXT NOT NULL CHECK (json_valid(observed_json)),
  observed_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_episodes (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  episode TEXT NOT NULL,
  since TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_dirty (page_id TEXT PRIMARY KEY) WITHOUT ROWID, STRICT;
CREATE TABLE space_invites (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
 code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','member')),
 member_id TEXT REFERENCES members(id),
 expires_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), redeemed_at INTEGER
, device_link INTEGER NOT NULL DEFAULT 0 CHECK(device_link IN (0,1)), created_at INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE member_devices (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL, member_id TEXT NOT NULL,
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 256), credential_hash TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked_at INTEGER, form_factor TEXT NOT NULL DEFAULT 'desktop' CHECK(form_factor IN ('desktop','phone')),
 FOREIGN KEY(member_id,library_id) REFERENCES members(id,library_id)
) STRICT;
CREATE TABLE member_device_push_registrations (
 device_id TEXT PRIMARY KEY REFERENCES member_devices(id) ON DELETE CASCADE,
 handle TEXT NOT NULL CHECK(length(handle) BETWEEN 1 AND 1024),
 push_key TEXT NOT NULL CHECK(length(push_key)=43),
 needs_you INTEGER NOT NULL CHECK(needs_you IN (0,1)),
 finished INTEGER NOT NULL CHECK(finished IN (0,1)),
 updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE member_sessions (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES member_devices(id),
 token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE remote_operation_members (
 module_name TEXT NOT NULL, operation_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id), PRIMARY KEY(module_name,operation_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_notes (
  note_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  episode TEXT NOT NULL,
  coordinator_session_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  notify INTEGER NOT NULL CHECK(notify IN (0,1)),
  created_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
, actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_note_events (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES coordinator_work_events(event_id),
  note_id TEXT NOT NULL REFERENCES page_turn_notes(note_id) ON DELETE CASCADE,
  PRIMARY KEY(page_id,episode,event_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_answers (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  question_page_id TEXT NOT NULL UNIQUE REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scope_project_id TEXT REFERENCES projects(id),
  coordinator_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  handled_at TEXT
, member_id TEXT REFERENCES members(id)) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_replies (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  episode TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_notification_intents (
  member_id TEXT NOT NULL REFERENCES members(id),
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  PRIMARY KEY(member_id,page_id,episode)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_deliveries (
  delivery_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  destination_title TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  author_json TEXT NOT NULL CHECK(json_valid(author_json)),
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count BETWEEN 0 AND 100),
  question_answer INTEGER NOT NULL DEFAULT 0 CHECK(question_answer IN (0,1)),
  answer_run_id TEXT,
  original_page_count INTEGER NOT NULL DEFAULT 0 CHECK(original_page_count >= 0),
  created_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_delivery_pages (
  delivery_id TEXT NOT NULL REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES inbox_proposals(proposal_id) ON DELETE SET NULL,
  content_fingerprint TEXT NOT NULL,
  PRIMARY KEY(delivery_id,page_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_delivery_origins (
  delivery_id TEXT NOT NULL REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  origin_id TEXT NOT NULL,
  PRIMARY KEY(origin_id,delivery_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_inbounds (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  question_answered INTEGER NOT NULL DEFAULT 0 CHECK(question_answered IN (0,1)),
  PRIMARY KEY(session_id,run_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_handbacks (
  receipt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  created_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
, actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_handback_pages (
  receipt_id TEXT NOT NULL REFERENCES chat_message_handbacks(receipt_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  PRIMARY KEY(page_id,receipt_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE intake_dispositions (
  id INTEGER PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('chat','filed','kept','done','open')),
  proposal_id TEXT REFERENCES inbox_proposals(proposal_id) ON DELETE SET NULL,
  at TEXT NOT NULL,
  actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))
) STRICT;
CREATE INDEX intake_dispositions_page ON intake_dispositions(page_id,proposal_id,at);
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
           notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only'), project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512)), agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude', 'opencode')), agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512)), agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind IN ('claude', 'opencode') AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512)))),
  mode TEXT NOT NULL DEFAULT 'run' CHECK (mode IN ('dry_run','ask_first','run')), runbook_page_id TEXT,
           CHECK (kind IN ('cron', 'heartbeat')),
           CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
           CHECK (execution_environment IN ('local', 'worktree')),
           CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
           CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
           CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
         ) WITHOUT ROWID;
CREATE TABLE automation_execution_leases (
  lease_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL CHECK (length(dispatch_id) BETWEEN 1 AND 512 AND dispatch_id = trim(dispatch_id)),
  automation_revision INTEGER NOT NULL CHECK (automation_revision >= 1),
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
CREATE TABLE automation_execution_runs (
  agent_selection_json TEXT CHECK(agent_selection_json IS NULL OR json_valid(agent_selection_json)),
  page_id TEXT REFERENCES pages(block_id) ON DELETE SET NULL,
  message_id TEXT,
  notification_policy TEXT CHECK(notification_policy IS NULL OR notification_policy='failed_runs_only'),
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
CREATE TABLE automation_decisions (
  dispatch_id TEXT PRIMARY KEY,
  automation_name TEXT NOT NULL DEFAULT '',
  automation_id TEXT NOT NULL REFERENCES automations(automation_id),
  status TEXT NOT NULL CHECK (status IN ('held','admitted','completed','failed','skipped','withdrawn')),
  page_id TEXT,
  automation_revision INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'ask_first' CHECK(mode IN ('dry_run','ask_first','run')),
  reason TEXT NOT NULL DEFAULT 'Clock condition matched',
  frozen_action_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(frozen_action_json)),
  frozen_authority_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(frozen_authority_json)),
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
  CHECK (waiting_in_inbox IN (0,1) AND (waiting_in_inbox=0 OR status IN ('held','failed'))), assessment_json TEXT CHECK(assessment_json IS NULL OR json_valid(assessment_json)), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))) WITHOUT ROWID, STRICT;
CREATE TABLE automation_clock_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  jitter_salt TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
  CHECK (length(jitter_salt) BETWEEN 1 AND 512)
) STRICT;
CREATE TABLE automation_clock_triggers (
 id TEXT PRIMARY KEY,
 automation_id TEXT NOT NULL REFERENCES automations(automation_id),
 schedule_revision INTEGER NOT NULL CHECK(schedule_revision>=1),
 due_at_ms INTEGER NOT NULL CHECK(due_at_ms>=0),
 received_at_ms INTEGER NOT NULL CHECK(received_at_ms>=0),
 semantic_key TEXT NOT NULL UNIQUE
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_decision_triggers (
 dispatch_id TEXT NOT NULL REFERENCES automation_decisions(dispatch_id),
 trigger_id TEXT NOT NULL REFERENCES automation_clock_triggers(id),
 PRIMARY KEY(dispatch_id,trigger_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_event_filters (
 automation_id TEXT PRIMARY KEY REFERENCES automations(automation_id) ON DELETE CASCADE,
 filter_json TEXT NOT NULL CHECK(json_valid(filter_json))
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_assessment_requests (
 request_id TEXT PRIMARY KEY,
 library_id TEXT NOT NULL REFERENCES libraries(id),
 thread_id TEXT NOT NULL REFERENCES external_threads(id),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','settled','failed','followed')),
 policy_hash TEXT NOT NULL,
 automations_json TEXT NOT NULL CHECK(json_valid(automations_json)),
 coordinator_session_id TEXT REFERENCES project_sessions(id),
 handed_over_at_ms INTEGER,
 run_started_at_ms INTEGER,
 failure TEXT,
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_assessment_triggers (
 trigger_id TEXT PRIMARY KEY REFERENCES source_triggers(id),
 thread_id TEXT NOT NULL REFERENCES external_threads(id),
 request_id TEXT REFERENCES automation_assessment_requests(request_id),
 generation INTEGER,
 CHECK((request_id IS NULL)=(generation IS NULL))
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_decision_source_triggers (
 dispatch_id TEXT NOT NULL REFERENCES automation_decisions(dispatch_id),
 trigger_id TEXT NOT NULL REFERENCES source_triggers(id),
 PRIMARY KEY(dispatch_id,trigger_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE mutation_actors (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  authorizing_member_id TEXT REFERENCES members(id),
  committed_at TEXT NOT NULL,
  PRIMARY KEY(module_name,operation_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE agent_actor_labels (
 session_id TEXT NOT NULL,
 run_key TEXT NOT NULL,
 label TEXT NOT NULL,
 PRIMARY KEY(session_id,run_key)
) WITHOUT ROWID, STRICT;
CREATE TABLE session_requesting_members (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(session_id,message_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE member_session_unread (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE member_inbox_preferences (
 member_id TEXT PRIMARY KEY REFERENCES members(id),
 start_my_requests INTEGER NOT NULL CHECK(start_my_requests IN (0,1))
) WITHOUT ROWID, STRICT;
CREATE TABLE session_run_members (
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id),
 message_id TEXT,
 PRIMARY KEY(session_id,run_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE page_work_grants (
 page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES members(id)
) WITHOUT ROWID, STRICT;
CREATE TABLE member_session_pins (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 pinned_order INTEGER NOT NULL CHECK(pinned_order >= 0),
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE member_session_reminders (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 remind_at TEXT NOT NULL,
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE member_session_reminder_deliveries (
 delivery_id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 remind_at TEXT NOT NULL,
 next_attempt_at TEXT NOT NULL,
 UNIQUE(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_coordinator_pending_events ON coordinator_work_events(created_at,event_id) WHERE batch_id IS NULL AND resolved_at IS NULL;
CREATE INDEX idx_coordinator_open_batches ON coordinator_event_batches(created_at,batch_id) WHERE accepted_at IS NULL;
CREATE INDEX idx_page_work_launches_pending ON page_work_launches(created_at,launch_id) WHERE accepted_at IS NULL AND rejection IS NULL;
CREATE INDEX idx_page_active_chats_session ON page_active_chats(session_id,page_id);
CREATE INDEX session_workspaces_workspace ON session_workspaces(workspace_id, session_id);
CREATE INDEX members_library ON members(library_id, lifecycle, display_name, id);
CREATE INDEX sources_library ON sources(library_id,id);
CREATE INDEX trigger_threads_window ON trigger_threads(thread_id,trigger_id);
CREATE UNIQUE INDEX problems_unresolved ON problems(library_id,kind,scope) WHERE resolved_at_ms IS NULL;
CREATE INDEX problems_open ON problems(library_id,opened_at_ms) WHERE resolved_at_ms IS NULL;
CREATE INDEX channel_outbox_pending ON channel_outbox(library_id,state,retry_at_ms);
CREATE INDEX page_thread_follows_thread ON page_thread_follows(external_thread_id,page_id);
CREATE UNIQUE INDEX page_thread_follows_own_pr ON page_thread_follows(page_id) WHERE role='own_pr';
CREATE INDEX thread_delivery_batches_pending ON thread_delivery_batches(state,message_id);
CREATE INDEX thread_deliveries_pending ON thread_deliveries(state,id);
CREATE INDEX github_intakes_page ON github_intakes(page_id,external_thread_id);
CREATE INDEX member_devices_member ON member_devices(member_id,revoked_at);
CREATE INDEX member_sessions_device ON member_sessions(device_id,expires_at);
CREATE INDEX idx_page_turn_notes_episode ON page_turn_notes(page_id,episode,created_seq,note_id);
CREATE INDEX idx_page_turn_episode_order ON page_turn_episodes(since,page_id);
CREATE INDEX idx_chat_message_deliveries_session ON chat_message_deliveries(session_id,created_at,delivery_id);
CREATE UNIQUE INDEX idx_automation_execution_leases_active_occurrence
  ON automation_execution_leases(automation_id, scheduled_for_ms)
  WHERE status = 'claimed';
CREATE INDEX idx_automation_execution_leases_inbox
  ON automation_execution_leases(status, expires_at_ms, scheduled_for_ms, lease_id);
CREATE UNIQUE INDEX idx_automations_active_heartbeat
           ON automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;
CREATE INDEX automation_execution_runs_definition_status_created
  ON automation_execution_runs(automation_id, status, created_at DESC);
CREATE INDEX automation_execution_runs_unread ON automation_execution_runs(read_at, status, updated_at);
CREATE INDEX automation_execution_runs_session_created
  ON automation_execution_runs(session_id, created_at DESC, run_id);
CREATE INDEX automation_execution_leases_retry
  ON automation_execution_leases(automation_id, automation_revision, retry_at_ms, status, claimed_at_ms DESC, attempt DESC);
CREATE INDEX automation_execution_leases_expiry
  ON automation_execution_leases(automation_id, automation_revision, scheduled_for_ms, status, reason_code, claimed_at_ms DESC, attempt DESC);
CREATE UNIQUE INDEX idx_automation_decisions_waiting ON automation_decisions(automation_id) WHERE waiting_in_inbox=1 AND assessment_json IS NULL;
CREATE UNIQUE INDEX idx_automation_decisions_page ON automation_decisions(page_id);
CREATE INDEX idx_automation_decisions_due ON automation_decisions(due_at_ms) WHERE status='admitted';
CREATE INDEX idx_automation_execution_runs_dispatch ON automation_execution_runs(dispatch_id,created_at,run_id);
CREATE UNIQUE INDEX idx_automation_execution_runs_message ON automation_execution_runs(message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_automation_assessment_unsettled ON automation_assessment_requests(thread_id) WHERE state='pending';
CREATE INDEX idx_automation_assessment_trigger_request ON automation_assessment_triggers(request_id,generation);
CREATE INDEX idx_automation_assessment_thread_queue ON automation_assessment_triggers(thread_id,request_id,trigger_id);
CREATE INDEX mutation_actors_time ON mutation_actors(library_id,committed_at,operation_id);
CREATE INDEX session_requesting_member_order ON session_requesting_members(session_id,accepted_at DESC,message_id DESC);
CREATE INDEX member_session_pin_order ON member_session_pins(member_id,pinned_order,session_id);
CREATE INDEX member_session_pin_session ON member_session_pins(session_id);
CREATE INDEX member_session_reminder_due ON member_session_reminders(remind_at,session_id,member_id);
CREATE INDEX member_session_reminder_delivery_due ON member_session_reminder_deliveries(next_attempt_at,delivery_id);

-- Each Space's existing person becomes its one active Owner. Rust gives the Owner the name its OS
-- account gives its person before the step commits.
INSERT INTO members(id,library_id,display_name,lifecycle,role)
  SELECT lower(hex(randomblob(16))),id,'Owner','active','owner' FROM libraries;
INSERT INTO local_profile_members(profile_id,library_id,member_id)
  SELECT library.profile_id,library.id,member.id
  FROM libraries library JOIN members member ON member.library_id=library.id;

-- Columns existing tables gain in place. An unnamed Space reads as what it is.
ALTER TABLE libraries ADD COLUMN space_kind TEXT NOT NULL DEFAULT 'personal' CHECK (space_kind IN ('personal','team'));
ALTER TABLE libraries ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0 CHECK(hosted IN (0,1));
ALTER TABLE libraries ADD COLUMN name TEXT CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 256);
ALTER TABLE pages ADD COLUMN status_person_revision INTEGER NOT NULL DEFAULT 0 CHECK(status_person_revision >= 0);
ALTER TABLE project_session_pages ADD COLUMN report_outcome TEXT CHECK(report_outcome IN ('ready','blocked','failed','dropped'));
ALTER TABLE project_session_pages ADD COLUMN report_summary TEXT;
ALTER TABLE project_session_pages ADD COLUMN report_at TEXT;
ALTER TABLE project_session_pages ADD COLUMN report_run_id TEXT;
ALTER TABLE project_session_pages ADD COLUMN report_revision INTEGER NOT NULL DEFAULT 0 CHECK(report_revision >= 0);
ALTER TABLE project_session_pages ADD COLUMN status_fence INTEGER CHECK(status_fence >= 0);
ALTER TABLE project_session_pages ADD COLUMN status_moved INTEGER NOT NULL DEFAULT 0 CHECK(status_moved IN (0,1));
ALTER TABLE project_session_pages ADD COLUMN report_status_moved INTEGER CHECK(report_status_moved IN (0,1));
ALTER TABLE data_source_relation_edges ADD COLUMN target_data_source_id TEXT REFERENCES data_sources(id);
ALTER TABLE inbox_handoffs ADD COLUMN question_response_json TEXT CHECK (question_response_json IS NULL OR json_valid(question_response_json));
ALTER TABLE local_commits ADD COLUMN actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json));
ALTER TABLE local_commits ADD COLUMN authorizing_member_id TEXT REFERENCES members(id);
-- Rust fills these from retained evidence, then drops the identifiers they replace.
ALTER TABLE library_files ADD COLUMN created_by_actor_json TEXT CHECK(created_by_actor_json IS NULL OR json_valid(created_by_actor_json));
ALTER TABLE file_versions ADD COLUMN actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json));
ALTER TABLE document_recovery_drafts ADD COLUMN member_id TEXT REFERENCES members(id);
UPDATE document_recovery_drafts
  SET member_id=(SELECT member_id FROM local_profile_members WHERE library_id=document_recovery_drafts.library_id);
-- Triggers whose bodies change are recreated with the current schema below.
DROP TRIGGER data_source_relation_edges_validate_insert;
DROP TRIGGER library_files_validate_update;
DROP TRIGGER core_automation_firing_page_inactive;
DROP TRIGGER core_automation_firing_page_deleted;

-- Scheduled tasks become clock Automations owned by the local Member, keeping their identity, timing,
-- state, jitter and history. Rust sets each Automation's timezone to the machine's own.
INSERT INTO automations(automation_id,owner_member_id,scope_project_id,condition_text,timezone,jitter_salt,schedule_revision,
    kind,status,target_session_id,name,prompt,rrule,model,reasoning_effort,service_tier,cwds_json,execution_environment,
    local_environment_config_path,next_run_at,last_run_at,created_at,updated_at,automation_revision,notification_policy,project_id,
    agent_backend_kind,agent_backend_definition_id,agent_backend_instance_config_id,mode,runbook_page_id)
  SELECT task.automation_id,(SELECT member_id FROM local_profile_members LIMIT 1),
    COALESCE(task.project_id,(SELECT project_id FROM project_sessions WHERE id=task.target_session_id)),
    'On the clock','UTC',(SELECT jitter_salt FROM core_automation_runtime_metadata WHERE id=1),task.definition_revision,
    task.kind,task.status,task.target_session_id,task.name,task.prompt,task.rrule,task.model,task.reasoning_effort,
    task.service_tier,task.cwds_json,task.execution_environment,task.local_environment_config_path,task.next_run_at,
    task.last_run_at,task.created_at,task.updated_at,task.definition_revision,task.notification_policy,task.project_id,
    task.agent_backend_kind,task.agent_backend_definition_id,task.agent_backend_instance_config_id,
    CASE task.launch WHEN 'automatic' THEN 'run' ELSE 'ask_first' END,task.runbook_page_id
  FROM codex_scheduled_automations task;
INSERT INTO automation_clock_metadata(id,jitter_salt,created_at_unix_ms)
  SELECT id,jitter_salt,created_at_unix_ms FROM core_automation_runtime_metadata;
INSERT INTO automation_execution_leases(lease_id,automation_id,dispatch_id,automation_revision,scheduled_for_ms,attempt,status,claimed_at_ms,
    expires_at_ms,settled_at_ms,retry_at_ms,reason_code,purpose)
  SELECT lease_id,automation_id,dispatch_id,definition_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,
    settled_at_ms,retry_at_ms,reason_code,purpose
  FROM core_automation_leases;
INSERT INTO automation_execution_runs(run_id,automation_id,session_id,status,read_at,session_title,source_cwd,inbox_title,inbox_summary,
    archived_user_message,archived_assistant_message,archived_reason,created_at,updated_at,run_revision,admission_hash,dispatch_id)
  SELECT run_id,automation_id,session_id,status,read_at,session_title,source_cwd,inbox_title,inbox_summary,
    archived_user_message,archived_assistant_message,archived_reason,created_at,updated_at,run_revision,admission_hash,dispatch_id
  FROM core_automation_runs;
-- A firing waiting in the Inbox becomes an Ask first decision with the Automation's authority frozen.
INSERT INTO automation_decisions(dispatch_id,automation_name,automation_id,status,page_id,automation_revision,frozen_action_json,frozen_authority_json,
    inbox_project_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,hold_basis_json,admission_prompt,
    admission_agent_json,admitted_at_ms,due_at_ms,failure_message,created_at_ms,updated_at_ms,waiting_in_inbox,actor_json)
  SELECT firing.dispatch_id,automation.name,firing.automation_id,firing.status,firing.page_id,automation.automation_revision,
    json_object('prompt',automation.prompt,'automation_id',automation.automation_id),
    json_object('owner_member_id',automation.owner_member_id,'mode',automation.mode,'automation_revision',automation.automation_revision),
    firing.inbox_project_id,firing.first_scheduled_for_ms,firing.last_scheduled_for_ms,firing.missed_count,
    firing.hold_basis_json,firing.admission_prompt,firing.admission_agent_json,firing.admitted_at_ms,firing.due_at_ms,
    firing.failure_message,firing.created_at_ms,firing.updated_at_ms,firing.waiting_in_inbox,
    json_object('type','service','kind','automations')
  FROM core_automation_firings firing JOIN automations automation ON automation.automation_id=firing.automation_id;
-- Each retained occurrence becomes the clock Trigger that caused it.
INSERT OR IGNORE INTO automation_clock_triggers
  SELECT 'clock:'||automation_id||':'||automation_revision||':'||scheduled_for_ms,automation_id,automation_revision,scheduled_for_ms,claimed_at_ms,
    'clock:'||automation_id||':'||automation_revision||':'||scheduled_for_ms
  FROM automation_execution_leases lease
  WHERE lease.attempt=(SELECT MIN(first.attempt) FROM automation_execution_leases first WHERE first.dispatch_id=lease.dispatch_id);
INSERT OR IGNORE INTO automation_clock_triggers
  SELECT 'clock:'||automation_id||':'||automation_revision||':'||first_scheduled_for_ms,automation_id,automation_revision,first_scheduled_for_ms,
    created_at_ms,'clock:'||automation_id||':'||automation_revision||':'||first_scheduled_for_ms
  FROM automation_decisions;
INSERT OR IGNORE INTO automation_clock_triggers
  SELECT 'clock:'||automation_id||':'||automation_revision||':'||last_scheduled_for_ms,automation_id,automation_revision,last_scheduled_for_ms,
    updated_at_ms,'clock:'||automation_id||':'||automation_revision||':'||last_scheduled_for_ms
  FROM automation_decisions;
INSERT OR IGNORE INTO automation_decision_triggers
  SELECT decision.dispatch_id,trigger.id FROM automation_decisions decision
  JOIN automation_clock_triggers trigger ON trigger.automation_id=decision.automation_id
    AND trigger.due_at_ms IN (decision.first_scheduled_for_ms,decision.last_scheduled_for_ms);
-- A run claim without a firing becomes the decision its latest attempt settled.
INSERT OR IGNORE INTO automation_decisions(dispatch_id,automation_name,automation_id,status,page_id,first_scheduled_for_ms,
    last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms,automation_revision,mode,frozen_action_json,
    frozen_authority_json,actor_json)
  SELECT lease.dispatch_id,automation.name,lease.automation_id,
    CASE lease.status WHEN 'claimed' THEN 'admitted' WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'withdrawn'
      ELSE 'failed' END,
    NULL,lease.scheduled_for_ms,lease.scheduled_for_ms,'{}',lease.claimed_at_ms,
    COALESCE(lease.settled_at_ms,lease.claimed_at_ms),lease.automation_revision,automation.mode,
    json_object('prompt',automation.prompt,'automation_id',automation.automation_id),
    json_object('owner_member_id',automation.owner_member_id,'mode',automation.mode,'automation_revision',lease.automation_revision),
    json_object('type','service','kind','automations')
  FROM automation_execution_leases lease JOIN automations automation USING(automation_id)
  WHERE lease.purpose='run'
    AND lease.attempt=(SELECT max(latest.attempt) FROM automation_execution_leases latest WHERE latest.dispatch_id=lease.dispatch_id);
INSERT OR IGNORE INTO automation_decision_triggers
  SELECT lease.dispatch_id,trigger.id FROM automation_execution_leases lease
  JOIN automation_clock_triggers trigger
    ON trigger.semantic_key='clock:'||lease.automation_id||':'||lease.automation_revision||':'||lease.scheduled_for_ms
  WHERE EXISTS(SELECT 1 FROM automation_decisions decision WHERE decision.dispatch_id=lease.dispatch_id);
DROP TABLE core_automation_leases;
DROP TABLE core_automation_runs;
DROP TABLE core_automation_firings;
DROP TABLE codex_scheduled_automations;
DROP TABLE core_automation_runtime_metadata;

-- An Inbox item a Scheduled task sent comes from its Automation, and its proposal executes that Automation's
-- decision. A confirmed proposal was confirmed by its person.
ALTER TABLE inbox_entries RENAME TO inbox_entries_v203;
CREATE TABLE "inbox_entries" (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  submitted_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'agent', 'command_line', 'automation', 'github')),
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
  reply_to_page_id TEXT CHECK (reply_to_page_id IS NULL OR length(reply_to_page_id) BETWEEN 1 AND 512), status_fence INTEGER NOT NULL DEFAULT 0 CHECK(status_fence >= 0), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)), author_member_id TEXT REFERENCES members(id),
  UNIQUE (library_id, seq),
  CHECK (source_kind = 'agent' OR (source_session_id IS NULL AND source_thread_id IS NULL AND source_turn_id IS NULL)),
  CHECK (source_kind <> 'user' OR (source_project_id IS NULL AND source_label IS NULL)),
  CHECK (source_kind = 'user' OR source_label IS NOT NULL),
  CHECK (suggestion_state = 'failed' OR suggestion_error IS NULL)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,source_session_id,source_thread_id,source_turn_id,
    source_project_id,source_label,provisional_title,kind,kind_set_by_user,state,suggestion_state,suggestion_error,
    current_proposal_id,revision,updated_at,source_budget_key,scope_project_id,outcome,suggestion_request_id,important,
    source_automation_id,source_dispatch_id)
  SELECT page_id,library_id,seq,submitted_at,CASE source_kind WHEN 'scheduled_task' THEN 'automation' ELSE source_kind END,
    source_session_id,source_thread_id,source_turn_id,source_project_id,source_label,provisional_title,kind,
    kind_set_by_user,state,suggestion_state,suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,
    scope_project_id,outcome,suggestion_request_id,important,source_automation_id,source_dispatch_id
  FROM inbox_entries_v203;
DROP TABLE inbox_entries_v203;
ALTER TABLE inbox_proposals RENAME TO inbox_proposals_v203;
CREATE TABLE "inbox_proposals" (
  proposal_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user', 'automation')),
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
  failure_kind TEXT CHECK (failure_kind IN ('rejected','unavailable','unknown')), explicit_request INTEGER NOT NULL DEFAULT 0 CHECK (explicit_request IN (0,1) AND (origin='agent' OR explicit_request=0)), confirmed_by TEXT CHECK (confirmed_by IS NULL OR (confirmed_by IN ('user','nodex') AND confirmed_at IS NOT NULL)), auto_confirm_pending INTEGER NOT NULL DEFAULT 0 CHECK(auto_confirm_pending IN (0,1)), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)), confirmed_actor_json TEXT CHECK(confirmed_actor_json IS NULL OR json_valid(confirmed_actor_json)),
  CHECK (state <> 'dispatching' OR (dispatch_session_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_message IS NOT NULL)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,revision,action_json,kind,summary,rationale,produced_by,
    basis_json,dispatch_session_id,dispatch_thread_id,confirmed_at,attempt,failure_message,created_at,updated_at,
    failure_kind,confirmed_by,actor_json,confirmed_actor_json)
  SELECT proposal_id,library_id,CASE origin WHEN 'schedule' THEN 'automation' ELSE origin END,state,revision,
    CASE WHEN json_extract(action_json,'$.type')='run_task'
      THEN json_remove(json_set(action_json,'$.type','execute_decision','$.decision_id',json_extract(action_json,'$.dispatch_id')),
        '$.automation_id','$.dispatch_id')
      ELSE action_json END,
    kind,summary,rationale,produced_by,basis_json,dispatch_session_id,dispatch_thread_id,confirmed_at,attempt,
    failure_message,created_at,updated_at,failure_kind,CASE WHEN confirmed_at IS NOT NULL THEN 'user' END,
    CASE origin WHEN 'user'
      THEN json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=proposal.library_id))
      ELSE json_object('type','service','kind','inbox_routing') END,
    CASE WHEN confirmed_at IS NOT NULL
      THEN json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=proposal.library_id))
      END
  FROM inbox_proposals_v203 proposal;
DROP TABLE inbox_proposals_v203;

-- Activity records each handled message as a fact. A released Inbox kept only where each message
-- stands, so its standing routing decision and a later Keep or Done become its first facts.
INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,proposal_id,at,actor_json)
  SELECT entry.library_id,entry.page_id,entry.scope_project_id,
    CASE json_extract(proposal.action_json,'$.type') WHEN 'move_to_project' THEN 'filed' WHEN 'keep' THEN 'kept'
      WHEN 'plan' THEN 'done' ELSE 'chat' END,
    proposal.proposal_id,proposal.confirmed_at,proposal.confirmed_actor_json
  FROM inbox_entries entry JOIN inbox_proposals proposal ON proposal.proposal_id=entry.current_proposal_id
  WHERE proposal.confirmed_at IS NOT NULL
    AND (proposal.state='completed' OR (proposal.state='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown'))
    AND (json_extract(proposal.action_json,'$.type') IN ('new_chat','send_to_chat','execute_decision') OR entry.state<>'open')
  ORDER BY proposal.confirmed_at,entry.seq;
INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,at,actor_json)
  SELECT entry.library_id,entry.page_id,entry.scope_project_id,entry.state,entry.updated_at,
    json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=entry.library_id))
  FROM inbox_entries entry
  WHERE entry.state<>'open' AND NOT EXISTS(SELECT 1 FROM intake_dispositions fact WHERE fact.page_id=entry.page_id
    AND (CASE fact.disposition WHEN 'filed' THEN 'kept' ELSE fact.disposition END)=entry.state)
  ORDER BY entry.updated_at,entry.seq;

-- Every Page has Work owned by the local Member. A text Assignee named the Space's one person,
-- so it assigns the Page to them; the text Property and its values retire.
INSERT INTO block_properties(block_id,library_id,property_key,value_type,value_json,revision,updated_at)
  SELECT page.block_id,page.library_id,'work','json',
    json_object('assignee',json(CASE WHEN EXISTS(
        SELECT 1 FROM data_source_page_memberships membership
        JOIN data_source_property_values value ON value.membership_id=membership.id
          AND value.data_source_id=membership.data_source_id AND value.property_id='assignee'
        WHERE membership.page_block_id=page.block_id
          AND json_type(value.value_json)='text' AND length(trim(json_extract(value.value_json,'$')))>0)
      THEN json_object('kind','member','member_id',local.member_id) ELSE 'null' END),
      'auto_start',json('false'),'owner',local.member_id),
    1,page.updated_at
  FROM pages page JOIN local_profile_members local ON local.library_id=page.library_id;
DELETE FROM data_source_property_values WHERE property_id='assignee';
DELETE FROM data_source_page_layout_entries WHERE property_id='assignee';
DELETE FROM retired_data_source_property_ids WHERE property_id='assignee';
DELETE FROM data_source_properties WHERE id='assignee';
UPDATE page_read_model SET
  intrinsic_properties_json=json_set(intrinsic_properties_json,'$.work',
    json((SELECT value_json FROM block_properties WHERE block_id=page_read_model.page_block_id AND property_key='work'))),
  database_values_json=json_remove(database_values_json,'$.assignee');

-- A work Source gains Waits for. Only Sources gaining the Property advance their schema and
-- layout revisions; empty values follow the Relation convention and need no value header.
CREATE TEMP TABLE work_graph_backfill_sources AS
  SELECT source.id FROM data_sources source
  WHERE EXISTS(SELECT 1 FROM data_source_properties property WHERE property.data_source_id=source.id AND property.id='task_parent')
    AND NOT EXISTS(SELECT 1 FROM data_source_properties property WHERE property.data_source_id=source.id AND property.id='blocked_by');
INSERT INTO data_source_properties(data_source_id,id,name,value_type,config_json,rank_key,lifecycle,schema_revision,created_at,updated_at)
  SELECT source.id,'blocked_by','Waits for','relation','{}','ffffffffffffffffffffffffffffffff','active',1,source.created_at,source.updated_at
  FROM data_sources source JOIN work_graph_backfill_sources selected ON selected.id=source.id;
INSERT INTO data_source_relation_properties(data_source_id,property_id,target_data_source_id,cardinality)
  SELECT id,'blocked_by',id,'many' FROM work_graph_backfill_sources;
INSERT INTO data_source_page_layout_entries(data_source_id,property_id,rank_key,visibility)
  SELECT data_source_id,'blocked_by',rank_key,'hide_when_empty' FROM data_source_properties
  WHERE id='blocked_by' AND data_source_id IN (SELECT id FROM work_graph_backfill_sources);
UPDATE data_sources SET schema_revision=schema_revision+1 WHERE id IN (SELECT id FROM work_graph_backfill_sources);
UPDATE data_source_page_layouts SET revision=revision+1 WHERE data_source_id IN (SELECT id FROM work_graph_backfill_sources);
DROP TABLE work_graph_backfill_sources;

-- A chat's unread state, pin, order and reminder become its Space's local Member's. A projectless
-- chat belongs to the Profile's Space. Archived chats keep no pin or reminder.
CREATE TEMP TABLE session_members AS
  SELECT session.id AS session_id,local.member_id
  FROM project_sessions session LEFT JOIN projects project ON project.id=session.project_id
  JOIN local_profile_members local ON local.library_id=COALESCE(project.library_id,(SELECT id FROM libraries LIMIT 1));
ALTER TABLE project_sessions RENAME TO project_sessions_v203;
CREATE TABLE "project_sessions" (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  no_thread_fallback_title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_default_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_default_draft IN (0, 1)),
  activity_at INTEGER NOT NULL,
  manual_rank INTEGER,
  CHECK (activity_at >= CAST(round(unixepoch(created_at, 'subsec') * 1000) AS INTEGER)),
  CHECK (archived IN (0, 1))
);
INSERT INTO project_sessions(id,project_id,no_thread_fallback_title,archived,archived_at,created_at,updated_at,
    is_default_draft,activity_at,manual_rank)
  SELECT id,project_id,no_thread_fallback_title,archived,archived_at,created_at,updated_at,is_default_draft,activity_at,
    manual_rank
  FROM project_sessions_v203;
INSERT INTO member_session_unread(member_id,session_id)
  SELECT owner.member_id,session.id FROM project_sessions_v203 session JOIN session_members owner ON owner.session_id=session.id
  WHERE session.unread=1;
INSERT INTO member_session_pins(member_id,session_id,pinned_order)
  SELECT owner.member_id,session.id,
    ROW_NUMBER() OVER (PARTITION BY owner.member_id
      ORDER BY COALESCE(session.pinned_order,9223372036854775807),session.id)-1
  FROM project_sessions_v203 session JOIN session_members owner ON owner.session_id=session.id
  WHERE session.pinned=1 AND session.archived=0;
INSERT INTO member_session_reminders(member_id,session_id,remind_at)
  SELECT owner.member_id,session.id,session.remind_at
  FROM project_sessions_v203 session JOIN session_members owner ON owner.session_id=session.id
  WHERE session.remind_at IS NOT NULL AND session.archived=0;
INSERT INTO member_session_reminder_deliveries(delivery_id,member_id,session_id,remind_at,next_attempt_at)
  SELECT delivery.delivery_id,owner.member_id,delivery.session_id,delivery.remind_at,delivery.next_attempt_at
  FROM project_session_reminder_deliveries delivery JOIN session_members owner ON owner.session_id=delivery.session_id;
-- A default draft is the local Member's; each Member opens one of their own.
INSERT INTO session_requesting_members(session_id,message_id,member_id,accepted_at)
  SELECT session.id,'session:created',owner.member_id,session.created_at
  FROM project_sessions session JOIN session_members owner ON owner.session_id=session.id
  WHERE session.is_default_draft=1;
DROP TABLE project_session_reminder_deliveries;
DROP TABLE project_sessions_v203;
DROP TABLE session_members;

-- A Page's attached file names who attached it: its Agent on behalf of the Page's Owner, Core's
-- own maintenance for an unknown attachment, or otherwise the local Member.
INSERT OR IGNORE INTO agent_actor_labels(session_id,run_key,label)
  SELECT json_extract(attached_by_json,'$.session_id'),'',
    CASE json_extract(attached_by_json,'$.backend')
      WHEN 'codex' THEN 'Codex' WHEN 'claude' THEN 'Claude' WHEN 'opencode' THEN 'OpenCode' ELSE 'Agent' END
  FROM page_file_entries WHERE json_extract(attached_by_json,'$.kind')='agent';
ALTER TABLE page_file_entries RENAME TO page_file_entries_v203;
CREATE TABLE "page_file_entries" (
  page_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  logical_path TEXT NOT NULL CHECK (length(logical_path) BETWEEN 1 AND 1024),
  path_key TEXT NOT NULL CHECK (length(path_key) BETWEEN 1 AND 1024),
  attached_by_json TEXT NOT NULL CHECK(json_valid(attached_by_json) AND COALESCE(json_extract(attached_by_json,'$.type') IN ('member','agent','service'),0)),
  attached_at TEXT,
  PRIMARY KEY (page_id, file_id),
  UNIQUE (page_id, path_key),
  FOREIGN KEY (page_id, library_id) REFERENCES pages(block_id, library_id)
    ON DELETE CASCADE,
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;
INSERT INTO page_file_entries(page_id,library_id,file_id,logical_path,path_key,attached_by_json,attached_at)
  SELECT entry.page_id,entry.library_id,entry.file_id,entry.logical_path,entry.path_key,
    CASE json_extract(entry.attached_by_json,'$.kind')
      WHEN 'agent' THEN json_object('type','agent','session_id',json_extract(entry.attached_by_json,'$.session_id'),
        'run_id',NULL,'on_behalf_of',COALESCE(
          (SELECT json_extract(value_json,'$.owner') FROM block_properties WHERE block_id=entry.page_id AND property_key='work'),
          (SELECT member_id FROM local_profile_members WHERE library_id=entry.library_id)))
      WHEN 'unknown' THEN json_object('type','service','kind','maintenance')
      ELSE json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=entry.library_id))
    END,
    entry.attached_at
  FROM page_file_entries_v203 entry;
DROP TABLE page_file_entries_v203;

-- Personal View state belongs to the Profile's Member rather than the Profile.
ALTER TABLE database_view_personal_preferences RENAME TO database_view_personal_preferences_v203;
CREATE TABLE "database_view_personal_preferences" (
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          preferences_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (member_id, view_id),
          CHECK (
            json_valid(preferences_json)
            AND json_type(preferences_json) = 'object'
          )
        ) WITHOUT ROWID, STRICT;
INSERT INTO database_view_personal_preferences(member_id,view_id,preferences_json,revision,created_at,updated_at)
  SELECT local.member_id,old.view_id,old.preferences_json,old.revision,old.created_at,old.updated_at
  FROM database_view_personal_preferences_v203 old JOIN local_profile_members local ON local.profile_id=old.profile_id;
DROP TABLE database_view_personal_preferences_v203;
ALTER TABLE database_view_collapsed_occurrences RENAME TO database_view_collapsed_occurrences_v203;
CREATE TABLE "database_view_collapsed_occurrences" (
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          target_kind TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          collapsed_at TEXT NOT NULL,
          PRIMARY KEY (member_id, view_id, target_kind, occurrence_key),
          CHECK (target_kind IN ('group', 'page')),
          CHECK (length(occurrence_key) BETWEEN 1 AND 1024),
          CHECK (
            (target_kind = 'group' AND substr(occurrence_key, 1, 6) = 'GROUP_')
            OR (target_kind = 'page' AND substr(occurrence_key, 1, 5) = 'ITEM_')
          )
        ) WITHOUT ROWID, STRICT;
INSERT INTO database_view_collapsed_occurrences(member_id,view_id,target_kind,occurrence_key,collapsed_at)
  SELECT local.member_id,old.view_id,old.target_kind,old.occurrence_key,old.collapsed_at
  FROM database_view_collapsed_occurrences_v203 old JOIN local_profile_members local ON local.profile_id=old.profile_id;
DROP TABLE database_view_collapsed_occurrences_v203;

-- Receipts admit a remote Member's adapter.
ALTER TABLE core_module_receipts RENAME TO core_module_receipts_v203;
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
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test', 'remote_member')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
INSERT INTO core_module_receipts SELECT * FROM core_module_receipts_v203;
DROP TABLE core_module_receipts_v203;
ALTER TABLE detached_module_receipts RENAME TO detached_module_receipts_v203;
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
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test', 'remote_member')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (event_sequence IS NULL OR event_sequence >= 1),
  CHECK (length(commit_manifest_hash) = 64 AND commit_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
INSERT INTO detached_module_receipts SELECT * FROM detached_module_receipts_v203;
DROP TABLE detached_module_receipts_v203;

-- Every Page derives its first Turn after Rust has completed the data above.
INSERT INTO page_turn_dirty SELECT block_id FROM pages;

-- Indexes, triggers and views, exactly as the current schema declares them.
CREATE TRIGGER project_session_execution_draft_update_guard
BEFORE UPDATE OF is_default_draft ON project_sessions
WHEN NEW.is_default_draft = 1
  AND EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'A running Session cannot become a default draft');
END;
CREATE INDEX idx_page_file_entries_file ON page_file_entries(file_id,page_id);
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
            member_id, view_id, collapsed_at, target_kind, occurrence_key
          );
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
CREATE TRIGGER project_sessions_clear_manual_rank AFTER UPDATE OF project_id, archived ON project_sessions
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.archived <> OLD.archived
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.id;
END;
CREATE TRIGGER clear_archived_active_chats AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived = 1
BEGIN
  DELETE FROM page_active_chats WHERE session_id = NEW.id;
END;
CREATE TRIGGER remote_receipt_collect AFTER DELETE ON core_module_receipts
WHEN NOT EXISTS(SELECT 1 FROM detached_module_receipts WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id)
BEGIN DELETE FROM remote_operation_members WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id; END;
CREATE TRIGGER remote_detached_receipt_collect AFTER DELETE ON detached_module_receipts
WHEN NOT EXISTS(SELECT 1 FROM core_module_receipts WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id)
BEGIN DELETE FROM remote_operation_members WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id; END;
CREATE INDEX idx_inbox_entries_suggestion ON inbox_entries(library_id, suggestion_state, seq);
CREATE INDEX idx_inbox_entries_source_budget ON inbox_entries(library_id, source_budget_key)
  WHERE source_budget_key IS NOT NULL;
CREATE INDEX idx_inbox_entries_scope ON inbox_entries(library_id, scope_project_id, seq);
CREATE INDEX idx_inbox_proposals_state ON inbox_proposals(library_id, state, confirmed_at);
CREATE INDEX idx_inbox_proposals_dispatch_session ON inbox_proposals(dispatch_session_id)
  WHERE dispatch_session_id IS NOT NULL;
CREATE TRIGGER intake_disposition_recorded AFTER UPDATE OF state ON inbox_entries
WHEN OLD.state<>NEW.state AND NOT EXISTS(SELECT 1 FROM intake_dispositions fact
  WHERE fact.page_id=NEW.page_id AND fact.proposal_id=NEW.current_proposal_id AND fact.at=NEW.updated_at)
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,at) VALUES(NEW.library_id,NEW.page_id,NEW.scope_project_id,NEW.state,NEW.updated_at);
END;
CREATE TRIGGER intake_disposition_confirmed AFTER UPDATE OF confirmed_at ON inbox_proposals
WHEN NEW.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,proposal_id,at)
  SELECT entry.library_id,entry.page_id,entry.scope_project_id,
    CASE json_extract(NEW.action_json,'$.type') WHEN 'move_to_project' THEN 'filed' WHEN 'keep' THEN 'kept' WHEN 'plan' THEN 'done' ELSE 'chat' END,
    NEW.proposal_id,NEW.confirmed_at
  FROM inbox_proposal_pages link JOIN inbox_entries entry ON entry.page_id=link.page_id
  WHERE link.proposal_id=NEW.proposal_id;
END;
CREATE TRIGGER inbox_proposals_capture_actor AFTER INSERT ON inbox_proposals
BEGIN
 UPDATE inbox_proposals SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN NEW.origin='automation' THEN json_object('type','service','kind','automations') END) WHERE proposal_id=NEW.proposal_id;
 SELECT CASE WHEN (SELECT actor_json FROM inbox_proposals WHERE proposal_id=NEW.proposal_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER inbox_proposals_capture_confirmation_actor AFTER UPDATE OF confirmed_at ON inbox_proposals
WHEN NEW.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
 UPDATE inbox_proposals SET confirmed_actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN NEW.origin='automation' THEN json_object('type','service','kind','automations') END) WHERE proposal_id=NEW.proposal_id;
 SELECT CASE WHEN (SELECT confirmed_actor_json FROM inbox_proposals WHERE proposal_id=NEW.proposal_id) IS NULL THEN RAISE(ABORT,'Inbox confirmation requires an admitted mutation actor') END;
END;
CREATE TRIGGER project_sessions_clear_member_attention AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived=1
BEGIN
  DELETE FROM member_session_unread WHERE session_id=NEW.id;
  DELETE FROM member_session_pins WHERE session_id=NEW.id;
  DELETE FROM member_session_reminders WHERE session_id=NEW.id;
  DELETE FROM member_session_reminder_deliveries WHERE session_id=NEW.id;
END;
CREATE INDEX idx_page_work_reports_latest ON project_session_pages(page_id,report_at DESC,report_revision DESC,session_id) WHERE report_outcome IS NOT NULL;
CREATE INDEX document_recovery_drafts_member ON document_recovery_drafts(member_id,library_id,document_id,draft_id);
CREATE TRIGGER library_files_validate_update
BEFORE UPDATE ON library_files
WHEN NEW.file_id <> OLD.file_id OR NEW.library_id <> OLD.library_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.head_version < OLD.head_version
  OR NEW.created_by_actor_json <> OLD.created_by_actor_json
  OR NEW.created_by_turn_id IS NOT OLD.created_by_turn_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'File updates must preserve identity and advance revision');
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
  JOIN data_sources source ON source.id = relation.data_source_id
  JOIN data_sources target_source
    ON target_source.id = COALESCE(NEW.target_data_source_id, relation.target_data_source_id)
   AND target_source.library_id = source.library_id
  JOIN blocks target_block ON target_block.id = NEW.target_page_block_id
  JOIN pages target_page
    ON target_page.block_id = target_block.id
   AND target_page.library_id = target_block.library_id
  JOIN data_source_page_memberships target_membership
    ON target_membership.page_block_id = target_block.id
   AND target_membership.data_source_id = COALESCE(NEW.target_data_source_id, relation.target_data_source_id)
   AND target_membership.removed_at IS NULL
  WHERE relation.data_source_id = NEW.source_data_source_id
    AND relation.property_id = NEW.property_id
    AND (NEW.target_data_source_id IS NULL OR NEW.property_id = 'blocked_by')
    AND target_page.library_id = source.library_id
    AND value.value_type = 'relation'
    AND json_type(value.value_json) = 'null'
    AND target_block.type = 'page'
    AND target_block.lifecycle = 'active'
) BEGIN
  SELECT RAISE(ABORT, 'Relation edge requires an active target Page in its target Source');
END;
CREATE TRIGGER libraries_initialize_local_member AFTER INSERT ON libraries
BEGIN
  INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES (lower(hex(randomblob(16))),NEW.id,'Owner','active','owner');
  INSERT INTO local_profile_members(profile_id,library_id,member_id) SELECT NEW.profile_id,NEW.id,id FROM members WHERE library_id=NEW.id;
END;
CREATE TRIGGER members_name_insert BEFORE INSERT ON members
WHEN lower(trim(NEW.display_name))='you'
BEGIN SELECT RAISE(ABORT,'A Member name cannot be You'); END;
CREATE TRIGGER members_name_update BEFORE UPDATE OF display_name ON members
WHEN lower(trim(NEW.display_name))='you'
BEGIN SELECT RAISE(ABORT,'A Member name cannot be You'); END;
CREATE TRIGGER pages_initialize_work AFTER INSERT ON pages
BEGIN
  INSERT OR IGNORE INTO block_properties(block_id, library_id, property_key, value_type, value_json, revision, updated_at)
  SELECT NEW.block_id, NEW.library_id, 'work', 'json',
    json_object('assignee', null, 'auto_start', json('false'), 'owner', member_id), 1, NEW.updated_at
  FROM local_profile_members WHERE library_id = NEW.library_id;
END;
CREATE TRIGGER source_triggers_immutable BEFORE UPDATE ON source_triggers
BEGIN SELECT RAISE(ABORT,'Source Triggers are immutable'); END;
CREATE TRIGGER channel_outbox_frozen BEFORE UPDATE OF page_id,source_id,external_thread_id,source_json,thread_json,episode,body,body_hash,marker,thread_order,created_at_ms ON channel_outbox
BEGIN SELECT RAISE(ABORT,'Channel replies are frozen'); END;
CREATE TRIGGER turn_pages_insert AFTER INSERT ON pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_pages_update AFTER UPDATE ON pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_pages_delete AFTER DELETE ON pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_blocks_insert AFTER INSERT ON blocks

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_blocks_update AFTER UPDATE ON blocks

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_blocks_delete AFTER DELETE ON blocks

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_block_properties_insert AFTER INSERT ON block_properties
WHEN NEW.property_key='work'
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_block_properties_update AFTER UPDATE ON block_properties
WHEN NEW.property_key='work'
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_block_properties_delete AFTER DELETE ON block_properties
WHEN OLD.property_key='work'
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_active_chats_insert AFTER INSERT ON page_active_chats

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_active_chats_update AFTER UPDATE ON page_active_chats

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_active_chats_delete AFTER DELETE ON page_active_chats

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_session_pages_insert AFTER INSERT ON project_session_pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_session_pages_update AFTER UPDATE ON project_session_pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_session_pages_delete AFTER DELETE ON project_session_pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_pull_requests_insert AFTER INSERT ON page_pull_requests

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_pull_requests_update AFTER UPDATE ON page_pull_requests

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_pull_requests_delete AFTER DELETE ON page_pull_requests

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_insert AFTER INSERT ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_property_values_insert AFTER INSERT ON data_source_property_values
WHEN NEW.property_id='status'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_page_memberships_insert AFTER INSERT ON data_source_page_memberships

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_relation_edges_insert AFTER INSERT ON data_source_relation_edges
WHEN NEW.property_id='blocked_by'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.source_membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_properties_insert AFTER INSERT ON data_source_properties
WHEN NEW.id IN ('status','blocked_by')
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=NEW.data_source_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_update AFTER UPDATE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_property_values_update AFTER UPDATE ON data_source_property_values
WHEN NEW.property_id='status'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_page_memberships_update AFTER UPDATE ON data_source_page_memberships

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_relation_edges_update AFTER UPDATE ON data_source_relation_edges
WHEN NEW.property_id='blocked_by'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.source_membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_properties_update AFTER UPDATE ON data_source_properties
WHEN NEW.id IN ('status','blocked_by')
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=NEW.data_source_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_delete AFTER DELETE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=OLD.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_property_values_delete AFTER DELETE ON data_source_property_values
WHEN OLD.property_id='status'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=OLD.membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_page_memberships_delete AFTER DELETE ON data_source_page_memberships

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_relation_edges_delete AFTER DELETE ON data_source_relation_edges
WHEN OLD.property_id='blocked_by'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=OLD.source_membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_properties_delete AFTER DELETE ON data_source_properties
WHEN OLD.id IN ('status','blocked_by')
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=OLD.data_source_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_sources_update AFTER UPDATE ON data_sources

BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=NEW.id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_database_containers_update AFTER UPDATE ON database_containers

BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership JOIN data_sources source ON source.id=membership.data_source_id WHERE source.home_database_block_id=NEW.block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_members_update AFTER UPDATE ON members

BEGIN
  INSERT INTO page_turn_dirty SELECT block_id FROM block_properties WHERE property_key='work' ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_key_namespaces_update AFTER UPDATE ON page_key_namespaces
BEGIN
  INSERT INTO page_turn_dirty SELECT DISTINCT dependent.page_block_id
  FROM data_sources source JOIN data_source_page_memberships target ON target.data_source_id=source.id
  JOIN data_source_relation_edges edge ON edge.target_page_block_id=target.page_block_id AND edge.property_id='blocked_by'
  JOIN data_source_page_memberships dependent ON dependent.id=edge.source_membership_id
  WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_workspaces_insert AFTER INSERT ON page_workspaces
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_workspaces_update AFTER UPDATE ON page_workspaces
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_workspaces_delete AFTER DELETE ON page_workspaces
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_projects_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_projects_update AFTER UPDATE ON projects
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_projects_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_database_bindings_insert AFTER INSERT ON project_database_bindings
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_database_bindings_update AFTER UPDATE ON project_database_bindings
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_database_bindings_delete AFTER DELETE ON project_database_bindings
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER personal_space_member_insert BEFORE INSERT ON members
WHEN (SELECT space_kind FROM libraries WHERE id=NEW.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR EXISTS(SELECT 1 FROM members WHERE library_id=NEW.library_id))
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_member_update BEFORE UPDATE OF role,lifecycle,library_id ON members
WHEN ((SELECT space_kind FROM libraries WHERE id=OLD.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR NEW.library_id<>OLD.library_id))
 OR ((SELECT space_kind FROM libraries WHERE id=NEW.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR EXISTS(SELECT 1 FROM members WHERE library_id=NEW.library_id AND id<>OLD.id)))
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_member_delete BEFORE DELETE ON members
WHEN (SELECT space_kind FROM libraries WHERE id=OLD.library_id)='personal'
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_kind_update BEFORE UPDATE OF space_kind ON libraries
WHEN NEW.space_kind='personal' AND (SELECT count(*) FROM members WHERE library_id=NEW.id AND lifecycle='active' AND role='owner')<>1
 OR NEW.space_kind='personal' AND (SELECT count(*) FROM members WHERE library_id=NEW.id)<>1
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER automation_clock_triggers_immutable BEFORE UPDATE ON automation_clock_triggers
BEGIN SELECT RAISE(ABORT,'Clock Triggers are immutable'); END;
CREATE TRIGGER automation_run_identity_guard
BEFORE UPDATE ON automation_execution_runs
WHEN NEW.run_id <> OLD.run_id OR NEW.automation_id <> OLD.automation_id
  OR NEW.admission_hash <> OLD.admission_hash
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Automation Run admission and Session binding are immutable');
END;
CREATE TRIGGER automation_decision_page_inactive
AFTER UPDATE OF lifecycle ON blocks WHEN NEW.lifecycle<>'active' AND OLD.lifecycle='active'
BEGIN
  UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch(NEW.updated_at,'subsec')*1000 AS INTEGER)
  WHERE page_id=NEW.id AND waiting_in_inbox=1;
END;
CREATE TRIGGER automation_decision_page_deleted
BEFORE DELETE ON blocks
BEGIN
  UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)
  WHERE page_id=OLD.id AND waiting_in_inbox=1;
END;
CREATE TRIGGER automations_owner_removed AFTER UPDATE OF lifecycle ON members WHEN NEW.lifecycle='removed'
BEGIN
 UPDATE automations SET status='DELETED',next_run_at=NULL,automation_revision=automation_revision+1,updated_at=MAX(updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE owner_member_id=NEW.id AND status<>'DELETED';
 UPDATE automation_execution_leases SET status='cancelled',settled_at_ms=MAX(claimed_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)),reason_code='automation_owner_removed' WHERE status='claimed' AND (automation_id IN(SELECT automation_id FROM automations WHERE owner_member_id=NEW.id) OR dispatch_id IN(SELECT dispatch_id FROM automation_decisions WHERE json_extract(frozen_authority_json,'$.owner_member_id')=NEW.id));
 UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,reason='Automation Owner is unavailable',updated_at_ms=MAX(created_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE (status IN('held','admitted') OR waiting_in_inbox=1) AND (automation_id IN(SELECT automation_id FROM automations WHERE owner_member_id=NEW.id) OR dispatch_id IN(SELECT dispatch_id FROM automation_decisions WHERE json_extract(frozen_authority_json,'$.owner_member_id')=NEW.id));
END;
CREATE TRIGGER automation_decisions_name_immutable BEFORE UPDATE OF automation_name ON automation_decisions WHEN OLD.automation_name<>'' AND NEW.automation_name IS NOT OLD.automation_name BEGIN SELECT RAISE(ABORT,'Automation decision names are immutable'); END;
CREATE TRIGGER local_commits_require_actor BEFORE INSERT ON local_commits
WHEN NEW.actor_json IS NULL OR NOT COALESCE(json_extract(NEW.actor_json,'$.type') IN ('member','agent','service'),0)
BEGIN SELECT RAISE(ABORT,'A LocalCommit requires a Core-authored actor'); END;
CREATE TRIGGER page_work_launches_require_actor BEFORE INSERT ON page_work_launches
WHEN NEW.actor_json IS NULL
BEGIN SELECT RAISE(ABORT,'A work launch requires its mutation actor'); END;
CREATE TRIGGER channel_outbox_capture_actor AFTER INSERT ON channel_outbox
BEGIN
 UPDATE channel_outbox SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM channel_outbox WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'A channel reply requires its mutation actor') END;
END;
CREATE TRIGGER channel_outbox_capture_state_actor AFTER UPDATE OF state,updated_at_ms ON channel_outbox
BEGIN
 UPDATE channel_outbox SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM channel_outbox WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'A channel transition requires its mutation actor') END;
END;
CREATE TRIGGER intake_dispositions_capture_actor AFTER INSERT ON intake_dispositions
BEGIN
 UPDATE intake_dispositions SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN EXISTS(SELECT 1 FROM inbox_entries WHERE page_id=NEW.page_id AND source_kind='automation') THEN json_object('type','service','kind','automations') END) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM intake_dispositions WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER page_turn_notes_capture_actor AFTER INSERT ON page_turn_notes
BEGIN
 UPDATE page_turn_notes SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE note_id=NEW.note_id;
 SELECT CASE WHEN (SELECT actor_json FROM page_turn_notes WHERE note_id=NEW.note_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER chat_message_handbacks_capture_actor AFTER INSERT ON chat_message_handbacks
BEGIN
 UPDATE chat_message_handbacks SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE receipt_id=NEW.receipt_id;
 SELECT CASE WHEN (SELECT actor_json FROM chat_message_handbacks WHERE receipt_id=NEW.receipt_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER automation_decisions_capture_actor AFTER INSERT ON automation_decisions
WHEN NEW.actor_json IS NULL
BEGIN
 UPDATE automation_decisions SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),json_object('type','service','kind','automations')) WHERE dispatch_id=NEW.dispatch_id;
 SELECT CASE WHEN (SELECT actor_json FROM automation_decisions WHERE dispatch_id=NEW.dispatch_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER page_work_retires_grant AFTER UPDATE ON block_properties
WHEN NEW.property_key='work' AND NOT COALESCE(json_extract(NEW.value_json,'$.auto_start'),0)
BEGIN DELETE FROM page_work_grants WHERE page_id=NEW.block_id; END;
CREATE TRIGGER page_work_captures_grant AFTER UPDATE ON block_properties
WHEN NEW.property_key='work' AND json_extract(NEW.value_json,'$.auto_start')=1
 AND (NOT COALESCE(json_extract(OLD.value_json,'$.auto_start'),0) OR NOT EXISTS(SELECT 1 FROM page_work_grants WHERE page_id=NEW.block_id))
BEGIN
 INSERT INTO page_work_grants(page_id,member_id)
 SELECT NEW.block_id,COALESCE(json_extract(actor_json,'$.member_id'),json_extract(actor_json,'$.on_behalf_of'),authorizing_member_id)
 FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1
 ON CONFLICT(page_id) DO UPDATE SET member_id=excluded.member_id;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM page_work_grants WHERE page_id=NEW.block_id) THEN RAISE(ABORT,'Automatic work requires its authorizing Member') END;
END;
CREATE TRIGGER page_work_captures_initial_grant AFTER INSERT ON block_properties
WHEN NEW.property_key='work' AND json_extract(NEW.value_json,'$.auto_start')=1
BEGIN
 INSERT INTO page_work_grants(page_id,member_id)
 SELECT NEW.block_id,COALESCE(json_extract(actor_json,'$.member_id'),json_extract(actor_json,'$.on_behalf_of'),authorizing_member_id)
 FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1
 ON CONFLICT(page_id) DO UPDATE SET member_id=excluded.member_id;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM page_work_grants WHERE page_id=NEW.block_id) THEN RAISE(ABORT,'Automatic work requires its authorizing Member') END;
END;
CREATE TRIGGER local_commit_actor_is_immutable BEFORE UPDATE OF actor_json,authorizing_member_id ON local_commits
WHEN OLD.finalized=1 AND (OLD.actor_json IS NOT NEW.actor_json OR OLD.authorizing_member_id IS NOT NEW.authorizing_member_id)
BEGIN SELECT RAISE(ABORT,'Committed actors are immutable'); END;
CREATE TRIGGER mutation_actors_are_immutable BEFORE UPDATE ON mutation_actors
BEGIN SELECT RAISE(ABORT,'Mutation actors are immutable'); END;
CREATE TRIGGER member_session_pin_clears_manual_rank AFTER INSERT ON member_session_pins
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.session_id;
END;
CREATE TRIGGER member_session_unpin_clears_manual_rank AFTER DELETE ON member_session_pins
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = OLD.session_id;
END;
CREATE VIEW activity_page_scopes AS
SELECT page.block_id AS page_id,page.library_id,binding.project_id
FROM pages page LEFT JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id
LEFT JOIN project_database_bindings binding ON binding.database_block_id=source.home_database_block_id AND binding.lifecycle='active';
CREATE VIEW inbox_rows AS
SELECT 'intake' AS row_kind, entry.page_id, entry.library_id, entry.scope_project_id AS project_id,
       entry.submitted_at AS sort_at, 'intake:'||entry.page_id AS row_id,
       (entry.state='open' AND NOT(COALESCE(proposal.state,'')='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown')
        AND NOT(COALESCE(proposal.state,'')='completed' AND COALESCE(json_extract(proposal.action_json,'$.type'),'') IN ('new_chat','send_to_chat','execute_decision'))) AS actionable,
       (entry.state='open' AND NOT(COALESCE(proposal.state,'')='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown')
        AND NOT(COALESCE(proposal.state,'')='completed' AND COALESCE(json_extract(proposal.action_json,'$.type'),'') IN ('new_chat','send_to_chat','execute_decision'))) AS in_inbox
FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals proposal ON proposal.proposal_id=entry.current_proposal_id
LEFT JOIN projects project ON project.id=entry.scope_project_id
WHERE entry.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'turn', page.block_id, page.library_id, project.id, episode.since, 'turn:'||page.block_id||':'||episode.episode, 1, 1
FROM page_turn_episodes episode JOIN pages page ON page.block_id=episode.page_id
JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
LEFT JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id
LEFT JOIN project_database_bindings binding ON binding.database_block_id=source.home_database_block_id AND binding.lifecycle='active'
LEFT JOIN projects project ON project.id=binding.project_id
WHERE json_extract(episode.signature,'$[0].kind')='member'
  AND (project.id IS NULL OR project.lifecycle='active')
  AND (json_extract(episode.signature,'$[1]') IN ('question','approval','review','blocked','failed','stalled')
       OR (json_extract(episode.signature,'$[1]')='ready_to_start' AND EXISTS(
         SELECT 1 FROM data_source_page_memberships membership JOIN data_source_relation_edges edge ON edge.source_membership_id=membership.id AND edge.property_id='blocked_by'
         WHERE membership.page_block_id=page.block_id AND membership.data_source_id=page.parent_id AND membership.removed_at IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM inbox_entries intake WHERE intake.page_id=page.block_id AND intake.state='open' AND intake.current_proposal_id IS NULL)
UNION ALL
SELECT 'answer', answer.page_id, answer.library_id, answer.scope_project_id, answer.created_at, 'answer:'||answer.page_id, 0, answer.handled_at IS NULL
FROM inbox_answers answer JOIN blocks block ON block.id=answer.page_id AND block.lifecycle='active'
LEFT JOIN projects project ON project.id=answer.scope_project_id
WHERE answer.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'problem', problem.id, problem.library_id, problem.project_id,
       strftime('%Y-%m-%dT%H:%M:%fZ',problem.opened_at_ms/1000.0,'unixepoch'), 'problem:'||problem.id, 1, 1
FROM problems problem LEFT JOIN projects project ON project.id=problem.project_id
WHERE problem.opened_at_ms IS NOT NULL AND problem.resolved_at_ms IS NULL
  AND (problem.project_id IS NULL OR project.lifecycle='active');
CREATE VIEW activity_facts AS
SELECT 'message:'||d.id AS id,d.library_id,d.page_id,d.project_id,d.at,
 d.actor_json AS actor_json,
 CASE d.disposition WHEN 'chat' THEN 'Sent message to chat' WHEN 'filed' THEN 'Filed message' WHEN 'kept' THEN 'Kept message' WHEN 'done' THEN 'Marked message done' ELSE 'Returned message to Inbox' END AS description,
 p.rationale AS reason,CASE d.disposition WHEN 'chat' THEN COALESCE(p.dispatch_session_id,json_extract(p.action_json,'$.session_id')) END AS session_id,NULL AS url,
 json_object('disposition',d.disposition,'proposal_id',d.proposal_id,'confirmed_by',p.confirmed_by,
   'answered',json(CASE WHEN d.disposition='done' AND EXISTS(SELECT 1 FROM inbox_answers answer
     WHERE answer.question_page_id=d.page_id AND answer.created_at=d.at) THEN 'true' ELSE 'false' END),
   'action',json_object('type',json_extract(p.action_json,'$.type'),'session_id',json_extract(p.action_json,'$.session_id'),
     'project_id',json_extract(p.action_json,'$.project_id'),'decision_id',json_extract(p.action_json,'$.decision_id'),
     'steps',json_array_length(p.action_json,'$.steps'))) AS evidence_json,'messages' AS category
FROM intake_dispositions d JOIN inbox_entries entry ON entry.page_id=d.page_id
JOIN blocks block ON block.id=d.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals p ON p.proposal_id=d.proposal_id
UNION ALL
SELECT 'launch:'||l.launch_id,s.library_id,l.page_id,l.project_id,l.created_at,l.actor_json,
 CASE l.automatic WHEN 1 THEN 'Automatically started work' ELSE 'Started work' END,l.rejection,l.session_id,NULL,json_object('launch_id',l.launch_id,'accepted_at',l.accepted_at,'automatic',json(CASE l.automatic WHEN 1 THEN 'true' ELSE 'false' END)),'decisions'
FROM page_work_launches l JOIN activity_page_scopes s ON s.page_id=l.page_id
UNION ALL
SELECT 'trigger:'||t.id||':'||COALESCE(d.page_id,intake.page_id,''),t.library_id,COALESCE(d.page_id,intake.page_id),COALESCE(s.project_id,entry.scope_project_id),strftime('%Y-%m-%dT%H:%M:%fZ',t.received_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE t.disposition WHEN 'followed' THEN 'Routed GitHub update to followed cards' WHEN 'intake' THEN 'Sent GitHub request to Inbox' ELSE 'Ignored GitHub update' END,
 CASE t.disposition WHEN 'followed' THEN 'Thread is followed; no new assessment' WHEN 'intake' THEN 'Discovery matched an unwatched request' ELSE 'No followed card or enabled discovery matched' END,d.session_id,json_extract(t.event_json,'$.url'),json_object('trigger_id',t.id,'kind',json_extract(t.event_json,'$.kind'),'actor',json_extract(t.event_json,'$.actor_login'),'event',json(t.event_json),'disposition',t.disposition,'delivery_state',d.state),'decisions'
FROM source_triggers t LEFT JOIN thread_deliveries d ON d.trigger_id=t.id
LEFT JOIN activity_page_scopes s ON s.page_id=d.page_id
LEFT JOIN github_intake_triggers intake_link ON intake_link.trigger_id=t.id
LEFT JOIN github_intakes intake ON intake.external_thread_id=intake_link.external_thread_id
LEFT JOIN inbox_entries entry ON entry.page_id=intake.page_id
UNION ALL
SELECT 'milestone:'||m.page_id||':'||m.fact_identity,s.library_id,m.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',t.received_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE m.status_moved WHEN 1 THEN 'Moved card to ' ELSE 'Skipped move to ' END||CASE m.destination WHEN 'doing' THEN 'In Progress' WHEN 'review' THEN 'In Review' WHEN 'done' THEN 'Done' ELSE 'Canceled' END,m.reason,NULL,json_extract(t.event_json,'$.url'),json_object('trigger_id',t.id,'fact',m.fact_identity,'moved',m.status_moved,'destination',m.destination,'stage',m.stage,'event',json(t.event_json)),'decisions'
FROM thread_milestones m JOIN source_triggers t ON t.id=m.trigger_id JOIN activity_page_scopes s ON s.page_id=m.page_id
UNION ALL
SELECT 'delivery:'||d.id,s.library_id,d.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(b.settled_at_ms,t.received_at_ms)/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE d.state WHEN 'accepted' THEN 'Delivered GitHub update to chat' WHEN 'suppressed' THEN 'Ignored GitHub update on closed work' WHEN 'unresolved' THEN 'GitHub update needs a chat' WHEN 'rejected' THEN 'Chat rejected GitHub update' ELSE 'Queued GitHub update for chat' END,d.reason,d.session_id,json_extract(t.event_json,'$.url'),json_object('delivery_id',d.id,'message_id',d.message_id,'state',d.state,'event',json(t.event_json)),'all'
FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN activity_page_scopes s ON s.page_id=d.page_id LEFT JOIN thread_delivery_batches b ON b.message_id=d.message_id
UNION ALL
SELECT 'channel:'||o.id,o.library_id,o.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',o.updated_at_ms/1000.0,'unixepoch'),o.actor_json,
 CASE o.state WHEN 'sent' THEN 'Replied to origin on GitHub' WHEN 'dropped' THEN 'GitHub reply could not be sent' WHEN 'failed' THEN 'GitHub reply needs retry' ELSE 'Queued reply to origin' END,o.terminal_reason,NULL,COALESCE(o.remote_url,json_extract(o.thread_json,'$.url')),json_object('outbox_id',o.id,'state',o.state,'body',o.body,'comment_id',o.remote_comment_id,'thread',json(o.thread_json)),'all'
FROM channel_outbox o JOIN activity_page_scopes s ON s.page_id=o.page_id
UNION ALL
SELECT 'note:'||n.note_id,s.library_id,n.page_id,s.project_id,n.created_at,n.actor_json,'Added Turn note',n.body,n.coordinator_session_id,NULL,json_object('note_id',n.note_id,'episode',n.episode),'all'
FROM page_turn_notes n JOIN activity_page_scopes s ON s.page_id=n.page_id
UNION ALL
SELECT 'handback:'||h.receipt_id||':'||link.page_id,d.library_id,link.page_id,s.project_id,h.created_at,h.actor_json,'Returned message to Inbox',h.reason,d.session_id,NULL,json_object('receipt_id',h.receipt_id,'delivery_id',h.delivery_id),'decisions'
FROM chat_message_handbacks h JOIN chat_message_deliveries d ON d.delivery_id=h.delivery_id JOIN chat_message_handback_pages link ON link.receipt_id=h.receipt_id JOIN activity_page_scopes s ON s.page_id=link.page_id
UNION ALL
SELECT 'problem-open:'||p.id,p.library_id,p.page_id,p.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',p.opened_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),p.summary,json_extract(p.evidence_json,'$.reason'),NULL,json_extract(p.evidence_json,'$.url'),json_object('problem_id',p.id,'kind',p.kind,'fix',p.fix,'source_id',p.source_id,'count',p.consecutive_failures,'scope',p.scope),'problems'
FROM problems p WHERE p.opened_at_ms IS NOT NULL
UNION ALL
SELECT 'problem-resolved:'||p.id,p.library_id,p.page_id,p.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',p.resolved_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),'Resolved: '||p.summary,'Recovered successfully',NULL,json_extract(p.evidence_json,'$.url'),json_object('problem_id',p.id,'kind',p.kind,'source_id',p.source_id,'count',p.consecutive_failures,'scope',p.scope),'problems'
FROM problems p WHERE p.opened_at_ms IS NOT NULL AND p.resolved_at_ms IS NOT NULL
UNION ALL
SELECT phase.kind||':'||decision.dispatch_id,owner.library_id,decision.page_id,automation.scope_project_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',(CASE phase.kind WHEN 'automation' THEN decision.created_at_ms ELSE decision.updated_at_ms END)/1000.0,'unixepoch'),
 decision.actor_json,'Automation decision',
 CASE WHEN phase.kind='automation' AND decision.status IN ('skipped','withdrawn','failed') THEN NULL
   ELSE COALESCE(decision.failure_message,NULLIF(decision.reason,'')) END,NULL,NULL,
 json_object('decision_id',decision.dispatch_id,'automation_id',decision.automation_id,
   'mode',decision.mode,'manual',json(CASE WHEN decision.admitted_at_ms IS NOT NULL AND decision.page_id IS NULL THEN 'true' ELSE 'false' END),'status',CASE WHEN phase.kind='automation' AND decision.admitted_at_ms IS NOT NULL AND decision.page_id IS NULL THEN 'admitted' WHEN phase.kind='automation' THEN CASE decision.mode WHEN 'dry_run' THEN 'completed' WHEN 'ask_first' THEN 'held' ELSE 'admitted' END ELSE decision.status END,'automation_revision',decision.automation_revision,
   'first_due_at_ms',decision.first_scheduled_for_ms,'last_due_at_ms',decision.last_scheduled_for_ms,
   'missed_count',decision.missed_count),'decisions'
FROM automation_decisions decision JOIN automations automation ON automation.automation_id=decision.automation_id
JOIN members owner ON owner.id=automation.owner_member_id
JOIN (SELECT 'automation' AS kind UNION ALL SELECT 'automation-settlement') phase
  ON phase.kind='automation' OR decision.status IN ('skipped','withdrawn','failed')
WHERE decision.assessment_json IS NULL AND (phase.kind='automation-settlement'
 OR (decision.mode='dry_run' AND decision.status='completed')
 OR decision.admitted_at_ms IS NOT NULL
 OR decision.page_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM automation_execution_leases lease
   WHERE lease.dispatch_id=decision.dispatch_id AND lease.automation_id=decision.automation_id AND lease.purpose='run')
 OR EXISTS(SELECT 1 FROM automation_execution_runs run
   WHERE run.dispatch_id=decision.dispatch_id AND run.automation_id=decision.automation_id))
UNION ALL
SELECT 'assessment:'||d.dispatch_id,m.library_id,d.page_id,r.scope_project_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',d.created_at_ms/1000.0,'unixepoch'),
 d.actor_json,'Automation assessment',d.reason,NULL,NULL,
 json_set(d.assessment_json,'$.fact_kind','assessment','$.automation_id',d.automation_id,'$.decision_id',d.dispatch_id,'$.mode',d.mode,'$.status',d.status),'decisions'
FROM automation_decisions d JOIN automations r ON r.automation_id=d.automation_id JOIN members m ON m.id=r.owner_member_id WHERE d.assessment_json IS NOT NULL;
CREATE VIEW inbox_member_rows AS
SELECT rows.*,member.id AS member_id FROM inbox_rows rows
JOIN members member ON member.library_id=rows.library_id AND member.lifecycle='active'
LEFT JOIN inbox_entries entry ON entry.page_id=rows.page_id
LEFT JOIN inbox_answers answer ON answer.page_id=rows.page_id
LEFT JOIN page_turn_episodes episode ON episode.page_id=rows.page_id
WHERE (rows.row_kind='turn' AND member.id=json_extract(episode.signature,'$[0].member_id'))
 OR (rows.row_kind='answer' AND member.id=answer.member_id)
 OR (rows.row_kind='intake' AND (entry.source_kind<>'automation' OR member.id=entry.author_member_id))
 OR rows.row_kind='problem';
