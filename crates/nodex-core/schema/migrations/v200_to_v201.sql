DROP TRIGGER "project_session_execution_binding_insert_guard";
DROP TRIGGER "project_session_execution_draft_update_guard";
DROP TRIGGER "session_search_project_sessions_insert";
DROP TRIGGER "session_search_project_sessions_delete";
DROP TRIGGER "session_search_project_sessions_update";
DROP TRIGGER project_session_archive_cancels_reminder;
DROP TABLE workspace_sidebar_positions;
DROP TABLE workspace_sidebar_lanes;
DROP INDEX idx_project_sessions_project_order;
DROP INDEX idx_project_sessions_project_sidebar;
DROP INDEX idx_project_sessions_reminder;
CREATE TABLE project_sessions_new (
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
INSERT INTO project_sessions_new(id,project_id,no_thread_fallback_title,pinned,pinned_order,archived,archived_at,unread,created_at,updated_at,is_default_draft,remind_at,activity_at,manual_rank)
SELECT session.id,session.project_id,session.no_thread_fallback_title,session.pinned,session.pinned_order,session.archived,session.archived_at,session.unread,session.created_at,session.updated_at,session.is_default_draft,session.remind_at, max(CAST(round(unixepoch(session.created_at, 'subsec') * 1000) AS INTEGER), COALESCE((SELECT thread.recency_at FROM project_session_threads link JOIN codex_threads thread ON thread.thread_id=link.thread_id WHERE link.session_id=session.id), CAST(round(unixepoch(session.created_at, 'subsec') * 1000) AS INTEGER))), NULL FROM project_sessions session;
DROP TABLE project_sessions;
ALTER TABLE project_sessions_new RENAME TO project_sessions;
CREATE INDEX idx_project_sessions_project_activity ON project_sessions(project_id, archived, activity_at DESC, id);
CREATE INDEX idx_project_sessions_project_manual ON project_sessions(project_id, archived, manual_rank, activity_at DESC, id);
CREATE INDEX idx_project_sessions_project_sidebar ON project_sessions(project_id, archived, pinned, pinned_order, id);
CREATE INDEX idx_project_sessions_project_identity ON project_sessions(project_id, id);
CREATE INDEX idx_project_sessions_reminder ON project_sessions(remind_at,id) WHERE remind_at IS NOT NULL AND archived = 0;
CREATE TRIGGER project_session_archive_cancels_reminder AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived = 1
BEGIN
  UPDATE project_sessions SET remind_at = NULL WHERE id = NEW.id;
  DELETE FROM project_session_reminder_deliveries WHERE session_id = NEW.id;
END;
CREATE TRIGGER project_sessions_clear_manual_rank AFTER UPDATE OF project_id, pinned, archived ON project_sessions
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.pinned <> OLD.pinned OR NEW.archived <> OLD.archived
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.id;
END;
CREATE TRIGGER sidebar_section_session_clear_manual_rank AFTER INSERT ON workspace_sidebar_section_items
WHEN NEW.session_id IS NOT NULL
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.session_id;
END;
CREATE TRIGGER sidebar_section_session_move_clear_manual_rank AFTER UPDATE OF section_id ON workspace_sidebar_section_items
WHEN NEW.session_id IS NOT NULL
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.session_id;
END;

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

CREATE UNIQUE INDEX idx_project_sessions_default_draft_project ON project_sessions(project_id) WHERE is_default_draft = 1 AND project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_project_sessions_default_draft_projectless ON project_sessions(is_default_draft) WHERE is_default_draft = 1 AND project_id IS NULL;

CREATE TRIGGER project_session_link_activity AFTER INSERT ON project_session_threads
BEGIN
  UPDATE project_sessions SET activity_at = max(activity_at, (SELECT recency_at FROM codex_threads WHERE thread_id = NEW.thread_id)) WHERE id = NEW.session_id;
END;
CREATE TRIGGER codex_thread_session_activity AFTER UPDATE OF recency_at ON codex_threads
WHEN NEW.recency_at > OLD.recency_at
BEGIN
  UPDATE project_sessions SET activity_at = max(activity_at, NEW.recency_at) WHERE id IN (SELECT session_id FROM project_session_threads WHERE thread_id = NEW.thread_id);
END;

CREATE TRIGGER sidebar_section_restore_clear_manual_rank AFTER UPDATE OF lifecycle ON workspace_sidebar_sections
WHEN NEW.lifecycle = 'active' AND OLD.lifecycle <> 'active'
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id IN (SELECT session_id FROM workspace_sidebar_section_items WHERE section_id = NEW.section_id AND library_id = NEW.library_id);
END;
