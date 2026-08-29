CREATE TABLE workspace_sidebar_sections (
  section_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pinned', 'pages', 'projects', 'chats', 'custom')),
  name TEXT,
  rank_key INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (section_id, kind),
  UNIQUE (library_id, rank_key),
  CHECK (
    (kind = 'custom' AND name IS NOT NULL AND length(trim(name)) BETWEEN 1 AND 120)
    OR (kind <> 'custom' AND name IS NULL)
  ),
  CHECK (
    (lifecycle = 'active' AND deleted_at IS NULL)
    OR (lifecycle = 'deleted' AND kind = 'custom' AND deleted_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE UNIQUE INDEX idx_workspace_sidebar_sections_builtin
  ON workspace_sidebar_sections(library_id, kind)
  WHERE kind <> 'custom';
CREATE INDEX idx_workspace_sidebar_sections_order
  ON workspace_sidebar_sections(library_id, lifecycle, rank_key, section_id);

CREATE TABLE workspace_sidebar_section_items (
  placement_id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL,
  section_kind TEXT NOT NULL DEFAULT 'custom' CHECK (section_kind = 'custom'),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES project_sessions(id) ON DELETE CASCADE,
  rank_key INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (section_id, section_kind)
    REFERENCES workspace_sidebar_sections(section_id, kind) ON DELETE CASCADE,
  UNIQUE (project_id),
  UNIQUE (session_id),
  UNIQUE (section_id, rank_key),
  CHECK ((project_id IS NOT NULL) <> (session_id IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_workspace_sidebar_section_items_project
  ON workspace_sidebar_section_items(project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_section_items_session
  ON workspace_sidebar_section_items(session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_section_items_order
  ON workspace_sidebar_section_items(section_id, rank_key, placement_id);

CREATE TABLE workspace_sidebar_section_host_links (
  section_id TEXT NOT NULL REFERENCES workspace_sidebar_sections(section_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  remote_section_id TEXT,
  sync_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (sync_state IN ('pending', 'ready', 'delete_pending', 'conflict', 'unsupported')),
  observed_generation INTEGER NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (section_id, host_id),
  UNIQUE (host_id, remote_section_id),
  CHECK (length(trim(host_id)) BETWEEN 1 AND 512),
  CHECK (remote_section_id IS NULL OR length(trim(remote_section_id)) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_workspace_sidebar_section_host_links_sync
  ON workspace_sidebar_section_host_links(host_id, sync_state, section_id);

-- Host links double as the durable projection outbox. Logical mutations never wait for a host;
-- they only mark the affected projections stale for the scoped Effect worker to reconcile.
CREATE TRIGGER workspace_sidebar_section_item_insert_pending
AFTER INSERT ON workspace_sidebar_section_items
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = 'pending', last_error = NULL
  WHERE section_id = NEW.section_id;
END;

CREATE TRIGGER workspace_sidebar_section_item_update_pending
AFTER UPDATE OF section_id, rank_key ON workspace_sidebar_section_items
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = 'pending', last_error = NULL
  WHERE section_id IN (OLD.section_id, NEW.section_id);
END;

CREATE TRIGGER workspace_sidebar_section_item_delete_pending
AFTER DELETE ON workspace_sidebar_section_items
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = 'pending', last_error = NULL
  WHERE section_id = OLD.section_id;
END;

CREATE TRIGGER workspace_sidebar_section_definition_pending
AFTER UPDATE OF name, lifecycle ON workspace_sidebar_sections
WHEN NEW.kind = 'custom'
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = CASE WHEN NEW.lifecycle = 'deleted' THEN 'delete_pending' ELSE 'pending' END,
      last_error = NULL
  WHERE section_id = NEW.section_id;
END;

CREATE TRIGGER workspace_sidebar_sections_seed_library
AFTER INSERT ON libraries
BEGIN
  INSERT INTO workspace_sidebar_sections(
    section_id, library_id, kind, name, rank_key, revision, lifecycle,
    deleted_at, created_at, updated_at
  ) VALUES
    ('sidebar:pinned', NEW.id, 'pinned', NULL, 0, 1, 'active', NULL, NEW.created_at, NEW.created_at),
    ('sidebar:pages', NEW.id, 'pages', NULL, 1000000000000, 1, 'active', NULL, NEW.created_at, NEW.created_at),
    ('sidebar:projects', NEW.id, 'projects', NULL, 3000000000000, 1, 'active', NULL, NEW.created_at, NEW.created_at),
    ('sidebar:chats', NEW.id, 'chats', NULL, 4000000000000, 1, 'active', NULL, NEW.created_at, NEW.created_at);
END;

INSERT INTO workspace_sidebar_sections(
  section_id, library_id, kind, name, rank_key, revision, lifecycle,
  deleted_at, created_at, updated_at
)
SELECT 'sidebar:pinned', id, 'pinned', NULL, 0, 1, 'active', NULL, created_at, created_at
FROM libraries
UNION ALL
SELECT 'sidebar:pages', id, 'pages', NULL, 1000000000000, 1, 'active', NULL, created_at, created_at
FROM libraries
UNION ALL
SELECT 'sidebar:projects', id, 'projects', NULL, 3000000000000, 1, 'active', NULL, created_at, created_at
FROM libraries
UNION ALL
SELECT 'sidebar:chats', id, 'chats', NULL, 4000000000000, 1, 'active', NULL, created_at, created_at
FROM libraries;

PRAGMA user_version = 142;
