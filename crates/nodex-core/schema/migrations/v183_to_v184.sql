ALTER TABLE inbox_entries ADD COLUMN outcome TEXT CHECK (outcome IN ('kept','done','moved','chat'));
ALTER TABLE inbox_entries ADD COLUMN suggestion_request_id TEXT;
ALTER TABLE inbox_proposals ADD COLUMN failure_kind TEXT CHECK (failure_kind IN ('rejected','unavailable','unknown'));
CREATE TABLE inbox_handoffs (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  final_text TEXT NOT NULL CHECK (length(CAST(final_text AS BLOB)) <= 1179648),
  launch_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL UNIQUE,
  execution_selection_json TEXT CHECK (execution_selection_json IS NULL OR json_valid(execution_selection_json)),
  target_execution_ref_json TEXT CHECK (target_execution_ref_json IS NULL OR json_valid(target_execution_ref_json))
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_suggestion_requests (
  request_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('auto','grouped','refine')),
  state TEXT NOT NULL CHECK (state IN ('pending','settled','failed','superseded')),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
  proposal_id TEXT,
  expected_revision INTEGER,
  correction TEXT CHECK (correction IS NULL OR length(CAST(correction AS BLOB)) <= 16384),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_inbox_requests_pending ON inbox_suggestion_requests(library_id,state,created_at);
CREATE TABLE inbox_suggestion_request_pages (
  request_id TEXT NOT NULL REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(request_id,page_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_decision_undo (
  token TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
) WITHOUT ROWID, STRICT;
UPDATE inbox_entries SET outcome = CASE state WHEN 'kept' THEN 'kept' WHEN 'done' THEN 'done' ELSE NULL END;
UPDATE inbox_entries SET outcome = CASE json_extract(proposal.action_json,'$.type') WHEN 'move_to_project' THEN 'moved' WHEN 'new_chat' THEN 'chat' WHEN 'send_to_chat' THEN 'chat' ELSE outcome END FROM inbox_proposals proposal WHERE proposal.proposal_id=inbox_entries.current_proposal_id AND proposal.state='completed';
UPDATE inbox_entries SET outcome=NULL WHERE current_proposal_id IN (SELECT proposal_id FROM inbox_proposals WHERE state='dispatching');
PRAGMA user_version = 184;

-- Older advice has no observed placement fence and must be reviewed afresh.
UPDATE inbox_proposals SET basis_json=(SELECT json_group_array(json_set(basis.value,'$.placement_revision',COALESCE((SELECT placement_revision FROM blocks WHERE id=json_extract(basis.value,'$.page_id')),0))) FROM json_each(inbox_proposals.basis_json) basis);
UPDATE inbox_entries SET current_proposal_id=NULL,suggestion_state='pending' WHERE state='open' AND current_proposal_id IN (SELECT proposal_id FROM inbox_proposals WHERE state='open');
UPDATE inbox_proposals SET state='superseded',revision=revision+1 WHERE state='open';
