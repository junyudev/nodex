ALTER TABLE codex_scheduled_automations ADD COLUMN launch TEXT NOT NULL DEFAULT 'automatic' CHECK (launch IN ('automatic','ask'));
ALTER TABLE core_automation_runs ADD COLUMN dispatch_id TEXT;
ALTER TABLE core_automation_leases ADD COLUMN purpose TEXT NOT NULL DEFAULT 'run' CHECK (purpose IN ('run','hold'));
CREATE TEMP TABLE saved_inbox_entries AS SELECT * FROM inbox_entries;
CREATE TEMP TABLE saved_inbox_proposals AS SELECT * FROM inbox_proposals;
CREATE TEMP TABLE saved_inbox_proposal_pages AS SELECT * FROM inbox_proposal_pages;
CREATE TEMP TABLE saved_inbox_handoffs AS SELECT * FROM inbox_handoffs;
CREATE TEMP TABLE saved_inbox_suggestion_request_pages AS SELECT * FROM inbox_suggestion_request_pages;
CREATE TEMP TABLE saved_inbox_decision_undo AS SELECT * FROM inbox_decision_undo;
DROP TABLE inbox_decision_undo;
DROP TABLE inbox_suggestion_request_pages;
DROP TABLE inbox_handoffs;
DROP TABLE inbox_proposal_pages;
DROP TABLE inbox_proposals;
DROP TABLE inbox_entries;
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
  suggestion_state TEXT NOT NULL DEFAULT 'pending' CHECK (suggestion_state IN ('pending', 'settled', 'failed')),
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
INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,source_session_id,source_thread_id,source_turn_id,source_project_id,source_label,provisional_title,kind,kind_set_by_user,state,suggestion_state,suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,scope_project_id,outcome,suggestion_request_id,important) SELECT page_id,library_id,seq,submitted_at,source_kind,source_session_id,source_thread_id,source_turn_id,source_project_id,source_label,provisional_title,kind,kind_set_by_user,state,suggestion_state,suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,scope_project_id,outcome,suggestion_request_id,important FROM saved_inbox_entries;
DROP TABLE saved_inbox_entries;
CREATE INDEX idx_inbox_entries_suggestion ON inbox_entries(library_id, suggestion_state, seq);
CREATE INDEX idx_inbox_entries_source_budget ON inbox_entries(library_id, source_budget_key)
  WHERE source_budget_key IS NOT NULL;
CREATE INDEX idx_inbox_entries_scope ON inbox_entries(library_id, scope_project_id, seq);
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
INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,revision,action_json,kind,summary,rationale,produced_by,basis_json,dispatch_session_id,dispatch_thread_id,confirmed_at,attempt,failure_message,created_at,updated_at,failure_kind) SELECT proposal_id,library_id,origin,state,revision,action_json,kind,summary,rationale,produced_by,basis_json,dispatch_session_id,dispatch_thread_id,confirmed_at,attempt,failure_message,created_at,updated_at,failure_kind FROM saved_inbox_proposals;
DROP TABLE saved_inbox_proposals;
CREATE INDEX idx_inbox_proposals_state ON inbox_proposals(library_id, state, confirmed_at);
CREATE TABLE inbox_proposal_pages (
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (proposal_id, page_id)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_proposal_pages(proposal_id,page_id,position) SELECT proposal_id,page_id,position FROM saved_inbox_proposal_pages;
DROP TABLE saved_inbox_proposal_pages;
CREATE INDEX idx_inbox_proposal_pages_page ON inbox_proposal_pages(page_id, proposal_id);
CREATE TABLE inbox_handoffs (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  final_text TEXT NOT NULL CHECK (length(CAST(final_text AS BLOB)) <= 1179648),
  launch_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL UNIQUE,
  execution_selection_json TEXT CHECK (execution_selection_json IS NULL OR json_valid(execution_selection_json)),
  target_execution_ref_json TEXT CHECK (target_execution_ref_json IS NULL OR json_valid(target_execution_ref_json))
  , image_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(image_sources_json) AND json_type(image_sources_json) = 'array')) WITHOUT ROWID, STRICT;
INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id,execution_selection_json,target_execution_ref_json,image_sources_json) SELECT proposal_id,store_epoch,final_text,launch_id,message_id,execution_selection_json,target_execution_ref_json,image_sources_json FROM saved_inbox_handoffs;
DROP TABLE saved_inbox_handoffs;
CREATE TABLE inbox_suggestion_request_pages (
  request_id TEXT NOT NULL REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(request_id,page_id)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_suggestion_request_pages(request_id,page_id,position) SELECT request_id,page_id,position FROM saved_inbox_suggestion_request_pages;
DROP TABLE saved_inbox_suggestion_request_pages;
CREATE TABLE inbox_decision_undo (
  token TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_decision_undo(token,operation_id,library_id,store_epoch,proposal_id,recipe_json,consumed) SELECT token,operation_id,library_id,store_epoch,proposal_id,recipe_json,consumed FROM saved_inbox_decision_undo;
DROP TABLE saved_inbox_decision_undo;
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
CREATE UNIQUE INDEX idx_core_automation_firings_waiting ON core_automation_firings(automation_id) WHERE waiting_in_inbox=1;
CREATE UNIQUE INDEX idx_core_automation_firings_page ON core_automation_firings(page_id);
CREATE INDEX idx_core_automation_firings_due ON core_automation_firings(due_at_ms) WHERE status='admitted';
CREATE INDEX idx_core_automation_runs_dispatch ON core_automation_runs(dispatch_id,created_at,run_id);

-- Page lifecycle is shared by Library, document ownership and erasure paths.
CREATE TRIGGER core_automation_firing_page_inactive
AFTER UPDATE OF lifecycle ON blocks WHEN NEW.lifecycle<>'active' AND OLD.lifecycle='active'
BEGIN
  UPDATE core_automation_firings SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch(NEW.updated_at,'subsec')*1000 AS INTEGER)
  WHERE page_id=NEW.id AND waiting_in_inbox=1;
END;
CREATE TRIGGER core_automation_firing_page_deleted
BEFORE DELETE ON blocks
BEGIN
  UPDATE core_automation_firings SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)
  WHERE page_id=OLD.id AND waiting_in_inbox=1;
END;
