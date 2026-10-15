DROP TABLE nodex_agent_runtime_native_session_admissions;
DROP TABLE nodex_agent_runtime_turn_admissions;
DROP TRIGGER nodex_agent_turn_authorities_cannot_delete;
DELETE FROM nodex_agent_turn_authorities WHERE thread_id LIKE 'runtime:%';
CREATE TRIGGER nodex_agent_turn_authorities_cannot_delete
    BEFORE DELETE ON nodex_agent_turn_authorities
    BEGIN
      SELECT RAISE(ABORT, 'Nodex Agent Turn authorities are immutable');
    END;
