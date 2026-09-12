CREATE TABLE codex_identity_unread_threads (
  identity_key TEXT NOT NULL,
  execution_host_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  unread_position INTEGER NOT NULL,
  PRIMARY KEY(identity_key, execution_host_key, thread_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX codex_identity_unread_order ON codex_identity_unread_threads(identity_key, execution_host_key, unread_position);
