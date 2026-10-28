CREATE TABLE project_session_side_chats (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL
) WITHOUT ROWID, STRICT;
