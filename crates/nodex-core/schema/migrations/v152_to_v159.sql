CREATE TABLE editor_history_owners (
  owner_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  peer_pid INTEGER NOT NULL CHECK (peer_pid > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
  CHECK (length(owner_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE editor_history_recipes (
  recipe_operation_id TEXT PRIMARY KEY
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES editor_history_owners(owner_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_editor_history_recipes_owner ON editor_history_recipes(owner_id);

CREATE TABLE editor_history_local_sets (
  owner_id TEXT NOT NULL REFERENCES editor_history_owners(owner_id) ON DELETE CASCADE,
  surface_id TEXT NOT NULL CHECK (length(surface_id) BETWEEN 1 AND 512),
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 512),
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  membership_hash TEXT NOT NULL,
  closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
  retain_document INTEGER NOT NULL CHECK (retain_document IN (0, 1)),
  PRIMARY KEY (owner_id, surface_id),
  CHECK (closed = 0 OR retain_document = 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE editor_history_local_roots (
  owner_id TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  block_id TEXT NOT NULL CHECK (length(block_id) BETWEEN 1 AND 512),
  PRIMARY KEY (owner_id, surface_id, block_id),
  FOREIGN KEY (owner_id, surface_id) REFERENCES editor_history_local_sets(owner_id, surface_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_editor_history_local_roots_identity ON editor_history_local_roots(block_id);

CREATE INDEX idx_editor_history_owners_peer ON editor_history_owners(peer_pid);
CREATE INDEX idx_editor_history_owners_active ON editor_history_owners(state) WHERE state = 'active';
CREATE INDEX idx_editor_history_local_sets_active ON editor_history_local_sets(owner_id) WHERE closed = 0;

CREATE TABLE editor_history_cleanup (
  owner_id TEXT PRIMARY KEY REFERENCES editor_history_owners(owner_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE structural_history_root_cleanup (
  recipe_operation_id TEXT PRIMARY KEY REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

ALTER TABLE structural_history_recipes RENAME COLUMN recipe_json TO payload_ref_json;

CREATE TABLE structural_history_payloads (
  recipe_operation_id TEXT NOT NULL
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part BETWEEN 0 AND 511),
  payload_chunk TEXT NOT NULL CHECK (octet_length(payload_chunk) BETWEEN 1 AND 262144),
  PRIMARY KEY (recipe_operation_id, part)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER structural_history_payloads_are_immutable
BEFORE UPDATE ON structural_history_payloads
BEGIN
  SELECT RAISE(ABORT, 'Structural history payloads are immutable');
END;

CREATE TABLE structural_history_payload_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_recipe_operation_id TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1))
) STRICT;
INSERT INTO structural_history_payload_backfill VALUES (1, '', 0);

CREATE TABLE structural_dormant_document_sources (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 512),
  page_id TEXT NOT NULL CHECK (length(page_id) BETWEEN 1 AND 512),
  placeholder_block_id TEXT NOT NULL CHECK (length(placeholder_block_id) BETWEEN 1 AND 512),
  check_after_ms INTEGER NOT NULL DEFAULT 0 CHECK (check_after_ms >= 0),
  PRIMARY KEY (library_id, document_id, page_id, placeholder_block_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_structural_dormant_sources_due
  ON structural_dormant_document_sources(check_after_ms, library_id, document_id, page_id, placeholder_block_id);

CREATE TABLE structural_history_payload_gc (
  recipe_operation_id TEXT PRIMARY KEY
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE CASCADE,
  terminal_at_ms INTEGER NOT NULL CHECK (terminal_at_ms >= 0),
  check_after_ms INTEGER NOT NULL DEFAULT 0 CHECK (check_after_ms >= 0)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_structural_history_payload_gc_due
  ON structural_history_payload_gc(check_after_ms, recipe_operation_id);
CREATE TRIGGER structural_history_payload_gc_on_terminal
AFTER UPDATE OF state ON structural_history_recipes
WHEN OLD.state = 'available' AND NEW.state <> 'available'
BEGIN
  INSERT OR IGNORE INTO structural_history_payload_gc(recipe_operation_id, terminal_at_ms)
    VALUES (NEW.recipe_operation_id, CAST(unixepoch(NEW.consumed_at, 'subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER structural_history_payloads_require_terminal_marker
BEFORE DELETE ON structural_history_payloads
WHEN EXISTS (SELECT 1 FROM structural_history_recipes
  WHERE recipe_operation_id = OLD.recipe_operation_id AND state = 'available')
BEGIN
  SELECT RAISE(ABORT, 'Available structural history requires its payload');
END;
DROP TRIGGER structural_history_recipes_transition_once;
CREATE TRIGGER structural_history_recipes_transition_once
BEFORE UPDATE ON structural_history_recipes
WHEN NOT (OLD.recipe_operation_id = NEW.recipe_operation_id
  AND OLD.library_id = NEW.library_id
  AND OLD.project_id = NEW.project_id
  AND OLD.store_epoch = NEW.store_epoch
  AND OLD.recipe_hash = NEW.recipe_hash
  AND OLD.created_at = NEW.created_at
  AND (
    (OLD.state = 'available'
      AND NEW.state IN ('consumed', 'superseded')
      AND NEW.consumed_at IS NOT NULL
      AND OLD.payload_ref_json = NEW.payload_ref_json)
    OR
    (OLD.state = NEW.state
      AND OLD.consumed_at IS NEW.consumed_at
      AND OLD.superseded_by_recipe_operation_id IS NEW.superseded_by_recipe_operation_id
      AND NEW.payload_ref_json = '{"kind":"detached"}'
      AND OLD.payload_ref_json <> NEW.payload_ref_json
      AND OLD.payload_ref_json IS (SELECT group_concat(payload_chunk, '') FROM (
        SELECT payload_chunk FROM structural_history_payloads
        WHERE recipe_operation_id = OLD.recipe_operation_id ORDER BY part)))
  ))
BEGIN
  SELECT RAISE(ABORT, 'Structural history recipe transition is invalid');
END;

CREATE TABLE block_mutation_body_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_mutation_id TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1))
) STRICT;
INSERT INTO block_mutation_body_backfill VALUES (1, '', 0);
CREATE TABLE block_mutation_body_gc (
  mutation_id TEXT PRIMARY KEY REFERENCES block_mutations(mutation_id) ON DELETE CASCADE,
  check_after_ms INTEGER NOT NULL DEFAULT 0 CHECK (check_after_ms >= 0)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_block_mutation_body_gc_due ON block_mutation_body_gc(check_after_ms, mutation_id);

DROP TRIGGER block_mutations_are_immutable;
CREATE TRIGGER block_mutations_are_immutable
BEFORE UPDATE ON block_mutations
WHEN NOT (
  OLD.mutation_kind IN ('structural_edit', 'block_transfer')
  AND NEW.request_json = '{}' AND NEW.result_json = '{}'
  AND OLD.mutation_id IS NEW.mutation_id
  AND OLD.project_id IS NEW.project_id
  AND OLD.store_epoch IS NEW.store_epoch
  AND OLD.mutation_kind IS NEW.mutation_kind
  AND OLD.actor_json IS NEW.actor_json
  AND OLD.client_session_id IS NEW.client_session_id
  AND OLD.request_hash IS NEW.request_hash
  AND OLD.target_block_ids_json IS NEW.target_block_ids_json
  AND OLD.affected_document_ids_json IS NEW.affected_document_ids_json
  AND OLD.affected_database_block_ids_json IS NEW.affected_database_block_ids_json
  AND OLD.field_intents_json IS NEW.field_intents_json
  AND OLD.expected_revisions_json IS NEW.expected_revisions_json
  AND OLD.outcome IS NEW.outcome
  AND OLD.committed_revisions_json IS NEW.committed_revisions_json
  AND OLD.document_heads_json IS NEW.document_heads_json
  AND OLD.change_log_seq IS NEW.change_log_seq
  AND OLD.recorded_at IS NEW.recorded_at
)
BEGIN
  SELECT RAISE(ABORT, 'Block mutation evidence is immutable');
END;

-- Complete manual order is prepared incrementally from the retained sparse import.
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
