CREATE TABLE project_session_chat_folders (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  execution_host_id TEXT NOT NULL,
  path TEXT NOT NULL,
  output_directory TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'chosen'))
) WITHOUT ROWID;
