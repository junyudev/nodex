-- Candidate complete-order storage, exercised independently before runtime cutover.
ALTER TABLE database_view_page_positions RENAME TO database_view_order_import_positions;

CREATE TABLE database_view_order_state (
  view_id TEXT PRIMARY KEY REFERENCES database_views(id) ON DELETE CASCADE,
  active_generation INTEGER,
  pending_generation INTEGER,
  generation_clock INTEGER NOT NULL DEFAULT 1 CHECK (generation_clock >= 1),
  import_enabled INTEGER NOT NULL DEFAULT 1 CHECK (import_enabled IN (0, 1)),
  order_revision INTEGER NOT NULL DEFAULT 0 CHECK (order_revision >= 0),
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  default_epoch INTEGER NOT NULL DEFAULT 1 CHECK (default_epoch >= 1),
  semantic_reset_epoch INTEGER NOT NULL DEFAULT 1 CHECK (semantic_reset_epoch >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('explicit', 'implicit', 'rebalance', 'ready', 'retired')),
  cursor_rank TEXT NOT NULL DEFAULT '',
  cursor_page_id TEXT NOT NULL DEFAULT '',
  next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
  CHECK (active_generation IS NULL OR active_generation >= 1),
  CHECK (pending_generation IS NULL OR pending_generation >= 1),
  CHECK (pending_generation IS NULL OR pending_generation = generation_clock),
  CHECK (active_generation IS NULL OR active_generation <= generation_clock),
  CHECK ((phase IN ('ready', 'retired')) = (pending_generation IS NULL)),
  CHECK (phase <> 'ready' OR active_generation IS NOT NULL),
  CHECK (phase <> 'retired' OR (active_generation IS NULL AND import_enabled = 0))
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_database_view_order_preparation
  ON database_view_order_state(view_id) WHERE pending_generation IS NOT NULL;

CREATE TABLE database_view_order_retired_generations (
  view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
  -- Generation zero denotes the one-time sparse import source.
  generation INTEGER NOT NULL CHECK (generation >= 0),
  PRIMARY KEY (view_id, generation)
) WITHOUT ROWID, STRICT;

CREATE TABLE database_view_order_rows (
  view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  page_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  rank_key TEXT NOT NULL CHECK (length(rank_key) = 32 AND rank_key NOT GLOB '*[^0-9a-f]*'),
  default_epoch INTEGER CHECK (default_epoch IS NULL OR default_epoch >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  is_task_root INTEGER NOT NULL CHECK (is_task_root IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (view_id, generation, page_block_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_database_view_order_all
  ON database_view_order_rows(view_id, generation, rank_key, page_block_id);
CREATE INDEX idx_database_view_order_active
  ON database_view_order_rows(view_id, generation, rank_key, page_block_id)
  WHERE is_active = 1;
CREATE INDEX idx_database_view_order_roots
  ON database_view_order_rows(view_id, generation, rank_key, page_block_id)
  WHERE is_active = 1 AND is_task_root = 1;
CREATE INDEX idx_database_view_order_defaults
  ON database_view_order_rows(view_id, generation, default_epoch, page_block_id);
CREATE INDEX idx_database_view_order_page
  ON database_view_order_rows(page_block_id, view_id, generation);

-- Activity is derived from canonical placement, independently of whether a
-- View itself is currently presented. Retired generations are immutable.
CREATE VIEW database_view_order_member_activity AS
  SELECT view.id AS view_id, page.block_id AS page_block_id,
    block.lifecycle = 'active' AS is_active,
    NOT EXISTS(SELECT 1 FROM data_source_relation_edges edge
      WHERE edge.source_data_source_id = membership.data_source_id
        AND edge.source_membership_id = membership.id AND edge.property_id = 'task_parent') AS is_task_root
  FROM database_views view
  JOIN data_source_page_memberships membership
    ON membership.data_source_id = view.data_source_id AND membership.removed_at IS NULL
  JOIN pages page ON page.block_id = membership.page_block_id
    AND page.parent_kind = 'data_source' AND page.parent_id = view.data_source_id
  JOIN blocks block ON block.id = page.block_id;

CREATE TRIGGER database_view_order_block_activity
AFTER UPDATE OF lifecycle ON blocks
WHEN (OLD.lifecycle = 'active') <> (NEW.lifecycle = 'active')
BEGIN
  UPDATE database_view_order_rows
  SET is_active = coalesce((SELECT is_active FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = NEW.id), 0)
  WHERE page_block_id = NEW.id AND generation IN (
    SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
  );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id IN (
    SELECT parent_id FROM pages WHERE block_id = NEW.id AND parent_kind = 'data_source'
  ));
END;

CREATE TRIGGER database_view_order_page_parent
AFTER UPDATE OF parent_kind, parent_id ON pages
WHEN OLD.parent_kind IS NOT NEW.parent_kind OR OLD.parent_id IS NOT NEW.parent_id
BEGIN
  UPDATE database_view_order_rows
  SET is_active = coalesce((SELECT is_active FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = NEW.block_id), 0),
    is_task_root = coalesce((SELECT is_task_root FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = NEW.block_id), 1)
  WHERE page_block_id = NEW.block_id AND generation IN (
    SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
  );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id IN (
    SELECT OLD.parent_id WHERE OLD.parent_kind = 'data_source'
    UNION ALL SELECT NEW.parent_id WHERE NEW.parent_kind = 'data_source'
  ));
END;

CREATE TRIGGER database_view_order_membership_activity
AFTER UPDATE OF data_source_id, page_block_id, removed_at ON data_source_page_memberships
WHEN OLD.data_source_id IS NOT NEW.data_source_id OR OLD.page_block_id IS NOT NEW.page_block_id
  OR OLD.removed_at IS NOT NEW.removed_at
BEGIN
  UPDATE database_view_order_rows
  SET is_active = coalesce((SELECT is_active FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id
      AND activity.page_block_id = database_view_order_rows.page_block_id), 0),
    is_task_root = coalesce((SELECT is_task_root FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id
      AND activity.page_block_id = database_view_order_rows.page_block_id), 1)
  WHERE page_block_id IN (OLD.page_block_id, NEW.page_block_id) AND generation IN (
    SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
  );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id IN (OLD.data_source_id, NEW.data_source_id));
END;

CREATE TRIGGER database_view_order_membership_join
AFTER INSERT ON data_source_page_memberships
BEGIN
  UPDATE database_view_order_rows
  SET is_active = coalesce((SELECT is_active FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = NEW.page_block_id), 0),
    is_task_root = coalesce((SELECT is_task_root FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = NEW.page_block_id), 1)
  WHERE page_block_id = NEW.page_block_id AND generation IN (
    SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
  );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id = NEW.data_source_id);
END;

CREATE TRIGGER database_view_order_membership_leave
AFTER DELETE ON data_source_page_memberships
BEGIN
  UPDATE database_view_order_rows
  SET is_active = coalesce((SELECT is_active FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = OLD.page_block_id), 0),
    is_task_root = coalesce((SELECT is_task_root FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id AND activity.page_block_id = OLD.page_block_id), 1)
  WHERE page_block_id = OLD.page_block_id AND generation IN (
    SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
  );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id = OLD.data_source_id);
END;

-- Canonical task-root eligibility follows the Relation edge, not whether its
-- parent is currently visible. Edge identity is immutable in the owning schema.
CREATE TRIGGER database_view_order_task_parent_insert
AFTER INSERT ON data_source_relation_edges
WHEN NEW.property_id = 'task_parent'
BEGIN
  UPDATE database_view_order_rows SET is_task_root = 0
  WHERE page_block_id IN (SELECT page_block_id FROM data_source_page_memberships
    WHERE data_source_id = NEW.source_data_source_id AND id = NEW.source_membership_id AND removed_at IS NULL)
    AND view_id IN (SELECT id FROM database_views WHERE data_source_id = NEW.source_data_source_id)
    AND generation IN (
      SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
      UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id = NEW.source_data_source_id);
END;

CREATE TRIGGER database_view_order_task_parent_delete
AFTER DELETE ON data_source_relation_edges
WHEN OLD.property_id = 'task_parent'
BEGIN
  UPDATE database_view_order_rows
  SET is_task_root = coalesce((SELECT is_task_root FROM database_view_order_member_activity activity
    WHERE activity.view_id = database_view_order_rows.view_id
      AND activity.page_block_id = database_view_order_rows.page_block_id), 1)
  WHERE page_block_id IN (SELECT page_block_id FROM data_source_page_memberships
    WHERE data_source_id = OLD.source_data_source_id AND id = OLD.source_membership_id)
    AND view_id IN (SELECT id FROM database_views WHERE data_source_id = OLD.source_data_source_id)
    AND generation IN (
      SELECT active_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
      UNION ALL SELECT pending_generation FROM database_view_order_state WHERE view_id = database_view_order_rows.view_id
    );
  UPDATE database_view_order_state SET order_revision = order_revision + 1
  WHERE view_id IN (SELECT id FROM database_views WHERE data_source_id = OLD.source_data_source_id);
END;

-- This is the nullable position projection, not another order authority.
-- Import rows are visible only until their View publishes its first generation.
CREATE VIEW database_view_page_positions AS
  SELECT position.view_id, position.page_block_id, position.rank_key,
    CASE WHEN position.revision = 0 THEN 1 ELSE position.revision END AS revision,
    position.created_at, position.updated_at
  FROM database_view_order_state state
  JOIN database_view_order_rows position
    ON position.view_id = state.view_id AND position.generation = state.active_generation
  WHERE position.default_epoch IS NULL OR position.default_epoch <> state.default_epoch
  UNION ALL
  SELECT position.view_id, position.page_block_id, position.rank_key,
    position.revision, position.created_at, position.updated_at
  FROM database_view_order_import_positions position
  LEFT JOIN database_view_order_state state ON state.view_id = position.view_id
  WHERE state.active_generation IS NULL AND (state.view_id IS NULL OR state.import_enabled = 1);

-- Existing Views retain their sparse import until a complete generation is
-- published. This migration visits View metadata, never the membership rows.
INSERT INTO database_view_order_state(view_id, pending_generation, phase)
  SELECT id, 1, 'explicit' FROM database_views;

CREATE TRIGGER database_view_order_new_view
AFTER INSERT ON database_views
BEGIN
  INSERT INTO database_view_order_state(view_id, active_generation, pending_generation, import_enabled, phase)
  SELECT NEW.id, CASE WHEN has_members THEN NULL ELSE 1 END,
    CASE WHEN has_members THEN 1 ELSE NULL END, 0,
    CASE WHEN has_members THEN 'implicit' ELSE 'ready' END
  FROM (SELECT EXISTS(SELECT 1 FROM data_source_page_memberships
    WHERE data_source_id = NEW.data_source_id AND removed_at IS NULL) AS has_members);
END;
