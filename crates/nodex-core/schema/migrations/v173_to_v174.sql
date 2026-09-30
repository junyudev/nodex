ALTER TABLE thread_backend_sessions ADD COLUMN native_home TEXT
  CHECK (native_home IS NULL OR (backend_kind = 'claude' AND length(native_home) BETWEEN 1 AND 16384 AND native_home = trim(native_home)));
CREATE UNIQUE INDEX thread_backend_sessions_native_identity
  ON thread_backend_sessions(backend_kind, native_home, backend_session_id)
  WHERE native_home IS NOT NULL;
