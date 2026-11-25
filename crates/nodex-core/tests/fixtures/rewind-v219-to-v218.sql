CREATE TEMP TABLE saved_page_pull_requests AS SELECT * FROM page_pull_requests;
DROP TABLE page_pull_requests;
CREATE TABLE page_pull_requests (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES page_workspaces(workspace_id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','MERGED')),
  observed_at TEXT NOT NULL
) STRICT;
INSERT INTO page_pull_requests SELECT * FROM saved_page_pull_requests;
DROP TABLE saved_page_pull_requests;
CREATE TRIGGER turn_page_pull_requests_insert AFTER INSERT ON page_pull_requests
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_pull_requests_update AFTER UPDATE ON page_pull_requests
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_pull_requests_delete AFTER DELETE ON page_pull_requests
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
PRAGMA user_version=218;
