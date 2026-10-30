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
INSERT INTO inbox_entries SELECT * FROM saved_inbox_entries;
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
INSERT INTO inbox_proposals SELECT * FROM saved_inbox_proposals;
DROP TABLE saved_inbox_proposals;
CREATE INDEX idx_inbox_proposals_state ON inbox_proposals(library_id, state, confirmed_at);
CREATE TABLE inbox_proposal_pages (
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (proposal_id, page_id)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_proposal_pages SELECT * FROM saved_inbox_proposal_pages;
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
  , images_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(images_json) AND json_type(images_json) = 'array')) WITHOUT ROWID, STRICT;
INSERT INTO inbox_handoffs SELECT * FROM saved_inbox_handoffs;
DROP TABLE saved_inbox_handoffs;
CREATE TABLE inbox_suggestion_request_pages (
  request_id TEXT NOT NULL REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(request_id,page_id)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_suggestion_request_pages SELECT * FROM saved_inbox_suggestion_request_pages;
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
INSERT INTO inbox_decision_undo SELECT * FROM saved_inbox_decision_undo;
DROP TABLE saved_inbox_decision_undo;
UPDATE inbox_entries SET suggestion_state='waiting' WHERE suggestion_state='pending' AND suggestion_request_id IS NULL AND source_kind<>'scheduled_task';
ALTER TABLE inbox_suggestion_requests ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inputs_json) AND json_type(inputs_json) = 'array');
