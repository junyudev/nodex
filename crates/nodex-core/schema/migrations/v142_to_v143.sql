DROP TRIGGER workspace_sidebar_sections_seed_library;

CREATE TABLE workspace_sidebar_sections_v143 (
  section_id TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pinned', 'pages', 'projects', 'chats', 'custom')),
  name TEXT,
  rank_key INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, section_id),
  UNIQUE (library_id, section_id, kind),
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

CREATE TABLE workspace_sidebar_section_items_v143 (
  placement_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  section_kind TEXT NOT NULL DEFAULT 'custom' CHECK (section_kind = 'custom'),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES project_sessions(id) ON DELETE CASCADE,
  rank_key INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (library_id, section_id, section_kind)
    REFERENCES workspace_sidebar_sections_v143(library_id, section_id, kind) ON DELETE CASCADE,
  UNIQUE (project_id),
  UNIQUE (session_id),
  UNIQUE (library_id, section_id, rank_key),
  CHECK ((project_id IS NOT NULL) <> (session_id IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE TABLE workspace_sidebar_section_host_links_v143 (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  remote_section_id TEXT,
  sync_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (sync_state IN ('pending', 'ready', 'delete_pending', 'conflict', 'unsupported')),
  observed_generation INTEGER NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, section_id, host_id),
  UNIQUE (library_id, host_id, remote_section_id),
  FOREIGN KEY (library_id, section_id)
    REFERENCES workspace_sidebar_sections_v143(library_id, section_id) ON DELETE CASCADE,
  CHECK (length(trim(host_id)) BETWEEN 1 AND 512),
  CHECK (remote_section_id IS NULL OR length(trim(remote_section_id)) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;

INSERT INTO workspace_sidebar_sections_v143(
  section_id, library_id, kind, name, rank_key, revision, lifecycle,
  deleted_at, created_at, updated_at
)
SELECT section_id, library_id, kind, name, rank_key, revision, lifecycle,
       deleted_at, created_at, updated_at
FROM workspace_sidebar_sections;

INSERT INTO workspace_sidebar_section_items_v143(
  placement_id, library_id, section_id, section_kind, project_id, session_id,
  rank_key, revision, created_at, updated_at
)
SELECT item.placement_id, section.library_id, item.section_id, item.section_kind,
       item.project_id, item.session_id, item.rank_key, item.revision,
       item.created_at, item.updated_at
FROM workspace_sidebar_section_items item
JOIN workspace_sidebar_sections section
  ON section.section_id = item.section_id AND section.kind = item.section_kind;

INSERT INTO workspace_sidebar_section_host_links_v143(
  library_id, section_id, host_id, remote_section_id, sync_state,
  observed_generation, last_error, updated_at
)
SELECT section.library_id, link.section_id, link.host_id, link.remote_section_id,
       link.sync_state, link.observed_generation, link.last_error, link.updated_at
FROM workspace_sidebar_section_host_links link
JOIN workspace_sidebar_sections section ON section.section_id = link.section_id;

DROP TABLE workspace_sidebar_section_items;
DROP TABLE workspace_sidebar_section_host_links;
DROP TABLE workspace_sidebar_sections;

ALTER TABLE workspace_sidebar_sections_v143 RENAME TO workspace_sidebar_sections;
ALTER TABLE workspace_sidebar_section_items_v143 RENAME TO workspace_sidebar_section_items;
ALTER TABLE workspace_sidebar_section_host_links_v143
  RENAME TO workspace_sidebar_section_host_links;

CREATE UNIQUE INDEX idx_workspace_sidebar_sections_builtin
  ON workspace_sidebar_sections(library_id, kind)
  WHERE kind <> 'custom';
CREATE INDEX idx_workspace_sidebar_sections_order
  ON workspace_sidebar_sections(library_id, lifecycle, rank_key, section_id);
CREATE INDEX idx_workspace_sidebar_section_items_project
  ON workspace_sidebar_section_items(project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_section_items_session
  ON workspace_sidebar_section_items(session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_section_items_order
  ON workspace_sidebar_section_items(library_id, section_id, rank_key, placement_id);
CREATE INDEX idx_workspace_sidebar_section_host_links_sync
  ON workspace_sidebar_section_host_links(library_id, host_id, sync_state, section_id);

CREATE TRIGGER workspace_sidebar_section_item_insert_pending
AFTER INSERT ON workspace_sidebar_section_items
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = 'pending', last_error = NULL
  WHERE library_id = NEW.library_id AND section_id = NEW.section_id;
END;

CREATE TRIGGER workspace_sidebar_section_item_update_pending
AFTER UPDATE OF library_id, section_id, rank_key ON workspace_sidebar_section_items
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = 'pending', last_error = NULL
  WHERE (library_id = OLD.library_id AND section_id = OLD.section_id)
     OR (library_id = NEW.library_id AND section_id = NEW.section_id);
END;

CREATE TRIGGER workspace_sidebar_section_item_delete_pending
AFTER DELETE ON workspace_sidebar_section_items
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = 'pending', last_error = NULL
  WHERE library_id = OLD.library_id AND section_id = OLD.section_id;
END;

CREATE TRIGGER workspace_sidebar_section_definition_pending
AFTER UPDATE OF name, lifecycle ON workspace_sidebar_sections
WHEN NEW.kind = 'custom'
BEGIN
  UPDATE workspace_sidebar_section_host_links
  SET sync_state = CASE WHEN NEW.lifecycle = 'deleted' THEN 'delete_pending' ELSE 'pending' END,
      last_error = NULL
  WHERE library_id = NEW.library_id AND section_id = NEW.section_id;
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

PRAGMA user_version = 143;
