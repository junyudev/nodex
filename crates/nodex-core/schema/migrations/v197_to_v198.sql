ALTER TABLE project_sessions ADD COLUMN remind_at TEXT;
CREATE INDEX idx_project_sessions_reminder ON project_sessions(remind_at,id) WHERE remind_at IS NOT NULL AND archived = 0;
CREATE TABLE project_session_reminder_deliveries (
  delivery_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES project_sessions(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_project_session_reminder_delivery_due ON project_session_reminder_deliveries(next_attempt_at,delivery_id);
CREATE TRIGGER project_session_archive_cancels_reminder AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived = 1
BEGIN
  UPDATE project_sessions SET remind_at = NULL WHERE id = NEW.id;
  DELETE FROM project_session_reminder_deliveries WHERE session_id = NEW.id;
END;
CREATE TABLE project_session_user_message_receipts (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
) WITHOUT ROWID, STRICT;
