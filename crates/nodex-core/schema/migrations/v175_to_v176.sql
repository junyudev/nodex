CREATE TABLE inbox_registry (
  library_id TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  database_block_id TEXT NOT NULL UNIQUE,
  data_source_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL UNIQUE,
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(database_block_id) BETWEEN 1 AND 512),
  CHECK (length(data_source_id) BETWEEN 1 AND 512),
  CHECK (length(view_id) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_entries (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  submitted_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'agent', 'command_line')),
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
  UNIQUE (library_id, seq),
  CHECK (source_kind = 'agent' OR (source_session_id IS NULL AND source_thread_id IS NULL AND source_turn_id IS NULL)),
  CHECK (source_kind <> 'user' OR (source_project_id IS NULL AND source_label IS NULL)),
  CHECK (source_kind = 'user' OR source_label IS NOT NULL),
  CHECK (suggestion_state = 'failed' OR suggestion_error IS NULL)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_inbox_entries_suggestion ON inbox_entries(library_id, suggestion_state, seq);
CREATE INDEX idx_inbox_entries_source_turn ON inbox_entries(source_thread_id, source_turn_id)
  WHERE source_turn_id IS NOT NULL;
CREATE TABLE inbox_proposals (
  proposal_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user')),
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
  CHECK (state <> 'dispatching' OR (dispatch_session_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_message IS NOT NULL)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_inbox_proposals_state ON inbox_proposals(library_id, state, confirmed_at);
CREATE TABLE inbox_proposal_pages (
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (proposal_id, page_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_inbox_proposal_pages_page ON inbox_proposal_pages(page_id, proposal_id);
