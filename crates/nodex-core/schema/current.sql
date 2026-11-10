CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    , library_id TEXT, database_block_id TEXT, lifecycle TEXT NOT NULL DEFAULT 'active', binding_revision INTEGER NOT NULL DEFAULT 1, appearance_color TEXT NOT NULL DEFAULT 'black'
  CHECK (appearance_color IN ('black', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink')), appearance_marker_kind TEXT NOT NULL DEFAULT 'icon'
  CHECK (appearance_marker_kind IN ('icon', 'emoji')), appearance_marker_value TEXT NOT NULL DEFAULT 'folder'
  CHECK (
    (
      appearance_marker_kind = 'icon'
      AND appearance_marker_value IN (
        'folder', 'currency-dollar', 'book', 'graduation-cap', 'edit', 'writing',
        'function', 'terminal', 'music', 'popcorn', 'customize', 'palette',
        'stethoscope', 'health', 'lotus', 'suitcase', 'bar-chart', 'kettlebell',
        'dumbbell', 'logs', 'scale', 'desk-globe', 'plane', 'globe', 'wrench',
        'paw', 'flask', 'brain', 'heart', 'plant'
      )
    )
    OR (
      appearance_marker_kind = 'emoji'
      AND length(trim(appearance_marker_value)) > 0
      AND length(CAST(appearance_marker_value AS BLOB)) <= 256
    )
  ));
CREATE TABLE project_sources (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      root TEXT NOT NULL,
      root_key TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      PRIMARY KEY (project_id, root_key)
    );
CREATE TABLE project_order (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      "order" INTEGER NOT NULL,
      updated TEXT NOT NULL
    );
CREATE TABLE pinned_project_order (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      "order" INTEGER NOT NULL,
      updated TEXT NOT NULL
    );
CREATE TABLE codex_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      parent_thread_id TEXT,
      thread_name TEXT,
      thread_source TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      thread_preview TEXT NOT NULL DEFAULT '',
      cwd TEXT,
      managed_worktree_path TEXT,
      projectless_output_directory TEXT,
      projectless_workspace_browser_root TEXT,
      status_type TEXT NOT NULL DEFAULT 'notLoaded',
      status_active_flags_json TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      linked_at TEXT NOT NULL
    , forked_from_id TEXT, service_name TEXT, agent_path TEXT, model_id TEXT, reasoning_effort TEXT, service_tier TEXT, execution_host_id TEXT NOT NULL DEFAULT 'local' CHECK (execution_host_id = trim(execution_host_id) AND length(execution_host_id) BETWEEN 1 AND 512), recency_at INTEGER NOT NULL DEFAULT 0 CHECK (recency_at >= 0), agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude', 'opencode')), agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512)), agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind IN ('claude', 'opencode') AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512))))) WITHOUT ROWID;
CREATE TABLE "thread_backend_sessions" (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('acp', 'claude', 'opencode')),
  agent_definition_id TEXT CHECK ((backend_kind IN ('claude', 'opencode') AND agent_definition_id IS NULL) OR (backend_kind = 'acp' AND agent_definition_id IS NOT NULL AND agent_definition_id = trim(agent_definition_id) AND length(agent_definition_id) BETWEEN 1 AND 512)),
  instance_config_id TEXT CHECK ((backend_kind = 'acp' AND instance_config_id IS NULL) OR (instance_config_id IS NOT NULL AND instance_config_id = trim(instance_config_id) AND length(instance_config_id) BETWEEN 1 AND 512)),
  backend_session_id TEXT NOT NULL CHECK (backend_session_id = trim(backend_session_id) AND length(backend_session_id) BETWEEN 1 AND 512),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  native_state_json TEXT CHECK (native_state_json IS NULL OR (json_valid(native_state_json) AND length(native_state_json) <= 262144)),
  native_home TEXT CHECK (native_home IS NULL OR (backend_kind IN ('claude', 'opencode') AND length(native_home) BETWEEN 1 AND 16384 AND native_home = trim(native_home))),
  runtime_options_json TEXT CHECK (runtime_options_json IS NULL OR (json_valid(runtime_options_json) AND length(runtime_options_json) <= 262144))
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_thread_dynamic_tool_catalogs (
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      toolset_revision INTEGER NOT NULL,
      PRIMARY KEY (thread_id, namespace),
      CHECK (length(trim(namespace)) > 0),
      CHECK (toolset_revision > 0)
    ) WITHOUT ROWID;
CREATE TABLE nodex_agent_token_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      key_material BLOB NOT NULL CHECK (length(key_material) = 32)
    );
CREATE TABLE nodex_agent_call_receipts (
      call_identity TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      call_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      mutation_id TEXT NOT NULL UNIQUE,
      authority_fingerprint TEXT,
      provenance_version INTEGER,
      allocations_json TEXT NOT NULL DEFAULT '[]',
      result_metadata_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'prepared',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (thread_id, call_id),
      CHECK (length(call_identity) = 64),
      CHECK (length(trim(thread_id)) BETWEEN 1 AND 512),
      CHECK (turn_id IS NULL OR length(trim(turn_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(call_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(tool)) BETWEEN 1 AND 128),
      CHECK (length(request_hash) = 64),
      CHECK (length(trim(mutation_id)) BETWEEN 1 AND 512),
      CHECK (
        (turn_id IS NULL AND authority_fingerprint IS NULL AND provenance_version IS NULL)
        OR (
          turn_id IS NOT NULL
          AND authority_fingerprint IS NOT NULL
          AND provenance_version IS NOT NULL
          AND
          length(trim(turn_id)) BETWEEN 1 AND 512
          AND length(authority_fingerprint) = 64
          AND provenance_version = 1
        )
      ),
      CHECK (json_valid(allocations_json) AND json_type(allocations_json) = 'array'),
      CHECK (json_valid(result_metadata_json) AND json_type(result_metadata_json) = 'object'),
      CHECK (status IN ('prepared', 'committed'))
    ) WITHOUT ROWID;
CREATE TABLE nodex_agent_turn_authorities (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  root_thread_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  store_epoch TEXT NOT NULL,
  authority_fingerprint TEXT NOT NULL CHECK (length(authority_fingerprint) = 64),
  provenance_version INTEGER NOT NULL CHECK (provenance_version = 2),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, turn_id),
  CHECK (length(trim(thread_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(turn_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(root_thread_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(library_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(profile_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(store_epoch)) BETWEEN 1 AND 512)
) WITHOUT ROWID;
CREATE TABLE codex_background_processes (
      process_record_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      thread_title TEXT,
      item_id TEXT NOT NULL,
      turn_id TEXT,
      command TEXT NOT NULL,
      cwd TEXT,
      app_server_process_id TEXT,
      os_pid INTEGER,
      terminal_session_id TEXT,
      source TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK (source IN ('app-server', 'terminal-action'))
    ) WITHOUT ROWID;
CREATE TABLE codex_pinned_threads (
      thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      pinned_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
CREATE TABLE block_store_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      store_epoch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE document_updates (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      seq INTEGER NOT NULL CHECK (seq >= 1),
      update_id TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      base_head_seq INTEGER NOT NULL CHECK (base_head_seq >= 0),
      touched_block_ids_json TEXT NOT NULL DEFAULT '[]',
      update_blob BLOB NOT NULL,
      update_hash TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (document_id, generation, seq),
      UNIQUE (document_id, update_id)
    ) WITHOUT ROWID;
CREATE TABLE document_snapshots (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      snapshot_seq INTEGER NOT NULL CHECK (snapshot_seq >= 0),
      state_vector BLOB NOT NULL,
      snapshot_update BLOB NOT NULL,
      snapshot_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, generation, snapshot_seq)
    ) WITHOUT ROWID;
CREATE TABLE document_materializations (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      projected_seq INTEGER NOT NULL CHECK (projected_seq >= 0),
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
      title TEXT NOT NULL DEFAULT '',
      title_rich_json TEXT NOT NULL DEFAULT '[]',
      title_rich_hash TEXT NOT NULL DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      markdown TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      preview TEXT NOT NULL,
      block_tree_json TEXT NOT NULL,
      references_json TEXT NOT NULL DEFAULT '[]',
      asset_refs_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL, materialization_derivation_version INTEGER NOT NULL DEFAULT 3 CHECK (materialization_derivation_version >= 1),
      CHECK (json_valid(block_tree_json) AND json_type(block_tree_json) = 'array'),
      CHECK (json_valid(title_rich_json) AND json_type(title_rich_json) = 'array'),
      CHECK (length(title_rich_hash) = 64),
      CHECK (json_valid(references_json) AND json_type(references_json) = 'array'),
      CHECK (json_valid(asset_refs_json) AND json_type(asset_refs_json) = 'array')
    ) WITHOUT ROWID;
CREATE TABLE document_block_index (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      block_id TEXT NOT NULL UNIQUE REFERENCES blocks(id) ON DELETE CASCADE,
      parent_block_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      block_type TEXT NOT NULL,
      text TEXT NOT NULL,
      projected_seq INTEGER NOT NULL CHECK (projected_seq >= 0),
      PRIMARY KEY (document_id, block_id)
    ) WITHOUT ROWID;
CREATE TABLE document_update_receipts (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      seq INTEGER NOT NULL CHECK (seq >= 1),
      update_id TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      base_head_seq INTEGER NOT NULL CHECK (base_head_seq >= 0),
      client_touched_block_ids_json TEXT NOT NULL DEFAULT '[]',
      derived_touched_block_ids_json TEXT NOT NULL DEFAULT '[]',
      derivation_version INTEGER NOT NULL DEFAULT 1 CHECK (derivation_version IN (0, 1)),
      update_hash TEXT NOT NULL,
      update_byte_length INTEGER NOT NULL CHECK (update_byte_length > 0),
      committed_at TEXT NOT NULL,
      PRIMARY KEY (document_id, generation, seq),
      UNIQUE (document_id, update_id)
    ) WITHOUT ROWID;
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
CREATE TABLE document_version_file_index (
  version_id TEXT PRIMARY KEY REFERENCES document_versions(version_id) ON DELETE CASCADE,
  checkpoint_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  CHECK (length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID, STRICT;
CREATE TABLE document_version_file_refs (
  version_id TEXT NOT NULL REFERENCES document_versions(version_id) ON DELETE CASCADE,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('body', 'canvas')),
  binding_id TEXT NOT NULL CHECK (length(binding_id) BETWEEN 1 AND 512),
  file_id TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  file_version INTEGER,
  default_name TEXT,
  resolution TEXT NOT NULL CHECK (resolution IN ('exact', 'unresolved_legacy')),
  PRIMARY KEY (version_id, binding_kind, binding_id),
  CHECK (binding_kind <> 'body' OR binding_id = file_id),
  FOREIGN KEY (file_id, file_version) REFERENCES file_versions(file_id, version) ON DELETE RESTRICT,
  CHECK ((resolution = 'exact' AND file_version IS NOT NULL AND file_version >= 1 AND default_name IS NOT NULL)
      OR (resolution = 'unresolved_legacy' AND file_version IS NULL AND default_name IS NULL))
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_document_version_file_refs_file ON document_version_file_refs(file_id, version_id);
CREATE TRIGGER document_version_file_refs_validate_insert BEFORE INSERT ON document_version_file_refs
WHEN NOT EXISTS (
  SELECT 1 FROM document_versions version JOIN documents document ON document.id = version.document_id
  WHERE version.version_id = NEW.version_id AND document.library_id = NEW.library_id
) OR (NEW.resolution = 'exact' AND NOT EXISTS (
  SELECT 1 FROM file_versions version WHERE version.file_id = NEW.file_id
    AND version.version = NEW.file_version AND version.library_id = NEW.library_id
)) BEGIN
  SELECT RAISE(ABORT, 'Document File snapshot target is outside its Library');
END;
CREATE TABLE document_version_retention_index (
      version_id TEXT PRIMARY KEY
        REFERENCES document_versions(version_id) ON DELETE CASCADE,
      checkpoint_hash TEXT NOT NULL,
      member_count INTEGER NOT NULL CHECK (member_count >= 0),
      indexed_at TEXT NOT NULL,
      CHECK (length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(indexed_at) > 0)
    ) WITHOUT ROWID, STRICT;
CREATE TABLE document_version_retention_members (
      version_id TEXT NOT NULL
        REFERENCES document_version_retention_index(version_id) ON DELETE CASCADE,
      member_kind TEXT NOT NULL CHECK (member_kind IN ('block', 'database_view')),
      member_id TEXT NOT NULL,
      PRIMARY KEY (version_id, member_kind, member_id),
      CHECK (length(member_id) BETWEEN 1 AND 1024)
    ) WITHOUT ROWID, STRICT;
CREATE TABLE block_retention_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      maintenance_revision INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_revision >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    ) WITHOUT ROWID, STRICT;
CREATE TABLE block_retention_deferrals (
      root_block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
      evaluated_commit_seq INTEGER NOT NULL CHECK (evaluated_commit_seq >= 0),
      retry_after_ms INTEGER NOT NULL CHECK (retry_after_ms >= 0)
    ) WITHOUT ROWID, STRICT;
CREATE TABLE document_revision_sessions (
      document_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      dirty_head_seq INTEGER NOT NULL CHECK (dirty_head_seq >= 0),
      burst_started_at TEXT NOT NULL,
      last_edit_at TEXT NOT NULL,
      last_checkpoint_at TEXT,
      client_session_id TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      CHECK (length(burst_started_at) > 0),
      CHECK (length(last_edit_at) > 0),
      CHECK (last_checkpoint_at IS NULL OR length(last_checkpoint_at) > 0),
      CHECK (length(trim(client_session_id)) BETWEEN 1 AND 512)
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
CREATE VIRTUAL TABLE block_search_units_fts USING fts5(
      text,
      content='block_search_units',
      content_rowid='rowid',
      tokenize="unicode61 remove_diacritics 2 tokenchars '-_/@.:#'",
      prefix='2 3 4'
    );
CREATE TABLE codex_unread_threads (
          thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE
        ) WITHOUT ROWID;
CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(trim(id)) BETWEEN 1 AND 512)
    ) WITHOUT ROWID;
CREATE TABLE libraries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL UNIQUE
        REFERENCES profiles(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, space_kind TEXT NOT NULL DEFAULT 'personal' CHECK (space_kind IN ('personal','team')), hosted INTEGER NOT NULL DEFAULT 0 CHECK(hosted IN (0,1)), name TEXT CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 256),
      CHECK (length(trim(id)) BETWEEN 1 AND 512)
    ) WITHOUT ROWID;
CREATE TABLE database_containers (
      block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      default_view_id TEXT,
      metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK (metadata_revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (lifecycle IN ('active', 'archived', 'deleted')),
      CHECK (length(trim(name)) BETWEEN 1 AND 256)
    ) WITHOUT ROWID;
CREATE TABLE data_sources (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      home_database_block_id TEXT NOT NULL
        REFERENCES database_containers(block_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      schema_key TEXT NOT NULL,
      schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision >= 1),
      lifecycle TEXT NOT NULL DEFAULT 'active',
      rank_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (id, home_database_block_id),
      CHECK (lifecycle IN ('active', 'archived', 'deleted')),
      CHECK (length(trim(name)) BETWEEN 1 AND 256)
    ) WITHOUT ROWID;
CREATE TABLE data_source_page_memberships (
      id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
      page_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      removed_at TEXT, completed_at TEXT,
      UNIQUE (id, data_source_id)
    ) WITHOUT ROWID;
CREATE TABLE project_database_bindings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      database_block_id TEXT NOT NULL
        REFERENCES database_containers(block_id) ON DELETE RESTRICT,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (lifecycle IN ('active', 'inactive', 'archived'))
    ) WITHOUT ROWID;
CREATE TABLE library_block_placements (
      block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      rank_key TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (block_id, library_id)
    ) WITHOUT ROWID;
CREATE TABLE database_module_receipts (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      store_epoch TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      outcome TEXT NOT NULL,
      result_json TEXT NOT NULL,
      change_log_seq INTEGER,
      created_at TEXT NOT NULL,
      CHECK (length(trim(operation_id)) BETWEEN 1 AND 512),
      CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
      CHECK (outcome IN ('committed', 'rejected')),
      CHECK (json_valid(result_json) AND json_type(result_json) = 'object')
    ) WITHOUT ROWID;
CREATE TABLE core_store_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_owner TEXT NOT NULL CHECK (schema_owner = 'rust_core'),
  projection_event_v2_floor INTEGER NOT NULL
    CHECK (projection_event_v2_floor >= 1)
) STRICT;
CREATE TABLE core_store_migration_history (
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  target_revision INTEGER NOT NULL CHECK (target_revision > source_revision),
  source_schema_fingerprint TEXT NOT NULL
    CHECK (
      length(source_schema_fingerprint) = 64
      AND source_schema_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  target_schema_fingerprint TEXT NOT NULL
    CHECK (
      length(target_schema_fingerprint) = 64
      AND target_schema_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  backup_name TEXT NOT NULL
    CHECK (
      length(backup_name) BETWEEN 1 AND 512
      AND instr(backup_name, '/') = 0
      AND instr(backup_name, '\') = 0
    ),
  completed_at_unix_ms INTEGER NOT NULL CHECK (completed_at_unix_ms >= 0),
  evidence_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  PRIMARY KEY (source_revision, target_revision)
) WITHOUT ROWID, STRICT;
CREATE TABLE document_structural_barriers (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  head_seq INTEGER NOT NULL CHECK (head_seq >= 1),
  operation_id TEXT NOT NULL,
  block_ids_json TEXT NOT NULL,
  title_fence INTEGER NOT NULL CHECK (title_fence IN (0, 1)),
  committed_at TEXT NOT NULL, document_wide_fence INTEGER NOT NULL DEFAULT 0 CHECK (document_wide_fence IN (0, 1)),
  PRIMARY KEY (document_id, generation, head_seq),
  UNIQUE (operation_id),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (json_valid(block_ids_json) AND json_type(block_ids_json) = 'array'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_thread_writable_roots (
  thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  root TEXT NOT NULL,
  root_order INTEGER NOT NULL CHECK (root_order >= 0),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
  PRIMARY KEY (thread_id, root),
  UNIQUE (thread_id, root_order),
  CHECK (length(thread_id) BETWEEN 1 AND 512),
  CHECK (length(root) BETWEEN 1 AND 16384)
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_thread_workspace_states (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
    CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_app_server_thread_observations (
  thread_id TEXT PRIMARY KEY
    REFERENCES codex_threads(thread_id) ON UPDATE CASCADE ON DELETE CASCADE,
  last_seen_sweep_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_subagent_universes (
  host_id TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  root_thread_id TEXT NOT NULL
    REFERENCES codex_threads(thread_id) ON UPDATE CASCADE ON DELETE CASCADE,
  discovery_continuation TEXT,
  discovery_complete INTEGER NOT NULL DEFAULT 0 CHECK (discovery_complete IN (0, 1)),
  observed_page_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_page_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host_id, source_epoch, generation, root_thread_id),
  CHECK (length(trim(host_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(source_epoch)) BETWEEN 1 AND 512),
  CHECK (length(trim(root_thread_id)) BETWEEN 1 AND 512),
  CHECK (discovery_continuation IS NULL OR length(CAST(discovery_continuation AS BLOB)) <= 524288)
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_subagent_discovery_pages (
  host_id TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  root_thread_id TEXT NOT NULL,
  page_identity TEXT NOT NULL,
  page_hash TEXT NOT NULL,
  continuation TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (host_id, source_epoch, generation, root_thread_id, page_identity),
  FOREIGN KEY (host_id, source_epoch, generation, root_thread_id)
    REFERENCES workspace_subagent_universes(host_id, source_epoch, generation, root_thread_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (length(trim(page_identity)) BETWEEN 1 AND 512),
  CHECK (length(page_hash) = 64 AND page_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (continuation IS NULL OR length(CAST(continuation AS BLOB)) <= 524288)
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_subagent_descendants (
  host_id TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  root_thread_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON UPDATE CASCADE ON DELETE CASCADE,
  parent_thread_id TEXT NOT NULL,
  first_seen_page_identity TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (host_id, source_epoch, generation, root_thread_id, thread_id),
  FOREIGN KEY (host_id, source_epoch, generation, root_thread_id)
    REFERENCES workspace_subagent_universes(host_id, source_epoch, generation, root_thread_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (thread_id <> root_thread_id),
  CHECK (thread_id <> parent_thread_id),
  CHECK (length(trim(parent_thread_id)) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_subagent_status_evidence (
  host_id TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  root_thread_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'done', 'unknown')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('metadata', 'notification', 'completion', 'reconciliation')),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host_id, source_epoch, generation, root_thread_id, thread_id),
  FOREIGN KEY (host_id, source_epoch, generation, root_thread_id, thread_id)
    REFERENCES workspace_subagent_descendants(host_id, source_epoch, generation, root_thread_id, thread_id)
    ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_subagent_pending_status_evidence (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'done', 'unknown')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('notification', 'completion', 'reconciliation')),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, host_id, source_epoch, generation, thread_id),
  CHECK (length(trim(host_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(source_epoch)) BETWEEN 1 AND 512),
  CHECK (length(trim(thread_id)) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE "canvas_scenes" (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  scene_hash_version INTEGER NOT NULL CHECK (scene_hash_version = 2),
  app_state_json TEXT NOT NULL DEFAULT '{}',
  app_state_hash TEXT NOT NULL,
  scene_hash TEXT NOT NULL,
  element_count INTEGER NOT NULL CHECK (element_count >= 0),
  tombstone_count INTEGER NOT NULL
    CHECK (tombstone_count BETWEEN 0 AND element_count),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  element_json_bytes INTEGER NOT NULL CHECK (element_json_bytes >= 0),
  file_json_bytes INTEGER NOT NULL CHECK (file_json_bytes >= 0),
  scene_byte_length INTEGER NOT NULL
    CHECK (scene_byte_length BETWEEN 0 AND 16777216),
  updated_at TEXT NOT NULL, tombstone_json_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (
    tombstone_json_bytes >= 0
    AND tombstone_json_bytes <= element_json_bytes
  ),
  CHECK (json_valid(app_state_json) AND json_type(app_state_json) = 'object'),
  CHECK (length(app_state_hash) = 64 AND app_state_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(scene_hash) = 64 AND scene_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;
CREATE TABLE "canvas_scene_elements" (
  document_id TEXT NOT NULL
    REFERENCES "canvas_scenes"(document_id) ON DELETE CASCADE,
  element_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  version_nonce INTEGER NOT NULL CHECK (version_nonce >= 0),
  order_key TEXT NOT NULL,
  is_deleted INTEGER NOT NULL CHECK (is_deleted IN (0, 1)),
  element_json TEXT NOT NULL,
  element_hash TEXT NOT NULL,
  hash_bucket INTEGER NOT NULL CHECK (hash_bucket BETWEEN 0 AND 1023),
  referenced_file_id TEXT,
  plain_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, element_id),
  CHECK (length(element_id) BETWEEN 1 AND 512),
  CHECK (length(order_key) BETWEEN 1 AND 256),
  CHECK (json_valid(element_json) AND json_type(element_json) = 'object'),
  CHECK (length(element_hash) = 64 AND element_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (is_deleted = 0)
    OR (referenced_file_id IS NULL AND plain_text = '')
  ),
  CHECK (referenced_file_id IS NULL OR length(referenced_file_id) BETWEEN 1 AND 512)
) WITHOUT ROWID;
CREATE TABLE "canvas_scene_files" (
  document_id TEXT NOT NULL
    REFERENCES "canvas_scenes"(document_id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  asset_uri TEXT NOT NULL,
  created_ms INTEGER CHECK (created_ms IS NULL OR created_ms >= 0),
  file_json TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  hash_bucket INTEGER NOT NULL CHECK (hash_bucket BETWEEN 0 AND 1023),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, file_id),
  CHECK (length(file_id) BETWEEN 1 AND 512),
  CHECK (length(mime_type) BETWEEN 1 AND 256),
  CHECK (length(asset_uri) BETWEEN 1 AND 4096),
  CHECK (json_valid(file_json) AND json_type(file_json) = 'object'),
  CHECK (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;
CREATE TABLE "canvas_scene_hash_buckets" (
  document_id TEXT NOT NULL
    REFERENCES "canvas_scenes"(document_id) ON DELETE CASCADE,
  bucket_index INTEGER NOT NULL CHECK (bucket_index BETWEEN 0 AND 1023),
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  bucket_hash TEXT NOT NULL,
  PRIMARY KEY (document_id, bucket_index),
  CHECK (length(bucket_hash) = 64 AND bucket_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;
CREATE TABLE "canvas_scene_projection_heads" (
  document_id TEXT PRIMARY KEY
    REFERENCES "canvas_scenes"(document_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  projected_head_seq INTEGER NOT NULL CHECK (projected_head_seq >= 0),
  projection_version INTEGER NOT NULL CHECK (projection_version = 2),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE "canvas_scene_mutation_receipts" (
  document_id TEXT NOT NULL
    REFERENCES "canvas_scenes"(document_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  mutation_id TEXT NOT NULL,
  base_head_seq INTEGER NOT NULL CHECK (base_head_seq >= 0),
  committed_head_seq INTEGER NOT NULL CHECK (committed_head_seq >= 0),
  intent_hash TEXT NOT NULL,
  intent_byte_length INTEGER NOT NULL CHECK (intent_byte_length > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'no_change')),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (document_id, generation, mutation_id),
  UNIQUE (document_id, mutation_id),
  CHECK (length(mutation_id) BETWEEN 1 AND 512),
  CHECK (length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;
CREATE TABLE canvas_owners (
  block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(block_id) BETWEEN 1 AND 512),
  CHECK (length(library_id) BETWEEN 1 AND 512),
  CHECK (length(created_at) > 0),
  CHECK (length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE "project_sessions" (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  no_thread_fallback_title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_default_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_default_draft IN (0, 1)),
  activity_at INTEGER NOT NULL,
  manual_rank INTEGER,
  CHECK (activity_at >= CAST(round(unixepoch(created_at, 'subsec') * 1000) AS INTEGER)),
  CHECK (archived IN (0, 1))
);
CREATE TABLE project_session_side_chats (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE project_session_threads (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE project_session_execution_bindings (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  launch_request_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  UNIQUE (runtime_id, runtime_thread_id),
  UNIQUE (runtime_id, launch_request_id),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (length(runtime_id) BETWEEN 1 AND 512 AND runtime_id = trim(runtime_id)),
  CHECK (length(runtime_thread_id) BETWEEN 1 AND 512 AND runtime_thread_id = trim(runtime_thread_id)),
  CHECK (length(launch_request_id) BETWEEN 1 AND 512 AND launch_request_id = trim(launch_request_id)),
  CHECK (length(bound_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER project_session_execution_binding_insert_guard
BEFORE INSERT ON project_session_execution_bindings
WHEN EXISTS (SELECT 1 FROM project_session_threads WHERE session_id = NEW.session_id)
  OR EXISTS (SELECT 1 FROM project_sessions WHERE id = NEW.session_id AND is_default_draft = 1)
BEGIN
  SELECT RAISE(ABORT, 'Session already has execution ownership or is a default draft');
END;
CREATE TRIGGER project_session_execution_binding_update_guard
BEFORE UPDATE ON project_session_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'Agent Runtime Session binding is immutable');
END;
CREATE TRIGGER project_session_native_binding_insert_guard
BEFORE INSERT ON project_session_threads
WHEN EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Session execution belongs to Agent Runtime');
END;
CREATE TRIGGER project_session_native_binding_update_guard
BEFORE UPDATE ON project_session_threads
WHEN EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Session execution belongs to Agent Runtime');
END;
CREATE TRIGGER project_session_execution_draft_update_guard
BEFORE UPDATE OF is_default_draft ON project_sessions
WHEN NEW.is_default_draft = 1
  AND EXISTS (SELECT 1 FROM project_session_execution_bindings WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'A running Session cannot become a default draft');
END;
CREATE TABLE project_session_pages (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  report_outcome TEXT CHECK(report_outcome IN ('ready','blocked','failed','dropped')),
  report_summary TEXT,
  report_at TEXT,
  report_run_id TEXT,
  report_revision INTEGER NOT NULL DEFAULT 0 CHECK(report_revision >= 0), status_fence INTEGER CHECK(status_fence >= 0), status_moved INTEGER NOT NULL DEFAULT 0 CHECK(status_moved IN (0,1)), report_status_moved INTEGER CHECK(report_status_moved IN (0,1)),
  PRIMARY KEY (session_id, page_id),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (length(page_id) BETWEEN 1 AND 512),
  CHECK (length(linked_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_sidebar_sections (
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
CREATE UNIQUE INDEX idx_workspace_sidebar_sections_builtin
  ON workspace_sidebar_sections(library_id, kind)
  WHERE kind <> 'custom';
CREATE INDEX idx_workspace_sidebar_sections_order
  ON workspace_sidebar_sections(library_id, lifecycle, rank_key, section_id);
CREATE TABLE workspace_sidebar_section_items (
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
    REFERENCES workspace_sidebar_sections(library_id, section_id, kind) ON DELETE CASCADE,
  UNIQUE (project_id),
  UNIQUE (session_id),
  UNIQUE (library_id, section_id, rank_key),
  CHECK ((project_id IS NOT NULL) <> (session_id IS NOT NULL))
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_workspace_sidebar_section_items_project
  ON workspace_sidebar_section_items(project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_section_items_session
  ON workspace_sidebar_section_items(session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_section_items_order
  ON workspace_sidebar_section_items(library_id, section_id, rank_key, placement_id);
CREATE TABLE workspace_sidebar_section_host_links (
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
    REFERENCES workspace_sidebar_sections(library_id, section_id) ON DELETE CASCADE,
  CHECK (length(trim(host_id)) BETWEEN 1 AND 512),
  CHECK (remote_section_id IS NULL OR length(trim(remote_section_id)) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
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
CREATE TABLE "local_commits" (
  commit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  store_epoch TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  projection_impact_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL, intent_hash TEXT NOT NULL
  DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
  CHECK (length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*'), projection_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(projection_json) AND json_type(projection_json) = 'object'), receipt_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(receipt_json) AND json_type(receipt_json) = 'object'), audience_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(audience_json) AND json_type(audience_json) = 'object'), finalized INTEGER NOT NULL DEFAULT 0
  CHECK (finalized IN (0, 1)), manifest_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)), authorizing_member_id TEXT REFERENCES members(id),
  UNIQUE (store_epoch, commit_seq),
  UNIQUE (store_epoch, operation_id),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (length(committed_at) > 0),
  CHECK (json_valid(projection_impact_json) AND json_type(projection_impact_json) = 'object'),
  CHECK (length(canonical_hash) = 64 AND canonical_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE local_commit_retention_metadata (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  sealed_at_ms INTEGER NOT NULL CHECK (sealed_at_ms >= 0),
  delivery_bytes INTEGER NOT NULL CHECK (delivery_bytes >= 0),
  PRIMARY KEY (store_epoch, commit_seq),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(store_epoch) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
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
CREATE TABLE "core_module_receipts" (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  adapter_kind TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  store_epoch TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  event_sequence INTEGER REFERENCES change_log(seq) ON DELETE RESTRICT,
  local_commit_seq INTEGER,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (module_name, operation_id),
  FOREIGN KEY (store_epoch, local_commit_seq)
    REFERENCES "local_commits"(store_epoch, commit_seq),
  CHECK (module_name IN (
    'library', 'database', 'owned_document', 'project_workspace',
    'automation', 'store_administration'
  )),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (length(profile_id) BETWEEN 1 AND 512),
  CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 512),
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test', 'remote_member')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE detached_module_receipts (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  project_id TEXT,
  adapter_kind TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  store_epoch TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  event_sequence INTEGER,
  local_commit_seq INTEGER NOT NULL CHECK (local_commit_seq >= 1),
  commit_manifest_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  detached_at_ms INTEGER NOT NULL CHECK (detached_at_ms >= 0),
  PRIMARY KEY (module_name, operation_id),
  CHECK (module_name IN (
    'library', 'database', 'owned_document', 'project_workspace',
    'automation', 'store_administration'
  )),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (length(profile_id) BETWEEN 1 AND 512),
  CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 512),
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test', 'remote_member')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (event_sequence IS NULL OR event_sequence >= 1),
  CHECK (length(commit_manifest_hash) = 64 AND commit_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE module_receipt_retention_metadata (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= issued_at_ms),
  receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes >= 0),
  PRIMARY KEY (module_name, operation_id),
  CHECK (module_name IN (
    'library', 'database', 'owned_document', 'project_workspace',
    'automation', 'store_administration'
  )),
  CHECK (length(operation_id) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE local_commit_delivery_atoms (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  atom_order INTEGER NOT NULL CHECK (atom_order >= 0),
  atom_id TEXT NOT NULL,
  atom_kind TEXT NOT NULL,
  required_resources_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (store_epoch, commit_seq, atom_order),
  UNIQUE (store_epoch, commit_seq, atom_id),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(atom_id) = 64 AND atom_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (atom_kind IN (
    'library_navigation_changed',
    'database_changed',
    'owned_document_changed',
    'project_workspace_changed',
    'automation_changed',
    'store_administration_changed'
  )),
  CHECK (
    json_valid(required_resources_json)
    AND json_type(required_resources_json) = 'array'
    AND json_array_length(required_resources_json) > 0
  ),
  CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID, STRICT;
CREATE TABLE "data_source_properties" (
  data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  rank_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (data_source_id, id),
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(name) BETWEEN 1 AND 256),
  CHECK (value_type IN (
    'text', 'number', 'checkbox', 'select', 'multi_select',
    'date', 'datetime', 'relation'
  )),
  CHECK (lifecycle IN ('active', 'deleted')),
  CHECK (json_valid(config_json) AND json_type(config_json) = 'object')
) WITHOUT ROWID;
CREATE TABLE data_source_page_layouts (
  data_source_id TEXT PRIMARY KEY REFERENCES data_sources(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
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
CREATE TABLE retired_data_source_property_ids (
  data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY (data_source_id, property_id),
  CHECK (length(property_id) BETWEEN 1 AND 128),
  CHECK (length(retired_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE "data_source_property_values" (
  data_source_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (data_source_id, membership_id, property_id),
  FOREIGN KEY (membership_id, data_source_id)
    REFERENCES data_source_page_memberships(id, data_source_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (data_source_id, property_id)
    REFERENCES "data_source_properties"(data_source_id, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (value_type IN (
    'text', 'number', 'checkbox', 'select', 'multi_select',
    'date', 'datetime', 'relation'
  )),
  CHECK (json_valid(value_json)),
  CHECK (value_type <> 'relation' OR json_type(value_json) = 'null')
) WITHOUT ROWID;
CREATE TABLE "data_source_relation_properties" (
  data_source_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  target_data_source_id TEXT NOT NULL, cardinality TEXT NOT NULL DEFAULT 'many' CHECK (cardinality IN ('one', 'many')),
  PRIMARY KEY (data_source_id, property_id),
  FOREIGN KEY (data_source_id, property_id)
    REFERENCES "data_source_properties"(data_source_id, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (target_data_source_id)
    REFERENCES data_sources(id)
    ON UPDATE CASCADE ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID, STRICT;
CREATE TABLE "data_source_relation_edges" (
  edge_id TEXT NOT NULL UNIQUE,
  source_data_source_id TEXT NOT NULL,
  source_membership_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  target_page_block_id TEXT NOT NULL,
  created_at TEXT NOT NULL, sibling_rank TEXT CHECK (sibling_rank IS NULL OR length(sibling_rank) BETWEEN 1 AND 512), target_data_source_id TEXT REFERENCES data_sources(id),
  PRIMARY KEY (
    source_data_source_id,
    source_membership_id,
    property_id,
    target_page_block_id
  ),
  FOREIGN KEY (source_data_source_id, property_id)
    REFERENCES "data_source_relation_properties"(data_source_id, property_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (source_data_source_id, source_membership_id, property_id)
    REFERENCES "data_source_property_values"(
      data_source_id,
      membership_id,
      property_id
    ) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (target_page_block_id)
    REFERENCES blocks(id)
    ON UPDATE CASCADE ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(edge_id) = 64 AND edge_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(created_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE local_commit_library_effects (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  effect_order INTEGER NOT NULL CHECK (effect_order >= 0),
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  module_name TEXT NOT NULL CHECK (module_name = 'store_administration'),
  effect_kind TEXT NOT NULL CHECK (effect_kind = 'store_administration.changed'),
  operation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (store_epoch, commit_seq, effect_order),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(library_id) BETWEEN 1 AND 512),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID, STRICT;
CREATE TABLE local_commit_sealed_projection_effects (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  effect_order INTEGER NOT NULL CHECK (effect_order >= 0),
  descriptor_json TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  PRIMARY KEY (store_epoch, commit_seq, effect_order),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (json_valid(descriptor_json) AND json_type(descriptor_json) = 'object'),
  CHECK (length(descriptor_hash) = 64 AND descriptor_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID, STRICT;
CREATE TABLE projection_scope_heads (
  store_epoch TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_schema_version INTEGER NOT NULL CHECK (scope_schema_version >= 1),
  scope_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  covered_commit_seq INTEGER NOT NULL CHECK (covered_commit_seq >= 1),
  effect_hash TEXT NOT NULL,
  PRIMARY KEY (store_epoch, scope_key),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(scope_key) BETWEEN 1 AND 128),
  CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'),
  CHECK (length(effect_hash) = 64 AND effect_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID, STRICT;
CREATE TABLE "database_views" (
  id TEXT PRIMARY KEY,
  database_block_id TEXT NOT NULL,
  data_source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  layout TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  rank_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (database_block_id)
    REFERENCES database_containers(block_id) ON DELETE CASCADE,
  FOREIGN KEY (data_source_id, database_block_id)
    REFERENCES data_sources(id, home_database_block_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (layout IN ('board', 'list')),
  CHECK (lifecycle IN ('active', 'deleted')),
  CHECK (json_valid(config_json) AND json_type(config_json) = 'object')
) WITHOUT ROWID, STRICT;
CREATE TABLE "database_view_order_import_positions" (
  view_id TEXT NOT NULL,
  page_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  rank_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (view_id, page_block_id),
  FOREIGN KEY (view_id) REFERENCES "database_views"(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE "database_view_personal_preferences" (
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          preferences_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (member_id, view_id),
          CHECK (
            json_valid(preferences_json)
            AND json_type(preferences_json) = 'object'
          )
        ) WITHOUT ROWID, STRICT;
CREATE TABLE "database_view_collapsed_occurrences" (
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          target_kind TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          collapsed_at TEXT NOT NULL,
          PRIMARY KEY (member_id, view_id, target_kind, occurrence_key),
          CHECK (target_kind IN ('group', 'page')),
          CHECK (length(occurrence_key) BETWEEN 1 AND 1024),
          CHECK (
            (target_kind = 'group' AND substr(occurrence_key, 1, 6) = 'GROUP_')
            OR (target_kind = 'page' AND substr(occurrence_key, 1, 5) = 'ITEM_')
          )
        ) WITHOUT ROWID, STRICT;
CREATE TABLE "blocks" (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  placement_revision INTEGER NOT NULL DEFAULT 1 CHECK (placement_revision >= 1),
  metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK (metadata_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, library_id),
  CHECK (lifecycle IN ('active', 'archived', 'deleted'))
) STRICT;
CREATE TABLE "documents" (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  head_seq INTEGER NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  schema_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  state_vector BLOB NOT NULL DEFAULT X'',
  state_hash TEXT NOT NULL DEFAULT '',
  readiness TEXT NOT NULL DEFAULT 'pending_genesis',
  authority TEXT NOT NULL DEFAULT 'legacy_shadow',
  genesis_source_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_engine TEXT NOT NULL DEFAULT 'yjs' CHECK (sync_engine IN ('yjs', 'canvas_scene')),
  UNIQUE (id, library_id),
  CHECK (readiness IN ('pending_genesis', 'ready', 'failed')),
  CHECK (authority IN ('legacy_shadow', 'ydoc_primary')),
  CHECK (authority <> 'ydoc_primary' OR readiness = 'ready')
) STRICT;
CREATE TABLE "pages" (
  block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  document_id TEXT NOT NULL UNIQUE,
  parent_kind TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, status_person_revision INTEGER NOT NULL DEFAULT 0 CHECK(status_person_revision >= 0),
  FOREIGN KEY (block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CHECK (parent_kind IN ('library', 'page', 'data_source')),
  CHECK (length(trim(parent_id)) BETWEEN 1 AND 512),
  CHECK (parent_kind <> 'library' OR parent_id = library_id),
  CHECK (parent_kind <> 'page' OR parent_id <> block_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE managed_blobs (
  content_hash TEXT PRIMARY KEY,
  physical_asset_name TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL,
  CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(physical_asset_name) BETWEEN 1 AND 255),
  CHECK (physical_asset_name NOT IN ('.', '..')),
  CHECK (physical_asset_name NOT LIKE '%/%'),
  CHECK (physical_asset_name NOT LIKE '%\%'),
  CHECK (length(created_at) > 0)
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
CREATE TABLE page_file_manifests (
  page_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  body_usage_revision INTEGER NOT NULL DEFAULT 0 CHECK (body_usage_revision >= 0),
  FOREIGN KEY (page_id, library_id)
    REFERENCES pages(block_id, library_id) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE library_files (
  file_id TEXT PRIMARY KEY CHECK (length(file_id) BETWEEN 1 AND 512),
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  default_name TEXT NOT NULL CHECK (length(default_name) BETWEEN 1 AND 255),
  head_version INTEGER NOT NULL CHECK (head_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('live', 'trashed')),
  created_by_turn_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0), created_by_actor_json TEXT CHECK(created_by_actor_json IS NULL OR json_valid(created_by_actor_json)),
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
  turn_id TEXT,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)),
  PRIMARY KEY (file_id, version),
  UNIQUE (file_id, version, library_id),
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID, STRICT;
CREATE TABLE "page_file_entries" (
  page_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  logical_path TEXT NOT NULL CHECK (length(logical_path) BETWEEN 1 AND 1024),
  path_key TEXT NOT NULL CHECK (length(path_key) BETWEEN 1 AND 1024),
  attached_by_json TEXT NOT NULL CHECK(json_valid(attached_by_json) AND COALESCE(json_extract(attached_by_json,'$.type') IN ('member','agent','service'),0)),
  attached_at TEXT,
  PRIMARY KEY (page_id, file_id),
  UNIQUE (page_id, path_key),
  FOREIGN KEY (page_id, library_id) REFERENCES pages(block_id, library_id)
    ON DELETE CASCADE,
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;
CREATE TABLE retired_file_ids (
  file_id TEXT PRIMARY KEY CHECK (length(file_id) BETWEEN 1 AND 512),
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  retired_at TEXT NOT NULL CHECK (length(retired_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE file_import_events (
  file_id TEXT NOT NULL REFERENCES library_files(file_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  PRIMARY KEY (file_id, source_version)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_library_files_catalog
  ON library_files(library_id, lifecycle, default_name COLLATE NOCASE, file_id);
CREATE INDEX idx_file_versions_blob ON file_versions(blob_hash);
CREATE INDEX idx_page_file_entries_file ON page_file_entries(file_id,page_id);
CREATE TRIGGER library_files_retain_document_history BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM document_version_file_refs reference WHERE reference.file_id = OLD.file_id AND reference.library_id = OLD.library_id)
BEGIN
  SELECT RAISE(ABORT, 'File is retained by Document history');
END;
CREATE TRIGGER library_files_validate_insert
BEFORE INSERT ON library_files
WHEN EXISTS (SELECT 1 FROM retired_file_ids retired WHERE retired.file_id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'Retired File identities cannot be reused');
END;
CREATE TRIGGER library_files_validate_update
BEFORE UPDATE ON library_files
WHEN NEW.file_id <> OLD.file_id OR NEW.library_id <> OLD.library_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.head_version < OLD.head_version
  OR NEW.created_by_actor_json <> OLD.created_by_actor_json
  OR NEW.created_by_turn_id IS NOT OLD.created_by_turn_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'File updates must preserve identity and advance revision');
END;
CREATE TRIGGER library_files_validate_trash BEFORE UPDATE OF lifecycle ON library_files
WHEN NEW.lifecycle = 'trashed' AND (
  EXISTS (SELECT 1 FROM page_file_entries WHERE file_id = NEW.file_id AND library_id = NEW.library_id)
  OR EXISTS (SELECT 1 FROM block_asset_refs WHERE file_id = NEW.file_id AND library_id = NEW.library_id)
  OR EXISTS (SELECT 1 FROM canvas_scene_file_refs WHERE target_file_id = NEW.file_id AND library_id = NEW.library_id)
)
BEGIN SELECT RAISE(ABORT, 'Current or recoverable content prevents File trash'); END;
CREATE TRIGGER library_files_require_retirement BEFORE DELETE ON library_files
WHEN NOT EXISTS (SELECT 1 FROM retired_file_ids WHERE file_id = OLD.file_id AND library_id = OLD.library_id)
BEGIN SELECT RAISE(ABORT, 'Permanent File deletion must retire its identity'); END;
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
CREATE TRIGGER file_versions_reject_update
BEFORE UPDATE ON file_versions
BEGIN
  SELECT RAISE(ABORT, 'File versions are immutable');
END;
CREATE TABLE "block_properties" (
  block_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  property_key TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (block_id, property_key),
  FOREIGN KEY (block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (length(property_key) BETWEEN 1 AND 128),
  CHECK (value_type IN ('null', 'boolean', 'number', 'string', 'json')),
  CHECK (
    CASE
      WHEN json_valid(value_json) = 0 THEN 0
      WHEN json_type(value_json) = 'null' THEN value_type IN ('null', 'string', 'json')
      WHEN value_type = 'boolean' THEN json_type(value_json) IN ('true', 'false')
      WHEN value_type = 'number' THEN json_type(value_json) IN ('integer', 'real')
      WHEN value_type = 'string' THEN json_type(value_json) = 'text'
      WHEN value_type = 'json' THEN json_type(value_json) IN ('array', 'object')
      ELSE 0
    END
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE "block_documents" (
  block_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (block_id, library_id)
    REFERENCES blocks(id, library_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;
CREATE TABLE "block_asset_refs" (
  document_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  owner_block_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  document_generation INTEGER NOT NULL CHECK (document_generation >= 1),
  projected_seq INTEGER NOT NULL CHECK (projected_seq >= 0),
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  asset_uri TEXT NOT NULL,
  asset_hash TEXT,
  file_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, block_id, role, ordinal),
  FOREIGN KEY (file_id, library_id) REFERENCES library_files(file_id, library_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (owner_block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (length(role) BETWEEN 1 AND 128),
  CHECK (length(asset_uri) BETWEEN 1 AND 4096),
  CHECK (
    asset_hash IS NULL OR (
      length(asset_hash) = 64 AND asset_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (file_id IS NULL AND asset_uri NOT LIKE 'nodex://files/%')
    OR (file_id IS NOT NULL
      AND asset_uri = 'nodex://files/' || file_id
      AND asset_hash IS NOT NULL)
  ),
  CHECK (length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE "block_search_units" (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_key TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  owner_block_id TEXT NOT NULL,
  document_id TEXT,
  document_generation INTEGER,
  projected_seq INTEGER,
  source_revision INTEGER,
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
  source_kind TEXT NOT NULL,
  field_key TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (owner_block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (block_id, source_kind, field_key),
  CHECK (length(unit_key) BETWEEN 1 AND 1024),
  CHECK (length(source_kind) BETWEEN 1 AND 128),
  CHECK (length(field_key) BETWEEN 1 AND 256),
  CHECK (length(text_hash) = 64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(updated_at) > 0),
  CHECK (
    (document_id IS NOT NULL
      AND document_generation >= 1
      AND projected_seq >= 0
      AND source_revision IS NULL)
    OR (document_id IS NULL
      AND document_generation IS NULL
      AND projected_seq IS NULL
      AND source_revision >= 1
      AND owner_block_id = block_id)
  )
) STRICT;
CREATE TABLE "canvas_page_references" (
  document_id TEXT NOT NULL,
  source_element_id TEXT NOT NULL,
  target_block_id TEXT NOT NULL,
  owner_block_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  document_generation INTEGER NOT NULL CHECK (document_generation >= 1),
  projected_seq INTEGER NOT NULL CHECK (projected_seq >= 0),
  title_hint TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, source_element_id),
  FOREIGN KEY (target_block_id) REFERENCES blocks(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_block_id, document_id, library_id)
    REFERENCES block_documents(block_id, document_id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON DELETE CASCADE,
  CHECK (length(source_element_id) BETWEEN 1 AND 512),
  CHECK (title_hint IS NULL OR length(title_hint) <= 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE "canvas_scene_file_refs" (
  document_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  owner_block_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  document_generation INTEGER NOT NULL CHECK (document_generation >= 1),
  projected_seq INTEGER NOT NULL CHECK (projected_seq >= 0),
  mime_type TEXT NOT NULL,
  asset_uri TEXT NOT NULL,
  target_file_id TEXT NOT NULL,
  file_version INTEGER NOT NULL CHECK (file_version >= 1),
  default_name TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, file_id),
  FOREIGN KEY (target_file_id, file_version, library_id) REFERENCES file_versions(file_id, version, library_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_block_id, document_id, library_id)
    REFERENCES block_documents(block_id, document_id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON DELETE CASCADE,
  CHECK (length(file_id) BETWEEN 1 AND 512),
  CHECK (length(mime_type) BETWEEN 1 AND 256),
  CHECK (length(asset_uri) BETWEEN 1 AND 4096),
  CHECK (length(target_file_id) BETWEEN 1 AND 512),
  CHECK (length(default_name) BETWEEN 1 AND 255),
  CHECK (length(asset_hash) = 64 AND asset_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID, STRICT;
CREATE TABLE "page_read_model" (
  page_block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  parent_kind TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  library_rank_key TEXT,
  placement_revision INTEGER NOT NULL CHECK (placement_revision >= 1),
  metadata_revision INTEGER NOT NULL CHECK (metadata_revision >= 1),
  document_id TEXT NOT NULL UNIQUE,
  document_generation INTEGER NOT NULL CHECK (document_generation >= 1),
  document_projected_seq INTEGER NOT NULL CHECK (document_projected_seq >= 0),
  document_schema_version INTEGER NOT NULL CHECK (document_schema_version >= 1),
  document_authority TEXT NOT NULL,
  membership_id TEXT,
  database_block_id TEXT,
  view_id TEXT,
  view_group_key TEXT,
  view_rank_key TEXT,
  title TEXT NOT NULL,
  description_preview TEXT NOT NULL,
  description_length INTEGER NOT NULL CHECK (description_length >= 0),
  has_description INTEGER NOT NULL CHECK (has_description IN (0, 1)),
  database_values_json TEXT NOT NULL DEFAULT '{}',
  intrinsic_properties_json TEXT NOT NULL DEFAULT '{}',
  property_revisions_json TEXT NOT NULL DEFAULT '{}',
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (page_block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (membership_id)
    REFERENCES data_source_page_memberships(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (database_block_id)
    REFERENCES database_containers(block_id) ON DELETE RESTRICT,
  FOREIGN KEY (view_id)
    REFERENCES database_views(id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (lifecycle IN ('active', 'archived', 'deleted')),
  CHECK (parent_kind IN ('library', 'page', 'data_source')),
  CHECK (
    (parent_kind = 'library' AND lifecycle <> 'deleted' AND library_rank_key IS NOT NULL)
    OR ((parent_kind <> 'library' OR lifecycle = 'deleted') AND library_rank_key IS NULL)
  ),
  CHECK (document_authority IN ('legacy_shadow', 'ydoc_primary')),
  CHECK (
    (membership_id IS NULL AND database_block_id IS NULL)
    OR (membership_id IS NOT NULL AND database_block_id IS NOT NULL)
  ),
  CHECK (view_id IS NULL OR membership_id IS NOT NULL),
  CHECK (json_valid(database_values_json) AND json_type(database_values_json) = 'object'),
  CHECK (json_valid(intrinsic_properties_json) AND json_type(intrinsic_properties_json) = 'object'),
  CHECK (json_valid(property_revisions_json) AND json_type(property_revisions_json) = 'object'),
  CHECK (length(created_at) > 0 AND length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE "recurrence_exceptions" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  occurrence_start TEXT NOT NULL,
  exception_type TEXT NOT NULL,
  override_start TEXT,
  override_end TEXT,
  override_reminders_json TEXT,
  created TEXT NOT NULL,
  FOREIGN KEY (page_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (exception_type IN ('skip', 'override_time'))
) STRICT;
CREATE TABLE "reminder_receipts" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  page_id TEXT NOT NULL,
  occurrence_start TEXT NOT NULL,
  reminder_offset_minutes INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  FOREIGN KEY (page_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
CREATE TABLE "reminder_snoozes" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  page_id TEXT NOT NULL,
  occurrence_start TEXT NOT NULL,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (page_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
CREATE TABLE "scheduled_page_index" (
  page_block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  scheduled_start TEXT,
  scheduled_end TEXT,
  is_all_day INTEGER NOT NULL DEFAULT 0 CHECK (is_all_day IN (0, 1)),
  recurrence_json TEXT NOT NULL DEFAULT 'null',
  reminders_json TEXT NOT NULL DEFAULT '[]',
  schedule_timezone TEXT,
  source_metadata_revision INTEGER NOT NULL CHECK (source_metadata_revision >= 1),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (page_block_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (lifecycle IN ('active', 'archived', 'deleted')),
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start),
  CHECK (is_all_day = 0 OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)),
  CHECK (json_valid(recurrence_json) AND json_type(recurrence_json) IN ('null', 'object')),
  CHECK (json_valid(reminders_json) AND json_type(reminders_json) = 'array')
) WITHOUT ROWID, STRICT;
CREATE TABLE "core_reminder_leases" (
  lease_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  receipt_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  page_id TEXT NOT NULL,
  occurrence_start_ms INTEGER NOT NULL CHECK (occurrence_start_ms >= 0),
  reminder_offset_minutes INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL CHECK (due_at_ms >= 0),
  title TEXT NOT NULL,
  snooze_id INTEGER REFERENCES reminder_snoozes(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4294967295),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed', 'cancelled')),
  claimed_at_ms INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > claimed_at_ms),
  settled_at_ms INTEGER,
  retry_at_ms INTEGER,
  reason_code TEXT,
  UNIQUE (receipt_project_id, page_id, occurrence_start_ms, reminder_offset_minutes, attempt),
  FOREIGN KEY (page_id, library_id)
    REFERENCES blocks(id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (length(lease_id) BETWEEN 1 AND 512),
  CHECK (length(title) <= 16384),
  CHECK (settled_at_ms IS NULL OR settled_at_ms >= claimed_at_ms),
  CHECK (retry_at_ms IS NULL OR retry_at_ms >= 0),
  CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  CHECK (
    (status = 'claimed' AND settled_at_ms IS NULL)
    OR (status <> 'claimed' AND settled_at_ms IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE "retired_block_identities" (
  block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  block_type TEXT NOT NULL,
  retention_root_block_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  CHECK (length(block_id) BETWEEN 1 AND 512 AND block_id = trim(block_id)),
  CHECK (length(library_id) BETWEEN 1 AND 512 AND library_id = trim(library_id)),
  CHECK (length(block_type) BETWEEN 1 AND 512 AND block_type = trim(block_type)),
  CHECK (
    length(retention_root_block_id) BETWEEN 1 AND 512
    AND retention_root_block_id = trim(retention_root_block_id)
  ),
  CHECK (length(retired_at) > 0)
) WITHOUT ROWID, STRICT;
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
CREATE TABLE "block_relocation_members" (
  relocation_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  tree_ordinal INTEGER NOT NULL CHECK (tree_ordinal >= 0),
  is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
  source_placement_revision INTEGER NOT NULL CHECK (source_placement_revision >= 1),
  final_placement_revision INTEGER NOT NULL CHECK (final_placement_revision >= 2),
  PRIMARY KEY (relocation_id, block_id),
  UNIQUE (relocation_id, tree_ordinal),
  FOREIGN KEY (relocation_id, library_id)
    REFERENCES block_relocations(id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (block_id, library_id)
    REFERENCES blocks(id, library_id) ON DELETE RESTRICT,
  CHECK (final_placement_revision = source_placement_revision + 1)
) WITHOUT ROWID, STRICT;
CREATE TABLE document_block_tombstones ( block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, document_generation INTEGER NOT NULL CHECK (document_generation >= 1), deletion_head_seq INTEGER NOT NULL CHECK (deletion_head_seq >= 1), placement_revision INTEGER NOT NULL CHECK (placement_revision >= 2), deleted_at TEXT NOT NULL, CHECK (length(block_id) BETWEEN 1 AND 512), CHECK (length(library_id) BETWEEN 1 AND 512), CHECK (length(document_id) BETWEEN 1 AND 512), CHECK (length(deleted_at) > 0) ) WITHOUT ROWID, STRICT;
CREATE TABLE local_commit_relocation_obligations ( store_epoch TEXT NOT NULL, commit_seq INTEGER NOT NULL, block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE RESTRICT, source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT, PRIMARY KEY (store_epoch, commit_seq, block_id), FOREIGN KEY (store_epoch, commit_seq) REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE, CHECK (length(store_epoch) BETWEEN 1 AND 512), CHECK (length(block_id) BETWEEN 1 AND 512), CHECK (length(source_document_id) BETWEEN 1 AND 512) ) WITHOUT ROWID, STRICT;
CREATE TABLE page_key_namespaces (
  database_block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (database_block_id, library_id),
  FOREIGN KEY (database_block_id, library_id)
    REFERENCES database_containers(block_id, library_id) ON DELETE RESTRICT,
  CHECK (length(created_at) > 0 AND length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE page_key_prefixes (
  library_id TEXT NOT NULL,
  normalized_prefix TEXT NOT NULL,
  database_block_id TEXT NOT NULL,
  last_number INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  activated_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (library_id, normalized_prefix),
  FOREIGN KEY (database_block_id, library_id)
    REFERENCES page_key_namespaces(database_block_id, library_id) ON DELETE RESTRICT,
  CHECK (length(normalized_prefix) BETWEEN 2 AND 8),
  CHECK (substr(normalized_prefix, 1, 1) BETWEEN 'A' AND 'Z'),
  CHECK (normalized_prefix NOT GLOB '*[^A-Z0-9]*'),
  CHECK (length(activated_at) > 0),
  CHECK (
    (retired_at IS NULL AND last_number IS NULL)
    OR (retired_at IS NOT NULL AND length(retired_at) > 0 AND last_number >= 1)
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE page_key_assignments (
  database_block_id TEXT NOT NULL
    REFERENCES page_key_namespaces(database_block_id) ON DELETE RESTRICT,
  page_block_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  assigned_at TEXT NOT NULL CHECK (length(assigned_at) > 0),
  PRIMARY KEY (database_block_id, page_block_id),
  UNIQUE (database_block_id, number)
) WITHOUT ROWID, STRICT;
CREATE TABLE document_page_references ( document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, source_owner_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, source_block_id TEXT NOT NULL, target_page_id TEXT NOT NULL CHECK (length(target_page_id) BETWEEN 1 AND 512), presentation TEXT NOT NULL CHECK (presentation IN ('mention', 'reference_block', 'link')), occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 1), updated_at TEXT NOT NULL CHECK (length(updated_at) > 0), PRIMARY KEY (document_id, source_block_id, target_page_id, presentation) ) WITHOUT ROWID, STRICT;
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
CREATE TABLE structural_clipboard_bundles (
  bundle_id TEXT PRIMARY KEY,
  capture_operation_id TEXT NOT NULL UNIQUE
    REFERENCES block_mutations(mutation_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(bundle_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(capability_hash) = 64 AND capability_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(snapshot_json) BETWEEN 2 AND 67108864
    AND json_valid(snapshot_json)
    AND json_type(snapshot_json) = 'object'),
  CHECK (length(created_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE structural_clipboard_leases (
  bundle_id TEXT PRIMARY KEY
    REFERENCES structural_clipboard_bundles(bundle_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  released_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'active' AND released_at IS NULL)
    OR (state = 'released' AND length(released_at) > 0)),
  CHECK (length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE structural_cut_claims (
  bundle_id TEXT PRIMARY KEY
    REFERENCES structural_clipboard_bundles(bundle_id) ON DELETE CASCADE,
  source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  source_root_ids_json TEXT NOT NULL,
  delete_recipe_operation_id TEXT NOT NULL UNIQUE
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('available', 'consumed', 'revoked')),
  consumed_by_operation_id TEXT REFERENCES block_mutations(mutation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(source_root_ids_json)
    AND json_type(source_root_ids_json) = 'array'
    AND json_array_length(source_root_ids_json) BETWEEN 1 AND 10000),
  CHECK ((state = 'consumed' AND consumed_by_operation_id IS NOT NULL)
    OR (state <> 'consumed' AND consumed_by_operation_id IS NULL)),
  CHECK (length(created_at) > 0),
  CHECK (length(updated_at) > 0)
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
CREATE TABLE editor_history_owners (
  owner_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  peer_pid INTEGER NOT NULL CHECK (peer_pid > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'closed')), peer_started INTEGER NOT NULL DEFAULT 0 CHECK (peer_started >= 0),
  CHECK (length(owner_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE editor_history_recipes (
  recipe_operation_id TEXT PRIMARY KEY
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES editor_history_owners(owner_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_editor_history_recipes_owner ON editor_history_recipes(owner_id);
CREATE INDEX idx_editor_history_owners_peer ON editor_history_owners(peer_pid, peer_started);
CREATE INDEX idx_editor_history_owners_active ON editor_history_owners(state) WHERE state = 'active';
CREATE TABLE editor_history_cleanup (
  owner_id TEXT PRIMARY KEY REFERENCES editor_history_owners(owner_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE structural_history_root_cleanup (
  recipe_operation_id TEXT PRIMARY KEY REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
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
CREATE INDEX idx_editor_history_local_sets_active ON editor_history_local_sets(owner_id) WHERE closed = 0;
CREATE TABLE structural_retention_members (
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('clipboard_bundle', 'history_recipe')),
  authority_id TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('block', 'document', 'database', 'asset', 'file')),
  member_id TEXT NOT NULL,
  PRIMARY KEY (authority_kind, authority_id, member_kind, member_id),
  CHECK (length(authority_id) BETWEEN 1 AND 512),
  CHECK (length(member_id) BETWEEN 1 AND 1024)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_structural_retention_members_identity
  ON structural_retention_members(library_id, member_kind, member_id);
CREATE TRIGGER library_files_retain_structural_evidence BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM structural_retention_members member
  WHERE member.library_id = OLD.library_id AND member.member_kind = 'file' AND member.member_id = OLD.file_id)
BEGIN SELECT RAISE(ABORT, 'File is retained by structural evidence'); END;
CREATE INDEX idx_structural_history_recipes_state
  ON structural_history_recipes(library_id, state, created_at);
CREATE INDEX idx_project_sources_project_order
      ON project_sources(project_id, "order", created);
CREATE INDEX idx_codex_background_processes_thread_updated
      ON codex_background_processes(thread_id, updated_at_ms DESC, process_record_id);
CREATE INDEX idx_codex_pinned_threads_order
      ON codex_pinned_threads(pinned_order, created_at);
CREATE INDEX idx_document_updates_tail
      ON document_updates(document_id, generation, seq);
CREATE INDEX idx_document_block_index_parent_order
      ON document_block_index(document_id, parent_block_id, ordinal, block_id);
CREATE INDEX idx_change_log_project_seq
      ON change_log(project_id, seq);
CREATE INDEX idx_change_log_kind_seq
      ON change_log(kind, seq);
CREATE UNIQUE INDEX idx_change_log_operation
      ON change_log(project_id, kind, operation_id)
      WHERE operation_id IS NOT NULL;
CREATE INDEX idx_block_relocation_source_states_document
      ON block_relocation_source_states(document_id, generation, head_seq);
CREATE INDEX idx_document_recovery_artifacts_document
      ON document_recovery_artifacts(
        document_id, generation, status, created_at, id
      );
CREATE INDEX idx_document_recovery_artifacts_expiry
      ON document_recovery_artifacts(status, expires_at, id);
CREATE INDEX idx_document_versions_document_head
      ON document_versions(document_id, generation, base_head_seq DESC, created_at DESC);
CREATE INDEX idx_document_versions_project_created
      ON document_versions(project_id, created_at DESC, version_id);
CREATE INDEX idx_document_versions_source_mutation
      ON document_versions(source_mutation_id)
      WHERE source_mutation_id IS NOT NULL;
CREATE INDEX idx_document_versions_retention
      ON document_versions(document_id, pinned, created_at DESC, version_id);
CREATE INDEX idx_document_version_retention_members_identity
      ON document_version_retention_members(member_kind, member_id, version_id);
CREATE INDEX idx_document_revision_sessions_due
      ON document_revision_sessions(last_edit_at, document_id);
CREATE INDEX idx_block_mutations_project_recorded
      ON block_mutations(project_id, recorded_at DESC, mutation_id);
CREATE INDEX idx_block_mutations_session_recorded
      ON block_mutations(project_id, client_session_id, recorded_at DESC)
      WHERE client_session_id IS NOT NULL;
CREATE INDEX idx_database_containers_library_lifecycle
      ON database_containers(library_id, lifecycle, block_id);
CREATE INDEX idx_data_sources_home_order
      ON data_sources(home_database_block_id, lifecycle, rank_key, id);
CREATE UNIQUE INDEX idx_data_source_memberships_active_page
      ON data_source_page_memberships(page_block_id)
      WHERE removed_at IS NULL;
CREATE UNIQUE INDEX idx_data_source_memberships_history
      ON data_source_page_memberships(data_source_id, page_block_id);
CREATE INDEX idx_data_source_memberships_source_active
      ON data_source_page_memberships(data_source_id, removed_at, page_block_id);
CREATE UNIQUE INDEX idx_project_database_bindings_active
      ON project_database_bindings(database_block_id)
      WHERE lifecycle = 'active';
CREATE INDEX idx_library_block_placements_order
      ON library_block_placements(library_id, rank_key, block_id);
CREATE INDEX idx_database_module_receipts_project_created
      ON database_module_receipts(project_id, created_at, operation_id);
CREATE INDEX idx_workspace_app_server_thread_observations_sweep
  ON workspace_app_server_thread_observations(last_seen_sweep_id, thread_id);
CREATE INDEX idx_workspace_subagent_descendants_parent
  ON workspace_subagent_descendants(
    host_id, source_epoch, generation, root_thread_id, parent_thread_id, thread_id
  );
CREATE INDEX idx_workspace_subagent_status_lane
  ON workspace_subagent_status_evidence(
    host_id, source_epoch, generation, root_thread_id, status, thread_id
  );
CREATE INDEX idx_workspace_subagent_pending_status_recency
  ON workspace_subagent_pending_status_evidence(
    library_id, observed_at_ms DESC, source_revision DESC, host_id, thread_id
  );
CREATE INDEX idx_canvas_scene_elements_order
           ON canvas_scene_elements(document_id, order_key, element_id);
CREATE INDEX idx_canvas_scene_elements_bucket
           ON canvas_scene_elements(document_id, hash_bucket, element_id);
CREATE INDEX idx_canvas_scene_elements_file_reference
           ON canvas_scene_elements(document_id, referenced_file_id)
           WHERE referenced_file_id IS NOT NULL AND is_deleted = 0;
CREATE INDEX idx_canvas_scene_files_bucket
           ON canvas_scene_files(document_id, hash_bucket, file_id);
CREATE INDEX idx_canvas_scene_mutation_receipts_head
           ON canvas_scene_mutation_receipts(document_id, generation, committed_head_seq);
CREATE INDEX idx_canvas_owners_library
  ON canvas_owners(library_id, block_id);
CREATE UNIQUE INDEX idx_project_session_threads_thread
  ON project_session_threads(thread_id);
CREATE INDEX idx_project_session_pages_page
  ON project_session_pages(page_id, session_id);
CREATE INDEX idx_local_commits_epoch_seq
  ON local_commits(store_epoch, commit_seq);
CREATE INDEX idx_local_commits_retention
  ON local_commits(store_epoch, committed_at, commit_seq);
CREATE INDEX idx_local_commit_retention_metadata_age
  ON local_commit_retention_metadata(store_epoch, sealed_at_ms, commit_seq);
CREATE INDEX idx_local_commit_effects_change_log
  ON local_commit_effects(change_log_seq);
CREATE INDEX idx_document_versions_source_change
  ON document_versions(source_change_seq)
  WHERE source_change_seq IS NOT NULL;
CREATE INDEX idx_database_module_receipts_change_log
  ON database_module_receipts(change_log_seq)
  WHERE change_log_seq IS NOT NULL;
CREATE INDEX idx_local_commit_documents_document
  ON local_commit_documents(document_id, generation, head_seq);
CREATE INDEX idx_core_module_receipts_local_commit
  ON core_module_receipts(store_epoch, local_commit_seq);
CREATE INDEX idx_core_module_receipts_event_sequence
  ON core_module_receipts(event_sequence)
  WHERE event_sequence IS NOT NULL;
CREATE INDEX idx_core_module_receipts_retention
  ON core_module_receipts(committed_at, module_name, operation_id);
CREATE INDEX idx_detached_module_receipts_retention
  ON detached_module_receipts(detached_at_ms, local_commit_seq);
CREATE INDEX idx_detached_module_receipts_expiry
  ON detached_module_receipts(operation_kind, committed_at, module_name, operation_id);
CREATE INDEX idx_module_receipt_retention_expiry
  ON module_receipt_retention_metadata(expires_at_ms, issued_at_ms, module_name, operation_id);
CREATE INDEX idx_module_receipt_retention_prune
  ON module_receipt_retention_metadata(issued_at_ms, module_name, operation_id);
CREATE INDEX idx_local_commit_delivery_atoms_id
  ON local_commit_delivery_atoms(atom_id);
CREATE INDEX idx_data_source_properties_order
  ON data_source_properties(data_source_id, lifecycle, rank_key, id);
CREATE INDEX idx_data_source_property_values_property
  ON data_source_property_values(data_source_id, property_id, membership_id);
CREATE INDEX idx_data_source_relation_properties_target
  ON data_source_relation_properties(
    target_data_source_id,
    data_source_id,
    property_id
  );
CREATE INDEX idx_data_source_relation_edges_property_target
  ON data_source_relation_edges(
    source_data_source_id,
    property_id,
    target_page_block_id,
    source_membership_id
  );
CREATE INDEX idx_data_source_relation_edges_target
  ON data_source_relation_edges(
    target_page_block_id,
    source_data_source_id,
    property_id,
    source_membership_id
  );
CREATE INDEX idx_local_commit_library_effects_library
  ON local_commit_library_effects(library_id, commit_seq);
CREATE INDEX idx_local_commit_documents_commit_order
  ON local_commit_documents(store_epoch, commit_seq, document_order);
CREATE INDEX idx_projection_scope_heads_commit
  ON projection_scope_heads(store_epoch, covered_commit_seq);
CREATE INDEX idx_database_views_database_order
  ON database_views(database_block_id, lifecycle, rank_key, id);
CREATE INDEX idx_database_views_source
  ON database_views(data_source_id, lifecycle, id);
CREATE INDEX idx_database_view_page_positions_order ON "database_view_order_import_positions"(view_id, rank_key, page_block_id);
CREATE UNIQUE INDEX idx_data_source_task_parent_single_target
          ON data_source_relation_edges(
            source_data_source_id, source_membership_id, property_id
          ) WHERE property_id = 'task_parent';
CREATE INDEX idx_data_source_task_parent_children_order
          ON data_source_relation_edges(
            source_data_source_id, property_id, target_page_block_id,
            sibling_rank, source_membership_id
          ) WHERE property_id = 'task_parent';
CREATE INDEX idx_database_view_collapsed_occurrences_age
          ON database_view_collapsed_occurrences(
            member_id, view_id, collapsed_at, target_kind, occurrence_key
          );
CREATE INDEX idx_blocks_library_lifecycle_type
  ON blocks(library_id, lifecycle, type);
CREATE INDEX idx_blocks_library_lifecycle_updated
  ON blocks(library_id, lifecycle, updated_at DESC, id DESC);
CREATE INDEX idx_block_retention_deferrals_retry
  ON block_retention_deferrals(retry_after_ms, root_block_id);
CREATE INDEX idx_documents_library_readiness
  ON documents(library_id, readiness, authority);
CREATE INDEX idx_pages_library_parent
  ON pages(library_id, parent_kind, parent_id, block_id);
CREATE UNIQUE INDEX idx_pages_owner_library
  ON pages(block_id, library_id);
CREATE UNIQUE INDEX idx_pages_owner_document_library
  ON pages(block_id, document_id, library_id);
CREATE INDEX idx_prepared_blob_receipts_expiry
  ON prepared_blob_receipts(state, expires_at_unix_ms, receipt_id);
CREATE INDEX idx_prepared_blob_receipts_blob
  ON prepared_blob_receipts(content_hash, state, receipt_id);
CREATE INDEX idx_block_properties_library_key
  ON block_properties(library_id, property_key, block_id);
CREATE UNIQUE INDEX idx_block_documents_owner_document_library
  ON block_documents(block_id, document_id, library_id);
CREATE INDEX idx_block_asset_refs_block ON block_asset_refs(block_id, library_id);
CREATE INDEX idx_block_asset_refs_owner ON block_asset_refs(owner_block_id, library_id);
CREATE INDEX idx_block_asset_refs_document_freshness
  ON block_asset_refs(document_id, document_generation, projected_seq);
CREATE INDEX idx_block_asset_refs_library_uri
  ON block_asset_refs(library_id, asset_uri, block_id);
CREATE INDEX idx_block_asset_refs_page_file
  ON block_asset_refs(file_id, document_id, block_id)
  WHERE file_id IS NOT NULL;
CREATE INDEX idx_block_search_units_block ON block_search_units(block_id, library_id);
CREATE INDEX idx_block_search_units_owner ON block_search_units(owner_block_id, library_id);
CREATE INDEX idx_block_search_units_document_freshness
  ON block_search_units(document_id, document_generation, projected_seq)
  WHERE document_id IS NOT NULL;
CREATE INDEX idx_block_search_units_library_source
  ON block_search_units(library_id, source_kind, block_id);
CREATE INDEX idx_canvas_page_references_target
  ON canvas_page_references(library_id, target_block_id, document_id);
CREATE INDEX idx_canvas_scene_file_refs_target_file
  ON canvas_scene_file_refs(target_file_id, library_id, owner_block_id);
CREATE INDEX idx_canvas_scene_file_refs_owner
  ON canvas_scene_file_refs(library_id, owner_block_id, file_id);
CREATE INDEX idx_page_read_model_library_lifecycle
  ON page_read_model(library_id, lifecycle, page_block_id);
CREATE INDEX idx_page_read_model_parent
  ON page_read_model(library_id, parent_kind, parent_id, page_block_id);
CREATE INDEX idx_page_read_model_view_order
  ON page_read_model(view_id, view_group_key, view_rank_key, page_block_id)
  WHERE view_id IS NOT NULL;
CREATE INDEX idx_page_read_model_document_freshness
  ON page_read_model(document_id, document_generation, document_projected_seq);
CREATE INDEX idx_recurrence_exceptions_lookup
  ON recurrence_exceptions(library_id, page_id, occurrence_start);
CREATE UNIQUE INDEX idx_recurrence_exceptions_unique
  ON recurrence_exceptions(library_id, page_id, occurrence_start);
CREATE INDEX idx_reminder_receipts_lookup
  ON reminder_receipts(project_id, delivered_at DESC);
CREATE UNIQUE INDEX idx_reminder_receipts_unique
  ON reminder_receipts(project_id, page_id, occurrence_start, reminder_offset_minutes);
CREATE INDEX idx_reminder_snoozes_lookup
  ON reminder_snoozes(project_id, due_at, consumed_at);
CREATE INDEX idx_scheduled_page_index_due
  ON scheduled_page_index(library_id, scheduled_start, page_block_id)
  WHERE lifecycle = 'active' AND scheduled_start IS NOT NULL;
CREATE UNIQUE INDEX idx_core_reminder_leases_active_coordinate
  ON core_reminder_leases(
    receipt_project_id, page_id, occurrence_start_ms, reminder_offset_minutes
  ) WHERE status = 'claimed';
CREATE INDEX idx_core_reminder_leases_inbox
  ON core_reminder_leases(status, expires_at_ms, due_at_ms, lease_id);
CREATE INDEX idx_retired_block_identities_library_time
  ON retired_block_identities(library_id, retired_at, block_id);
CREATE INDEX idx_block_relocations_project_committed
  ON block_relocations(project_id, committed_at, id);
CREATE INDEX idx_block_relocations_library_committed
  ON block_relocations(library_id, committed_at, id);
CREATE INDEX idx_block_relocations_source
  ON block_relocations(source_document_id, source_generation, source_base_head_seq, id);
CREATE INDEX idx_block_relocations_target
  ON block_relocations(target_document_id, target_generation, id)
  WHERE target_document_id IS NOT NULL;
CREATE INDEX idx_block_relocation_members_block
  ON block_relocation_members(block_id, relocation_id);
CREATE INDEX idx_block_relocation_members_roots
  ON block_relocation_members(relocation_id, tree_ordinal) WHERE is_root = 1;
CREATE UNIQUE INDEX idx_document_block_index_single_host
  ON document_block_index(block_id);
CREATE INDEX idx_document_block_tombstones_document ON document_block_tombstones(document_id, deletion_head_seq, block_id);
CREATE UNIQUE INDEX idx_database_containers_block_library
  ON database_containers(block_id, library_id);
CREATE UNIQUE INDEX idx_page_key_prefixes_current_database
  ON page_key_prefixes(database_block_id)
  WHERE retired_at IS NULL;
CREATE INDEX idx_page_key_prefixes_database_history
  ON page_key_prefixes(database_block_id, retired_at, normalized_prefix);
CREATE INDEX idx_page_key_assignments_page
  ON page_key_assignments(page_block_id, database_block_id);
CREATE INDEX idx_codex_threads_project_recency ON codex_threads(project_id, recency_at DESC);
CREATE INDEX idx_document_page_references_target ON document_page_references(target_page_id, updated_at DESC, source_owner_block_id, source_block_id);
CREATE INDEX idx_block_transfer_undo_recipes_scope
  ON block_transfer_undo_recipes(library_id, project_id, created_at);
CREATE TRIGGER projects_binding_after_update
      AFTER UPDATE OF library_id, database_block_id, lifecycle,
        binding_revision, updated ON projects
      WHEN NEW.database_block_id IS NOT NULL AND NEW.library_id IS NOT NULL
      BEGIN
        INSERT INTO project_database_bindings (
          project_id, library_id, database_block_id, lifecycle, revision,
          created_at, updated_at
        ) VALUES (
          NEW.id, NEW.library_id, NEW.database_block_id, NEW.lifecycle,
          NEW.binding_revision, NEW.created, NEW.updated
        )
        ON CONFLICT(project_id) DO UPDATE SET
          library_id = excluded.library_id,
          database_block_id = excluded.database_block_id,
          lifecycle = excluded.lifecycle,
          revision = excluded.revision,
          updated_at = excluded.updated_at;
      END;
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
CREATE TRIGGER block_relocation_source_states_are_immutable
      BEFORE UPDATE ON block_relocation_source_states
      BEGIN
        SELECT RAISE(ABORT, 'committed block relocation source states are immutable');
      END;
CREATE TRIGGER change_log_is_immutable
      BEFORE UPDATE ON change_log
      BEGIN
        SELECT RAISE(ABORT, 'change log entries are immutable');
      END;
CREATE TRIGGER prevent_change_log_projection_impact_update BEFORE UPDATE OF projection_impact_json ON change_log BEGIN SELECT RAISE(ABORT, 'change_log projection impact is immutable'); END;
CREATE TRIGGER validate_change_log_projection_impact_insert BEFORE INSERT ON change_log WHEN NEW.projection_impact_json IS NULL OR NOT json_valid(NEW.projection_impact_json) OR json_type(NEW.projection_impact_json) != 'object' BEGIN SELECT RAISE(ABORT, 'change_log projection impact is required'); END;
CREATE TRIGGER data_sources_require_container_library_insert
      BEFORE INSERT ON data_sources
      WHEN NOT EXISTS (
        SELECT 1 FROM database_containers container
        WHERE container.block_id = NEW.home_database_block_id
          AND container.library_id = NEW.library_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Data Source must share its Database Container Library');
      END;
CREATE TRIGGER data_sources_require_container_library_update
      BEFORE UPDATE OF library_id, home_database_block_id ON data_sources
      WHEN NOT EXISTS (
        SELECT 1 FROM database_containers container
        WHERE container.block_id = NEW.home_database_block_id
          AND container.library_id = NEW.library_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Data Source must share its Database Container Library');
      END;
CREATE TRIGGER database_module_receipts_immutable_update
      BEFORE UPDATE ON database_module_receipts
      BEGIN
        SELECT RAISE(ABORT, 'Database Module receipts are immutable');
      END;
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
CREATE TRIGGER document_snapshots_require_yjs_engine
      BEFORE INSERT ON document_snapshots
      WHEN COALESCE((
        SELECT sync_engine FROM documents WHERE id = NEW.document_id
      ), '') <> 'yjs'
      BEGIN
        SELECT RAISE(ABORT, 'Document snapshot requires yjs sync engine');
      END;
CREATE TRIGGER document_structural_barriers_validate_insert
BEFORE INSERT ON document_structural_barriers
WHEN NOT EXISTS (
  SELECT 1 FROM documents document
  WHERE document.id = NEW.document_id
    AND document.generation = NEW.generation
    AND document.head_seq = NEW.head_seq
    AND document.readiness = 'ready'
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.block_ids_json) block_id
  WHERE block_id.type <> 'text'
    OR length(block_id.value) NOT BETWEEN 1 AND 512
) OR (
  SELECT count(*) FROM json_each(NEW.block_ids_json)
) <> (
  SELECT count(DISTINCT block_id.value)
  FROM json_each(NEW.block_ids_json) block_id
)
BEGIN
  SELECT RAISE(ABORT, 'Document structural barrier is invalid');
END;
CREATE TRIGGER document_update_receipts_require_yjs_engine
      BEFORE INSERT ON document_update_receipts
      WHEN COALESCE((
        SELECT sync_engine FROM documents WHERE id = NEW.document_id
      ), '') <> 'yjs'
      BEGIN
        SELECT RAISE(ABORT, 'Document update receipt requires yjs sync engine');
      END;
CREATE TRIGGER document_updates_require_yjs_engine
      BEFORE INSERT ON document_updates
      WHEN COALESCE((
        SELECT sync_engine FROM documents WHERE id = NEW.document_id
      ), '') <> 'yjs'
      BEGIN
        SELECT RAISE(ABORT, 'Document update requires yjs sync engine');
      END;
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
CREATE TRIGGER nodex_agent_call_receipts_validate_update
    BEFORE UPDATE ON nodex_agent_call_receipts
    WHEN OLD.status = 'committed'
      OR NEW.call_identity IS NOT OLD.call_identity
      OR NEW.thread_id IS NOT OLD.thread_id
      OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.call_id IS NOT OLD.call_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.tool IS NOT OLD.tool
      OR NEW.request_hash IS NOT OLD.request_hash
      OR NEW.mutation_id IS NOT OLD.mutation_id
      OR NEW.authority_fingerprint IS NOT OLD.authority_fingerprint
      OR NEW.provenance_version IS NOT OLD.provenance_version
      OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.status = 'prepared' AND NEW.status NOT IN ('prepared', 'committed'))
    BEGIN
      SELECT RAISE(ABORT, 'Nodex Agent call receipt identity is immutable');
    END;
CREATE TRIGGER nodex_agent_committed_call_receipts_cannot_delete
    BEFORE DELETE ON nodex_agent_call_receipts
    WHEN OLD.status = 'committed'
    BEGIN
      SELECT RAISE(ABORT, 'Committed Nodex Agent call receipts are immutable');
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
CREATE TRIGGER canvas_scene_mutation_receipts_immutable_update
           BEFORE UPDATE ON canvas_scene_mutation_receipts
           BEGIN
             SELECT RAISE(ABORT, 'Canvas scene mutation receipts are immutable');
           END;
CREATE TRIGGER canvas_scene_mutation_receipts_immutable_delete
           BEFORE DELETE ON canvas_scene_mutation_receipts
           BEGIN
             SELECT RAISE(ABORT, 'Canvas scene mutation receipts are immutable');
           END;
CREATE TRIGGER canvas_scenes_require_scene_engine
           BEFORE INSERT ON canvas_scenes
           WHEN COALESCE((
             SELECT sync_engine FROM documents WHERE id = NEW.document_id
           ), '') <> 'canvas_scene'
           BEGIN
             SELECT RAISE(ABORT, 'Canvas scene authority requires canvas_scene sync engine');
           END;
CREATE TRIGGER data_source_property_values_require_matching_type_insert
BEFORE INSERT ON data_source_property_values
WHEN NOT EXISTS (
  SELECT 1 FROM data_source_properties property
  WHERE property.data_source_id = NEW.data_source_id
    AND property.id = NEW.property_id
    AND property.value_type = NEW.value_type
    AND property.lifecycle = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'Data Source Property value must match an active Property type');
END;
CREATE TRIGGER data_source_property_values_require_matching_type_update
BEFORE UPDATE OF data_source_id, property_id, value_type
ON data_source_property_values
WHEN NOT EXISTS (
  SELECT 1 FROM data_source_properties property
  WHERE property.data_source_id = NEW.data_source_id
    AND property.id = NEW.property_id
    AND property.value_type = NEW.value_type
    AND property.lifecycle = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'Data Source Property value must match an active Property type');
END;
CREATE TRIGGER data_source_relation_properties_validate_insert
BEFORE INSERT ON data_source_relation_properties
WHEN NOT EXISTS (
  SELECT 1
  FROM data_source_properties property
  JOIN data_sources source ON source.id = property.data_source_id
  JOIN data_sources target ON target.id = NEW.target_data_source_id
  WHERE property.data_source_id = NEW.data_source_id
    AND property.id = NEW.property_id
    AND property.value_type = 'relation'
    AND property.config_json = '{}'
    AND property.lifecycle = 'active'
    AND source.lifecycle = 'active'
    AND target.lifecycle = 'active'
    AND source.library_id = target.library_id
)
BEGIN
  SELECT RAISE(ABORT, 'Relation Property must target an active Data Source in the same Library');
END;
CREATE TRIGGER data_source_relation_properties_are_immutable
BEFORE UPDATE ON data_source_relation_properties
BEGIN
  SELECT RAISE(ABORT, 'Relation Property target is immutable');
END;
CREATE TRIGGER data_source_relation_property_type_is_stable
BEFORE UPDATE OF value_type ON data_source_properties
WHEN NEW.value_type <> 'relation'
  AND EXISTS (
    SELECT 1 FROM data_source_relation_properties relation
    WHERE relation.data_source_id = OLD.data_source_id
      AND relation.property_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Relation Property type is immutable');
END;
CREATE TRIGGER database_containers_default_view_is_owned_insert
BEFORE INSERT ON database_containers
WHEN NEW.default_view_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM database_views view
    WHERE view.id = NEW.default_view_id
      AND view.database_block_id = NEW.block_id
      AND view.lifecycle = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'Database default View must be active and owned by its Container');
END;
CREATE TRIGGER database_containers_default_view_is_owned_update
BEFORE UPDATE OF default_view_id, block_id ON database_containers
WHEN NEW.default_view_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM database_views view
    WHERE view.id = NEW.default_view_id
      AND view.database_block_id = NEW.block_id
      AND view.lifecycle = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'Database default View must be active and owned by its Container');
END;
CREATE TRIGGER database_views_preserve_container_default_update
BEFORE UPDATE OF database_block_id, lifecycle ON database_views
WHEN EXISTS (
  SELECT 1 FROM database_containers container
  WHERE container.default_view_id = OLD.id
    AND (NEW.database_block_id <> container.block_id OR NEW.lifecycle <> 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'A Database default View must remain active and owned');
END;
CREATE TRIGGER database_views_preserve_container_default_delete
BEFORE DELETE ON database_views
WHEN EXISTS (
  SELECT 1 FROM database_containers container
  WHERE container.default_view_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'A Database default View cannot be deleted');
END;
CREATE TRIGGER database_view_page_positions_require_active_membership_insert
BEFORE INSERT ON "database_view_order_import_positions"
WHEN NOT EXISTS (
  SELECT 1
  FROM database_views view
  INNER JOIN data_source_page_memberships membership
    ON membership.data_source_id = view.data_source_id
   AND membership.page_block_id = NEW.page_block_id
   AND membership.removed_at IS NULL
  WHERE view.id = NEW.view_id
)
BEGIN
  SELECT RAISE(ABORT, 'Database View position requires active Source membership');
END;
CREATE TRIGGER database_view_page_positions_require_active_membership_update
BEFORE UPDATE OF view_id, page_block_id ON "database_view_order_import_positions"
WHEN NOT EXISTS (
  SELECT 1
  FROM database_views view
  INNER JOIN data_source_page_memberships membership
    ON membership.data_source_id = view.data_source_id
   AND membership.page_block_id = NEW.page_block_id
   AND membership.removed_at IS NULL
  WHERE view.id = NEW.view_id
)
BEGIN
  SELECT RAISE(ABORT, 'Database View position requires active Source membership');
END;
CREATE TRIGGER data_source_relation_edge_rank_validate_insert
        BEFORE INSERT ON data_source_relation_edges
        WHEN (
          NEW.property_id = 'task_parent'
          AND (
            NEW.sibling_rank IS NULL
            OR length(NEW.sibling_rank) <> 32
            OR NEW.sibling_rank GLOB '*[^0-9a-f]*'
            OR NEW.target_page_block_id = (
              SELECT membership.page_block_id
              FROM data_source_page_memberships membership
              WHERE membership.data_source_id = NEW.source_data_source_id
                AND membership.id = NEW.source_membership_id
            )
          )
        ) OR (NEW.property_id <> 'task_parent' AND NEW.sibling_rank IS NOT NULL)
        BEGIN
          SELECT RAISE(ABORT, 'Relation edge rank does not match Property semantics');
        END;
CREATE TRIGGER data_source_relation_edge_rank_validate_update
        BEFORE UPDATE OF sibling_rank ON data_source_relation_edges
        WHEN (
          NEW.property_id = 'task_parent'
          AND (
            NEW.sibling_rank IS NULL
            OR length(NEW.sibling_rank) <> 32
            OR NEW.sibling_rank GLOB '*[^0-9a-f]*'
          )
        ) OR (NEW.property_id <> 'task_parent' AND NEW.sibling_rank IS NOT NULL)
        BEGIN
          SELECT RAISE(ABORT, 'Relation edge rank does not match Property semantics');
        END;
CREATE TRIGGER data_source_relation_edge_cardinality_validate_insert
        BEFORE INSERT ON data_source_relation_edges
        WHEN EXISTS (
          SELECT 1 FROM data_source_relation_properties relation
          WHERE relation.data_source_id = NEW.source_data_source_id
            AND relation.property_id = NEW.property_id
            AND relation.cardinality = 'one'
        ) AND EXISTS (
          SELECT 1 FROM data_source_relation_edges existing
          WHERE existing.source_data_source_id = NEW.source_data_source_id
            AND existing.source_membership_id = NEW.source_membership_id
            AND existing.property_id = NEW.property_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'Cardinality-one Relation accepts at most one target');
        END;
CREATE TRIGGER data_source_task_parent_relation_is_standard
        BEFORE INSERT ON data_source_relation_properties
        WHEN NEW.property_id = 'task_parent'
          AND (
            NEW.target_data_source_id <> NEW.data_source_id
            OR NEW.cardinality <> 'one'
          )
        BEGIN
          SELECT RAISE(ABORT, 'Task Parent must be a cardinality-one self Relation');
        END;
CREATE TRIGGER data_source_task_parent_property_is_standard
        BEFORE UPDATE OF data_source_id, id, value_type, config_json, lifecycle
        ON data_source_properties
        WHEN OLD.id = 'task_parent'
          AND (
            NEW.data_source_id <> OLD.data_source_id
            OR NEW.id <> OLD.id
            OR NEW.value_type <> 'relation'
            OR NEW.config_json <> '{}'
            OR NEW.lifecycle <> 'active'
          )
        BEGIN
          SELECT RAISE(ABORT, 'Task Parent is a required standard Relation Property');
        END;
CREATE TRIGGER data_source_task_parent_property_validate_insert
        BEFORE INSERT ON data_source_properties
        WHEN NEW.id = 'task_parent'
          AND (
            NEW.value_type <> 'relation'
            OR NEW.config_json <> '{}'
            OR NEW.lifecycle <> 'active'
          )
        BEGIN
          SELECT RAISE(ABORT, 'Task Parent is a required standard Relation Property');
        END;
CREATE TRIGGER data_source_task_parent_property_prevent_delete
        BEFORE DELETE ON data_source_properties
        WHEN OLD.id = 'task_parent'
          AND EXISTS (
            SELECT 1 FROM data_sources source
            WHERE source.id = OLD.data_source_id AND source.lifecycle = 'active'
          )
        BEGIN
          SELECT RAISE(ABORT, 'Task Parent is a required standard Relation Property');
        END;
CREATE TRIGGER data_source_task_parent_relation_prevent_delete
        BEFORE DELETE ON data_source_relation_properties
        WHEN OLD.property_id = 'task_parent'
          AND EXISTS (
            SELECT 1 FROM data_sources source
            WHERE source.id = OLD.data_source_id AND source.lifecycle = 'active'
          )
        BEGIN
          SELECT RAISE(ABORT, 'Task Parent Relation definition is required');
        END;
CREATE TRIGGER data_source_task_parent_remove_inactive_membership
        AFTER UPDATE OF removed_at ON data_source_page_memberships
        WHEN OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
        BEGIN
          UPDATE data_source_property_values
          SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE data_source_id = NEW.data_source_id
            AND property_id = 'task_parent'
            AND EXISTS (
            SELECT 1 FROM data_source_relation_edges edge
            WHERE edge.source_data_source_id = NEW.data_source_id
              AND edge.property_id = 'task_parent'
              AND edge.source_data_source_id = data_source_property_values.data_source_id
              AND edge.source_membership_id = data_source_property_values.membership_id
              AND edge.property_id = data_source_property_values.property_id
              AND (
                edge.source_membership_id = NEW.id
                OR edge.target_page_block_id = NEW.page_block_id
              )
          );
          DELETE FROM data_source_relation_edges
          WHERE source_data_source_id = NEW.data_source_id
            AND property_id = 'task_parent'
            AND (
              source_membership_id = NEW.id
              OR target_page_block_id = NEW.page_block_id
            );
        END;
CREATE TRIGGER block_search_units_ai AFTER INSERT ON block_search_units BEGIN
  INSERT INTO block_search_units_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;
CREATE TRIGGER block_search_units_ad AFTER DELETE ON block_search_units BEGIN
  INSERT INTO block_search_units_fts(block_search_units_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
END;
CREATE TRIGGER block_search_units_au AFTER UPDATE ON block_search_units BEGIN
  INSERT INTO block_search_units_fts(block_search_units_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
  INSERT INTO block_search_units_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;
CREATE TRIGGER blocks_identity_is_immutable
BEFORE UPDATE OF id ON blocks WHEN NEW.id IS NOT OLD.id BEGIN
  SELECT RAISE(ABORT, 'Block identity is immutable');
END;
CREATE TRIGGER library_block_placements_validate_insert
BEFORE INSERT ON library_block_placements
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  WHERE block.id = NEW.block_id AND block.library_id = NEW.library_id
    AND block.lifecycle <> 'deleted'
    AND block.type IN (
      'page', 'database', 'canvas', 'synced_block_source', 'reusable_template_source'
    )
) OR EXISTS (
  SELECT 1 FROM document_block_index block_index WHERE block_index.block_id = NEW.block_id
) OR EXISTS (
  SELECT 1 FROM pages page
  WHERE page.block_id = NEW.block_id
    AND (page.library_id <> NEW.library_id OR page.parent_kind <> 'library')
) BEGIN
  SELECT RAISE(ABORT, 'Library placement requires a placeable Library root');
END;
CREATE TRIGGER library_block_placements_validate_update
BEFORE UPDATE OF block_id, library_id ON library_block_placements
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  WHERE block.id = NEW.block_id AND block.library_id = NEW.library_id
    AND block.lifecycle <> 'deleted'
    AND block.type IN (
      'page', 'database', 'canvas', 'synced_block_source', 'reusable_template_source'
    )
) OR EXISTS (
  SELECT 1 FROM document_block_index block_index WHERE block_index.block_id = NEW.block_id
) OR EXISTS (
  SELECT 1 FROM pages page
  WHERE page.block_id = NEW.block_id
    AND (page.library_id <> NEW.library_id OR page.parent_kind <> 'library')
) BEGIN
  SELECT RAISE(ABORT, 'Library placement requires a placeable Library root');
END;
CREATE TRIGGER pages_validate_insert BEFORE INSERT ON pages
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN documents document ON document.id = NEW.document_id
  JOIN block_documents ownership
    ON ownership.block_id = NEW.block_id
   AND ownership.document_id = NEW.document_id
  WHERE block.id = NEW.block_id AND block.type = 'page'
    AND block.library_id = NEW.library_id
    AND document.library_id = NEW.library_id
    AND ownership.library_id = NEW.library_id
) OR (
  NEW.parent_kind = 'page' AND NOT EXISTS (
    SELECT 1 FROM pages parent
    WHERE parent.block_id = NEW.parent_id AND parent.library_id = NEW.library_id
  )
) OR (
  NEW.parent_kind = 'data_source' AND NOT EXISTS (
    SELECT 1 FROM data_sources source
    WHERE source.id = NEW.parent_id AND source.library_id = NEW.library_id
  )
) OR (
  NEW.parent_kind <> 'library' AND EXISTS (
    SELECT 1 FROM library_block_placements placement
    WHERE placement.block_id = NEW.block_id
  )
) OR (
  NEW.parent_kind <> 'page' AND EXISTS (
    SELECT 1 FROM document_block_index block_index
    WHERE block_index.block_id = NEW.block_id
  )
) BEGIN
  SELECT RAISE(ABORT, 'Page subtype or parent authority is invalid');
END;
CREATE TRIGGER pages_validate_update
BEFORE UPDATE OF block_id, library_id, document_id, parent_kind, parent_id ON pages
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN documents document ON document.id = NEW.document_id
  JOIN block_documents ownership
    ON ownership.block_id = NEW.block_id
   AND ownership.document_id = NEW.document_id
  WHERE block.id = NEW.block_id AND block.type = 'page'
    AND block.library_id = NEW.library_id
    AND document.library_id = NEW.library_id
    AND ownership.library_id = NEW.library_id
) OR (
  NEW.parent_kind = 'page' AND NOT EXISTS (
    SELECT 1 FROM pages parent
    WHERE parent.block_id = NEW.parent_id AND parent.library_id = NEW.library_id
  )
) OR (
  NEW.parent_kind = 'data_source' AND NOT EXISTS (
    SELECT 1 FROM data_sources source
    WHERE source.id = NEW.parent_id AND source.library_id = NEW.library_id
  )
) OR (
  NEW.parent_kind <> 'library' AND EXISTS (
    SELECT 1 FROM library_block_placements placement
    WHERE placement.block_id = NEW.block_id
  )
) OR (
  NEW.parent_kind <> 'page' AND EXISTS (
    SELECT 1 FROM document_block_index block_index
    WHERE block_index.block_id = NEW.block_id
  )
) BEGIN
  SELECT RAISE(ABORT, 'Page subtype or parent authority is invalid');
END;
CREATE TRIGGER data_source_relation_edges_validate_insert
BEFORE INSERT ON data_source_relation_edges
WHEN NOT EXISTS (
  SELECT 1
  FROM data_source_relation_properties relation
  JOIN data_source_property_values value
    ON value.data_source_id = NEW.source_data_source_id
   AND value.membership_id = NEW.source_membership_id
   AND value.property_id = NEW.property_id
  JOIN data_sources source ON source.id = relation.data_source_id
  JOIN data_sources target_source
    ON target_source.id = COALESCE(NEW.target_data_source_id, relation.target_data_source_id)
   AND target_source.library_id = source.library_id
  JOIN blocks target_block ON target_block.id = NEW.target_page_block_id
  JOIN pages target_page
    ON target_page.block_id = target_block.id
   AND target_page.library_id = target_block.library_id
  JOIN data_source_page_memberships target_membership
    ON target_membership.page_block_id = target_block.id
   AND target_membership.data_source_id = COALESCE(NEW.target_data_source_id, relation.target_data_source_id)
   AND target_membership.removed_at IS NULL
  WHERE relation.data_source_id = NEW.source_data_source_id
    AND relation.property_id = NEW.property_id
    AND (NEW.target_data_source_id IS NULL OR NEW.property_id = 'blocked_by')
    AND target_page.library_id = source.library_id
    AND value.value_type = 'relation'
    AND json_type(value.value_json) = 'null'
    AND target_block.type = 'page'
    AND target_block.lifecycle = 'active'
) BEGIN
  SELECT RAISE(ABORT, 'Relation edge requires an active target Page in its target Source');
END;
CREATE TRIGGER data_source_relation_edges_are_immutable
BEFORE UPDATE ON data_source_relation_edges BEGIN
  SELECT RAISE(ABORT, 'Relation edge identity is immutable');
END;
CREATE TRIGGER documents_sync_engine_immutable
BEFORE UPDATE OF sync_engine ON documents WHEN NEW.sync_engine <> OLD.sync_engine BEGIN
  SELECT RAISE(ABORT, 'Owned Document sync engine is immutable');
END;
CREATE TRIGGER yjs_documents_require_empty_state_hash_insert
BEFORE INSERT ON documents
WHEN NEW.sync_engine = 'yjs' AND NEW.state_hash <> '' BEGIN
  SELECT RAISE(ABORT, 'Yjs Document cannot persist a full-state hash');
END;
CREATE TRIGGER yjs_documents_require_empty_state_hash_update
BEFORE UPDATE OF state_hash ON documents
WHEN NEW.sync_engine = 'yjs' AND NEW.state_hash <> '' BEGIN
  SELECT RAISE(ABORT, 'Yjs Document cannot persist a full-state hash');
END;
CREATE TRIGGER canvas_documents_require_empty_yjs_state_insert
BEFORE INSERT ON documents
WHEN NEW.sync_engine = 'canvas_scene'
  AND (length(NEW.state_vector) <> 0 OR NEW.state_hash = '') BEGIN
  SELECT RAISE(ABORT, 'Canvas Document cannot contain Yjs state');
END;
CREATE TRIGGER canvas_documents_require_empty_yjs_state_update
BEFORE UPDATE OF state_vector, state_hash ON documents
WHEN NEW.sync_engine = 'canvas_scene'
  AND (length(NEW.state_vector) <> 0 OR NEW.state_hash = '') BEGIN
  SELECT RAISE(ABORT, 'Canvas Document cannot contain Yjs state');
END;
CREATE TRIGGER data_source_memberships_require_page_parent_insert
BEFORE INSERT ON data_source_page_memberships
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1
  FROM pages page
  JOIN blocks block ON block.id = page.block_id AND block.type = 'page'
  JOIN data_sources source
    ON source.id = NEW.data_source_id AND source.library_id = block.library_id
  WHERE page.block_id = NEW.page_block_id
    AND page.parent_kind = 'data_source'
    AND page.parent_id = NEW.data_source_id
) BEGIN
  SELECT RAISE(ABORT, 'Active Source membership must match the Page Data Source parent');
END;
CREATE TRIGGER data_source_memberships_require_page_parent_update
BEFORE UPDATE OF data_source_id, page_block_id, removed_at ON data_source_page_memberships
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1
  FROM pages page
  JOIN blocks block ON block.id = page.block_id AND block.type = 'page'
  JOIN data_sources source
    ON source.id = NEW.data_source_id AND source.library_id = block.library_id
  WHERE page.block_id = NEW.page_block_id
    AND page.parent_kind = 'data_source'
    AND page.parent_id = NEW.data_source_id
) BEGIN
  SELECT RAISE(ABORT, 'Active Source membership must match the Page Data Source parent');
END;
CREATE TRIGGER document_block_index_requires_library_content_insert
BEFORE INSERT ON document_block_index
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN documents document ON document.id = NEW.document_id
  WHERE block.id = NEW.block_id AND block.library_id = document.library_id
    AND block.lifecycle <> 'deleted'
) OR EXISTS (
  SELECT 1 FROM library_block_placements placement WHERE placement.block_id = NEW.block_id
) OR EXISTS (
  SELECT 1 FROM pages page
  WHERE page.block_id = NEW.block_id AND (
    page.parent_kind <> 'page' OR NOT EXISTS (
      SELECT 1 FROM pages parent
      JOIN block_documents parent_document ON parent_document.block_id = parent.block_id
      WHERE parent.block_id = page.parent_id
        AND parent.library_id = page.library_id
        AND parent_document.document_id = NEW.document_id
        AND parent_document.library_id = page.library_id
    )
  )
) BEGIN
  SELECT RAISE(ABORT, 'Indexed Block must belong to the Document Library and not be a Library root');
END;
CREATE TRIGGER document_block_index_requires_library_content_update
BEFORE UPDATE OF document_id, block_id ON document_block_index
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN documents document ON document.id = NEW.document_id
  WHERE block.id = NEW.block_id AND block.library_id = document.library_id
    AND block.lifecycle <> 'deleted'
) OR EXISTS (
  SELECT 1 FROM library_block_placements placement WHERE placement.block_id = NEW.block_id
) OR EXISTS (
  SELECT 1 FROM pages page
  WHERE page.block_id = NEW.block_id AND (
    page.parent_kind <> 'page' OR NOT EXISTS (
      SELECT 1 FROM pages parent
      JOIN block_documents parent_document ON parent_document.block_id = parent.block_id
      WHERE parent.block_id = page.parent_id
        AND parent.library_id = page.library_id
        AND parent_document.document_id = NEW.document_id
        AND parent_document.library_id = page.library_id
    )
  )
) BEGIN
  SELECT RAISE(ABORT, 'Indexed Block must belong to the Document Library and not be a Library root');
END;
CREATE TRIGGER document_block_index_parent_same_document_insert
BEFORE INSERT ON document_block_index
WHEN NEW.parent_block_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_block_index parent
  WHERE parent.document_id = NEW.document_id AND parent.block_id = NEW.parent_block_id
) BEGIN
  SELECT RAISE(ABORT, 'Indexed parent must belong to the indexed Document');
END;
CREATE TRIGGER document_block_index_parent_same_document_update
BEFORE UPDATE OF document_id, parent_block_id ON document_block_index
WHEN NEW.parent_block_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_block_index parent
  WHERE parent.document_id = NEW.document_id AND parent.block_id = NEW.parent_block_id
) BEGIN
  SELECT RAISE(ABORT, 'Indexed parent must belong to the indexed Document');
END;
CREATE TRIGGER managed_blobs_are_immutable
BEFORE UPDATE ON managed_blobs
BEGIN
  SELECT RAISE(ABORT, 'Managed Blobs are immutable');
END;
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
CREATE TRIGGER page_file_manifests_advance_one_revision
BEFORE UPDATE ON page_file_manifests
WHEN OLD.page_id <> NEW.page_id
  OR OLD.library_id <> NEW.library_id
  OR NOT (
    (NEW.revision = OLD.revision + 1
      AND NEW.body_usage_revision = OLD.body_usage_revision)
    OR (NEW.revision = OLD.revision
      AND NEW.body_usage_revision = OLD.body_usage_revision + 1)
  )
BEGIN
  SELECT RAISE(ABORT, 'Page File manifest or body usage must advance by one revision');
END;
CREATE TRIGGER pages_initialize_file_manifest
AFTER INSERT ON pages
BEGIN
  INSERT INTO page_file_manifests(
    page_id, library_id, revision, body_usage_revision, updated_at
  ) VALUES (NEW.block_id, NEW.library_id, 0, 0, NEW.updated_at);
END;
CREATE TRIGGER block_asset_refs_validate_insert BEFORE INSERT ON block_asset_refs
WHEN NOT EXISTS (
  SELECT 1 FROM documents document
  JOIN block_documents ownership
    ON ownership.document_id = document.id AND ownership.library_id = document.library_id
  JOIN document_block_index block_index
    ON block_index.document_id = document.id AND block_index.block_id = NEW.block_id
  WHERE document.id = NEW.document_id AND document.library_id = NEW.library_id
    AND document.generation = NEW.document_generation
    AND document.head_seq >= NEW.projected_seq
    AND ownership.block_id = NEW.owner_block_id
    AND block_index.projected_seq = NEW.projected_seq
) OR (
  NEW.file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM library_files file
    JOIN file_versions version
      ON version.file_id = file.file_id AND version.version = file.head_version
    WHERE file.file_id = NEW.file_id
      AND file.library_id = NEW.library_id
      AND file.lifecycle = 'live'
      AND version.blob_hash = NEW.asset_hash
  )
) BEGIN
  SELECT RAISE(ABORT, 'Block asset projection source is invalid or from the future');
END;
CREATE TRIGGER block_asset_refs_validate_update BEFORE UPDATE ON block_asset_refs
WHEN NOT EXISTS (
  SELECT 1 FROM documents document
  JOIN block_documents ownership
    ON ownership.document_id = document.id AND ownership.library_id = document.library_id
  JOIN document_block_index block_index
    ON block_index.document_id = document.id AND block_index.block_id = NEW.block_id
  WHERE document.id = NEW.document_id AND document.library_id = NEW.library_id
    AND document.generation = NEW.document_generation
    AND document.head_seq >= NEW.projected_seq
    AND ownership.block_id = NEW.owner_block_id
    AND block_index.projected_seq = NEW.projected_seq
) OR (
  NEW.file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM library_files file
    JOIN file_versions version
      ON version.file_id = file.file_id AND version.version = file.head_version
    WHERE file.file_id = NEW.file_id
      AND file.library_id = NEW.library_id
      AND file.lifecycle = 'live'
      AND version.blob_hash = NEW.asset_hash
  )
) BEGIN
  SELECT RAISE(ABORT, 'Block asset projection source is invalid or from the future');
END;
CREATE TRIGGER block_search_units_validate_insert BEFORE INSERT ON block_search_units
WHEN (
  NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents document
    JOIN block_documents ownership
      ON ownership.document_id = document.id AND ownership.library_id = document.library_id
    LEFT JOIN document_block_index block_index
      ON block_index.document_id = document.id AND block_index.block_id = NEW.block_id
    WHERE document.id = NEW.document_id AND document.library_id = NEW.library_id
      AND document.generation = NEW.document_generation
      AND document.head_seq >= NEW.projected_seq
      AND ownership.block_id = NEW.owner_block_id
      AND (NEW.block_id = NEW.owner_block_id OR block_index.block_id IS NOT NULL)
  )
) OR (
  NEW.document_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM blocks source
    WHERE source.id = NEW.block_id AND source.library_id = NEW.library_id
      AND source.metadata_revision >= NEW.source_revision
  )
) BEGIN
  SELECT RAISE(ABORT, 'Block search projection source is invalid or from the future');
END;
CREATE TRIGGER block_search_units_validate_update BEFORE UPDATE ON block_search_units
WHEN (
  NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents document
    JOIN block_documents ownership
      ON ownership.document_id = document.id AND ownership.library_id = document.library_id
    LEFT JOIN document_block_index block_index
      ON block_index.document_id = document.id AND block_index.block_id = NEW.block_id
    WHERE document.id = NEW.document_id AND document.library_id = NEW.library_id
      AND document.generation = NEW.document_generation
      AND document.head_seq >= NEW.projected_seq
      AND ownership.block_id = NEW.owner_block_id
      AND (NEW.block_id = NEW.owner_block_id OR block_index.block_id IS NOT NULL)
  )
) OR (
  NEW.document_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM blocks source
    WHERE source.id = NEW.block_id AND source.library_id = NEW.library_id
      AND source.metadata_revision >= NEW.source_revision
  )
) BEGIN
  SELECT RAISE(ABORT, 'Block search projection source is invalid or from the future');
END;
CREATE TRIGGER canvas_page_references_validate_insert
BEFORE INSERT ON canvas_page_references
WHEN NOT EXISTS (
  SELECT 1 FROM blocks target
  WHERE target.id = NEW.target_block_id AND target.library_id = NEW.library_id
) BEGIN
  SELECT RAISE(ABORT, 'Canvas Page reference must remain inside its Library');
END;
CREATE TRIGGER canvas_page_references_validate_update
BEFORE UPDATE OF target_block_id, library_id ON canvas_page_references
WHEN NOT EXISTS (
  SELECT 1 FROM blocks target
  WHERE target.id = NEW.target_block_id AND target.library_id = NEW.library_id
) BEGIN
  SELECT RAISE(ABORT, 'Canvas Page reference must remain inside its Library');
END;
CREATE TRIGGER page_read_model_validate_insert BEFORE INSERT ON page_read_model
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN pages page ON page.block_id = block.id
  JOIN block_documents ownership
    ON ownership.block_id = page.block_id
   AND ownership.document_id = page.document_id
   AND ownership.library_id = page.library_id
  JOIN documents document ON document.id = page.document_id
  LEFT JOIN library_block_placements placement
    ON placement.block_id = page.block_id AND page.parent_kind = 'library'
  WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
    AND block.type = 'page' AND page.parent_kind = NEW.parent_kind
    AND page.parent_id = NEW.parent_id
    AND page.document_id = NEW.document_id
    AND document.library_id = NEW.library_id
    AND document.generation = NEW.document_generation
    AND document.head_seq = NEW.document_projected_seq
    AND document.schema_version = NEW.document_schema_version
    AND document.authority = NEW.document_authority
    AND block.lifecycle = NEW.lifecycle
    AND block.placement_revision = NEW.placement_revision
    AND block.metadata_revision = NEW.metadata_revision
    AND (
      (page.parent_kind = 'library' AND block.lifecycle <> 'deleted'
        AND placement.rank_key = NEW.library_rank_key)
      OR ((page.parent_kind <> 'library' OR block.lifecycle = 'deleted')
        AND NEW.library_rank_key IS NULL)
    )
) OR (
  NEW.membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM data_source_page_memberships membership
    JOIN data_sources source ON source.id = membership.data_source_id
    WHERE membership.id = NEW.membership_id
      AND membership.page_block_id = NEW.page_block_id
      AND membership.removed_at IS NULL
      AND source.home_database_block_id = NEW.database_block_id
  )
) OR (
  NEW.view_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM database_views view
    JOIN data_source_page_memberships membership
      ON membership.id = NEW.membership_id
     AND membership.data_source_id = view.data_source_id
    WHERE view.id = NEW.view_id AND view.database_block_id = NEW.database_block_id
  )
) BEGIN
  SELECT RAISE(ABORT, 'Page read model source coordinates are invalid or stale');
END;
CREATE TRIGGER page_read_model_validate_update BEFORE UPDATE ON page_read_model
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN pages page ON page.block_id = block.id
  JOIN block_documents ownership
    ON ownership.block_id = page.block_id
   AND ownership.document_id = page.document_id
   AND ownership.library_id = page.library_id
  JOIN documents document ON document.id = page.document_id
  LEFT JOIN library_block_placements placement
    ON placement.block_id = page.block_id AND page.parent_kind = 'library'
  WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
    AND block.type = 'page' AND page.parent_kind = NEW.parent_kind
    AND page.parent_id = NEW.parent_id
    AND page.document_id = NEW.document_id
    AND document.library_id = NEW.library_id
    AND document.generation = NEW.document_generation
    AND document.head_seq = NEW.document_projected_seq
    AND document.schema_version = NEW.document_schema_version
    AND document.authority = NEW.document_authority
    AND block.lifecycle = NEW.lifecycle
    AND block.placement_revision = NEW.placement_revision
    AND block.metadata_revision = NEW.metadata_revision
    AND (
      (page.parent_kind = 'library' AND block.lifecycle <> 'deleted'
        AND placement.rank_key = NEW.library_rank_key)
      OR ((page.parent_kind <> 'library' OR block.lifecycle = 'deleted')
        AND NEW.library_rank_key IS NULL)
    )
) OR (
  NEW.membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM data_source_page_memberships membership
    JOIN data_sources source ON source.id = membership.data_source_id
    WHERE membership.id = NEW.membership_id
      AND membership.page_block_id = NEW.page_block_id
      AND membership.removed_at IS NULL
      AND source.home_database_block_id = NEW.database_block_id
  )
) OR (
  NEW.view_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM database_views view
    JOIN data_source_page_memberships membership
      ON membership.id = NEW.membership_id
     AND membership.data_source_id = view.data_source_id
    WHERE view.id = NEW.view_id AND view.database_block_id = NEW.database_block_id
  )
) BEGIN
  SELECT RAISE(ABORT, 'Page read model source coordinates are invalid or stale');
END;
CREATE TRIGGER recurrence_exceptions_require_page_insert BEFORE INSERT ON recurrence_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  WHERE block.id = NEW.page_id AND block.library_id = NEW.library_id AND block.type = 'page'
) BEGIN
  SELECT RAISE(ABORT, 'Recurrence exception owner must be a Page in the Library');
END;
CREATE TRIGGER recurrence_exceptions_require_page_update
BEFORE UPDATE OF page_id, library_id ON recurrence_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  WHERE block.id = NEW.page_id AND block.library_id = NEW.library_id AND block.type = 'page'
) BEGIN
  SELECT RAISE(ABORT, 'Recurrence exception owner must be a Page in the Library');
END;
CREATE TRIGGER reminder_receipts_validate_insert BEFORE INSERT ON reminder_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects project
  JOIN blocks page ON page.id = NEW.page_id AND page.library_id = project.library_id
  WHERE project.id = NEW.project_id AND project.library_id = NEW.library_id
    AND page.type = 'page'
) BEGIN
  SELECT RAISE(ABORT, 'Reminder receipt Project and Page must share a Library');
END;
CREATE TRIGGER reminder_receipts_validate_update
BEFORE UPDATE OF project_id, library_id, page_id ON reminder_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects project
  JOIN blocks page ON page.id = NEW.page_id AND page.library_id = project.library_id
  WHERE project.id = NEW.project_id AND project.library_id = NEW.library_id
    AND page.type = 'page'
) BEGIN
  SELECT RAISE(ABORT, 'Reminder receipt Project and Page must share a Library');
END;
CREATE TRIGGER reminder_snoozes_validate_insert BEFORE INSERT ON reminder_snoozes
WHEN NOT EXISTS (
  SELECT 1 FROM projects project
  JOIN blocks page ON page.id = NEW.page_id AND page.library_id = project.library_id
  WHERE project.id = NEW.project_id AND project.library_id = NEW.library_id
    AND page.type = 'page'
) BEGIN
  SELECT RAISE(ABORT, 'Reminder snooze Project and Page must share a Library');
END;
CREATE TRIGGER reminder_snoozes_validate_update
BEFORE UPDATE OF project_id, library_id, page_id ON reminder_snoozes
WHEN NOT EXISTS (
  SELECT 1 FROM projects project
  JOIN blocks page ON page.id = NEW.page_id AND page.library_id = project.library_id
  WHERE project.id = NEW.project_id AND project.library_id = NEW.library_id
    AND page.type = 'page'
) BEGIN
  SELECT RAISE(ABORT, 'Reminder snooze Project and Page must share a Library');
END;
CREATE TRIGGER scheduled_page_index_require_page_insert BEFORE INSERT ON scheduled_page_index
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id
  JOIN block_documents ownership
    ON ownership.block_id = page.block_id
   AND ownership.document_id = page.document_id
   AND ownership.library_id = page.library_id
  WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
    AND block.type = 'page'
    AND block.lifecycle = NEW.lifecycle
    AND block.metadata_revision = NEW.source_metadata_revision
) BEGIN
  SELECT RAISE(ABORT, 'Scheduled Page index owner must be a Page in the Library');
END;
CREATE TRIGGER scheduled_page_index_require_page_update
BEFORE UPDATE OF page_block_id, library_id, lifecycle, source_metadata_revision
ON scheduled_page_index
WHEN NOT EXISTS (
  SELECT 1 FROM blocks block
  JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id
  JOIN block_documents ownership
    ON ownership.block_id = page.block_id
   AND ownership.document_id = page.document_id
   AND ownership.library_id = page.library_id
  WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
    AND block.type = 'page'
    AND block.lifecycle = NEW.lifecycle
    AND block.metadata_revision = NEW.source_metadata_revision
) BEGIN
  SELECT RAISE(ABORT, 'Scheduled Page index owner must be a Page in the Library');
END;
CREATE TRIGGER retired_block_identities_are_immutable_delete
BEFORE DELETE ON retired_block_identities BEGIN
  SELECT RAISE(ABORT, 'Retired Block identity evidence is immutable');
END;
CREATE TRIGGER retired_block_identities_are_immutable_update
BEFORE UPDATE ON retired_block_identities BEGIN
  SELECT RAISE(ABORT, 'Retired Block identity evidence is immutable');
END;
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
CREATE TRIGGER block_relocation_members_are_immutable
BEFORE UPDATE ON block_relocation_members BEGIN
  SELECT RAISE(ABORT, 'Committed Block relocation members are immutable');
END;
CREATE TRIGGER block_relocation_members_validate_insert
BEFORE INSERT ON block_relocation_members
WHEN NOT EXISTS (
  SELECT 1 FROM block_relocations relocation
  JOIN blocks block ON block.id = NEW.block_id
  WHERE relocation.id = NEW.relocation_id
    AND relocation.library_id = NEW.library_id
    AND block.library_id = NEW.library_id
) BEGIN
  SELECT RAISE(ABORT, 'Block relocation member must remain inside its Library');
END;
CREATE TRIGGER database_containers_require_database_block_insert
        BEFORE INSERT ON database_containers
        WHEN NOT EXISTS (
          SELECT 1 FROM blocks block
          WHERE block.id = NEW.block_id AND block.library_id = NEW.library_id
            AND block.type = 'database'
        ) BEGIN
          SELECT RAISE(ABORT, 'Database Container requires a Database Block in the Library');
        END;
CREATE TRIGGER database_containers_require_database_block_update
        BEFORE UPDATE OF block_id, library_id ON database_containers
        WHEN NOT EXISTS (
          SELECT 1 FROM blocks block
          WHERE block.id = NEW.block_id AND block.library_id = NEW.library_id
            AND block.type = 'database'
        ) BEGIN
          SELECT RAISE(ABORT, 'Database Container requires a Database Block in the Library');
        END;
CREATE TRIGGER canvas_owners_validate_insert
        BEFORE INSERT ON canvas_owners
        WHEN NOT EXISTS (
          SELECT 1 FROM blocks block
          JOIN block_documents ownership ON ownership.block_id = block.id
          JOIN documents document ON document.id = ownership.document_id
          WHERE block.id = NEW.block_id AND block.type = 'canvas'
            AND block.library_id = NEW.library_id
            AND ownership.library_id = NEW.library_id
            AND document.library_id = NEW.library_id
            AND document.sync_engine = 'canvas_scene'
        ) BEGIN
          SELECT RAISE(ABORT, 'Canvas owner metadata requires a Canvas Document owner');
        END;
CREATE TRIGGER page_behavior_records_guard_block_retype
        BEFORE UPDATE OF type ON blocks
        WHEN NEW.type <> OLD.type AND (
          EXISTS (SELECT 1 FROM pages page WHERE page.block_id = OLD.id)
          OR EXISTS (SELECT 1 FROM database_containers container WHERE container.block_id = OLD.id)
          OR EXISTS (SELECT 1 FROM canvas_owners canvas WHERE canvas.block_id = OLD.id)
        ) BEGIN
          SELECT RAISE(ABORT, 'Registered Block subtype cannot be retyped');
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
CREATE TRIGGER document_block_tombstones_validate_insert
BEFORE INSERT ON document_block_tombstones BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM blocks block
    JOIN documents document ON document.id = NEW.document_id
    WHERE block.id = NEW.block_id
      AND block.library_id = NEW.library_id
      AND block.lifecycle = 'deleted'
      AND block.placement_revision = NEW.placement_revision
      AND block.type NOT IN (
        'page', 'database', 'synced_block_source',
        'reusable_template_source', 'canvas'
      )
      AND document.library_id = NEW.library_id
      AND document.generation = NEW.document_generation
      AND NEW.deletion_head_seq = document.head_seq + 1
  ) THEN RAISE(ABORT, 'document Block tombstone authority mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM document_block_index entry WHERE entry.block_id = NEW.block_id
  ) OR EXISTS (
    SELECT 1 FROM library_block_placements placement WHERE placement.block_id = NEW.block_id
  ) THEN RAISE(ABORT, 'placed Block cannot retain a Document tombstone') END;
END;
CREATE TRIGGER document_block_tombstones_are_immutable
BEFORE UPDATE ON document_block_tombstones BEGIN
  SELECT RAISE(ABORT, 'document Block tombstones are immutable');
END;
CREATE TRIGGER page_key_namespaces_identity_immutable
  BEFORE UPDATE OF database_block_id, library_id ON page_key_namespaces
  WHEN NEW.database_block_id <> OLD.database_block_id OR NEW.library_id <> OLD.library_id
  BEGIN
    SELECT RAISE(ABORT, 'Page-key namespace identity is immutable');
  END;
CREATE TRIGGER page_key_namespaces_counter_monotonic
  BEFORE UPDATE OF next_number ON page_key_namespaces
  WHEN NEW.next_number < OLD.next_number
  BEGIN
    SELECT RAISE(ABORT, 'Page-key namespace counter cannot decrease');
  END;
CREATE TRIGGER page_key_prefixes_identity_immutable
  BEFORE UPDATE OF library_id, normalized_prefix, database_block_id ON page_key_prefixes
  WHEN NEW.library_id <> OLD.library_id
    OR NEW.normalized_prefix <> OLD.normalized_prefix
    OR NEW.database_block_id <> OLD.database_block_id
  BEGIN
    SELECT RAISE(ABORT, 'Page-key prefix identity is immutable');
  END;
CREATE TRIGGER page_key_assignments_validate_library
  BEFORE INSERT ON page_key_assignments
  WHEN NOT EXISTS (
    SELECT 1
    FROM page_key_namespaces namespace
    JOIN pages page ON page.block_id = NEW.page_block_id
    JOIN data_source_page_memberships membership
      ON membership.page_block_id = page.block_id
    JOIN data_sources source
      ON source.id = membership.data_source_id
     AND source.home_database_block_id = namespace.database_block_id
     AND source.library_id = namespace.library_id
    WHERE namespace.database_block_id = NEW.database_block_id
      AND namespace.library_id = page.library_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'Page-key assignment requires same-Library Database membership history');
  END;
CREATE TRIGGER page_key_assignments_immutable_update
  BEFORE UPDATE ON page_key_assignments
  BEGIN
    SELECT RAISE(ABORT, 'Page-key assignments are immutable');
  END;
CREATE TRIGGER page_key_assignments_immutable_delete
  BEFORE DELETE ON page_key_assignments
  BEGIN
    SELECT RAISE(ABORT, 'Page-key assignments are immutable');
  END;
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
CREATE TRIGGER structural_clipboard_bundles_are_immutable
BEFORE UPDATE ON structural_clipboard_bundles
BEGIN
  SELECT RAISE(ABORT, 'Structural clipboard bundles are immutable');
END;
CREATE TRIGGER structural_clipboard_leases_transition_once
BEFORE UPDATE ON structural_clipboard_leases
WHEN NOT (OLD.state = 'active'
  AND NEW.state = 'released'
  AND NEW.revision = OLD.revision + 1
  AND NEW.released_at IS NOT NULL
  AND OLD.bundle_id = NEW.bundle_id)
BEGIN
  SELECT RAISE(ABORT, 'Structural clipboard lease transition is invalid');
END;
CREATE TRIGGER structural_cut_claims_transition_once
BEFORE UPDATE ON structural_cut_claims
WHEN NOT (OLD.state = 'available'
  AND NEW.state IN ('consumed', 'revoked')
  AND NEW.revision = OLD.revision + 1
  AND OLD.bundle_id = NEW.bundle_id
  AND OLD.source_document_id = NEW.source_document_id
  AND OLD.source_root_ids_json = NEW.source_root_ids_json
  AND OLD.delete_recipe_operation_id = NEW.delete_recipe_operation_id
  AND OLD.created_at = NEW.created_at)
BEGIN
  SELECT RAISE(ABORT, 'Structural cut claim transition is invalid');
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
CREATE TRIGGER structural_retention_members_are_immutable
BEFORE UPDATE ON structural_retention_members
BEGIN
  SELECT RAISE(ABORT, 'Structural retention members are immutable');
END;
CREATE TABLE codex_thread_asset_refs (
  thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  blob_hash TEXT NOT NULL REFERENCES managed_blobs(content_hash) ON DELETE RESTRICT,
  retained_at TEXT NOT NULL CHECK (length(retained_at) > 0),
  PRIMARY KEY (thread_id, library_id, blob_hash)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER codex_thread_asset_refs_validate_insert BEFORE INSERT ON codex_thread_asset_refs
WHEN NOT EXISTS (
  SELECT 1 FROM codex_threads thread LEFT JOIN projects project ON project.id = thread.project_id
  WHERE thread.thread_id = NEW.thread_id AND (thread.project_id IS NULL OR project.library_id = NEW.library_id)
)
BEGIN SELECT RAISE(ABORT, 'Thread attachment must belong to its Library'); END;
CREATE TRIGGER codex_thread_asset_refs_immutable BEFORE UPDATE ON codex_thread_asset_refs
BEGIN SELECT RAISE(ABORT, 'Retained Thread attachment identities are immutable'); END;
CREATE INDEX idx_codex_thread_asset_refs_blob ON codex_thread_asset_refs(blob_hash);
CREATE TABLE operational_journal_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  commit_head_seq INTEGER NOT NULL DEFAULT 0 CHECK (commit_head_seq >= 0),
  replay_floor_seq INTEGER NOT NULL DEFAULT 0 CHECK (replay_floor_seq >= 0),
  maintenance_revision INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_revision >= 0),
  retained_commit_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_commit_count >= 0),
  retained_delivery_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_delivery_bytes >= 0),
  delivery_pressure_active INTEGER NOT NULL DEFAULT 0
    CHECK (delivery_pressure_active IN (0, 1)),
  pending_metadata_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_metadata_count >= 0),
  metadata_backfill_cursor_seq INTEGER NOT NULL DEFAULT 0
    CHECK (metadata_backfill_cursor_seq >= 0),
  retained_receipt_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_receipt_count >= 0),
  retained_receipt_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_receipt_bytes >= 0),
  receipt_pressure_active INTEGER NOT NULL DEFAULT 0
    CHECK (receipt_pressure_active IN (0, 1)),
  pending_receipt_metadata_count INTEGER NOT NULL DEFAULT 0
    CHECK (pending_receipt_metadata_count >= 0),
  receipt_backfill_cursor_module TEXT,
  receipt_backfill_cursor_operation_id TEXT,
  receipt_floor_at TEXT,
  receipt_floor_module TEXT,
  receipt_floor_operation_id TEXT,
  operation_identity_cutover_at TEXT NOT NULL,
  last_pruned_commit_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_pruned_commit_seq >= 0),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  updated_at TEXT NOT NULL,
  CHECK (receipt_floor_at IS NULL OR length(receipt_floor_at) > 0),
  CHECK (
    (receipt_backfill_cursor_module IS NULL AND receipt_backfill_cursor_operation_id IS NULL)
    OR (receipt_backfill_cursor_module IN (
        'library', 'database', 'owned_document', 'project_workspace',
        'automation', 'store_administration'
      )
      AND length(receipt_backfill_cursor_operation_id) BETWEEN 1 AND 512)
  ),
  CHECK (
    (receipt_floor_at IS NULL AND receipt_floor_module IS NULL AND receipt_floor_operation_id IS NULL)
    OR (receipt_floor_at IS NOT NULL
      AND receipt_floor_module IN (
        'library', 'database', 'owned_document', 'project_workspace',
        'automation', 'store_administration'
      )
      AND length(receipt_floor_operation_id) BETWEEN 1 AND 512)
  ),
  CHECK (length(operation_identity_cutover_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE block_mutation_body_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_mutation_id TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1))
) STRICT;
CREATE TABLE block_mutation_body_gc (
  mutation_id TEXT PRIMARY KEY REFERENCES block_mutations(mutation_id) ON DELETE CASCADE,
  check_after_ms INTEGER NOT NULL DEFAULT 0 CHECK (check_after_ms >= 0)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_block_mutation_body_gc_due ON block_mutation_body_gc(check_after_ms, mutation_id);
CREATE TABLE codex_identity_unread_threads (
  identity_key TEXT NOT NULL,
  execution_host_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  unread_position INTEGER NOT NULL,
  PRIMARY KEY(identity_key, execution_host_key, thread_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX codex_identity_unread_order ON codex_identity_unread_threads(identity_key, execution_host_key, unread_position);
CREATE TABLE codex_queued_message_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
CREATE TABLE inbox_registry (
  library_id TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  database_block_id TEXT NOT NULL UNIQUE,
  data_source_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL UNIQUE,
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(database_block_id) BETWEEN 1 AND 512),
  CHECK (length(data_source_id) BETWEEN 1 AND 512),
  CHECK (length(view_id) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_proposal_pages (
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (proposal_id, page_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_inbox_proposal_pages_page ON inbox_proposal_pages(page_id, proposal_id);
CREATE TABLE block_erasure_requests (
  root_block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  CHECK (length(root_block_id) BETWEEN 1 AND 512),
  CHECK (length(requested_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_handoffs (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  final_text TEXT NOT NULL CHECK (length(CAST(final_text AS BLOB)) <= 1179648),
  launch_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL UNIQUE,
  execution_selection_json TEXT CHECK (execution_selection_json IS NULL OR json_valid(execution_selection_json)),
  target_execution_ref_json TEXT CHECK (target_execution_ref_json IS NULL OR json_valid(target_execution_ref_json))
  , images_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(images_json) AND json_type(images_json) = 'array'), question_response_json TEXT
  CHECK (question_response_json IS NULL OR json_valid(question_response_json)), skill_invocations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_invocations_json) AND json_type(skill_invocations_json) = 'array'), unavailable_skills_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unavailable_skills_json) AND json_type(unavailable_skills_json) = 'array')) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_suggestion_requests (
  request_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('auto','grouped','refine')),
  state TEXT NOT NULL CHECK (state IN ('pending','settled','failed','superseded')),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
  proposal_id TEXT,
  expected_revision INTEGER,
  correction TEXT CHECK (correction IS NULL OR length(CAST(correction AS BLOB)) <= 16384),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, inputs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inputs_json) AND json_type(inputs_json) = 'array')) WITHOUT ROWID, STRICT;
CREATE INDEX idx_inbox_requests_pending ON inbox_suggestion_requests(library_id,state,created_at);
CREATE TABLE inbox_suggestion_request_pages (
  request_id TEXT NOT NULL REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(request_id,page_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_routing_deliveries (
  request_id TEXT PRIMARY KEY REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation>=1),
  coordinator_session_id TEXT NOT NULL,
  handed_over_at_ms INTEGER NOT NULL CHECK(handed_over_at_ms>=0)
, run_started_at_ms INTEGER
  CHECK (run_started_at_ms IS NULL OR run_started_at_ms >= 0), last_refusal TEXT
  CHECK (last_refusal IS NULL OR length(last_refusal) <= 2048), skill_offers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_offers_json) AND json_type(skill_offers_json) = 'array')) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_decision_undo (
  token TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
) WITHOUT ROWID, STRICT;
CREATE TABLE project_session_user_message_receipts (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE coordinator (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE coordinator_managed_sessions (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  observed_json TEXT CHECK(observed_json IS NULL OR json_valid(observed_json)),
  observed_revision INTEGER NOT NULL DEFAULT 0 CHECK(observed_revision >= 0)
) STRICT;
CREATE TABLE coordinator_event_batches (
  batch_id TEXT PRIMARY KEY,
  coordinator_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT
, invalidated_at TEXT, discarded_at TEXT) STRICT;
CREATE TABLE coordinator_work_events (
  event_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('report','attention','turn_ended','failed','stalled','ready_to_start','started')),
  session_id TEXT,
  page_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  batch_id TEXT REFERENCES coordinator_event_batches(batch_id)
, resolved_at TEXT) STRICT;
CREATE INDEX idx_coordinator_pending_events ON coordinator_work_events(created_at,event_id) WHERE batch_id IS NULL AND resolved_at IS NULL;
CREATE INDEX idx_coordinator_open_batches ON coordinator_event_batches(created_at,batch_id) WHERE accepted_at IS NULL;
CREATE TABLE document_recovery_drafts (
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    draft_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    source_store_epoch TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_encoding TEXT NOT NULL CHECK (payload_encoding IN ('legacy_json', 'bundle_v1')),
    payload BLOB NOT NULL CHECK (typeof(payload) = 'blob'),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    resolution TEXT CHECK (resolution IN ('already_saved', 'restored', 'copied', 'discarded')),
    resolved_at TEXT,
    resolution_operation_id TEXT,
    target_owner_id TEXT,
    target_document_id TEXT, member_id TEXT REFERENCES members(id),
    CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
    PRIMARY KEY (library_id, draft_id)
) WITHOUT ROWID;
CREATE INDEX document_recovery_drafts_document
    ON document_recovery_drafts(library_id, document_id, draft_id);
CREATE INDEX document_recovery_drafts_retention
    ON document_recovery_drafts(library_id, resolved_at) WHERE resolution IS NOT NULL;
CREATE TABLE document_recovery_file_snapshots (
    library_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (library_id, draft_id),
    FOREIGN KEY (library_id, draft_id) REFERENCES document_recovery_drafts(library_id, draft_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE document_recovery_file_refs (
    library_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    binding_kind TEXT NOT NULL CHECK (binding_kind IN ('body', 'canvas')),
    binding_id TEXT NOT NULL CHECK (length(binding_id) BETWEEN 1 AND 512),
    file_id TEXT NOT NULL CHECK (length(file_id) BETWEEN 1 AND 512),
    file_version INTEGER,
    default_name TEXT,
    PRIMARY KEY (library_id, draft_id, binding_kind, binding_id),
    CHECK (binding_kind <> 'body' OR binding_id = file_id),
    FOREIGN KEY (library_id, draft_id) REFERENCES document_recovery_file_snapshots(library_id, draft_id) ON DELETE CASCADE,
    FOREIGN KEY (file_id, file_version, library_id) REFERENCES file_versions(file_id, version, library_id) ON DELETE RESTRICT,
    CHECK ((file_version IS NULL AND default_name IS NULL) OR
           (file_version IS NOT NULL AND file_version >= 1 AND default_name IS NOT NULL AND length(default_name) BETWEEN 1 AND 255))
) WITHOUT ROWID, STRICT;
CREATE INDEX document_recovery_file_refs_file ON document_recovery_file_refs(file_id, file_version);
CREATE TRIGGER document_recovery_file_snapshots_immutable BEFORE UPDATE ON document_recovery_file_snapshots
BEGIN
    SELECT RAISE(ABORT, 'Recovery File snapshots are immutable');
END;
CREATE TRIGGER library_files_retain_recovery BEFORE DELETE ON library_files
WHEN EXISTS (SELECT 1 FROM document_recovery_file_refs reference WHERE reference.library_id = OLD.library_id AND reference.file_id = OLD.file_id)
  OR EXISTS (SELECT 1 FROM document_recovery_drafts draft LEFT JOIN document_recovery_file_snapshots snapshot
      ON snapshot.library_id = draft.library_id AND snapshot.draft_id = draft.draft_id
      WHERE draft.library_id = OLD.library_id AND (snapshot.draft_id IS NULL OR json_extract(snapshot.snapshot_json, '$.complete') <> 1))
BEGIN
    SELECT RAISE(ABORT, 'File is retained by recovery drafts');
END;
CREATE TABLE document_recovery_asset_roots (
    library_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    asset_hash TEXT NOT NULL,
    PRIMARY KEY (library_id, draft_id, asset_hash),
    FOREIGN KEY (library_id, draft_id) REFERENCES document_recovery_drafts(library_id, draft_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE document_recovery_block_roots (
    library_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    PRIMARY KEY (library_id, draft_id, block_id),
    FOREIGN KEY (library_id, draft_id) REFERENCES document_recovery_drafts(library_id, draft_id) ON DELETE CASCADE
) WITHOUT ROWID;
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
CREATE UNIQUE INDEX thread_backend_sessions_native_identity
  ON thread_backend_sessions(backend_kind, native_home, backend_session_id)
  WHERE native_home IS NOT NULL;
CREATE TABLE nodex_agent_runtime_execution_cleanups (
  cleanup_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT,
  runtime_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  UNIQUE (runtime_id, runtime_thread_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX nodex_agent_runtime_execution_cleanups_runtime
  ON nodex_agent_runtime_execution_cleanups(runtime_id, library_id, cleanup_id);
CREATE TABLE project_session_usage (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  score REAL NOT NULL CHECK (score > 0 AND score < 1.0e100)
) WITHOUT ROWID, STRICT;
CREATE TABLE session_search_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
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
CREATE TABLE app_tool_operations (
  caller_identity TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (caller_identity, tool_name, idempotency_key)
) STRICT;
CREATE INDEX idx_app_tool_operations_expiry ON app_tool_operations(expires_at_ms);
CREATE INDEX idx_project_sessions_project_activity ON project_sessions(project_id, archived, activity_at DESC, id);
CREATE INDEX idx_project_sessions_project_identity ON project_sessions(project_id, id);
CREATE INDEX idx_project_sessions_project_manual ON project_sessions(project_id, archived, manual_rank, activity_at DESC, id);
CREATE TRIGGER project_sessions_clear_manual_rank AFTER UPDATE OF project_id, archived ON project_sessions
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.archived <> OLD.archived
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.id;
END;
CREATE TRIGGER sidebar_section_session_clear_manual_rank AFTER INSERT ON workspace_sidebar_section_items
WHEN NEW.session_id IS NOT NULL
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.session_id;
END;
CREATE TRIGGER sidebar_section_session_move_clear_manual_rank AFTER UPDATE OF section_id ON workspace_sidebar_section_items
WHEN NEW.session_id IS NOT NULL
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.session_id;
END;
CREATE TRIGGER project_session_link_activity AFTER INSERT ON project_session_threads
BEGIN
  UPDATE project_sessions SET activity_at = max(activity_at, (SELECT recency_at FROM codex_threads WHERE thread_id = NEW.thread_id)) WHERE id = NEW.session_id;
END;
CREATE TRIGGER codex_thread_session_activity AFTER UPDATE OF recency_at ON codex_threads
WHEN NEW.recency_at > OLD.recency_at
BEGIN
  UPDATE project_sessions SET activity_at = max(activity_at, NEW.recency_at) WHERE id IN (SELECT session_id FROM project_session_threads WHERE thread_id = NEW.thread_id);
END;
CREATE TRIGGER sidebar_section_restore_clear_manual_rank AFTER UPDATE OF lifecycle ON workspace_sidebar_sections
WHEN NEW.lifecycle = 'active' AND OLD.lifecycle <> 'active'
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id IN (SELECT session_id FROM workspace_sidebar_section_items WHERE section_id = NEW.section_id AND library_id = NEW.library_id);
END;
CREATE TABLE page_work_launches (
  launch_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES project_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
  brief TEXT NOT NULL CHECK(length(CAST(brief AS BLOB)) BETWEEN 1 AND 256000),
  again INTEGER NOT NULL CHECK(again IN (0,1)),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  rejection TEXT, status_fence INTEGER NOT NULL DEFAULT 0 CHECK(status_fence >= 0), status_moved INTEGER NOT NULL DEFAULT 0 CHECK(status_moved IN (0,1)), automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)),
  CHECK(accepted_at IS NULL OR rejection IS NULL)
) STRICT;
CREATE INDEX idx_page_work_launches_pending ON page_work_launches(created_at,launch_id) WHERE accepted_at IS NULL AND rejection IS NULL;
CREATE INDEX idx_page_work_reports_latest ON project_session_pages(page_id,report_at DESC,report_revision DESC,session_id) WHERE report_outcome IS NOT NULL;
CREATE TABLE inbox_plan_results (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  page_ids_json TEXT NOT NULL CHECK(json_valid(page_ids_json) AND json_type(page_ids_json) = 'array' AND json_array_length(page_ids_json) BETWEEN 2 AND 8)
) STRICT;
CREATE TABLE page_active_chats (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  set_at TEXT NOT NULL,
  FOREIGN KEY(session_id,page_id) REFERENCES project_session_pages(session_id,page_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_page_active_chats_session ON page_active_chats(session_id,page_id);
CREATE TRIGGER clear_archived_active_chats AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived = 1
BEGIN
  DELETE FROM page_active_chats WHERE session_id = NEW.id;
END;
CREATE TABLE page_workspaces (
  workspace_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_url TEXT,
  repository_root TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_commit_oid TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('preparing','ready','cleanup_requested','removed','failed')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  allocation_operation_id TEXT NOT NULL UNIQUE,
  worktree_path TEXT,
  failure TEXT
) STRICT;
CREATE TABLE session_workspaces (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES page_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX session_workspaces_workspace ON session_workspaces(workspace_id, session_id);
CREATE TABLE page_pull_requests (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES page_workspaces(workspace_id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','MERGED')),
  observed_at TEXT NOT NULL
) STRICT;
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1), role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  UNIQUE (id, library_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX members_library ON members(library_id, lifecycle, display_name, id);
CREATE TABLE local_profile_members (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL UNIQUE REFERENCES libraries(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL,
  FOREIGN KEY (member_id, library_id) REFERENCES members(id, library_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;
CREATE TRIGGER libraries_initialize_local_member AFTER INSERT ON libraries
BEGIN
  INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES (lower(hex(randomblob(16))),NEW.id,'Owner','active','owner');
  INSERT INTO local_profile_members(profile_id,library_id,member_id) SELECT NEW.profile_id,NEW.id,id FROM members WHERE library_id=NEW.id;
END;
CREATE TRIGGER members_name_insert BEFORE INSERT ON members
WHEN lower(trim(NEW.display_name))='you'
BEGIN SELECT RAISE(ABORT,'A Member name cannot be You'); END;
CREATE TRIGGER members_name_update BEFORE UPDATE OF display_name ON members
WHEN lower(trim(NEW.display_name))='you'
BEGIN SELECT RAISE(ABORT,'A Member name cannot be You'); END;
CREATE TRIGGER pages_initialize_work AFTER INSERT ON pages
BEGIN
  INSERT OR IGNORE INTO block_properties(block_id, library_id, property_key, value_type, value_json, revision, updated_at)
  SELECT NEW.block_id, NEW.library_id, 'work', 'json',
    json_object('assignee', null, 'auto_start', json('false'), 'owner', member_id), 1, NEW.updated_at
  FROM local_profile_members WHERE library_id = NEW.library_id;
END;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  kind TEXT NOT NULL CHECK(kind='github'),
  revision INTEGER NOT NULL CHECK(revision>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  enabled_at_ms INTEGER,
  config_json TEXT NOT NULL CHECK(json_valid(config_json))
) STRICT;
CREATE INDEX sources_library ON sources(library_id,id);
CREATE TABLE source_positions (
  source_id TEXT NOT NULL REFERENCES sources(id),
  partition TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0 CHECK(baseline IN (0,1)),
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  next_poll_at_ms INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  last_success_at_ms INTEGER,
  PRIMARY KEY(source_id,partition)
) WITHOUT ROWID, STRICT;
CREATE TABLE external_threads (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  provider TEXT NOT NULL CHECK(provider='github'),
  host TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number>0),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  UNIQUE(library_id,provider,host,repository_id,number)
) STRICT;
CREATE TABLE source_triggers (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  library_id TEXT NOT NULL REFERENCES libraries(id),
  provider TEXT NOT NULL CHECK(provider='github'),
  semantic_key TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('recorded','followed','intake')),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  UNIQUE(library_id,provider,semantic_key)
) STRICT;
CREATE TABLE trigger_threads (
  trigger_id TEXT NOT NULL REFERENCES source_triggers(id),
  thread_id TEXT NOT NULL REFERENCES external_threads(id),
  role TEXT NOT NULL CHECK(role='primary'),
  PRIMARY KEY(trigger_id,thread_id),
  UNIQUE(trigger_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX trigger_threads_window ON trigger_threads(thread_id,trigger_id);
CREATE TRIGGER source_triggers_immutable BEFORE UPDATE ON source_triggers
BEGIN SELECT RAISE(ABORT,'Source Triggers are immutable'); END;
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id),
  page_id TEXT REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source_failing','delivery_failing','delivery_unresolved','channel_failing','credential_invalid')),
  first_failure_at_ms INTEGER NOT NULL,
  last_failure_at_ms INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL CHECK(consecutive_failures>0),
  summary TEXT NOT NULL,
  fix TEXT NOT NULL CHECK(fix IN ('reconnect','retry','open_card')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  opened_at_ms INTEGER,
  resolved_at_ms INTEGER
) STRICT;
CREATE UNIQUE INDEX problems_unresolved ON problems(library_id,kind,scope) WHERE resolved_at_ms IS NULL;
CREATE INDEX problems_open ON problems(library_id,opened_at_ms) WHERE resolved_at_ms IS NULL;
CREATE TABLE channel_outbox (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_thread_id TEXT NOT NULL REFERENCES external_threads(id),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  episode TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 16384),
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  marker TEXT NOT NULL UNIQUE,
  thread_order INTEGER NOT NULL CHECK(thread_order>0),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','dropped')),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  remote_comment_id TEXT,
  remote_url TEXT,
  terminal_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)),
  UNIQUE(page_id,body_hash,episode),
  UNIQUE(external_thread_id,thread_order)
) STRICT;
CREATE INDEX channel_outbox_pending ON channel_outbox(library_id,state,retry_at_ms);
CREATE TRIGGER channel_outbox_frozen BEFORE UPDATE OF page_id,source_id,external_thread_id,source_json,thread_json,episode,body,body_hash,marker,thread_order,created_at_ms ON channel_outbox
BEGIN SELECT RAISE(ABORT,'Channel replies are frozen'); END;
CREATE TABLE page_thread_follows (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  external_thread_id TEXT NOT NULL REFERENCES external_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('own_pr','origin','context')),
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status_fence INTEGER NOT NULL CHECK(status_fence >= 0),
  last_fact_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(page_id,external_thread_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX page_thread_follows_thread ON page_thread_follows(external_thread_id,page_id);
CREATE UNIQUE INDEX page_thread_follows_own_pr ON page_thread_follows(page_id) WHERE role='own_pr';
CREATE TABLE thread_delivery_batches (
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  message_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  execution_ref_json TEXT NOT NULL CHECK(json_valid(execution_ref_json)),
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  created_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected')),
  receipt TEXT
, consecutive_failures INTEGER NOT NULL DEFAULT 0, retry_at_ms INTEGER NOT NULL DEFAULT 0, last_failure TEXT, settled_at_ms INTEGER) WITHOUT ROWID, STRICT;
CREATE INDEX thread_delivery_batches_pending ON thread_delivery_batches(state,message_id);
CREATE TABLE thread_deliveries (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES source_triggers(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  session_id TEXT,
  binding_revision INTEGER,
  execution_ref_json TEXT CHECK(execution_ref_json IS NULL OR json_valid(execution_ref_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','unresolved','suppressed','batched','accepted','rejected')),
  reason TEXT,
  message_id TEXT REFERENCES thread_delivery_batches(message_id) ON DELETE SET NULL,
  UNIQUE(trigger_id,page_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX thread_deliveries_pending ON thread_deliveries(state,id);
CREATE TABLE github_intakes (
  external_thread_id TEXT PRIMARY KEY REFERENCES external_threads(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE github_entry_provenance (
  page_id TEXT PRIMARY KEY REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
) WITHOUT ROWID, STRICT;
CREATE INDEX github_intakes_page ON github_intakes(page_id,external_thread_id);
CREATE TABLE github_intake_triggers (
  trigger_id TEXT PRIMARY KEY REFERENCES source_triggers(id) ON DELETE CASCADE,
  external_thread_id TEXT NOT NULL REFERENCES github_intakes(external_thread_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE thread_milestones (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES source_triggers(id) ON DELETE CASCADE,
  fact_identity TEXT NOT NULL,
  destination TEXT NOT NULL,
  status_moved INTEGER NOT NULL CHECK(status_moved IN (0,1)), reason TEXT, stage TEXT,
  PRIMARY KEY(page_id,fact_identity)
) WITHOUT ROWID, STRICT;
CREATE TABLE execution_holds (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('page','project','space')),
  scope_id TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES members(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  paused_at TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id)
) STRICT;
CREATE TABLE execution_hold_routing_clocks (
  request_id TEXT NOT NULL REFERENCES inbox_suggestion_requests(request_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  paused_at_ms INTEGER,
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  PRIMARY KEY (request_id, generation)
) STRICT;
CREATE TABLE session_execution_observations (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  observed_json TEXT NOT NULL CHECK (json_valid(observed_json)),
  observed_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_episodes (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  episode TEXT NOT NULL,
  since TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_dirty (page_id TEXT PRIMARY KEY) WITHOUT ROWID, STRICT;
CREATE TRIGGER turn_pages_insert AFTER INSERT ON pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_pages_update AFTER UPDATE ON pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_pages_delete AFTER DELETE ON pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_blocks_insert AFTER INSERT ON blocks

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_blocks_update AFTER UPDATE ON blocks

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_blocks_delete AFTER DELETE ON blocks

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_block_properties_insert AFTER INSERT ON block_properties
WHEN NEW.property_key='work'
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_block_properties_update AFTER UPDATE ON block_properties
WHEN NEW.property_key='work'
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_block_properties_delete AFTER DELETE ON block_properties
WHEN OLD.property_key='work'
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_active_chats_insert AFTER INSERT ON page_active_chats

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_active_chats_update AFTER UPDATE ON page_active_chats

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_active_chats_delete AFTER DELETE ON page_active_chats

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_session_pages_insert AFTER INSERT ON project_session_pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_session_pages_update AFTER UPDATE ON project_session_pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_session_pages_delete AFTER DELETE ON project_session_pages

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
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
CREATE TRIGGER turn_session_execution_observations_insert AFTER INSERT ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_property_values_insert AFTER INSERT ON data_source_property_values
WHEN NEW.property_id='status'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_page_memberships_insert AFTER INSERT ON data_source_page_memberships

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_relation_edges_insert AFTER INSERT ON data_source_relation_edges
WHEN NEW.property_id='blocked_by'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.source_membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_properties_insert AFTER INSERT ON data_source_properties
WHEN NEW.id IN ('status','blocked_by')
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=NEW.data_source_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_update AFTER UPDATE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=NEW.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_property_values_update AFTER UPDATE ON data_source_property_values
WHEN NEW.property_id='status'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_page_memberships_update AFTER UPDATE ON data_source_page_memberships

BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_relation_edges_update AFTER UPDATE ON data_source_relation_edges
WHEN NEW.property_id='blocked_by'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=NEW.source_membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_properties_update AFTER UPDATE ON data_source_properties
WHEN NEW.id IN ('status','blocked_by')
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=NEW.data_source_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_session_execution_observations_delete AFTER DELETE ON session_execution_observations

BEGIN
  INSERT INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=OLD.session_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_property_values_delete AFTER DELETE ON data_source_property_values
WHEN OLD.property_id='status'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=OLD.membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_page_memberships_delete AFTER DELETE ON data_source_page_memberships

BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_block_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_relation_edges_delete AFTER DELETE ON data_source_relation_edges
WHEN OLD.property_id='blocked_by'
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.id=OLD.source_membership_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_source_properties_delete AFTER DELETE ON data_source_properties
WHEN OLD.id IN ('status','blocked_by')
BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=OLD.data_source_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_data_sources_update AFTER UPDATE ON data_sources

BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership  WHERE membership.data_source_id=NEW.id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_database_containers_update AFTER UPDATE ON database_containers

BEGIN
  INSERT INTO page_turn_dirty SELECT membership.page_block_id FROM data_source_page_memberships membership JOIN data_sources source ON source.id=membership.data_source_id WHERE source.home_database_block_id=NEW.block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_members_update AFTER UPDATE ON members

BEGIN
  INSERT INTO page_turn_dirty SELECT block_id FROM block_properties WHERE property_key='work' ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_key_namespaces_update AFTER UPDATE ON page_key_namespaces
BEGIN
  INSERT INTO page_turn_dirty SELECT DISTINCT dependent.page_block_id
  FROM data_sources source JOIN data_source_page_memberships target ON target.data_source_id=source.id
  JOIN data_source_relation_edges edge ON edge.target_page_block_id=target.page_block_id AND edge.property_id='blocked_by'
  JOIN data_source_page_memberships dependent ON dependent.id=edge.source_membership_id
  WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_workspaces_insert AFTER INSERT ON page_workspaces
BEGIN
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_workspaces_update AFTER UPDATE ON page_workspaces
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
  INSERT INTO page_turn_dirty VALUES (NEW.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_page_workspaces_delete AFTER DELETE ON page_workspaces
BEGIN
  INSERT INTO page_turn_dirty VALUES (OLD.page_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_projects_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_projects_update AFTER UPDATE ON projects
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_projects_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_database_bindings_insert AFTER INSERT ON project_database_bindings
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_database_bindings_update AFTER UPDATE ON project_database_bindings
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=NEW.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER turn_project_database_bindings_delete AFTER DELETE ON project_database_bindings
BEGIN
  INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id WHERE source.home_database_block_id=OLD.database_block_id ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER personal_space_member_insert BEFORE INSERT ON members
WHEN (SELECT space_kind FROM libraries WHERE id=NEW.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR EXISTS(SELECT 1 FROM members WHERE library_id=NEW.library_id))
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_member_update BEFORE UPDATE OF role,lifecycle,library_id ON members
WHEN ((SELECT space_kind FROM libraries WHERE id=OLD.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR NEW.library_id<>OLD.library_id))
 OR ((SELECT space_kind FROM libraries WHERE id=NEW.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR EXISTS(SELECT 1 FROM members WHERE library_id=NEW.library_id AND id<>OLD.id)))
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_member_delete BEFORE DELETE ON members
WHEN (SELECT space_kind FROM libraries WHERE id=OLD.library_id)='personal'
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_kind_update BEFORE UPDATE OF space_kind ON libraries
WHEN NEW.space_kind='personal' AND (SELECT count(*) FROM members WHERE library_id=NEW.id AND lifecycle='active' AND role='owner')<>1
 OR NEW.space_kind='personal' AND (SELECT count(*) FROM members WHERE library_id=NEW.id)<>1
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TABLE space_invites (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
 code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','member')),
 member_id TEXT REFERENCES members(id),
 expires_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), redeemed_at INTEGER
, device_link INTEGER NOT NULL DEFAULT 0 CHECK(device_link IN (0,1)), created_at INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE member_devices (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL, member_id TEXT NOT NULL,
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 256), credential_hash TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked_at INTEGER, form_factor TEXT NOT NULL DEFAULT 'desktop' CHECK(form_factor IN ('desktop','phone')),
 FOREIGN KEY(member_id,library_id) REFERENCES members(id,library_id)
) STRICT;
CREATE INDEX member_devices_member ON member_devices(member_id,revoked_at);
CREATE TABLE member_device_push_registrations (
 device_id TEXT PRIMARY KEY REFERENCES member_devices(id) ON DELETE CASCADE,
 handle TEXT NOT NULL CHECK(length(handle) BETWEEN 1 AND 1024),
 push_key TEXT NOT NULL CHECK(length(push_key)=43),
 needs_you INTEGER NOT NULL CHECK(needs_you IN (0,1)),
 finished INTEGER NOT NULL CHECK(finished IN (0,1)),
 updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE member_sessions (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES member_devices(id),
 token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX member_sessions_device ON member_sessions(device_id,expires_at);
CREATE TABLE remote_operation_members (
 module_name TEXT NOT NULL, operation_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id), PRIMARY KEY(module_name,operation_id)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER remote_receipt_collect AFTER DELETE ON core_module_receipts
WHEN NOT EXISTS(SELECT 1 FROM detached_module_receipts WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id)
BEGIN DELETE FROM remote_operation_members WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id; END;
CREATE TRIGGER remote_detached_receipt_collect AFTER DELETE ON detached_module_receipts
WHEN NOT EXISTS(SELECT 1 FROM core_module_receipts WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id)
BEGIN DELETE FROM remote_operation_members WHERE module_name=OLD.module_name AND operation_id=OLD.operation_id; END;
CREATE TABLE page_turn_notes (
  note_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  episode TEXT NOT NULL,
  coordinator_session_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  notify INTEGER NOT NULL CHECK(notify IN (0,1)),
  created_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
, actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))) WITHOUT ROWID, STRICT;
CREATE INDEX idx_page_turn_notes_episode ON page_turn_notes(page_id,episode,created_seq,note_id);
CREATE TABLE page_turn_note_events (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES coordinator_work_events(event_id),
  note_id TEXT NOT NULL REFERENCES page_turn_notes(note_id) ON DELETE CASCADE,
  PRIMARY KEY(page_id,episode,event_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE inbox_answers (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  question_page_id TEXT NOT NULL UNIQUE REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scope_project_id TEXT REFERENCES projects(id),
  coordinator_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  handled_at TEXT
, member_id TEXT REFERENCES members(id)) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_replies (
  proposal_id TEXT PRIMARY KEY REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  episode TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE TABLE page_turn_notification_intents (
  member_id TEXT NOT NULL REFERENCES members(id),
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  PRIMARY KEY(member_id,page_id,episode)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_page_turn_episode_order ON page_turn_episodes(since,page_id);
CREATE TABLE chat_message_deliveries (
  delivery_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  destination_title TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  author_json TEXT NOT NULL CHECK(json_valid(author_json)),
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count BETWEEN 0 AND 100),
  question_answer INTEGER NOT NULL DEFAULT 0 CHECK(question_answer IN (0,1)),
  answer_run_id TEXT,
  original_page_count INTEGER NOT NULL DEFAULT 0 CHECK(original_page_count >= 0),
  created_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_chat_message_deliveries_session ON chat_message_deliveries(session_id,created_at,delivery_id);
CREATE TABLE chat_message_delivery_pages (
  delivery_id TEXT NOT NULL REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES inbox_proposals(proposal_id) ON DELETE SET NULL,
  content_fingerprint TEXT NOT NULL,
  PRIMARY KEY(delivery_id,page_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_delivery_origins (
  delivery_id TEXT NOT NULL REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  origin_id TEXT NOT NULL,
  PRIMARY KEY(origin_id,delivery_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_inbounds (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  question_answered INTEGER NOT NULL DEFAULT 0 CHECK(question_answered IN (0,1)),
  PRIMARY KEY(session_id,run_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_handbacks (
  receipt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES chat_message_deliveries(delivery_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  created_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
, actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))) WITHOUT ROWID, STRICT;
CREATE TABLE chat_message_handback_pages (
  receipt_id TEXT NOT NULL REFERENCES chat_message_handbacks(receipt_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  PRIMARY KEY(page_id,receipt_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE intake_dispositions (
  id INTEGER PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('chat','filed','kept','done','open')),
  proposal_id TEXT REFERENCES inbox_proposals(proposal_id) ON DELETE SET NULL,
  at TEXT NOT NULL,
  actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))
) STRICT;
CREATE INDEX intake_dispositions_page ON intake_dispositions(page_id,proposal_id,at);
CREATE VIEW activity_page_scopes AS
SELECT page.block_id AS page_id,page.library_id,binding.project_id
FROM pages page LEFT JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id
LEFT JOIN project_database_bindings binding ON binding.database_block_id=source.home_database_block_id AND binding.lifecycle='active';
CREATE TABLE automations (
           automation_id TEXT PRIMARY KEY,
           owner_member_id TEXT NOT NULL REFERENCES members(id),
           scope_project_id TEXT REFERENCES projects(id),
           condition_text TEXT NOT NULL,
           timezone TEXT NOT NULL,
           jitter_salt TEXT NOT NULL,
           schedule_revision INTEGER NOT NULL DEFAULT 1 CHECK(schedule_revision>=1),
           kind TEXT NOT NULL,
           status TEXT NOT NULL,
           target_session_id TEXT,
           name TEXT NOT NULL,
           prompt TEXT NOT NULL DEFAULT '',
           rrule TEXT,
           model TEXT,
           reasoning_effort TEXT,
           service_tier TEXT,
           cwds_json TEXT NOT NULL DEFAULT '[]',
           execution_environment TEXT NOT NULL DEFAULT 'worktree',
           local_environment_config_path TEXT,
           next_run_at INTEGER,
           last_run_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           automation_revision INTEGER NOT NULL DEFAULT 1 CHECK (automation_revision >= 1),
           notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only'), project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512)), agent_backend_kind TEXT NOT NULL DEFAULT 'codex' CHECK (agent_backend_kind IN ('codex', 'acp', 'claude', 'opencode')), agent_backend_definition_id TEXT CHECK (agent_backend_definition_id IS NULL OR (agent_backend_definition_id = trim(agent_backend_definition_id) AND length(agent_backend_definition_id) BETWEEN 1 AND 512)), agent_backend_instance_config_id TEXT CHECK ((agent_backend_kind = 'codex' AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NULL) OR (agent_backend_kind IN ('claude', 'opencode') AND agent_backend_definition_id IS NULL AND agent_backend_instance_config_id IS NOT NULL AND agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512) OR (agent_backend_kind = 'acp' AND agent_backend_definition_id IS NOT NULL AND (agent_backend_instance_config_id IS NULL OR (agent_backend_instance_config_id = trim(agent_backend_instance_config_id) AND length(agent_backend_instance_config_id) BETWEEN 1 AND 512)))),
  mode TEXT NOT NULL DEFAULT 'run' CHECK (mode IN ('dry_run','ask_first','run')), runbook_page_id TEXT,
           CHECK (kind IN ('cron', 'heartbeat')),
           CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
           CHECK (execution_environment IN ('local', 'worktree')),
           CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
           CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
           CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
         ) WITHOUT ROWID;
CREATE TABLE automation_execution_leases (
  lease_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL CHECK (length(dispatch_id) BETWEEN 1 AND 512 AND dispatch_id = trim(dispatch_id)),
  automation_revision INTEGER NOT NULL CHECK (automation_revision >= 1),
  scheduled_for_ms INTEGER NOT NULL CHECK (scheduled_for_ms >= 0),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4294967295),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed', 'cancelled')),
  claimed_at_ms INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > claimed_at_ms),
  settled_at_ms INTEGER,
  retry_at_ms INTEGER,
  reason_code TEXT,
  purpose TEXT NOT NULL DEFAULT 'run' CHECK (purpose IN ('run','hold')),
  UNIQUE (dispatch_id, attempt),
  CHECK (length(lease_id) BETWEEN 1 AND 512),
  CHECK (settled_at_ms IS NULL OR settled_at_ms >= claimed_at_ms),
  CHECK (retry_at_ms IS NULL OR retry_at_ms >= 0),
  CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  CHECK ((status = 'claimed' AND settled_at_ms IS NULL) OR (status <> 'claimed' AND settled_at_ms IS NOT NULL))
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_execution_runs (
  agent_selection_json TEXT CHECK(agent_selection_json IS NULL OR json_valid(agent_selection_json)),
  page_id TEXT REFERENCES pages(block_id) ON DELETE SET NULL,
  message_id TEXT,
  notification_policy TEXT CHECK(notification_policy IS NULL OR notification_policy='failed_runs_only'),
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  read_at INTEGER,
  session_title TEXT,
  source_cwd TEXT,
  inbox_title TEXT,
  inbox_summary TEXT,
  archived_user_message TEXT,
  archived_assistant_message TEXT,
  archived_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  run_revision INTEGER NOT NULL DEFAULT 1 CHECK (run_revision >= 1),
  admission_hash TEXT NOT NULL CHECK (length(admission_hash) = 64 AND admission_hash NOT GLOB '*[^0-9a-f]*'),
  dispatch_id TEXT,
  CHECK (length(run_id) BETWEEN 1 AND 512 AND run_id = trim(run_id)),
  CHECK (session_id IS NULL OR (length(session_id) BETWEEN 1 AND 512 AND session_id = trim(session_id))),
  CHECK (status IN ('IN_PROGRESS', 'PENDING_REVIEW', 'ACCEPTED', 'ARCHIVED'))
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_decisions (
  dispatch_id TEXT PRIMARY KEY,
  automation_name TEXT NOT NULL DEFAULT '',
  automation_id TEXT NOT NULL REFERENCES automations(automation_id),
  status TEXT NOT NULL CHECK (status IN ('held','admitted','completed','failed','skipped','withdrawn')),
  page_id TEXT,
  automation_revision INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'ask_first' CHECK(mode IN ('dry_run','ask_first','run')),
  reason TEXT NOT NULL DEFAULT 'Clock condition matched',
  frozen_action_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(frozen_action_json)),
  frozen_authority_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(frozen_authority_json)),
  inbox_project_id TEXT,
  first_scheduled_for_ms INTEGER NOT NULL CHECK (first_scheduled_for_ms >= 0),
  last_scheduled_for_ms INTEGER NOT NULL CHECK (last_scheduled_for_ms >= first_scheduled_for_ms),
  missed_count INTEGER NOT NULL DEFAULT 0 CHECK (missed_count BETWEEN 0 AND 4294967295),
  hold_basis_json TEXT NOT NULL CHECK (json_valid(hold_basis_json)),
  admission_prompt TEXT,
  admission_agent_json TEXT CHECK (admission_agent_json IS NULL OR json_valid(admission_agent_json)),
  admitted_at_ms INTEGER,
  due_at_ms INTEGER,
  failure_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
, waiting_in_inbox INTEGER NOT NULL DEFAULT 0
  CHECK (waiting_in_inbox IN (0,1) AND (waiting_in_inbox=0 OR status IN ('held','failed'))), assessment_json TEXT CHECK(assessment_json IS NULL OR json_valid(assessment_json)), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))) WITHOUT ROWID, STRICT;
CREATE TABLE automation_clock_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  jitter_salt TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
  CHECK (length(jitter_salt) BETWEEN 1 AND 512)
) STRICT;
CREATE TABLE automation_clock_triggers (
 id TEXT PRIMARY KEY,
 automation_id TEXT NOT NULL REFERENCES automations(automation_id),
 schedule_revision INTEGER NOT NULL CHECK(schedule_revision>=1),
 due_at_ms INTEGER NOT NULL CHECK(due_at_ms>=0),
 received_at_ms INTEGER NOT NULL CHECK(received_at_ms>=0),
 semantic_key TEXT NOT NULL UNIQUE
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_decision_triggers (
 dispatch_id TEXT NOT NULL REFERENCES automation_decisions(dispatch_id),
 trigger_id TEXT NOT NULL REFERENCES automation_clock_triggers(id),
 PRIMARY KEY(dispatch_id,trigger_id)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER automation_clock_triggers_immutable BEFORE UPDATE ON automation_clock_triggers
BEGIN SELECT RAISE(ABORT,'Clock Triggers are immutable'); END;
CREATE TABLE "inbox_entries" (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  submitted_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'agent', 'command_line', 'automation', 'github')),
  source_session_id TEXT CHECK (source_session_id IS NULL OR length(source_session_id) BETWEEN 1 AND 512),
  source_thread_id TEXT CHECK (source_thread_id IS NULL OR length(source_thread_id) BETWEEN 1 AND 512),
  source_turn_id TEXT CHECK (source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 512),
  source_project_id TEXT CHECK (source_project_id IS NULL OR length(source_project_id) BETWEEN 1 AND 512),
  source_label TEXT CHECK (source_label IS NULL OR length(source_label) BETWEEN 1 AND 512),
  provisional_title TEXT CHECK (provisional_title IS NULL OR length(provisional_title) BETWEEN 1 AND 512),
  kind TEXT CHECK (kind IS NULL OR kind IN ('note', 'todo', 'question')),
  kind_set_by_user INTEGER NOT NULL DEFAULT 0 CHECK (kind_set_by_user IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'kept', 'done')),
  suggestion_state TEXT NOT NULL DEFAULT 'none' CHECK (suggestion_state IN ('none', 'waiting', 'pending', 'settled', 'failed')),
  suggestion_error TEXT CHECK (suggestion_error IS NULL OR length(suggestion_error) BETWEEN 1 AND 2000),
  current_proposal_id TEXT CHECK (current_proposal_id IS NULL OR length(current_proposal_id) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  source_budget_key TEXT,
  scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE CHECK (scope_project_id IS NULL OR length(scope_project_id) BETWEEN 1 AND 512),
  outcome TEXT CHECK (outcome IN ('kept','done','moved','chat')),
  suggestion_request_id TEXT,
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  source_automation_id TEXT,
  source_dispatch_id TEXT,
  reply_to_page_id TEXT CHECK (reply_to_page_id IS NULL OR length(reply_to_page_id) BETWEEN 1 AND 512), status_fence INTEGER NOT NULL DEFAULT 0 CHECK(status_fence >= 0), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)), author_member_id TEXT REFERENCES members(id),
  UNIQUE (library_id, seq),
  CHECK (source_kind = 'agent' OR (source_session_id IS NULL AND source_thread_id IS NULL AND source_turn_id IS NULL)),
  CHECK (source_kind <> 'user' OR (source_project_id IS NULL AND source_label IS NULL)),
  CHECK (source_kind = 'user' OR source_label IS NOT NULL),
  CHECK (suggestion_state = 'failed' OR suggestion_error IS NULL)
) WITHOUT ROWID, STRICT;
CREATE TABLE "inbox_proposals" (
  proposal_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user', 'automation')),
  state TEXT NOT NULL CHECK (state IN ('open', 'superseded', 'dismissed', 'dispatching', 'completed', 'failed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  action_json TEXT NOT NULL CHECK (json_valid(action_json) AND length(action_json) <= 65536),
  kind TEXT CHECK (kind IS NULL OR kind IN ('note', 'todo', 'question')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  rationale TEXT CHECK (rationale IS NULL OR length(rationale) BETWEEN 1 AND 4000),
  produced_by TEXT CHECK (produced_by IS NULL OR length(produced_by) BETWEEN 1 AND 256),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'array'),
  dispatch_session_id TEXT CHECK (dispatch_session_id IS NULL OR length(dispatch_session_id) BETWEEN 1 AND 512),
  dispatch_thread_id TEXT CHECK (dispatch_thread_id IS NULL OR length(dispatch_thread_id) BETWEEN 1 AND 512),
  confirmed_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  failure_message TEXT CHECK (failure_message IS NULL OR length(failure_message) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failure_kind TEXT CHECK (failure_kind IN ('rejected','unavailable','unknown')), explicit_request INTEGER NOT NULL DEFAULT 0 CHECK (explicit_request IN (0,1) AND (origin='agent' OR explicit_request=0)), confirmed_by TEXT CHECK (confirmed_by IS NULL OR (confirmed_by IN ('user','nodex') AND confirmed_at IS NOT NULL)), auto_confirm_pending INTEGER NOT NULL DEFAULT 0 CHECK(auto_confirm_pending IN (0,1)), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)), confirmed_actor_json TEXT CHECK(confirmed_actor_json IS NULL OR json_valid(confirmed_actor_json)),
  CHECK (state <> 'dispatching' OR (dispatch_session_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_message IS NOT NULL)
) WITHOUT ROWID, STRICT;
CREATE UNIQUE INDEX idx_automation_execution_leases_active_occurrence
  ON automation_execution_leases(automation_id, scheduled_for_ms)
  WHERE status = 'claimed';
CREATE INDEX idx_automation_execution_leases_inbox
  ON automation_execution_leases(status, expires_at_ms, scheduled_for_ms, lease_id);
CREATE UNIQUE INDEX idx_automations_active_heartbeat
           ON automations(target_session_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_session_id IS NOT NULL;
CREATE INDEX idx_inbox_entries_suggestion ON inbox_entries(library_id, suggestion_state, seq);
CREATE INDEX idx_inbox_entries_source_budget ON inbox_entries(library_id, source_budget_key)
  WHERE source_budget_key IS NOT NULL;
CREATE INDEX idx_inbox_entries_scope ON inbox_entries(library_id, scope_project_id, seq);
CREATE INDEX idx_inbox_proposals_state ON inbox_proposals(library_id, state, confirmed_at);
CREATE INDEX idx_inbox_proposals_dispatch_session ON inbox_proposals(dispatch_session_id)
  WHERE dispatch_session_id IS NOT NULL;
CREATE INDEX automation_execution_runs_definition_status_created
  ON automation_execution_runs(automation_id, status, created_at DESC);
CREATE INDEX automation_execution_runs_unread ON automation_execution_runs(read_at, status, updated_at);
CREATE INDEX automation_execution_runs_session_created
  ON automation_execution_runs(session_id, created_at DESC, run_id);
CREATE TRIGGER automation_run_identity_guard
BEFORE UPDATE ON automation_execution_runs
WHEN NEW.run_id <> OLD.run_id OR NEW.automation_id <> OLD.automation_id
  OR NEW.admission_hash <> OLD.admission_hash
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
BEGIN
  SELECT RAISE(ABORT, 'Automation Run admission and Session binding are immutable');
END;
CREATE INDEX automation_execution_leases_retry
  ON automation_execution_leases(automation_id, automation_revision, retry_at_ms, status, claimed_at_ms DESC, attempt DESC);
CREATE INDEX automation_execution_leases_expiry
  ON automation_execution_leases(automation_id, automation_revision, scheduled_for_ms, status, reason_code, claimed_at_ms DESC, attempt DESC);
CREATE UNIQUE INDEX idx_automation_decisions_waiting ON automation_decisions(automation_id) WHERE waiting_in_inbox=1 AND assessment_json IS NULL;
CREATE UNIQUE INDEX idx_automation_decisions_page ON automation_decisions(page_id);
CREATE INDEX idx_automation_decisions_due ON automation_decisions(due_at_ms) WHERE status='admitted';
CREATE INDEX idx_automation_execution_runs_dispatch ON automation_execution_runs(dispatch_id,created_at,run_id);
CREATE TRIGGER automation_decision_page_inactive
AFTER UPDATE OF lifecycle ON blocks WHEN NEW.lifecycle<>'active' AND OLD.lifecycle='active'
BEGIN
  UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch(NEW.updated_at,'subsec')*1000 AS INTEGER)
  WHERE page_id=NEW.id AND waiting_in_inbox=1;
END;
CREATE TRIGGER automation_decision_page_deleted
BEFORE DELETE ON blocks
BEGIN
  UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,
    updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)
  WHERE page_id=OLD.id AND waiting_in_inbox=1;
END;
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
CREATE VIEW inbox_rows AS
SELECT 'intake' AS row_kind, entry.page_id, entry.library_id, entry.scope_project_id AS project_id,
       entry.submitted_at AS sort_at, 'intake:'||entry.page_id AS row_id,
       (entry.state='open' AND NOT(COALESCE(proposal.state,'')='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown')
        AND NOT(COALESCE(proposal.state,'')='completed' AND COALESCE(json_extract(proposal.action_json,'$.type'),'') IN ('new_chat','send_to_chat','execute_decision'))) AS actionable,
       (entry.state='open' AND NOT(COALESCE(proposal.state,'')='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown')
        AND NOT(COALESCE(proposal.state,'')='completed' AND COALESCE(json_extract(proposal.action_json,'$.type'),'') IN ('new_chat','send_to_chat','execute_decision'))) AS in_inbox
FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals proposal ON proposal.proposal_id=entry.current_proposal_id
LEFT JOIN projects project ON project.id=entry.scope_project_id
WHERE entry.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'turn', page.block_id, page.library_id, project.id, episode.since, 'turn:'||page.block_id||':'||episode.episode, 1, 1
FROM page_turn_episodes episode JOIN pages page ON page.block_id=episode.page_id
JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
LEFT JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id
LEFT JOIN project_database_bindings binding ON binding.database_block_id=source.home_database_block_id AND binding.lifecycle='active'
LEFT JOIN projects project ON project.id=binding.project_id
WHERE json_extract(episode.signature,'$[0].kind')='member'
  AND (project.id IS NULL OR project.lifecycle='active')
  AND (json_extract(episode.signature,'$[1]') IN ('question','approval','review','blocked','failed','stalled')
       OR (json_extract(episode.signature,'$[1]')='ready_to_start' AND EXISTS(
         SELECT 1 FROM data_source_page_memberships membership JOIN data_source_relation_edges edge ON edge.source_membership_id=membership.id AND edge.property_id='blocked_by'
         WHERE membership.page_block_id=page.block_id AND membership.data_source_id=page.parent_id AND membership.removed_at IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM inbox_entries intake WHERE intake.page_id=page.block_id AND intake.state='open' AND intake.current_proposal_id IS NULL)
UNION ALL
SELECT 'answer', answer.page_id, answer.library_id, answer.scope_project_id, answer.created_at, 'answer:'||answer.page_id, 0, answer.handled_at IS NULL
FROM inbox_answers answer JOIN blocks block ON block.id=answer.page_id AND block.lifecycle='active'
LEFT JOIN projects project ON project.id=answer.scope_project_id
WHERE answer.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'problem', problem.id, problem.library_id, problem.project_id,
       strftime('%Y-%m-%dT%H:%M:%fZ',problem.opened_at_ms/1000.0,'unixepoch'), 'problem:'||problem.id, 1, 1
FROM problems problem LEFT JOIN projects project ON project.id=problem.project_id
WHERE problem.opened_at_ms IS NOT NULL AND problem.resolved_at_ms IS NULL
  AND (problem.project_id IS NULL OR project.lifecycle='active');
CREATE UNIQUE INDEX idx_automation_execution_runs_message ON automation_execution_runs(message_id) WHERE message_id IS NOT NULL;
CREATE TRIGGER automations_owner_removed AFTER UPDATE OF lifecycle ON members WHEN NEW.lifecycle='removed'
BEGIN
 UPDATE automations SET status='DELETED',next_run_at=NULL,automation_revision=automation_revision+1,updated_at=MAX(updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE owner_member_id=NEW.id AND status<>'DELETED';
 UPDATE automation_execution_leases SET status='cancelled',settled_at_ms=MAX(claimed_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)),reason_code='automation_owner_removed' WHERE status='claimed' AND (automation_id IN(SELECT automation_id FROM automations WHERE owner_member_id=NEW.id) OR dispatch_id IN(SELECT dispatch_id FROM automation_decisions WHERE json_extract(frozen_authority_json,'$.owner_member_id')=NEW.id));
 UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,reason='Automation Owner is unavailable',updated_at_ms=MAX(created_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE (status IN('held','admitted') OR waiting_in_inbox=1) AND (automation_id IN(SELECT automation_id FROM automations WHERE owner_member_id=NEW.id) OR dispatch_id IN(SELECT dispatch_id FROM automation_decisions WHERE json_extract(frozen_authority_json,'$.owner_member_id')=NEW.id));
END;
CREATE TRIGGER automation_decisions_name_immutable BEFORE UPDATE OF automation_name ON automation_decisions WHEN OLD.automation_name<>'' AND NEW.automation_name IS NOT OLD.automation_name BEGIN SELECT RAISE(ABORT,'Automation decision names are immutable'); END;
CREATE TRIGGER intake_disposition_recorded AFTER UPDATE OF state ON inbox_entries
WHEN OLD.state<>NEW.state AND NOT EXISTS(SELECT 1 FROM intake_dispositions fact
  WHERE fact.page_id=NEW.page_id AND fact.proposal_id=NEW.current_proposal_id AND fact.at=NEW.updated_at)
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,at) VALUES(NEW.library_id,NEW.page_id,NEW.scope_project_id,NEW.state,NEW.updated_at);
END;
CREATE TRIGGER intake_disposition_confirmed AFTER UPDATE OF confirmed_at ON inbox_proposals
WHEN NEW.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,proposal_id,at)
  SELECT entry.library_id,entry.page_id,entry.scope_project_id,
    CASE json_extract(NEW.action_json,'$.type') WHEN 'move_to_project' THEN 'filed' WHEN 'keep' THEN 'kept' WHEN 'plan' THEN 'done' ELSE 'chat' END,
    NEW.proposal_id,NEW.confirmed_at
  FROM inbox_proposal_pages link JOIN inbox_entries entry ON entry.page_id=link.page_id
  WHERE link.proposal_id=NEW.proposal_id;
END;
CREATE TABLE automation_event_filters (
 automation_id TEXT PRIMARY KEY REFERENCES automations(automation_id) ON DELETE CASCADE,
 filter_json TEXT NOT NULL CHECK(json_valid(filter_json))
) WITHOUT ROWID, STRICT;
CREATE TABLE automation_assessment_requests (
 request_id TEXT PRIMARY KEY,
 library_id TEXT NOT NULL REFERENCES libraries(id),
 thread_id TEXT NOT NULL REFERENCES external_threads(id),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','settled','failed','followed')),
 policy_hash TEXT NOT NULL,
 automations_json TEXT NOT NULL CHECK(json_valid(automations_json)),
 coordinator_session_id TEXT REFERENCES project_sessions(id),
 handed_over_at_ms INTEGER,
 run_started_at_ms INTEGER,
 failure TEXT,
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL
) WITHOUT ROWID, STRICT;
CREATE UNIQUE INDEX idx_automation_assessment_unsettled ON automation_assessment_requests(thread_id) WHERE state='pending';
CREATE TABLE automation_assessment_triggers (
 trigger_id TEXT PRIMARY KEY REFERENCES source_triggers(id),
 thread_id TEXT NOT NULL REFERENCES external_threads(id),
 request_id TEXT REFERENCES automation_assessment_requests(request_id),
 generation INTEGER,
 CHECK((request_id IS NULL)=(generation IS NULL))
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_automation_assessment_trigger_request ON automation_assessment_triggers(request_id,generation);
CREATE INDEX idx_automation_assessment_thread_queue ON automation_assessment_triggers(thread_id,request_id,trigger_id);
CREATE TABLE automation_decision_source_triggers (
 dispatch_id TEXT NOT NULL REFERENCES automation_decisions(dispatch_id),
 trigger_id TEXT NOT NULL REFERENCES source_triggers(id),
 PRIMARY KEY(dispatch_id,trigger_id)
) WITHOUT ROWID, STRICT;
CREATE VIEW activity_facts AS
SELECT 'message:'||d.id AS id,d.library_id,d.page_id,d.project_id,d.at,
 d.actor_json AS actor_json,
 CASE d.disposition WHEN 'chat' THEN 'Sent message to chat' WHEN 'filed' THEN 'Filed message' WHEN 'kept' THEN 'Kept message' WHEN 'done' THEN 'Marked message done' ELSE 'Returned message to Inbox' END AS description,
 p.rationale AS reason,CASE d.disposition WHEN 'chat' THEN COALESCE(p.dispatch_session_id,json_extract(p.action_json,'$.session_id')) END AS session_id,NULL AS url,
 json_object('disposition',d.disposition,'proposal_id',d.proposal_id,'confirmed_by',p.confirmed_by,
   'answered',json(CASE WHEN d.disposition='done' AND EXISTS(SELECT 1 FROM inbox_answers answer
     WHERE answer.question_page_id=d.page_id AND answer.created_at=d.at) THEN 'true' ELSE 'false' END),
   'action',json_object('type',json_extract(p.action_json,'$.type'),'session_id',json_extract(p.action_json,'$.session_id'),
     'project_id',json_extract(p.action_json,'$.project_id'),'decision_id',json_extract(p.action_json,'$.decision_id'),
     'steps',json_array_length(p.action_json,'$.steps'))) AS evidence_json,'messages' AS category
FROM intake_dispositions d JOIN inbox_entries entry ON entry.page_id=d.page_id
JOIN blocks block ON block.id=d.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals p ON p.proposal_id=d.proposal_id
UNION ALL
SELECT 'launch:'||l.launch_id,s.library_id,l.page_id,l.project_id,l.created_at,l.actor_json,
 CASE l.automatic WHEN 1 THEN 'Automatically started work' ELSE 'Started work' END,l.rejection,l.session_id,NULL,json_object('launch_id',l.launch_id,'accepted_at',l.accepted_at,'automatic',json(CASE l.automatic WHEN 1 THEN 'true' ELSE 'false' END)),'decisions'
FROM page_work_launches l JOIN activity_page_scopes s ON s.page_id=l.page_id
UNION ALL
SELECT 'trigger:'||t.id||':'||COALESCE(d.page_id,intake.page_id,''),t.library_id,COALESCE(d.page_id,intake.page_id),COALESCE(s.project_id,entry.scope_project_id),strftime('%Y-%m-%dT%H:%M:%fZ',t.received_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE t.disposition WHEN 'followed' THEN 'Routed GitHub update to followed cards' WHEN 'intake' THEN 'Sent GitHub request to Inbox' ELSE 'Ignored GitHub update' END,
 CASE t.disposition WHEN 'followed' THEN 'Thread is followed; no new assessment' WHEN 'intake' THEN 'Discovery matched an unwatched request' ELSE 'No followed card or enabled discovery matched' END,d.session_id,json_extract(t.event_json,'$.url'),json_object('trigger_id',t.id,'kind',json_extract(t.event_json,'$.kind'),'actor',json_extract(t.event_json,'$.actor_login'),'event',json(t.event_json),'disposition',t.disposition,'delivery_state',d.state),'decisions'
FROM source_triggers t LEFT JOIN thread_deliveries d ON d.trigger_id=t.id
LEFT JOIN activity_page_scopes s ON s.page_id=d.page_id
LEFT JOIN github_intake_triggers intake_link ON intake_link.trigger_id=t.id
LEFT JOIN github_intakes intake ON intake.external_thread_id=intake_link.external_thread_id
LEFT JOIN inbox_entries entry ON entry.page_id=intake.page_id
UNION ALL
SELECT 'milestone:'||m.page_id||':'||m.fact_identity,s.library_id,m.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',t.received_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE m.status_moved WHEN 1 THEN 'Moved card to ' ELSE 'Skipped move to ' END||CASE m.destination WHEN 'doing' THEN 'In Progress' WHEN 'review' THEN 'In Review' WHEN 'done' THEN 'Done' ELSE 'Canceled' END,m.reason,NULL,json_extract(t.event_json,'$.url'),json_object('trigger_id',t.id,'fact',m.fact_identity,'moved',m.status_moved,'destination',m.destination,'stage',m.stage,'event',json(t.event_json)),'decisions'
FROM thread_milestones m JOIN source_triggers t ON t.id=m.trigger_id JOIN activity_page_scopes s ON s.page_id=m.page_id
UNION ALL
SELECT 'delivery:'||d.id,s.library_id,d.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(b.settled_at_ms,t.received_at_ms)/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE d.state WHEN 'accepted' THEN 'Delivered GitHub update to chat' WHEN 'suppressed' THEN 'Ignored GitHub update on closed work' WHEN 'unresolved' THEN 'GitHub update needs a chat' WHEN 'rejected' THEN 'Chat rejected GitHub update' ELSE 'Queued GitHub update for chat' END,d.reason,d.session_id,json_extract(t.event_json,'$.url'),json_object('delivery_id',d.id,'message_id',d.message_id,'state',d.state,'event',json(t.event_json)),'all'
FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN activity_page_scopes s ON s.page_id=d.page_id LEFT JOIN thread_delivery_batches b ON b.message_id=d.message_id
UNION ALL
SELECT 'channel:'||o.id,o.library_id,o.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',o.updated_at_ms/1000.0,'unixepoch'),o.actor_json,
 CASE o.state WHEN 'sent' THEN 'Replied to origin on GitHub' WHEN 'dropped' THEN 'GitHub reply could not be sent' WHEN 'failed' THEN 'GitHub reply needs retry' ELSE 'Queued reply to origin' END,o.terminal_reason,NULL,COALESCE(o.remote_url,json_extract(o.thread_json,'$.url')),json_object('outbox_id',o.id,'state',o.state,'body',o.body,'comment_id',o.remote_comment_id,'thread',json(o.thread_json)),'all'
FROM channel_outbox o JOIN activity_page_scopes s ON s.page_id=o.page_id
UNION ALL
SELECT 'note:'||n.note_id,s.library_id,n.page_id,s.project_id,n.created_at,n.actor_json,'Added Turn note',n.body,n.coordinator_session_id,NULL,json_object('note_id',n.note_id,'episode',n.episode),'all'
FROM page_turn_notes n JOIN activity_page_scopes s ON s.page_id=n.page_id
UNION ALL
SELECT 'handback:'||h.receipt_id||':'||link.page_id,d.library_id,link.page_id,s.project_id,h.created_at,h.actor_json,'Returned message to Inbox',h.reason,d.session_id,NULL,json_object('receipt_id',h.receipt_id,'delivery_id',h.delivery_id),'decisions'
FROM chat_message_handbacks h JOIN chat_message_deliveries d ON d.delivery_id=h.delivery_id JOIN chat_message_handback_pages link ON link.receipt_id=h.receipt_id JOIN activity_page_scopes s ON s.page_id=link.page_id
UNION ALL
SELECT 'problem-open:'||p.id,p.library_id,p.page_id,p.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',p.opened_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),p.summary,json_extract(p.evidence_json,'$.reason'),NULL,json_extract(p.evidence_json,'$.url'),json_object('problem_id',p.id,'kind',p.kind,'fix',p.fix,'source_id',p.source_id,'count',p.consecutive_failures,'scope',p.scope),'problems'
FROM problems p WHERE p.opened_at_ms IS NOT NULL
UNION ALL
SELECT 'problem-resolved:'||p.id,p.library_id,p.page_id,p.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',p.resolved_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),'Resolved: '||p.summary,'Recovered successfully',NULL,json_extract(p.evidence_json,'$.url'),json_object('problem_id',p.id,'kind',p.kind,'source_id',p.source_id,'count',p.consecutive_failures,'scope',p.scope),'problems'
FROM problems p WHERE p.opened_at_ms IS NOT NULL AND p.resolved_at_ms IS NOT NULL
UNION ALL
SELECT phase.kind||':'||decision.dispatch_id,owner.library_id,decision.page_id,automation.scope_project_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',(CASE phase.kind WHEN 'automation' THEN decision.created_at_ms ELSE decision.updated_at_ms END)/1000.0,'unixepoch'),
 decision.actor_json,'Automation decision',
 CASE WHEN phase.kind='automation' AND decision.status IN ('skipped','withdrawn','failed') THEN NULL
   ELSE COALESCE(decision.failure_message,NULLIF(decision.reason,'')) END,NULL,NULL,
 json_object('decision_id',decision.dispatch_id,'automation_id',decision.automation_id,
   'mode',decision.mode,'manual',json(CASE WHEN decision.admitted_at_ms IS NOT NULL AND decision.page_id IS NULL THEN 'true' ELSE 'false' END),'status',CASE WHEN phase.kind='automation' AND decision.admitted_at_ms IS NOT NULL AND decision.page_id IS NULL THEN 'admitted' WHEN phase.kind='automation' THEN CASE decision.mode WHEN 'dry_run' THEN 'completed' WHEN 'ask_first' THEN 'held' ELSE 'admitted' END ELSE decision.status END,'automation_revision',decision.automation_revision,
   'first_due_at_ms',decision.first_scheduled_for_ms,'last_due_at_ms',decision.last_scheduled_for_ms,
   'missed_count',decision.missed_count),'decisions'
FROM automation_decisions decision JOIN automations automation ON automation.automation_id=decision.automation_id
JOIN members owner ON owner.id=automation.owner_member_id
JOIN (SELECT 'automation' AS kind UNION ALL SELECT 'automation-settlement') phase
  ON phase.kind='automation' OR decision.status IN ('skipped','withdrawn','failed')
WHERE decision.assessment_json IS NULL AND (phase.kind='automation-settlement'
 OR (decision.mode='dry_run' AND decision.status='completed')
 OR decision.admitted_at_ms IS NOT NULL
 OR decision.page_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM automation_execution_leases lease
   WHERE lease.dispatch_id=decision.dispatch_id AND lease.automation_id=decision.automation_id AND lease.purpose='run')
 OR EXISTS(SELECT 1 FROM automation_execution_runs run
   WHERE run.dispatch_id=decision.dispatch_id AND run.automation_id=decision.automation_id))
UNION ALL
SELECT 'assessment:'||d.dispatch_id,m.library_id,d.page_id,r.scope_project_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',d.created_at_ms/1000.0,'unixepoch'),
 d.actor_json,'Automation assessment',d.reason,NULL,NULL,
 json_set(d.assessment_json,'$.fact_kind','assessment','$.automation_id',d.automation_id,'$.decision_id',d.dispatch_id,'$.mode',d.mode,'$.status',d.status),'decisions'
FROM automation_decisions d JOIN automations r ON r.automation_id=d.automation_id JOIN members m ON m.id=r.owner_member_id WHERE d.assessment_json IS NOT NULL;
CREATE TABLE mutation_actors (
  module_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  authorizing_member_id TEXT REFERENCES members(id),
  committed_at TEXT NOT NULL,
  PRIMARY KEY(module_name,operation_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX mutation_actors_time ON mutation_actors(library_id,committed_at,operation_id);
CREATE TRIGGER local_commits_require_actor BEFORE INSERT ON local_commits
WHEN NEW.actor_json IS NULL OR NOT COALESCE(json_extract(NEW.actor_json,'$.type') IN ('member','agent','service'),0)
BEGIN SELECT RAISE(ABORT,'A LocalCommit requires a Core-authored actor'); END;
CREATE TRIGGER page_work_launches_require_actor BEFORE INSERT ON page_work_launches
WHEN NEW.actor_json IS NULL
BEGIN SELECT RAISE(ABORT,'A work launch requires its mutation actor'); END;
CREATE TRIGGER channel_outbox_capture_actor AFTER INSERT ON channel_outbox
BEGIN
 UPDATE channel_outbox SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM channel_outbox WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'A channel reply requires its mutation actor') END;
END;
CREATE TRIGGER channel_outbox_capture_state_actor AFTER UPDATE OF state,updated_at_ms ON channel_outbox
BEGIN
 UPDATE channel_outbox SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM channel_outbox WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'A channel transition requires its mutation actor') END;
END;
CREATE TABLE agent_actor_labels (
 session_id TEXT NOT NULL,
 run_key TEXT NOT NULL,
 label TEXT NOT NULL,
 PRIMARY KEY(session_id,run_key)
) WITHOUT ROWID, STRICT;
CREATE TABLE session_requesting_members (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(session_id,message_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX session_requesting_member_order ON session_requesting_members(session_id,accepted_at DESC,message_id DESC);
CREATE TABLE member_session_unread (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE member_inbox_preferences (
 member_id TEXT PRIMARY KEY REFERENCES members(id),
 start_my_requests INTEGER NOT NULL CHECK(start_my_requests IN (0,1))
) WITHOUT ROWID, STRICT;
CREATE VIEW inbox_member_rows AS
SELECT rows.*,member.id AS member_id FROM inbox_rows rows
JOIN members member ON member.library_id=rows.library_id AND member.lifecycle='active'
LEFT JOIN inbox_entries entry ON entry.page_id=rows.page_id
LEFT JOIN inbox_answers answer ON answer.page_id=rows.page_id
LEFT JOIN page_turn_episodes episode ON episode.page_id=rows.page_id
WHERE (rows.row_kind='turn' AND member.id=json_extract(episode.signature,'$[0].member_id'))
 OR (rows.row_kind='answer' AND member.id=answer.member_id)
 OR (rows.row_kind='intake' AND (entry.source_kind<>'automation' OR member.id=entry.author_member_id))
 OR rows.row_kind='problem';
CREATE INDEX document_recovery_drafts_member ON document_recovery_drafts(member_id,library_id,document_id,draft_id);
CREATE TABLE session_run_members (
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id),
 message_id TEXT,
 PRIMARY KEY(session_id,run_id)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER intake_dispositions_capture_actor AFTER INSERT ON intake_dispositions
BEGIN
 UPDATE intake_dispositions SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN EXISTS(SELECT 1 FROM inbox_entries WHERE page_id=NEW.page_id AND source_kind='automation') THEN json_object('type','service','kind','automations') END) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM intake_dispositions WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER inbox_proposals_capture_actor AFTER INSERT ON inbox_proposals
BEGIN
 UPDATE inbox_proposals SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN NEW.origin='automation' THEN json_object('type','service','kind','automations') END) WHERE proposal_id=NEW.proposal_id;
 SELECT CASE WHEN (SELECT actor_json FROM inbox_proposals WHERE proposal_id=NEW.proposal_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER page_turn_notes_capture_actor AFTER INSERT ON page_turn_notes
BEGIN
 UPDATE page_turn_notes SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE note_id=NEW.note_id;
 SELECT CASE WHEN (SELECT actor_json FROM page_turn_notes WHERE note_id=NEW.note_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER chat_message_handbacks_capture_actor AFTER INSERT ON chat_message_handbacks
BEGIN
 UPDATE chat_message_handbacks SET actor_json=(SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1) WHERE receipt_id=NEW.receipt_id;
 SELECT CASE WHEN (SELECT actor_json FROM chat_message_handbacks WHERE receipt_id=NEW.receipt_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER automation_decisions_capture_actor AFTER INSERT ON automation_decisions
WHEN NEW.actor_json IS NULL
BEGIN
 UPDATE automation_decisions SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),json_object('type','service','kind','automations')) WHERE dispatch_id=NEW.dispatch_id;
 SELECT CASE WHEN (SELECT actor_json FROM automation_decisions WHERE dispatch_id=NEW.dispatch_id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE TRIGGER inbox_proposals_capture_confirmation_actor AFTER UPDATE OF confirmed_at ON inbox_proposals
WHEN NEW.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
 UPDATE inbox_proposals SET confirmed_actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN NEW.origin='automation' THEN json_object('type','service','kind','automations') END) WHERE proposal_id=NEW.proposal_id;
 SELECT CASE WHEN (SELECT confirmed_actor_json FROM inbox_proposals WHERE proposal_id=NEW.proposal_id) IS NULL THEN RAISE(ABORT,'Inbox confirmation requires an admitted mutation actor') END;
END;
CREATE TABLE page_work_grants (
 page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES members(id)
) WITHOUT ROWID, STRICT;
CREATE TRIGGER page_work_retires_grant AFTER UPDATE ON block_properties
WHEN NEW.property_key='work' AND NOT COALESCE(json_extract(NEW.value_json,'$.auto_start'),0)
BEGIN DELETE FROM page_work_grants WHERE page_id=NEW.block_id; END;
CREATE TRIGGER page_work_captures_grant AFTER UPDATE ON block_properties
WHEN NEW.property_key='work' AND json_extract(NEW.value_json,'$.auto_start')=1
 AND (NOT COALESCE(json_extract(OLD.value_json,'$.auto_start'),0) OR NOT EXISTS(SELECT 1 FROM page_work_grants WHERE page_id=NEW.block_id))
BEGIN
 INSERT INTO page_work_grants(page_id,member_id)
 SELECT NEW.block_id,COALESCE(json_extract(actor_json,'$.member_id'),json_extract(actor_json,'$.on_behalf_of'),authorizing_member_id)
 FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1
 ON CONFLICT(page_id) DO UPDATE SET member_id=excluded.member_id;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM page_work_grants WHERE page_id=NEW.block_id) THEN RAISE(ABORT,'Automatic work requires its authorizing Member') END;
END;
CREATE TRIGGER page_work_captures_initial_grant AFTER INSERT ON block_properties
WHEN NEW.property_key='work' AND json_extract(NEW.value_json,'$.auto_start')=1
BEGIN
 INSERT INTO page_work_grants(page_id,member_id)
 SELECT NEW.block_id,COALESCE(json_extract(actor_json,'$.member_id'),json_extract(actor_json,'$.on_behalf_of'),authorizing_member_id)
 FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1
 ON CONFLICT(page_id) DO UPDATE SET member_id=excluded.member_id;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM page_work_grants WHERE page_id=NEW.block_id) THEN RAISE(ABORT,'Automatic work requires its authorizing Member') END;
END;
CREATE TRIGGER local_commit_actor_is_immutable BEFORE UPDATE OF actor_json,authorizing_member_id ON local_commits
WHEN OLD.finalized=1 AND (OLD.actor_json IS NOT NEW.actor_json OR OLD.authorizing_member_id IS NOT NEW.authorizing_member_id)
BEGIN SELECT RAISE(ABORT,'Committed actors are immutable'); END;
CREATE TRIGGER mutation_actors_are_immutable BEFORE UPDATE ON mutation_actors
BEGIN SELECT RAISE(ABORT,'Mutation actors are immutable'); END;
CREATE TRIGGER project_sessions_clear_member_attention AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived=1
BEGIN
  DELETE FROM member_session_unread WHERE session_id=NEW.id;
  DELETE FROM member_session_pins WHERE session_id=NEW.id;
  DELETE FROM member_session_reminders WHERE session_id=NEW.id;
  DELETE FROM member_session_reminder_deliveries WHERE session_id=NEW.id;
END;
CREATE TABLE member_session_pins (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 pinned_order INTEGER NOT NULL CHECK(pinned_order >= 0),
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX member_session_pin_order ON member_session_pins(member_id,pinned_order,session_id);
CREATE INDEX member_session_pin_session ON member_session_pins(session_id);
CREATE TABLE member_session_reminders (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 remind_at TEXT NOT NULL,
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX member_session_reminder_due ON member_session_reminders(remind_at,session_id,member_id);
CREATE TABLE member_session_reminder_deliveries (
 delivery_id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 remind_at TEXT NOT NULL,
 next_attempt_at TEXT NOT NULL,
 UNIQUE(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX member_session_reminder_delivery_due ON member_session_reminder_deliveries(next_attempt_at,delivery_id);
CREATE TRIGGER member_session_pin_clears_manual_rank AFTER INSERT ON member_session_pins
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = NEW.session_id;
END;
CREATE TRIGGER member_session_unpin_clears_manual_rank AFTER DELETE ON member_session_pins
BEGIN
  UPDATE project_sessions SET manual_rank = NULL WHERE id = OLD.session_id;
END;
INSERT INTO structural_history_payload_backfill VALUES (1, '', 1);
INSERT INTO block_mutation_body_backfill VALUES (1, '', 1);
INSERT INTO session_search_revision(id, revision) VALUES (1, 0);
CREATE TABLE project_session_chat_folders (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  execution_host_id TEXT NOT NULL,
  path TEXT NOT NULL,
  output_directory TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'chosen'))
) WITHOUT ROWID;
PRAGMA user_version=207;
