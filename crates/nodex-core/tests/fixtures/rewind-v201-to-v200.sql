-- Test support: rewinds a v201 Store to the v200 schema so predecessor upgrades can be reproduced
-- from Stores built at the current schema. Arranged positions and Session activity are discarded.
DROP TRIGGER project_sessions_clear_manual_rank;
DROP TRIGGER sidebar_section_session_clear_manual_rank;
DROP TRIGGER sidebar_section_session_move_clear_manual_rank;
DROP TRIGGER project_session_link_activity;
DROP TRIGGER codex_thread_session_activity;
DROP TRIGGER sidebar_section_restore_clear_manual_rank;
DROP TRIGGER project_session_execution_binding_insert_guard;
DROP TRIGGER project_session_execution_draft_update_guard;
DROP TRIGGER project_session_archive_cancels_reminder;
DROP TRIGGER session_search_project_sessions_insert;
DROP TRIGGER session_search_project_sessions_delete;
DROP TRIGGER session_search_project_sessions_update;
CREATE TABLE project_sessions_v200 (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  no_thread_fallback_title TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_order INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, is_default_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_default_draft IN (0, 1)), remind_at TEXT,
  CHECK (pinned IN (0, 1)),
  CHECK (archived IN (0, 1)),
  CHECK (unread IN (0, 1))
);
INSERT INTO project_sessions_v200(id,project_id,no_thread_fallback_title,pinned,pinned_order,archived,archived_at,unread,created_at,updated_at,is_default_draft,remind_at,"order")
SELECT id,project_id,no_thread_fallback_title,pinned,pinned_order,archived,archived_at,unread,created_at,updated_at,is_default_draft,remind_at,0 FROM project_sessions;
DROP TABLE project_sessions;
ALTER TABLE project_sessions_v200 RENAME TO project_sessions;
CREATE INDEX idx_project_sessions_project_identity ON project_sessions(project_id,id);
CREATE INDEX idx_project_sessions_project_order
  ON project_sessions(project_id, "order", created_at);
CREATE INDEX idx_project_sessions_project_sidebar
  ON project_sessions(project_id, archived, pinned, pinned_order, "order");
CREATE INDEX idx_project_sessions_reminder ON project_sessions(remind_at,id) WHERE remind_at IS NOT NULL AND archived = 0;
CREATE UNIQUE INDEX idx_project_sessions_default_draft_project ON project_sessions(project_id) WHERE is_default_draft = 1 AND project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_project_sessions_default_draft_projectless ON project_sessions(is_default_draft) WHERE is_default_draft = 1 AND project_id IS NULL;
CREATE TRIGGER project_session_execution_binding_insert_guard
BEFORE INSERT ON project_session_execution_bindings
WHEN EXISTS (SELECT 1 FROM project_session_threads WHERE session_id = NEW.session_id)
  OR EXISTS (SELECT 1 FROM project_sessions WHERE id = NEW.session_id AND is_default_draft = 1)
BEGIN
  SELECT RAISE(ABORT, 'Session already has execution ownership or is a default draft');
END;
CREATE TRIGGER project_session_execution_draft_update_guard
BEFORE UPDATE OF is_default_draft ON project_sessions
WHEN NEW.is_default_draft = 1
  AND EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'A running Session cannot become a default draft');
END;
CREATE TRIGGER project_session_archive_cancels_reminder AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived = 1
BEGIN
  UPDATE project_sessions SET remind_at = NULL WHERE id = NEW.id;
  DELETE FROM project_session_reminder_deliveries WHERE session_id = NEW.id;
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
CREATE TABLE workspace_sidebar_lanes (
  scope_key TEXT PRIMARY KEY,
  lane_kind TEXT NOT NULL CHECK (lane_kind IN ('project', 'projectless')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  order_mode TEXT NOT NULL CHECK (order_mode IN ('recency', 'manual')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  CHECK (
    (lane_kind = 'project' AND project_id IS NOT NULL AND scope_key = 'project:' || project_id)
    OR (lane_kind = 'projectless' AND project_id IS NULL AND scope_key = 'projectless')
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_sidebar_positions (
  scope_key TEXT NOT NULL
    REFERENCES workspace_sidebar_lanes(scope_key) ON UPDATE CASCADE ON DELETE CASCADE,
  thread_id TEXT NOT NULL
    REFERENCES codex_threads(thread_id) ON UPDATE CASCADE ON DELETE CASCADE,
  rank_key INTEGER NOT NULL CHECK (rank_key >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, thread_id),
  UNIQUE (scope_key, rank_key)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_workspace_sidebar_positions_lane_rank
  ON workspace_sidebar_positions(scope_key, rank_key, thread_id);
CREATE INDEX idx_workspace_sidebar_positions_thread
  ON workspace_sidebar_positions(thread_id, scope_key);
