CREATE TABLE data_source_page_layouts (
  data_source_id TEXT PRIMARY KEY REFERENCES data_sources(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;

ALTER TABLE database_views RENAME COLUMN default_layout TO layout;

DROP TRIGGER visibility_dirty_database_views_insert;
DROP TRIGGER visibility_dirty_database_views_update;
DROP TRIGGER visibility_dirty_database_views_delete;

CREATE TRIGGER visibility_dirty_database_views_insert
BEFORE INSERT ON database_views
WHEN 1
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_commit_visibility_context
    WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
  ) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
  INSERT INTO local_commit_visibility_dirty_facts(
    store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
  )
  SELECT store_epoch, commit_seq, 'database_views', 'insert', NULL,
    json_object('id', NEW.id, 'database_block_id', NEW.database_block_id, 'data_source_id', NEW.data_source_id, 'name', NEW.name, 'layout', NEW.layout, 'config_json', NEW.config_json, 'revision', NEW.revision, 'rank_key', NEW.rank_key, 'lifecycle', NEW.lifecycle, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at)
  FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;

CREATE TRIGGER visibility_dirty_database_views_update
BEFORE UPDATE OF id, database_block_id, data_source_id, lifecycle ON database_views
WHEN (1) AND (OLD.id IS NOT NEW.id OR OLD.database_block_id IS NOT NEW.database_block_id OR OLD.data_source_id IS NOT NEW.data_source_id OR OLD.lifecycle IS NOT NEW.lifecycle)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_commit_visibility_context
    WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
  ) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
  INSERT INTO local_commit_visibility_dirty_facts(
    store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
  )
  SELECT store_epoch, commit_seq, 'database_views', 'update',
    json_object('id', OLD.id, 'database_block_id', OLD.database_block_id, 'data_source_id', OLD.data_source_id, 'name', OLD.name, 'layout', OLD.layout, 'config_json', OLD.config_json, 'revision', OLD.revision, 'rank_key', OLD.rank_key, 'lifecycle', OLD.lifecycle, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at),
    json_object('id', NEW.id, 'database_block_id', NEW.database_block_id, 'data_source_id', NEW.data_source_id, 'name', NEW.name, 'layout', NEW.layout, 'config_json', NEW.config_json, 'revision', NEW.revision, 'rank_key', NEW.rank_key, 'lifecycle', NEW.lifecycle, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at)
  FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;

CREATE TRIGGER visibility_dirty_database_views_delete
BEFORE DELETE ON database_views
WHEN 1
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_commit_visibility_context
    WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
  ) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
  INSERT INTO local_commit_visibility_dirty_facts(
    store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
  )
  SELECT store_epoch, commit_seq, 'database_views', 'delete',
    json_object('id', OLD.id, 'database_block_id', OLD.database_block_id, 'data_source_id', OLD.data_source_id, 'name', OLD.name, 'layout', OLD.layout, 'config_json', OLD.config_json, 'revision', OLD.revision, 'rank_key', OLD.rank_key, 'lifecycle', OLD.lifecycle, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at), NULL
  FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;

CREATE TABLE data_source_page_layout_entries (
  data_source_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  rank_key TEXT NOT NULL,
  visibility TEXT NOT NULL
    CHECK (visibility IN ('always_show', 'hide_when_empty', 'always_hide')),
  PRIMARY KEY (data_source_id, property_id),
  FOREIGN KEY (data_source_id)
    REFERENCES data_source_page_layouts(data_source_id) ON DELETE CASCADE,
  FOREIGN KEY (data_source_id, property_id)
    REFERENCES data_source_properties(data_source_id, id)
    ON UPDATE CASCADE ON DELETE NO ACTION,
  CHECK (length(rank_key) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;

INSERT INTO data_source_page_layouts(
  data_source_id, revision, created_at, updated_at
)
SELECT id, 1, created_at, updated_at
FROM data_sources;

INSERT INTO data_source_page_layout_entries(
  data_source_id, property_id, rank_key, visibility
)
SELECT data_source_id, id, rank_key, 'always_show'
FROM data_source_properties;
