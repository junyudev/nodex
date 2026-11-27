DROP TRIGGER turn_session_execution_observations_insert;
DROP TRIGGER turn_session_execution_observations_update;
DROP TRIGGER turn_session_execution_observations_delete;
DROP VIEW page_active_chat_execution;
DROP TABLE session_scoped_observations;
ALTER TABLE page_turn_replies DROP COLUMN previous_scope_kind;
ALTER TABLE page_turn_replies DROP COLUMN previous_scope_id;
ALTER TABLE page_active_chats DROP COLUMN borrowed_scope_kind;
ALTER TABLE page_active_chats DROP COLUMN borrowed_scope_id;
CREATE TRIGGER turn_session_execution_observations_insert AFTER INSERT ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_update AFTER UPDATE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_delete AFTER DELETE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=OLD.session_id ON CONFLICT DO NOTHING;
END;
