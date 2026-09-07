-- Preserve actor attribution while allowing Library operations without a Project.

-- Foreign keys are disabled by the owning schema-rebuild transaction.

CREATE TEMP TABLE migration165_change_log AS SELECT * FROM "change_log";

CREATE TEMP TABLE migration165_block_relocations AS SELECT * FROM "block_relocations";

CREATE TEMP TABLE migration165_block_relocation_source_states AS SELECT * FROM "block_relocation_source_states";

CREATE TEMP TABLE migration165_document_recovery_artifacts AS SELECT * FROM "document_recovery_artifacts";

CREATE TEMP TABLE migration165_document_versions AS SELECT * FROM "document_versions";

CREATE TEMP TABLE migration165_block_mutations AS SELECT * FROM "block_mutations";

CREATE TEMP TABLE migration165_local_commit_effects AS SELECT * FROM "local_commit_effects";

CREATE TEMP TABLE migration165_local_commit_documents AS SELECT * FROM "local_commit_documents";

CREATE TEMP TABLE migration165_prepared_blob_receipts AS SELECT * FROM "prepared_blob_receipts";

CREATE TEMP TABLE migration165_block_transfer_undo_recipes AS SELECT * FROM "block_transfer_undo_recipes";

CREATE TEMP TABLE migration165_structural_history_recipes AS SELECT * FROM "structural_history_recipes";

CREATE TEMP TABLE migration165_nodex_agent_turn_authorities AS SELECT * FROM "nodex_agent_turn_authorities";

CREATE TEMP TABLE migration165_library_files AS SELECT * FROM "library_files";

CREATE TEMP TABLE migration165_file_versions AS SELECT * FROM "file_versions";

DROP TABLE "file_versions";

DROP TABLE "library_files";

DROP TABLE "nodex_agent_turn_authorities";

DROP TABLE "structural_history_recipes";

DROP TABLE "block_transfer_undo_recipes";

DROP TABLE "prepared_blob_receipts";

DROP TABLE "local_commit_documents";

DROP TABLE "local_commit_effects";

DROP TABLE "block_mutations";

DROP TABLE "document_versions";

DROP TABLE "document_recovery_artifacts";

DROP TABLE "block_relocation_source_states";

DROP TABLE "block_relocations";

DROP TABLE "change_log";

CREATE TABLE change_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      store_epoch TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation_id TEXT,
      block_ids_json TEXT NOT NULL DEFAULT '[]',
      document_ids_json TEXT NOT NULL DEFAULT '[]',
      database_block_ids_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      committed_at TEXT NOT NULL, projection_impact_json TEXT,
      CHECK (length(store_epoch) BETWEEN 1 AND 512),
      CHECK (length(kind) BETWEEN 1 AND 128),
      CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 512),
      CHECK (json_valid(block_ids_json) AND json_type(block_ids_json) = 'array'),
      CHECK (json_valid(document_ids_json) AND json_type(document_ids_json) = 'array'),
      CHECK (
        json_valid(database_block_ids_json)
        AND json_type(database_block_ids_json) = 'array'
      ),
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      CHECK (length(committed_at) > 0)
    );

CREATE TABLE "block_relocations" (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  store_epoch TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
  source_base_head_seq INTEGER NOT NULL CHECK (source_base_head_seq >= 0),
  target_kind TEXT NOT NULL,
  target_document_id TEXT,
  target_generation INTEGER,
  target_base_head_seq INTEGER,
  target_parent_block_id TEXT,
  target_before_block_id TEXT,
  root_block_ids_json TEXT NOT NULL,
  expected_placement_revisions_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'committed',
  source_update_id TEXT NOT NULL,
  source_committed_seq INTEGER NOT NULL CHECK (source_committed_seq >= 1),
  target_update_id TEXT,
  target_committed_seq INTEGER,
  final_placement_revisions_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  change_log_seq INTEGER NOT NULL UNIQUE
    REFERENCES change_log(seq) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  committed_at TEXT NOT NULL,
  UNIQUE (id, project_id),
  UNIQUE (id, library_id),
  UNIQUE (
    id, source_document_id, project_id, source_generation, source_base_head_seq
  ),
  UNIQUE (
    id, source_document_id, library_id, source_generation, source_base_head_seq
  ),
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_document_id) REFERENCES documents(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_parent_block_id) REFERENCES blocks(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_before_block_id) REFERENCES blocks(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, source_generation, source_committed_seq)
    REFERENCES document_update_receipts(document_id, generation, seq) ON DELETE RESTRICT,
  FOREIGN KEY (target_document_id, target_generation, target_committed_seq)
    REFERENCES document_update_receipts(document_id, generation, seq) ON DELETE RESTRICT,
  CHECK (length(id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  CHECK (
    json_valid(root_block_ids_json)
    AND json_type(root_block_ids_json) = 'array'
    AND json_array_length(root_block_ids_json) > 0
  ),
  CHECK (
    json_valid(expected_placement_revisions_json)
    AND json_type(expected_placement_revisions_json) = 'object'
  ),
  CHECK (
    json_valid(final_placement_revisions_json)
    AND json_type(final_placement_revisions_json) = 'object'
  ),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (status = 'committed'),
  CHECK (target_kind IN ('document', 'library')),
  CHECK (
    (target_kind = 'document'
      AND target_document_id IS NOT NULL
      AND target_document_id <> source_document_id
      AND target_generation IS NOT NULL
      AND target_generation >= 1
      AND target_base_head_seq IS NOT NULL
      AND target_base_head_seq >= 0
      AND target_update_id IS NOT NULL
      AND target_committed_seq = target_base_head_seq + 1)
    OR (target_kind = 'library'
      AND target_document_id IS NULL
      AND target_generation IS NULL
      AND target_base_head_seq IS NULL
      AND target_parent_block_id IS NULL
      AND target_update_id IS NULL
      AND target_committed_seq IS NULL)
  ),
  CHECK (source_committed_seq = source_base_head_seq + 1),
  CHECK (source_update_id = 'relocation:' || request_hash || ':source'),
  CHECK (
    target_update_id IS NULL
    OR target_update_id = 'relocation:' || request_hash || ':target'
  ),
  CHECK (length(committed_at) > 0)
) STRICT;

CREATE TABLE block_relocation_source_states (
      relocation_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
      pre_state_vector BLOB NOT NULL,
      pre_full_update BLOB NOT NULL,
      pre_full_update_byte_length INTEGER NOT NULL
        CHECK (pre_full_update_byte_length > 0),
      pre_state_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      FOREIGN KEY (
        relocation_id, document_id, library_id, generation, head_seq
      ) REFERENCES block_relocations(
        id, source_document_id, library_id, source_generation,
        source_base_head_seq
      ) ON DELETE CASCADE,
      CHECK (length(pre_state_vector) > 0),
      CHECK (length(pre_full_update) = pre_full_update_byte_length),
      CHECK (
        length(pre_state_hash) = 64
        AND pre_state_hash NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (length(captured_at) > 0)
    ) WITHOUT ROWID;

CREATE TABLE document_recovery_artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      store_epoch TEXT NOT NULL,
      document_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      update_id TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      base_head_seq INTEGER NOT NULL CHECK (base_head_seq >= 0),
      touched_block_ids_json TEXT NOT NULL DEFAULT '[]',
      derived_touched_block_ids_json TEXT,
      update_blob BLOB NOT NULL,
      update_hash TEXT NOT NULL,
      update_byte_length INTEGER NOT NULL CHECK (update_byte_length > 0),
      reason TEXT NOT NULL,
      relocation_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE (document_id, generation, update_id),
      FOREIGN KEY (document_id)
        REFERENCES documents(id) ON DELETE RESTRICT,
      CHECK (length(id) BETWEEN 1 AND 512),
      CHECK (length(store_epoch) BETWEEN 1 AND 512),
      CHECK (length(update_id) BETWEEN 1 AND 512),
      CHECK (length(client_session_id) BETWEEN 1 AND 512),
      CHECK (
        json_valid(touched_block_ids_json)
        AND json_type(touched_block_ids_json) = 'array'
      ),
      CHECK (
        derived_touched_block_ids_json IS NULL
        OR (json_valid(derived_touched_block_ids_json)
          AND json_type(derived_touched_block_ids_json) = 'array')
      ),
      CHECK (
        json_valid(relocation_ids_json)
        AND json_type(relocation_ids_json) = 'array'
      ),
      CHECK (length(update_blob) = update_byte_length),
      CHECK (
        length(update_hash) = 64
        AND update_hash NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (reason IN ('block_relocated', 'unsafe_stale_update')),
      CHECK (status IN ('pending', 'resolved', 'discarded')),
      CHECK (length(created_at) > 0),
      CHECK (length(expires_at) > 0 AND expires_at > created_at),
      CHECK (
        (status = 'pending' AND resolved_at IS NULL)
        OR (status IN ('resolved', 'discarded') AND resolved_at IS NOT NULL)
      )
    ) WITHOUT ROWID;

CREATE TABLE document_versions (
      version_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      base_head_seq INTEGER NOT NULL CHECK (base_head_seq >= 0),
      schema_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      cause TEXT NOT NULL,
      label TEXT,
      actor_json TEXT NOT NULL DEFAULT '{}',
      revision_kind TEXT NOT NULL DEFAULT 'manual',
      source_mutation_id TEXT,
      source_change_seq INTEGER,
      pinned INTEGER NOT NULL DEFAULT 1,
      checkpoint_format TEXT NOT NULL DEFAULT 'yjs_update_v1',
      full_update_blob BLOB NOT NULL,
      state_vector BLOB NOT NULL,
      checkpoint_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id)
        REFERENCES documents(id) ON DELETE CASCADE,
      CHECK (length(version_id) BETWEEN 1 AND 512),
      CHECK (length(schema_key) BETWEEN 1 AND 128),
      CHECK (length(cause) BETWEEN 1 AND 128),
      CHECK (label IS NULL OR length(label) <= 512),
      CHECK (json_valid(actor_json) AND json_type(actor_json) = 'object'),
      CHECK (revision_kind IN ('automatic', 'manual', 'operation', 'restore', 'safety')),
      CHECK (source_mutation_id IS NULL OR length(trim(source_mutation_id)) BETWEEN 1 AND 512),
      CHECK (source_change_seq IS NULL OR source_change_seq >= 1),
      CHECK (pinned IN (0, 1)),
      CHECK (checkpoint_format IN ('yjs_update_v1', 'block_tree_snapshot_v2', 'block_tree_snapshot_v3', 'canvas_scene_json_v1', 'canvas_scene_json_v2')),
      CHECK (
        checkpoint_format NOT IN ('block_tree_snapshot_v2', 'block_tree_snapshot_v3', 'canvas_scene_json_v1', 'canvas_scene_json_v2')
        OR (
          length(state_vector) = 0
          AND json_valid(CAST(full_update_blob AS TEXT))
          AND json_type(CAST(full_update_blob AS TEXT)) = 'object'
        )
      ),
      CHECK (byte_length = length(full_update_blob)),
      CHECK (
        length(checkpoint_hash) = 64
        AND checkpoint_hash NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (length(created_at) > 0)
    ) WITHOUT ROWID;

CREATE TABLE block_mutations (
      mutation_id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      store_epoch TEXT NOT NULL,
      mutation_kind TEXT NOT NULL,
      actor_json TEXT NOT NULL DEFAULT '{}',
      client_session_id TEXT,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      target_block_ids_json TEXT NOT NULL DEFAULT '[]',
      affected_document_ids_json TEXT NOT NULL DEFAULT '[]',
      affected_database_block_ids_json TEXT NOT NULL DEFAULT '[]',
      field_intents_json TEXT NOT NULL DEFAULT '[]',
      expected_revisions_json TEXT NOT NULL DEFAULT '{}',
      outcome TEXT NOT NULL,
      result_json TEXT NOT NULL,
      committed_revisions_json TEXT NOT NULL DEFAULT '{}',
      document_heads_json TEXT NOT NULL DEFAULT '{}',
      change_log_seq INTEGER UNIQUE
        REFERENCES change_log(seq) ON DELETE RESTRICT,
      recorded_at TEXT NOT NULL,
      CHECK (length(mutation_id) BETWEEN 1 AND 512),
      CHECK (length(store_epoch) BETWEEN 1 AND 512),
      CHECK (length(mutation_kind) BETWEEN 1 AND 128),
      CHECK (client_session_id IS NULL OR length(client_session_id) BETWEEN 1 AND 512),
      CHECK (
        length(request_hash) = 64
        AND request_hash NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (json_valid(actor_json) AND json_type(actor_json) = 'object'),
      CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
      CHECK (
        json_valid(target_block_ids_json)
        AND json_type(target_block_ids_json) = 'array'
      ),
      CHECK (
        json_valid(affected_document_ids_json)
        AND json_type(affected_document_ids_json) = 'array'
      ),
      CHECK (
        json_valid(affected_database_block_ids_json)
        AND json_type(affected_database_block_ids_json) = 'array'
      ),
      CHECK (
        json_valid(field_intents_json)
        AND json_type(field_intents_json) = 'array'
      ),
      CHECK (
        json_valid(expected_revisions_json)
        AND json_type(expected_revisions_json) = 'object'
      ),
      CHECK (outcome IN ('committed', 'rejected')),
      CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
      CHECK (
        json_valid(committed_revisions_json)
        AND json_type(committed_revisions_json) = 'object'
      ),
      CHECK (
        json_valid(document_heads_json)
        AND json_type(document_heads_json) = 'object'
      ),
      CHECK (
        (outcome = 'committed' AND change_log_seq IS NOT NULL)
        OR (outcome = 'rejected' AND change_log_seq IS NULL)
      ),
      CHECK (length(recorded_at) > 0)
    ) WITHOUT ROWID;

CREATE TABLE "local_commit_effects" (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  effect_order INTEGER NOT NULL CHECK (effect_order >= 0),
  change_log_seq INTEGER NOT NULL REFERENCES change_log(seq) ON DELETE RESTRICT, module_name TEXT NOT NULL DEFAULT 'library'
  CHECK (module_name IN (
    'library', 'database', 'owned_document', 'project_workspace',
    'automation', 'store_administration'
  )), effect_kind TEXT NOT NULL DEFAULT 'historical', project_id TEXT, resources_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(resources_json) AND json_type(resources_json) = 'object'), payload_hash TEXT NOT NULL
  DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
  CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'), projection_impact_json TEXT NOT NULL DEFAULT '{}'
  CHECK (
    json_valid(projection_impact_json)
    AND json_type(projection_impact_json) = 'object'
  ),
  PRIMARY KEY (store_epoch, commit_seq, effect_order),
  UNIQUE (change_log_seq),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES "local_commits"(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(store_epoch) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;

CREATE TABLE "local_commit_documents" (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  -- This is an immutable historical reference. It must remain readable after
  -- the document itself has been deleted or compacted.
  document_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
  update_id TEXT,
  update_hash TEXT, document_order INTEGER NOT NULL DEFAULT 0
  CHECK (document_order >= 0), project_id TEXT, page_id TEXT, base_head_seq INTEGER NOT NULL DEFAULT 0
  CHECK (base_head_seq >= 0), update_byte_length INTEGER NOT NULL DEFAULT 0
  CHECK (update_byte_length >= 0),
  PRIMARY KEY (store_epoch, commit_seq, document_id, generation, head_seq),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES "local_commits"(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(document_id) BETWEEN 1 AND 512),
  CHECK (update_id IS NULL OR length(update_id) BETWEEN 1 AND 512),
  CHECK (update_hash IS NULL OR (length(update_hash) = 64 AND update_hash NOT GLOB '*[^0-9a-f]*'))
) WITHOUT ROWID, STRICT;

CREATE TABLE prepared_blob_receipts (
  receipt_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES managed_blobs(content_hash) ON DELETE RESTRICT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'consumed')),
  operation_id TEXT NOT NULL,
  expires_at_unix_ms INTEGER NOT NULL CHECK (expires_at_unix_ms >= 0),
  consumed_commit_seq INTEGER CHECK (consumed_commit_seq >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(receipt_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (
    (state = 'prepared' AND consumed_commit_seq IS NULL)
    OR (state = 'consumed' AND consumed_commit_seq IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TABLE block_transfer_undo_recipes (
  transfer_operation_id TEXT PRIMARY KEY
    REFERENCES block_mutations(mutation_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  recipe_hash TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(transfer_operation_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(recipe_hash) = 64 AND recipe_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(recipe_json) AND json_type(recipe_json) = 'object'),
  CHECK (consumed_at IS NULL OR length(consumed_at) > 0),
  CHECK (length(created_at) > 0)
) WITHOUT ROWID, STRICT;

CREATE TABLE structural_history_recipes (
  recipe_operation_id TEXT PRIMARY KEY
    REFERENCES block_mutations(mutation_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  recipe_hash TEXT NOT NULL,
  payload_ref_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available', 'consumed', 'superseded')),
  consumed_at TEXT,
  superseded_by_recipe_operation_id TEXT
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (length(recipe_operation_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(recipe_hash) = 64 AND recipe_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(payload_ref_json) BETWEEN 2 AND 67108864
    AND json_valid(payload_ref_json)
    AND json_type(payload_ref_json) = 'object'),
  CHECK ((state = 'available' AND consumed_at IS NULL AND superseded_by_recipe_operation_id IS NULL)
    OR (state = 'consumed' AND length(consumed_at) > 0 AND superseded_by_recipe_operation_id IS NULL)
    OR (state = 'superseded' AND length(consumed_at) > 0 AND superseded_by_recipe_operation_id IS NOT NULL)),
  CHECK (length(created_at) > 0)
) WITHOUT ROWID, STRICT;

CREATE TABLE nodex_agent_turn_authorities (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      root_thread_id TEXT NOT NULL,
      actor_project_id TEXT,
      library_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      permission_profile_id TEXT,
      authority_fingerprint TEXT NOT NULL,
      provenance_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      read_only INTEGER NOT NULL DEFAULT 1 CHECK (read_only IN (0, 1)),
      PRIMARY KEY (thread_id, turn_id),
      CHECK (length(trim(thread_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(turn_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(root_thread_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(actor_project_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(library_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(profile_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(store_epoch)) BETWEEN 1 AND 512),
      CHECK (scope IN ('project', 'library')),
      CHECK (actor_project_id IS NOT NULL OR scope = 'library'),
      CHECK ((scope = 'project' AND source = 'project_turn') OR
        (scope = 'library' AND source IN ('builtin_full_access', 'inherited_builtin_full_access'))),
      CHECK (source IN (
        'project_turn',
        'builtin_full_access',
        'inherited_builtin_full_access'
      )),
      CHECK (
        (scope = 'library' AND permission_profile_id = ':danger-full-access')
        OR (scope = 'project' AND permission_profile_id IS NULL)
      ),
      CHECK (length(authority_fingerprint) = 64),
      CHECK (provenance_version = 1)
    ) WITHOUT ROWID;

CREATE TABLE library_files (
  file_id TEXT PRIMARY KEY CHECK (length(file_id) BETWEEN 1 AND 512),
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  default_name TEXT NOT NULL CHECK (length(default_name) BETWEEN 1 AND 255),
  head_version INTEGER NOT NULL CHECK (head_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('live', 'trashed')),
  created_by_actor_id TEXT CHECK (length(created_by_actor_id) BETWEEN 1 AND 512),
  created_by_turn_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  UNIQUE (file_id, library_id),
  FOREIGN KEY (file_id, head_version, library_id)
    REFERENCES file_versions(file_id, version, library_id)
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID, STRICT;

CREATE TABLE file_versions (
  file_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  library_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES managed_blobs(content_hash) ON DELETE RESTRICT,
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 255),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  actor_id TEXT CHECK (length(actor_id) BETWEEN 1 AND 512),
  turn_id TEXT,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
  PRIMARY KEY (file_id, version),
  UNIQUE (file_id, version, library_id),
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID, STRICT;

INSERT INTO "change_log"("seq", "project_id", "store_epoch", "kind", "operation_id", "block_ids_json", "document_ids_json", "database_block_ids_json", "payload_json", "committed_at", "projection_impact_json") SELECT backup."seq", backup."project_id", backup."store_epoch", backup."kind", backup."operation_id", backup."block_ids_json", backup."document_ids_json", backup."database_block_ids_json", backup."payload_json", backup."committed_at", backup."projection_impact_json" FROM migration165_change_log backup;

INSERT INTO "block_relocations"("id", "project_id", "library_id", "store_epoch", "request_hash", "request_json", "source_document_id", "source_generation", "source_base_head_seq", "target_kind", "target_document_id", "target_generation", "target_base_head_seq", "target_parent_block_id", "target_before_block_id", "root_block_ids_json", "expected_placement_revisions_json", "status", "source_update_id", "source_committed_seq", "target_update_id", "target_committed_seq", "final_placement_revisions_json", "result_json", "change_log_seq", "committed_at") SELECT backup."id", backup."project_id", backup."library_id", backup."store_epoch", backup."request_hash", backup."request_json", backup."source_document_id", backup."source_generation", backup."source_base_head_seq", backup."target_kind", backup."target_document_id", backup."target_generation", backup."target_base_head_seq", backup."target_parent_block_id", backup."target_before_block_id", backup."root_block_ids_json", backup."expected_placement_revisions_json", backup."status", backup."source_update_id", backup."source_committed_seq", backup."target_update_id", backup."target_committed_seq", backup."final_placement_revisions_json", backup."result_json", backup."change_log_seq", backup."committed_at" FROM migration165_block_relocations backup;

INSERT INTO "block_relocation_source_states"("relocation_id", "document_id", "project_id", "generation", "head_seq", "pre_state_vector", "pre_full_update", "pre_full_update_byte_length", "pre_state_hash", "captured_at", "library_id") SELECT backup."relocation_id", backup."document_id", backup."project_id", backup."generation", backup."head_seq", backup."pre_state_vector", backup."pre_full_update", backup."pre_full_update_byte_length", backup."pre_state_hash", backup."captured_at", (SELECT relocation.library_id FROM block_relocations relocation WHERE relocation.id = backup.relocation_id) FROM migration165_block_relocation_source_states backup;

INSERT INTO "document_recovery_artifacts"("id", "project_id", "store_epoch", "document_id", "generation", "update_id", "client_session_id", "base_head_seq", "touched_block_ids_json", "derived_touched_block_ids_json", "update_blob", "update_hash", "update_byte_length", "reason", "relocation_ids_json", "status", "created_at", "expires_at", "resolved_at") SELECT backup."id", backup."project_id", backup."store_epoch", backup."document_id", backup."generation", backup."update_id", backup."client_session_id", backup."base_head_seq", backup."touched_block_ids_json", backup."derived_touched_block_ids_json", backup."update_blob", backup."update_hash", backup."update_byte_length", backup."reason", backup."relocation_ids_json", backup."status", backup."created_at", backup."expires_at", backup."resolved_at" FROM migration165_document_recovery_artifacts backup;

INSERT INTO "document_versions"("version_id", "document_id", "project_id", "generation", "base_head_seq", "schema_key", "schema_version", "cause", "label", "actor_json", "revision_kind", "source_mutation_id", "source_change_seq", "pinned", "checkpoint_format", "full_update_blob", "state_vector", "checkpoint_hash", "byte_length", "created_at") SELECT backup."version_id", backup."document_id", backup."project_id", backup."generation", backup."base_head_seq", backup."schema_key", backup."schema_version", backup."cause", backup."label", backup."actor_json", backup."revision_kind", backup."source_mutation_id", backup."source_change_seq", backup."pinned", backup."checkpoint_format", backup."full_update_blob", backup."state_vector", backup."checkpoint_hash", backup."byte_length", backup."created_at" FROM migration165_document_versions backup;

INSERT INTO "block_mutations"("mutation_id", "project_id", "store_epoch", "mutation_kind", "actor_json", "client_session_id", "request_hash", "request_json", "target_block_ids_json", "affected_document_ids_json", "affected_database_block_ids_json", "field_intents_json", "expected_revisions_json", "outcome", "result_json", "committed_revisions_json", "document_heads_json", "change_log_seq", "recorded_at") SELECT backup."mutation_id", backup."project_id", backup."store_epoch", backup."mutation_kind", backup."actor_json", backup."client_session_id", backup."request_hash", backup."request_json", backup."target_block_ids_json", backup."affected_document_ids_json", backup."affected_database_block_ids_json", backup."field_intents_json", backup."expected_revisions_json", backup."outcome", backup."result_json", backup."committed_revisions_json", backup."document_heads_json", backup."change_log_seq", backup."recorded_at" FROM migration165_block_mutations backup;

INSERT INTO "local_commit_effects"("store_epoch", "commit_seq", "effect_order", "change_log_seq", "module_name", "effect_kind", "project_id", "resources_json", "payload_hash", "projection_impact_json") SELECT backup."store_epoch", backup."commit_seq", backup."effect_order", backup."change_log_seq", backup."module_name", backup."effect_kind", backup."project_id", backup."resources_json", backup."payload_hash", backup."projection_impact_json" FROM migration165_local_commit_effects backup;

INSERT INTO "local_commit_documents"("store_epoch", "commit_seq", "document_id", "generation", "head_seq", "update_id", "update_hash", "document_order", "project_id", "page_id", "base_head_seq", "update_byte_length") SELECT backup."store_epoch", backup."commit_seq", backup."document_id", backup."generation", backup."head_seq", backup."update_id", backup."update_hash", backup."document_order", backup."project_id", backup."page_id", backup."base_head_seq", backup."update_byte_length" FROM migration165_local_commit_documents backup;

INSERT INTO "prepared_blob_receipts"("receipt_id", "project_id", "library_id", "store_epoch", "content_hash", "byte_length", "state", "operation_id", "expires_at_unix_ms", "consumed_commit_seq", "created_at", "updated_at") SELECT backup."receipt_id", backup."project_id", backup."library_id", backup."store_epoch", backup."content_hash", backup."byte_length", backup."state", backup."operation_id", backup."expires_at_unix_ms", backup."consumed_commit_seq", backup."created_at", backup."updated_at" FROM migration165_prepared_blob_receipts backup;

INSERT INTO "block_transfer_undo_recipes"("transfer_operation_id", "project_id", "library_id", "store_epoch", "recipe_hash", "recipe_json", "consumed_at", "created_at") SELECT backup."transfer_operation_id", backup."project_id", backup."library_id", backup."store_epoch", backup."recipe_hash", backup."recipe_json", backup."consumed_at", backup."created_at" FROM migration165_block_transfer_undo_recipes backup;

INSERT INTO "structural_history_recipes"("recipe_operation_id", "library_id", "project_id", "store_epoch", "recipe_hash", "payload_ref_json", "state", "consumed_at", "superseded_by_recipe_operation_id", "created_at") SELECT backup."recipe_operation_id", backup."library_id", backup."project_id", backup."store_epoch", backup."recipe_hash", backup."payload_ref_json", backup."state", backup."consumed_at", backup."superseded_by_recipe_operation_id", backup."created_at" FROM migration165_structural_history_recipes backup;

INSERT INTO "nodex_agent_turn_authorities"("thread_id", "turn_id", "root_thread_id", "actor_project_id", "library_id", "profile_id", "store_epoch", "scope", "source", "permission_profile_id", "authority_fingerprint", "provenance_version", "created_at", "read_only") SELECT backup."thread_id", backup."turn_id", backup."root_thread_id", backup."actor_project_id", backup."library_id", backup."profile_id", backup."store_epoch", backup."scope", backup."source", backup."permission_profile_id", backup."authority_fingerprint", backup."provenance_version", backup."created_at", backup."read_only" FROM migration165_nodex_agent_turn_authorities backup;

INSERT INTO "library_files"("file_id", "library_id", "default_name", "head_version", "revision", "lifecycle", "created_by_actor_id", "created_by_turn_id", "created_at", "updated_at") SELECT backup."file_id", backup."library_id", backup."default_name", backup."head_version", backup."revision", backup."lifecycle", backup."created_by_actor_id", backup."created_by_turn_id", backup."created_at", backup."updated_at" FROM migration165_library_files backup;

INSERT INTO "file_versions"("file_id", "version", "library_id", "blob_hash", "mime_type", "byte_length", "actor_id", "turn_id", "operation_id", "occurred_at") SELECT backup."file_id", backup."version", backup."library_id", backup."blob_hash", backup."mime_type", backup."byte_length", backup."actor_id", backup."turn_id", backup."operation_id", backup."occurred_at" FROM migration165_file_versions backup;

CREATE INDEX idx_change_log_kind_seq
      ON change_log(kind, seq);

CREATE UNIQUE INDEX idx_change_log_operation
      ON change_log(project_id, kind, operation_id)
      WHERE operation_id IS NOT NULL;

CREATE INDEX idx_change_log_project_seq
      ON change_log(project_id, seq);

CREATE TRIGGER change_log_is_immutable
      BEFORE UPDATE ON change_log
      BEGIN
        SELECT RAISE(ABORT, 'change log entries are immutable');
      END;

CREATE TRIGGER prevent_change_log_projection_impact_update BEFORE UPDATE OF projection_impact_json ON change_log BEGIN SELECT RAISE(ABORT, 'change_log projection impact is immutable'); END;

CREATE TRIGGER validate_change_log_projection_impact_insert BEFORE INSERT ON change_log WHEN NEW.projection_impact_json IS NULL OR NOT json_valid(NEW.projection_impact_json) OR json_type(NEW.projection_impact_json) != 'object' BEGIN SELECT RAISE(ABORT, 'change_log projection impact is required'); END;

CREATE INDEX idx_block_relocations_library_committed
  ON block_relocations(library_id, committed_at, id);

CREATE INDEX idx_block_relocations_project_committed
  ON block_relocations(project_id, committed_at, id);

CREATE INDEX idx_block_relocations_source
  ON block_relocations(source_document_id, source_generation, source_base_head_seq, id);

CREATE INDEX idx_block_relocations_target
  ON block_relocations(target_document_id, target_generation, id)
  WHERE target_document_id IS NOT NULL;

CREATE TRIGGER block_relocations_are_immutable BEFORE UPDATE ON block_relocations BEGIN
  SELECT RAISE(ABORT, 'Committed Block relocations are immutable');
END;

CREATE TRIGGER block_relocations_validate_insert BEFORE INSERT ON block_relocations
WHEN NOT EXISTS (
  SELECT 1 FROM documents source
  LEFT JOIN documents target ON target.id = NEW.target_document_id
  WHERE source.id = NEW.source_document_id AND source.library_id = NEW.library_id
    AND (NEW.project_id IS NULL OR EXISTS (
      SELECT 1 FROM projects actor WHERE actor.id = NEW.project_id
        AND actor.library_id = NEW.library_id
    ))
    AND (NEW.target_document_id IS NULL OR target.library_id = NEW.library_id)
    AND (
      NEW.target_parent_block_id IS NULL OR EXISTS (
        SELECT 1 FROM document_block_index parent
        WHERE parent.document_id = NEW.target_document_id
          AND parent.block_id = NEW.target_parent_block_id
      )
    )
    AND (
      NEW.target_before_block_id IS NULL OR EXISTS (
        SELECT 1 FROM document_block_index sibling
        WHERE sibling.document_id = NEW.target_document_id
          AND sibling.block_id = NEW.target_before_block_id
      )
    )
) BEGIN
  SELECT RAISE(ABORT, 'Block relocation coordinates must remain inside the actor Library');
END;

CREATE INDEX idx_block_relocation_source_states_document
      ON block_relocation_source_states(document_id, generation, head_seq);

CREATE TRIGGER block_relocation_source_states_are_immutable
      BEFORE UPDATE ON block_relocation_source_states
      BEGIN
        SELECT RAISE(ABORT, 'committed block relocation source states are immutable');
      END;

CREATE INDEX idx_document_recovery_artifacts_document
      ON document_recovery_artifacts(
        document_id, generation, status, created_at, id
      );

CREATE INDEX idx_document_recovery_artifacts_expiry
      ON document_recovery_artifacts(status, expires_at, id);

CREATE TRIGGER document_recovery_artifacts_validate_insert
      BEFORE INSERT ON document_recovery_artifacts
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.touched_block_ids_json) touched
        WHERE touched.type <> 'text'
          OR length(touched.value) < 1
          OR length(touched.value) > 512
      ) OR (
        SELECT COUNT(*) FROM json_each(NEW.touched_block_ids_json)
      ) <> (
        SELECT COUNT(DISTINCT touched.value)
        FROM json_each(NEW.touched_block_ids_json) touched
      ) OR EXISTS (
        SELECT 1
        FROM json_each(COALESCE(NEW.derived_touched_block_ids_json, '[]')) touched
        WHERE touched.type <> 'text'
          OR length(touched.value) < 1
          OR length(touched.value) > 512
      ) OR (
        SELECT COUNT(*)
        FROM json_each(COALESCE(NEW.derived_touched_block_ids_json, '[]'))
      ) <> (
        SELECT COUNT(DISTINCT touched.value)
        FROM json_each(COALESCE(NEW.derived_touched_block_ids_json, '[]')) touched
      ) OR EXISTS (
        SELECT 1
        FROM json_each(NEW.relocation_ids_json) relocation_id
        WHERE relocation_id.type <> 'text'
          OR length(relocation_id.value) < 1
          OR length(relocation_id.value) > 512
          OR NOT EXISTS (
          SELECT 1
          FROM block_relocations relocation
          WHERE relocation.id = relocation_id.value
            AND relocation.project_id IS NEW.project_id
        )
      ) OR (
        SELECT COUNT(*) FROM json_each(NEW.relocation_ids_json)
      ) <> (
        SELECT COUNT(DISTINCT relocation_id.value)
        FROM json_each(NEW.relocation_ids_json) relocation_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'document recovery artifact is invalid');
      END;

CREATE TRIGGER document_recovery_artifacts_validate_update
      BEFORE UPDATE ON document_recovery_artifacts
      WHEN NEW.id <> OLD.id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.store_epoch <> OLD.store_epoch
        OR NEW.document_id <> OLD.document_id
        OR NEW.generation <> OLD.generation
        OR NEW.update_id <> OLD.update_id
        OR NEW.client_session_id <> OLD.client_session_id
        OR NEW.base_head_seq <> OLD.base_head_seq
        OR NEW.touched_block_ids_json <> OLD.touched_block_ids_json
        OR COALESCE(NEW.derived_touched_block_ids_json, '') <>
          COALESCE(OLD.derived_touched_block_ids_json, '')
        OR NEW.update_blob <> OLD.update_blob
        OR NEW.update_hash <> OLD.update_hash
        OR NEW.update_byte_length <> OLD.update_byte_length
        OR NEW.reason <> OLD.reason
        OR NEW.relocation_ids_json <> OLD.relocation_ids_json
        OR NEW.created_at <> OLD.created_at
        OR NEW.expires_at <> OLD.expires_at
        OR OLD.status <> 'pending'
        OR NEW.status = 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'document recovery artifact payload is immutable');
      END;

CREATE INDEX idx_document_versions_document_head
      ON document_versions(document_id, generation, base_head_seq DESC, created_at DESC);

CREATE INDEX idx_document_versions_project_created
      ON document_versions(project_id, created_at DESC, version_id);

CREATE INDEX idx_document_versions_retention
      ON document_versions(document_id, pinned, created_at DESC, version_id);

CREATE INDEX idx_document_versions_source_change
  ON document_versions(source_change_seq)
  WHERE source_change_seq IS NOT NULL;

CREATE INDEX idx_document_versions_source_mutation
      ON document_versions(source_mutation_id)
      WHERE source_mutation_id IS NOT NULL;

CREATE TRIGGER document_versions_are_immutable
      BEFORE UPDATE ON document_versions
      BEGIN
        SELECT RAISE(ABORT, 'document versions are immutable');
      END;

CREATE TRIGGER document_versions_validate_checkpoint_format
      BEFORE INSERT ON document_versions
      WHEN (
        NEW.checkpoint_format IN (
          'block_tree_snapshot_v2', 'block_tree_snapshot_v3', 'canvas_scene_json_v1', 'canvas_scene_json_v2'
        )
        AND (
          length(NEW.state_vector) <> 0
          OR json_valid(CAST(NEW.full_update_blob AS TEXT)) = 0
          OR json_type(CAST(NEW.full_update_blob AS TEXT)) <> 'object'
        )
      ) OR NEW.checkpoint_format NOT IN (
        'yjs_update_v1', 'block_tree_snapshot_v2', 'block_tree_snapshot_v3', 'canvas_scene_json_v1', 'canvas_scene_json_v2'
      )
      BEGIN
        SELECT RAISE(ABORT, 'Document checkpoint format does not match its payload');
      END;

CREATE TRIGGER document_versions_validate_insert
        BEFORE INSERT ON document_versions
        WHEN NOT EXISTS (
          SELECT 1 FROM documents document
          WHERE document.id = NEW.document_id
            AND (NEW.project_id IS NULL OR EXISTS (
              SELECT 1 FROM projects actor_project
              WHERE actor_project.id = NEW.project_id
                AND actor_project.library_id = document.library_id
            ))
            AND document.readiness = 'ready'
            AND document.generation = NEW.generation
            AND document.head_seq >= NEW.base_head_seq
            AND document.schema_key = NEW.schema_key
            AND document.schema_version = NEW.schema_version
        ) BEGIN
          SELECT RAISE(ABORT, 'Document version source is not a current ready Document');
        END;

CREATE INDEX idx_block_mutations_project_recorded
      ON block_mutations(project_id, recorded_at DESC, mutation_id);

CREATE INDEX idx_block_mutations_session_recorded
      ON block_mutations(project_id, client_session_id, recorded_at DESC)
      WHERE client_session_id IS NOT NULL;

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

CREATE TRIGGER block_mutations_reject_id_collision
      BEFORE INSERT ON block_mutations
      WHEN EXISTS (
        SELECT 1
        FROM block_mutations existing
        WHERE existing.mutation_id = NEW.mutation_id
          AND (
            existing.project_id IS NOT NEW.project_id
            OR existing.store_epoch <> NEW.store_epoch
            OR existing.mutation_kind <> NEW.mutation_kind
            OR existing.actor_json <> NEW.actor_json
            OR COALESCE(existing.client_session_id, '') <>
              COALESCE(NEW.client_session_id, '')
            OR existing.request_hash <> NEW.request_hash
            OR existing.request_json <> NEW.request_json
            OR existing.target_block_ids_json <> NEW.target_block_ids_json
            OR existing.affected_document_ids_json <>
              NEW.affected_document_ids_json
            OR existing.affected_database_block_ids_json <>
              NEW.affected_database_block_ids_json
            OR existing.field_intents_json <> NEW.field_intents_json
            OR existing.expected_revisions_json <>
              NEW.expected_revisions_json
            OR existing.outcome <> NEW.outcome
            OR existing.result_json <> NEW.result_json
            OR existing.committed_revisions_json <>
              NEW.committed_revisions_json
            OR existing.document_heads_json <> NEW.document_heads_json
            OR COALESCE(existing.change_log_seq, -1) <>
              COALESCE(NEW.change_log_seq, -1)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'block mutation id collides with another request or result');
      END;

CREATE TRIGGER block_mutations_validate_insert
        BEFORE INSERT ON block_mutations
        WHEN NEW.store_epoch <> COALESCE((
            SELECT store_epoch FROM block_store_metadata WHERE id = 1
          ), '')
          OR EXISTS (
            SELECT 1 FROM json_each(NEW.target_block_ids_json) target
            WHERE target.type <> 'text' OR length(target.value) = 0
          )
          OR (SELECT COUNT(*) FROM json_each(NEW.target_block_ids_json)) <> (
            SELECT COUNT(DISTINCT target.value)
            FROM json_each(NEW.target_block_ids_json) target
          )
          OR EXISTS (
            SELECT 1 FROM json_each(NEW.field_intents_json) intent
            WHERE intent.type <> 'object'
              OR json_type(intent.value, '$.path') <> 'text'
              OR length(json_extract(intent.value, '$.path')) = 0
              OR json_type(intent.value, '$.operation') <> 'text'
              OR length(json_extract(intent.value, '$.operation')) = 0
          )
          OR (
            NEW.outcome = 'committed' AND (
              EXISTS (
                SELECT 1 FROM json_each(NEW.target_block_ids_json) target
                WHERE NOT EXISTS (
                  SELECT 1 FROM blocks block
                  WHERE block.id = target.value
                    AND (NEW.project_id IS NULL OR EXISTS (
                      SELECT 1 FROM projects actor_project
                      WHERE actor_project.id = NEW.project_id
                        AND actor_project.library_id = block.library_id
                    ))
                )
              )
              OR NOT EXISTS (
                SELECT 1 FROM change_log change
                WHERE change.seq = NEW.change_log_seq
                  AND change.project_id IS NEW.project_id
                  AND change.store_epoch = NEW.store_epoch
                  AND change.operation_id = NEW.mutation_id
              )
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'Block mutation scope, intent, or result cursor is invalid');
        END;

CREATE INDEX idx_local_commit_effects_change_log
  ON local_commit_effects(change_log_seq);

CREATE INDEX idx_local_commit_documents_commit_order
  ON local_commit_documents(store_epoch, commit_seq, document_order);

CREATE INDEX idx_local_commit_documents_document
  ON local_commit_documents(document_id, generation, head_seq);

CREATE INDEX idx_prepared_blob_receipts_blob
  ON prepared_blob_receipts(content_hash, state, receipt_id);

CREATE INDEX idx_prepared_blob_receipts_expiry
  ON prepared_blob_receipts(state, expires_at_unix_ms, receipt_id);

CREATE TRIGGER prepared_blob_receipts_validate_insert
BEFORE INSERT ON prepared_blob_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM managed_blobs blob
  WHERE blob.content_hash = NEW.content_hash AND blob.byte_length = NEW.byte_length
)
BEGIN
  SELECT RAISE(ABORT, 'Prepared Blob receipt does not match one durable Blob');
END;

CREATE TRIGGER prepared_blob_receipts_validate_update
BEFORE UPDATE ON prepared_blob_receipts
WHEN OLD.receipt_id <> NEW.receipt_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.library_id <> NEW.library_id
  OR OLD.store_epoch <> NEW.store_epoch
  OR OLD.content_hash <> NEW.content_hash
  OR OLD.byte_length <> NEW.byte_length
  OR OLD.operation_id <> NEW.operation_id
  OR OLD.expires_at_unix_ms <> NEW.expires_at_unix_ms
  OR OLD.created_at <> NEW.created_at
  OR OLD.state <> 'prepared'
  OR NEW.state <> 'consumed'
  OR NEW.consumed_commit_seq IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Prepared Blob receipt transition is invalid');
END;

CREATE INDEX idx_block_transfer_undo_recipes_scope
  ON block_transfer_undo_recipes(library_id, project_id, created_at);

CREATE TRIGGER block_transfer_undo_recipes_are_immutable
BEFORE UPDATE ON block_transfer_undo_recipes
WHEN NOT (
  OLD.consumed_at IS NULL
  AND NEW.consumed_at IS NOT NULL
  AND OLD.transfer_operation_id = NEW.transfer_operation_id
  AND OLD.project_id IS NEW.project_id
  AND OLD.library_id = NEW.library_id
  AND OLD.store_epoch = NEW.store_epoch
  AND OLD.recipe_hash = NEW.recipe_hash
  AND OLD.recipe_json = NEW.recipe_json
  AND OLD.created_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'Block transfer Undo recipes are immutable');
END;

CREATE INDEX idx_structural_history_recipes_state
  ON structural_history_recipes(library_id, state, created_at);

CREATE TRIGGER structural_history_payload_gc_on_terminal
AFTER UPDATE OF state ON structural_history_recipes
WHEN OLD.state = 'available' AND NEW.state <> 'available'
BEGIN
  INSERT OR IGNORE INTO structural_history_payload_gc(recipe_operation_id, terminal_at_ms)
    VALUES (NEW.recipe_operation_id, CAST(unixepoch(NEW.consumed_at, 'subsec') * 1000 AS INTEGER));
END;

CREATE TRIGGER structural_history_recipes_transition_once
BEFORE UPDATE ON structural_history_recipes
WHEN NOT (OLD.recipe_operation_id = NEW.recipe_operation_id
  AND OLD.library_id = NEW.library_id
  AND OLD.project_id IS NEW.project_id
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

CREATE TRIGGER nodex_agent_turn_authorities_are_immutable
    BEFORE UPDATE ON nodex_agent_turn_authorities
    BEGIN
      SELECT RAISE(ABORT, 'Nodex Agent Turn authorities are immutable');
    END;

CREATE TRIGGER nodex_agent_turn_authorities_cannot_delete
    BEFORE DELETE ON nodex_agent_turn_authorities
    BEGIN
      SELECT RAISE(ABORT, 'Nodex Agent Turn authorities are immutable');
    END;

CREATE INDEX idx_library_files_catalog
  ON library_files(library_id, lifecycle, default_name COLLATE NOCASE, file_id);

CREATE TRIGGER library_files_require_retirement BEFORE DELETE ON library_files
WHEN NOT EXISTS (SELECT 1 FROM retired_file_ids WHERE file_id = OLD.file_id AND library_id = OLD.library_id)
BEGIN SELECT RAISE(ABORT, 'Permanent File deletion must retire its identity'); END;

CREATE TRIGGER library_files_retain_document_history BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM document_version_file_refs reference WHERE reference.file_id = OLD.file_id AND reference.library_id = OLD.library_id)
BEGIN
  SELECT RAISE(ABORT, 'File is retained by Document history');
END;

CREATE TRIGGER library_files_retain_recovery BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM document_recovery_file_refs reference WHERE reference.library_id = OLD.library_id AND reference.file_id = OLD.file_id)
  OR EXISTS (SELECT 1 FROM document_recovery_drafts draft LEFT JOIN document_recovery_file_snapshots snapshot
      ON snapshot.library_id = draft.library_id AND snapshot.draft_id = draft.draft_id
      WHERE draft.library_id = OLD.library_id AND (snapshot.draft_id IS NULL OR json_extract(snapshot.snapshot_json, '$.complete') <> 1))
BEGIN
    SELECT RAISE(ABORT, 'File is retained by recovery drafts');
END;

CREATE TRIGGER library_files_retain_structural_evidence BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM structural_retention_members member
  WHERE member.library_id = OLD.library_id AND member.member_kind = 'file' AND member.member_id = OLD.file_id)
BEGIN SELECT RAISE(ABORT, 'File is retained by structural evidence'); END;

CREATE TRIGGER library_files_validate_insert
BEFORE INSERT ON library_files
WHEN EXISTS (SELECT 1 FROM retired_file_ids retired WHERE retired.file_id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'Retired File identities cannot be reused');
END;

CREATE TRIGGER library_files_validate_trash BEFORE UPDATE OF lifecycle ON library_files
WHEN NEW.lifecycle = 'trashed' AND (
  EXISTS (SELECT 1 FROM page_file_entries WHERE file_id = NEW.file_id AND library_id = NEW.library_id)
  OR EXISTS (SELECT 1 FROM block_asset_refs WHERE file_id = NEW.file_id AND library_id = NEW.library_id)
  OR EXISTS (SELECT 1 FROM canvas_scene_file_refs WHERE target_file_id = NEW.file_id AND library_id = NEW.library_id)
)
BEGIN SELECT RAISE(ABORT, 'Current or recoverable content prevents File trash'); END;

CREATE TRIGGER library_files_validate_update
BEFORE UPDATE ON library_files
WHEN NEW.file_id <> OLD.file_id OR NEW.library_id <> OLD.library_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.head_version < OLD.head_version
  OR NEW.created_by_actor_id <> OLD.created_by_actor_id
  OR NEW.created_by_turn_id IS NOT OLD.created_by_turn_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'File updates must preserve identity and advance revision');
END;

CREATE TRIGGER visibility_dirty_library_files_delete
BEFORE DELETE ON library_files
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_commit_visibility_context
    WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
  ) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
  INSERT INTO local_commit_visibility_dirty_facts(
    store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
  )
  SELECT store_epoch, commit_seq, 'library_files', 'delete', json_object('file_id', OLD."file_id", 'library_id', OLD."library_id", 'default_name', OLD."default_name", 'head_version', OLD."head_version", 'revision', OLD."revision", 'lifecycle', OLD."lifecycle", 'created_by_actor_id', OLD."created_by_actor_id", 'created_by_turn_id', OLD."created_by_turn_id", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
  FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;

CREATE TRIGGER visibility_dirty_library_files_insert
BEFORE INSERT ON library_files
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_commit_visibility_context
    WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
  ) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
  INSERT INTO local_commit_visibility_dirty_facts(
    store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
  )
  SELECT store_epoch, commit_seq, 'library_files', 'insert', NULL, json_object('file_id', NEW."file_id", 'library_id', NEW."library_id", 'default_name', NEW."default_name", 'head_version', NEW."head_version", 'revision', NEW."revision", 'lifecycle', NEW."lifecycle", 'created_by_actor_id', NEW."created_by_actor_id", 'created_by_turn_id', NEW."created_by_turn_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
  FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;

CREATE INDEX idx_file_versions_blob ON file_versions(blob_hash);

CREATE TRIGGER file_versions_reject_update
BEFORE UPDATE ON file_versions
BEGIN
  SELECT RAISE(ABORT, 'File versions are immutable');
END;

CREATE TRIGGER file_versions_retain_while_file_exists BEFORE DELETE ON file_versions
WHEN EXISTS (SELECT 1 FROM library_files WHERE file_id = OLD.file_id)
BEGIN SELECT RAISE(ABORT, 'File versions remain retained while the File exists'); END;

CREATE TRIGGER file_versions_validate_insert
BEFORE INSERT ON file_versions
WHEN NOT EXISTS (
  SELECT 1 FROM managed_blobs blob
  WHERE blob.content_hash = NEW.blob_hash AND blob.byte_length = NEW.byte_length
)
BEGIN
  SELECT RAISE(ABORT, 'File version bytes must match a published Blob');
END;

DROP TABLE migration165_file_versions;

DROP TABLE migration165_library_files;

DROP TABLE migration165_nodex_agent_turn_authorities;

DROP TABLE migration165_structural_history_recipes;

DROP TABLE migration165_block_transfer_undo_recipes;

DROP TABLE migration165_prepared_blob_receipts;

DROP TABLE migration165_local_commit_documents;

DROP TABLE migration165_local_commit_effects;

DROP TABLE migration165_block_mutations;

DROP TABLE migration165_document_versions;

DROP TABLE migration165_document_recovery_artifacts;

DROP TABLE migration165_block_relocation_source_states;

DROP TABLE migration165_block_relocations;

DROP TABLE migration165_change_log;
