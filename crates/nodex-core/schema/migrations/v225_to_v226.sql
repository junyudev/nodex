ALTER TABLE page_active_chats ADD COLUMN borrowed_scope_id TEXT;
ALTER TABLE page_active_chats ADD COLUMN borrowed_scope_kind TEXT CHECK ((borrowed_scope_kind IS NULL) = (borrowed_scope_id IS NULL) AND borrowed_scope_kind IN ('delivery','run'));
ALTER TABLE page_turn_replies ADD COLUMN previous_scope_id TEXT;
ALTER TABLE page_turn_replies ADD COLUMN previous_scope_kind TEXT CHECK ((previous_scope_kind IS NULL) = (previous_scope_id IS NULL) AND previous_scope_kind IN ('delivery','run'));
CREATE TABLE session_scoped_observations (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('delivery','run')),
  scope_id TEXT NOT NULL,
  observed_json TEXT NOT NULL CHECK(json_valid(observed_json)),
  PRIMARY KEY(session_id,scope_kind,scope_id)
) WITHOUT ROWID, STRICT;
CREATE VIEW page_active_chat_execution AS
SELECT active.page_id, active.session_id, active.borrowed_scope_kind, active.borrowed_scope_id,
       CASE WHEN active.borrowed_scope_id IS NULL THEN chat.observed_json ELSE scoped.observed_json END AS observed_json
FROM page_active_chats active
LEFT JOIN session_execution_observations chat ON chat.session_id=active.session_id
LEFT JOIN session_scoped_observations scoped
  ON scoped.session_id=active.session_id AND scoped.scope_kind=active.borrowed_scope_kind
  AND scoped.scope_id=active.borrowed_scope_id;
DROP TRIGGER turn_session_execution_observations_insert;
DROP TRIGGER turn_session_execution_observations_update;
DROP TRIGGER turn_session_execution_observations_delete;
CREATE TRIGGER turn_session_execution_observations_insert AFTER INSERT ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id AND borrowed_scope_id IS NULL ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_update AFTER UPDATE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id AND borrowed_scope_id IS NULL ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_delete AFTER DELETE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=OLD.session_id AND borrowed_scope_id IS NULL ON CONFLICT DO NOTHING;
END;
