-- Session search usage is product state; passive observations never write it.
CREATE TABLE project_session_usage (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  score REAL NOT NULL CHECK (score > 0 AND score < 1.0e100)
) WITHOUT ROWID, STRICT;
CREATE TABLE session_search_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
INSERT INTO session_search_revision(id, revision) VALUES (1, 0);
CREATE TRIGGER session_search_project_sessions_insert
AFTER INSERT ON project_sessions
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_sessions_delete
AFTER DELETE ON project_sessions
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_usage_insert
AFTER INSERT ON project_session_usage
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_usage_delete
AFTER DELETE ON project_session_usage
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_threads_insert
AFTER INSERT ON project_session_threads
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_threads_delete
AFTER DELETE ON project_session_threads
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_execution_bindings_insert
AFTER INSERT ON project_session_execution_bindings
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_execution_bindings_delete
AFTER DELETE ON project_session_execution_bindings
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_sessions_update
AFTER UPDATE OF project_id, no_thread_fallback_title, archived, created_at ON project_sessions
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.no_thread_fallback_title IS NOT NEW.no_thread_fallback_title OR OLD.archived IS NOT NEW.archived OR OLD.created_at IS NOT NEW.created_at
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_usage_update
AFTER UPDATE OF opened_at, score ON project_session_usage
WHEN OLD.opened_at IS NOT NEW.opened_at OR OLD.score IS NOT NEW.score
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_threads_update
AFTER UPDATE OF thread_id ON project_session_threads
WHEN OLD.thread_id IS NOT NEW.thread_id
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_project_session_execution_bindings_update
AFTER UPDATE OF runtime_id, runtime_thread_id ON project_session_execution_bindings
WHEN OLD.runtime_id IS NOT NEW.runtime_id OR OLD.runtime_thread_id IS NOT NEW.runtime_thread_id
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_projects_update
AFTER UPDATE OF name, lifecycle, library_id ON projects
WHEN OLD.name IS NOT NEW.name OR OLD.lifecycle IS NOT NEW.lifecycle OR OLD.library_id IS NOT NEW.library_id
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER session_search_codex_threads_update
AFTER UPDATE OF thread_name, parent_thread_id, archived, created_at, recency_at, agent_backend_kind, agent_backend_definition_id, agent_backend_instance_config_id, execution_host_id ON codex_threads
WHEN (OLD.thread_name IS NOT NEW.thread_name OR OLD.parent_thread_id IS NOT NEW.parent_thread_id OR OLD.archived IS NOT NEW.archived OR OLD.created_at IS NOT NEW.created_at OR OLD.recency_at IS NOT NEW.recency_at OR OLD.agent_backend_kind IS NOT NEW.agent_backend_kind OR OLD.agent_backend_definition_id IS NOT NEW.agent_backend_definition_id OR OLD.agent_backend_instance_config_id IS NOT NEW.agent_backend_instance_config_id OR OLD.execution_host_id IS NOT NEW.execution_host_id) AND EXISTS (SELECT 1 FROM project_session_threads WHERE thread_id = NEW.thread_id)
BEGIN UPDATE session_search_revision SET revision = revision + 1 WHERE id = 1; END;
