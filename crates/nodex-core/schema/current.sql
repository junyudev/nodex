-- Generated current Nodex Store schema baseline.
-- Regenerate only when publishing a new Store revision.
-- The installer owns the transaction so fresh Profile rows can commit atomically
-- with this physical schema. The writer configures incremental auto-vacuum
-- before opening this transaction because SQLite fixes that header mode before
-- the first table is created.
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
      model_provider TEXT NOT NULL DEFAULT '',
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
    , forked_from_id TEXT, service_name TEXT, agent_path TEXT, model_id TEXT, harness_id TEXT, reasoning_effort TEXT, service_tier TEXT, execution_host_id TEXT NOT NULL DEFAULT 'local' CHECK (execution_host_id = trim(execution_host_id) AND length(execution_host_id) BETWEEN 1 AND 512), recency_at INTEGER NOT NULL DEFAULT 0 CHECK (recency_at >= 0)) WITHOUT ROWID;
CREATE TABLE codex_thread_dynamic_tool_catalogs (
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      toolset_revision INTEGER NOT NULL,
      PRIMARY KEY (thread_id, namespace),
      CHECK (length(trim(namespace)) > 0),
      CHECK (toolset_revision > 0)
    ) WITHOUT ROWID;
CREATE TABLE codex_project_permission_mode_selections (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (mode IN ('auto', 'guardian-approvals', 'full-access', 'custom'))
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
      actor_project_id TEXT NOT NULL,
      library_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      permission_profile_id TEXT,
      authority_fingerprint TEXT NOT NULL,
      provenance_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id),
      CHECK (length(trim(thread_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(turn_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(root_thread_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(actor_project_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(library_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(profile_id)) BETWEEN 1 AND 512),
      CHECK (length(trim(store_epoch)) BETWEEN 1 AND 512),
      CHECK (scope IN ('project', 'library')),
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
CREATE TABLE codex_automation_runs (
	      thread_id TEXT PRIMARY KEY,
	      automation_id TEXT NOT NULL,
	      status TEXT NOT NULL,
	      read_at INTEGER,
	      thread_title TEXT,
	      source_cwd TEXT,
	      inbox_title TEXT,
	      inbox_summary TEXT,
	      archived_user_message TEXT,
	      archived_assistant_message TEXT,
	      archived_reason TEXT,
	      created_at INTEGER NOT NULL,
	      updated_at INTEGER NOT NULL, run_revision INTEGER NOT NULL DEFAULT 1 CHECK (run_revision >= 1),
	      CHECK (status IN ('IN_PROGRESS', 'PENDING_REVIEW', 'ACCEPTED', 'ARCHIVED'))
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
      nfm TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      preview TEXT NOT NULL,
      block_tree_json TEXT NOT NULL,
      references_json TEXT NOT NULL DEFAULT '[]',
      asset_refs_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL, materialization_derivation_version INTEGER NOT NULL DEFAULT 2 CHECK (materialization_derivation_version >= 1),
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
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
      project_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
      pre_state_vector BLOB NOT NULL,
      pre_full_update BLOB NOT NULL,
      pre_full_update_byte_length INTEGER NOT NULL
        CHECK (pre_full_update_byte_length > 0),
      pre_state_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      FOREIGN KEY (
        relocation_id, document_id, project_id, generation, head_seq
      ) REFERENCES block_relocations(
        id, source_document_id, project_id, source_generation,
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
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
      project_id TEXT NOT NULL,
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
      CHECK (checkpoint_format IN ('yjs_update_v1', 'block_tree_snapshot_v2', 'canvas_scene_json_v1')),
      CHECK (
        checkpoint_format NOT IN ('block_tree_snapshot_v2', 'canvas_scene_json_v1')
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
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
      updated_at TEXT NOT NULL,
      CHECK (length(trim(id)) BETWEEN 1 AND 512)
    ) WITHOUT ROWID;
CREATE TABLE database_containers (
      block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      default_view_id TEXT,
      access_revision INTEGER NOT NULL DEFAULT 1 CHECK (access_revision >= 1),
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
CREATE TABLE core_automation_runtime_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  jitter_salt TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
  CHECK (length(jitter_salt) BETWEEN 1 AND 512)
) STRICT;
CREATE TABLE core_automation_leases (
  lease_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES codex_scheduled_automations(automation_id)
    ON DELETE CASCADE,
  scheduled_for_ms INTEGER NOT NULL CHECK (scheduled_for_ms >= 0),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4294967295),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed', 'cancelled')),
  claimed_at_ms INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > claimed_at_ms),
  settled_at_ms INTEGER,
  retry_at_ms INTEGER,
  reason_code TEXT,
  UNIQUE (automation_id, scheduled_for_ms, attempt),
  CHECK (length(lease_id) BETWEEN 1 AND 512),
  CHECK (settled_at_ms IS NULL OR settled_at_ms >= claimed_at_ms),
  CHECK (retry_at_ms IS NULL OR retry_at_ms >= 0),
  CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  CHECK (
    (status = 'claimed' AND settled_at_ms IS NULL)
    OR (status <> 'claimed' AND settled_at_ms IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE "codex_scheduled_automations" (
           automation_id TEXT PRIMARY KEY,
           kind TEXT NOT NULL,
           status TEXT NOT NULL,
           target_thread_id TEXT,
           name TEXT NOT NULL,
           prompt TEXT NOT NULL DEFAULT '',
           rrule TEXT,
           model TEXT,
           model_provider TEXT,
           harness_id TEXT,
           reasoning_effort TEXT,
           service_tier TEXT,
           cwds_json TEXT NOT NULL DEFAULT '[]',
           execution_environment TEXT NOT NULL DEFAULT 'worktree',
           local_environment_config_path TEXT,
           next_run_at INTEGER,
           last_run_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           definition_revision INTEGER NOT NULL DEFAULT 1 CHECK (definition_revision >= 1),
           CHECK (kind IN ('cron', 'heartbeat')),
           CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')),
           CHECK (execution_environment IN ('local', 'worktree')),
           CHECK (model_provider IS NULL OR length(trim(model_provider)) BETWEEN 1 AND 512),
           CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 512),
           CHECK (harness_id IS NULL OR length(trim(harness_id)) BETWEEN 1 AND 512),
           CHECK (reasoning_effort IS NULL OR length(trim(reasoning_effort)) BETWEEN 1 AND 64),
           CHECK (service_tier IS NULL OR length(trim(service_tier)) BETWEEN 1 AND 64)
         ) WITHOUT ROWID;
CREATE TABLE workspace_sidebar_lanes (
  scope_key TEXT PRIMARY KEY,
  lane_kind TEXT NOT NULL CHECK (lane_kind IN ('project', 'projectless')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  order_mode TEXT NOT NULL CHECK (order_mode IN ('recency', 'manual')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  CHECK (
    (lane_kind = 'project' AND project_id IS NOT NULL AND scope_key = 'project:' || project_id)
    OR (lane_kind = 'projectless' AND project_id IS NULL AND scope_key = 'projectless')
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_sidebar_positions (
  scope_key TEXT NOT NULL
    REFERENCES workspace_sidebar_lanes(scope_key) ON UPDATE CASCADE ON DELETE CASCADE,
  thread_id TEXT NOT NULL
    REFERENCES codex_threads(thread_id) ON UPDATE CASCADE ON DELETE CASCADE,
  rank_key INTEGER NOT NULL CHECK (rank_key >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, thread_id),
  UNIQUE (scope_key, rank_key)
) WITHOUT ROWID, STRICT;
CREATE TABLE workspace_app_server_thread_observations (
  thread_id TEXT PRIMARY KEY
    REFERENCES codex_threads(thread_id) ON UPDATE CASCADE ON DELETE CASCADE,
  last_seen_sweep_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
CREATE TABLE project_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  no_thread_fallback_title TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_order INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, is_default_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_default_draft IN (0, 1)),
  CHECK (pinned IN (0, 1)),
  CHECK (archived IN (0, 1)),
  CHECK (unread IN (0, 1))
);
CREATE TABLE project_session_threads (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE project_session_pages (
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (session_id, page_id),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (length(page_id) BETWEEN 1 AND 512),
  CHECK (length(linked_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_projectless_permission_mode_selection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (mode IN ('auto', 'guardian-approvals', 'full-access', 'custom')),
  CHECK (length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
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
  CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
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
  )), effect_kind TEXT NOT NULL DEFAULT 'historical', project_id TEXT NOT NULL DEFAULT 'historical', resources_json TEXT NOT NULL DEFAULT '{}'
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
  CHECK (document_order >= 0), project_id TEXT NOT NULL DEFAULT 'historical', page_id TEXT, base_head_seq INTEGER NOT NULL DEFAULT 0
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
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
-- Receipts are detached before their replay-only LocalCommit is pruned. This
-- preserves exact idempotent responses without retaining the full delivery
-- graph or weakening the authoritative receipt table's foreign keys.
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
  CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test')),
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  CHECK (event_sequence IS NULL OR event_sequence >= 1),
  CHECK (length(commit_manifest_hash) = 64 AND commit_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(committed_at) > 0)
) WITHOUT ROWID, STRICT;
-- Receipt lifetime is independent from which physical receipt table currently
-- owns the exact result. Keeping retention metadata in one companion table
-- lets detachment stay a value move and lets legacy rows backfill in slices.
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
CREATE TABLE local_commit_revocations (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  authorization_scope_json TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (
    store_epoch, commit_seq, scope_key, resource_kind, resource_id
  ),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(scope_key) BETWEEN 1 AND 1600),
  CHECK (
    json_valid(authorization_scope_json)
    AND json_type(authorization_scope_json) = 'object'
  ),
  CHECK (resource_kind IN ('page', 'document', 'database', 'data_source', 'view', 'canvas')),
  CHECK (length(resource_id) BETWEEN 1 AND 512),
  CHECK (reason IN ('ownership_moved', 'access_revoked', 'archived', 'deleted'))
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
  created_at TEXT NOT NULL, sibling_rank TEXT CHECK (sibling_rank IS NULL OR length(sibling_rank) BETWEEN 1 AND 512),
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
CREATE TABLE local_commit_visibility_context (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('active', 'overlay', 'maintenance')),
  store_epoch TEXT,
  commit_seq INTEGER,
  CHECK (
    (mode IN ('active', 'overlay') AND store_epoch IS NOT NULL AND commit_seq IS NOT NULL)
    OR (mode = 'maintenance' AND store_epoch IS NULL AND commit_seq IS NULL)
  ),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE
) STRICT;
CREATE TABLE local_commit_visibility_dirty_facts (
  fact_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  relation_kind TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  old_row_json TEXT,
  new_row_json TEXT,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (length(relation_kind) BETWEEN 1 AND 128),
  CHECK (old_row_json IS NULL OR json_valid(old_row_json)),
  CHECK (new_row_json IS NULL OR json_valid(new_row_json)),
  CHECK (
    (operation = 'insert' AND old_row_json IS NULL AND new_row_json IS NOT NULL)
    OR (operation = 'update' AND old_row_json IS NOT NULL AND new_row_json IS NOT NULL)
    OR (operation = 'delete' AND old_row_json IS NOT NULL AND new_row_json IS NULL)
  )
) STRICT;
CREATE TABLE local_commit_visibility_deltas (
  store_epoch TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  authorization_scope_json TEXT NOT NULL,
  delta_kind TEXT NOT NULL CHECK (delta_kind IN ('grant', 'revoke', 'conservative_reset')),
  roots_json TEXT NOT NULL,
  delta_hash TEXT NOT NULL,
  PRIMARY KEY (store_epoch, commit_seq, scope_key, delta_hash),
  FOREIGN KEY (store_epoch, commit_seq)
    REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE,
  CHECK (json_valid(authorization_scope_json) AND json_type(authorization_scope_json) = 'object'),
  CHECK (json_valid(roots_json) AND json_type(roots_json) = 'array'),
  CHECK (length(delta_hash) = 64 AND delta_hash NOT GLOB '*[^0-9a-f]*')
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
  default_layout TEXT NOT NULL,
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
  CHECK (default_layout IN ('board', 'list')),
  CHECK (lifecycle IN ('active', 'deleted')),
  CHECK (json_valid(config_json) AND json_type(config_json) = 'object')
) WITHOUT ROWID, STRICT;
CREATE TABLE "database_view_page_positions" (
  view_id TEXT NOT NULL,
  page_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  rank_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (view_id, page_block_id),
  FOREIGN KEY (view_id) REFERENCES "database_views"(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE TABLE database_view_personal_presentations (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          presentation_override_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, view_id),
          CHECK (
            json_valid(presentation_override_json)
            AND json_type(presentation_override_json) = 'object'
          )
        ) WITHOUT ROWID, STRICT;
CREATE TABLE database_view_collapsed_occurrences (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
          target_kind TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          collapsed_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, view_id, target_kind, occurrence_key),
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
  updated_at TEXT NOT NULL,
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
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
CREATE TABLE page_file_versions (
  file_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  library_id TEXT NOT NULL,
  owner_page_id TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 1),
  change_kind TEXT NOT NULL
    CHECK (change_kind IN (
      'create', 'replace', 'rename', 'delete', 'restore', 'clone', 'rehome'
    )),
  logical_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  blob_hash TEXT REFERENCES managed_blobs(content_hash) ON DELETE RESTRICT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  actor_id TEXT NOT NULL,
  turn_id TEXT,
  operation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (file_id, version),
  FOREIGN KEY (file_id) REFERENCES page_files(file_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(file_id) BETWEEN 1 AND 512),
  CHECK (length(logical_path) BETWEEN 1 AND 1024),
  CHECK (length(path_key) BETWEEN 1 AND 1024),
  CHECK (length(mime_type) BETWEEN 1 AND 255),
  CHECK (length(actor_id) BETWEEN 1 AND 512),
  CHECK (turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 512),
  CHECK (length(operation_id) BETWEEN 1 AND 512),
  CHECK (length(occurred_at) > 0),
  CHECK (
    (change_kind = 'delete' AND blob_hash IS NULL)
    OR (change_kind <> 'delete' AND blob_hash IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;
CREATE TABLE page_files (
  file_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  owner_page_id TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'deleted')),
  created_by_actor_id TEXT NOT NULL,
  created_by_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_page_id, library_id)
    REFERENCES pages(block_id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (length(file_id) BETWEEN 1 AND 512),
  CHECK (length(logical_path) BETWEEN 1 AND 1024),
  CHECK (length(path_key) BETWEEN 1 AND 1024),
  CHECK (length(mime_type) BETWEEN 1 AND 255),
  CHECK (length(created_by_actor_id) BETWEEN 1 AND 512),
  CHECK (created_by_turn_id IS NULL OR length(created_by_turn_id) BETWEEN 1 AND 512),
  CHECK (length(created_at) > 0),
  CHECK (length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE page_file_namespace (
  owner_page_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  path_key TEXT NOT NULL,
  file_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (owner_page_id, path_key),
  FOREIGN KEY (owner_page_id, library_id)
    REFERENCES pages(block_id, library_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES page_files(file_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(path_key) BETWEEN 1 AND 1024)
) WITHOUT ROWID, STRICT;
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
  page_file_id TEXT REFERENCES page_files(file_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, block_id, role, ordinal),
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
    (page_file_id IS NULL AND asset_uri NOT LIKE 'nodex://files/%')
    OR (page_file_id IS NOT NULL
      AND asset_uri = 'nodex://files/' || page_file_id
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
  managed_file_name TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, file_id),
  FOREIGN KEY (owner_block_id, document_id, library_id)
    REFERENCES block_documents(block_id, document_id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, library_id)
    REFERENCES documents(id, library_id) ON DELETE CASCADE,
  CHECK (length(file_id) BETWEEN 1 AND 512),
  CHECK (length(mime_type) BETWEEN 1 AND 256),
  CHECK (length(asset_uri) BETWEEN 1 AND 4096),
  CHECK (length(managed_file_name) BETWEEN 1 AND 512),
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
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
CREATE TABLE "project_resource_grants" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  access TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 1 CHECK (recursive = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lifecycle TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, root_kind, root_id),
  CHECK (root_kind IN ('page', 'database', 'canvas')),
  CHECK (access IN ('read', 'read_write')),
  CHECK (lifecycle IN ('active', 'revoked'))
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
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  recipe_hash TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available', 'consumed', 'superseded')),
  consumed_at TEXT,
  superseded_by_recipe_operation_id TEXT
    REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (length(recipe_operation_id) BETWEEN 1 AND 512),
  CHECK (length(store_epoch) BETWEEN 1 AND 512),
  CHECK (length(recipe_hash) = 64 AND recipe_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(recipe_json) BETWEEN 2 AND 67108864
    AND json_valid(recipe_json)
    AND json_type(recipe_json) = 'object'),
  CHECK ((state = 'available' AND consumed_at IS NULL AND superseded_by_recipe_operation_id IS NULL)
    OR (state = 'consumed' AND length(consumed_at) > 0 AND superseded_by_recipe_operation_id IS NULL)
    OR (state = 'superseded' AND length(consumed_at) > 0 AND superseded_by_recipe_operation_id IS NOT NULL)),
  CHECK (length(created_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE structural_retention_members (
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('clipboard_bundle', 'history_recipe')),
  authority_id TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('block', 'document', 'database', 'asset')),
  member_id TEXT NOT NULL,
  PRIMARY KEY (authority_kind, authority_id, member_kind, member_id),
  CHECK (length(authority_id) BETWEEN 1 AND 512),
  CHECK (length(member_id) BETWEEN 1 AND 1024)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_structural_retention_members_identity
  ON structural_retention_members(library_id, member_kind, member_id);
CREATE INDEX idx_structural_history_recipes_state
  ON structural_history_recipes(library_id, state, created_at);
CREATE INDEX idx_project_sources_project_order
      ON project_sources(project_id, "order", created);
CREATE INDEX idx_codex_automation_runs_automation_status_created
	      ON codex_automation_runs(automation_id, status, created_at DESC);
CREATE INDEX idx_codex_automation_runs_unread
	      ON codex_automation_runs(read_at, status, updated_at);
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
CREATE UNIQUE INDEX idx_core_automation_leases_active_occurrence
  ON core_automation_leases(automation_id, scheduled_for_ms)
  WHERE status = 'claimed';
CREATE INDEX idx_core_automation_leases_inbox
  ON core_automation_leases(status, expires_at_ms, scheduled_for_ms, lease_id);
CREATE UNIQUE INDEX idx_codex_scheduled_automations_active_heartbeat
           ON codex_scheduled_automations(target_thread_id)
           WHERE kind = 'heartbeat' AND status = 'ACTIVE' AND target_thread_id IS NOT NULL;
CREATE INDEX idx_workspace_sidebar_positions_lane_rank
  ON workspace_sidebar_positions(scope_key, rank_key, thread_id);
CREATE INDEX idx_workspace_sidebar_positions_thread
  ON workspace_sidebar_positions(thread_id, scope_key);
CREATE INDEX idx_workspace_app_server_thread_observations_sweep
  ON workspace_app_server_thread_observations(last_seen_sweep_id, thread_id);
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
CREATE INDEX idx_project_sessions_project_order
  ON project_sessions(project_id, "order", created_at);
CREATE INDEX idx_project_sessions_project_sidebar
  ON project_sessions(project_id, archived, pinned, pinned_order, "order");
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
CREATE INDEX idx_local_commit_visibility_dirty_facts_commit
  ON local_commit_visibility_dirty_facts(store_epoch, commit_seq, fact_seq);
CREATE INDEX idx_local_commit_documents_commit_order
  ON local_commit_documents(store_epoch, commit_seq, document_order);
CREATE INDEX idx_projection_scope_heads_commit
  ON projection_scope_heads(store_epoch, covered_commit_seq);
CREATE INDEX idx_database_views_database_order
  ON database_views(database_block_id, lifecycle, rank_key, id);
CREATE INDEX idx_database_views_source
  ON database_views(data_source_id, lifecycle, id);
CREATE INDEX idx_database_view_page_positions_order ON database_view_page_positions(view_id, rank_key, page_block_id);
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
            profile_id, view_id, collapsed_at, target_kind, occurrence_key
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
CREATE INDEX idx_page_file_versions_owner
  ON page_file_versions(owner_page_id, library_id, occurred_at DESC, file_id, version DESC);
CREATE INDEX idx_page_file_versions_blob
  ON page_file_versions(blob_hash, file_id)
  WHERE blob_hash IS NOT NULL;
CREATE INDEX idx_page_files_owner_path
  ON page_files(owner_page_id, state, path_key, file_id);
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
  ON block_asset_refs(page_file_id, document_id, block_id)
  WHERE page_file_id IS NOT NULL;
CREATE INDEX idx_block_search_units_block ON block_search_units(block_id, library_id);
CREATE INDEX idx_block_search_units_owner ON block_search_units(owner_block_id, library_id);
CREATE INDEX idx_block_search_units_document_freshness
  ON block_search_units(document_id, document_generation, projected_seq)
  WHERE document_id IS NOT NULL;
CREATE INDEX idx_block_search_units_library_source
  ON block_search_units(library_id, source_kind, block_id);
CREATE INDEX idx_canvas_page_references_target
  ON canvas_page_references(library_id, target_block_id, document_id);
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
CREATE INDEX idx_project_resource_grants_active
  ON project_resource_grants(project_id, lifecycle, root_kind, root_id);
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
CREATE UNIQUE INDEX idx_project_sessions_default_draft_project ON project_sessions(project_id) WHERE is_default_draft = 1 AND project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_project_sessions_default_draft_projectless ON project_sessions(is_default_draft) WHERE is_default_draft = 1 AND project_id IS NULL;
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
      BEGIN
        SELECT RAISE(ABORT, 'block mutations are immutable');
      END;
CREATE TRIGGER block_mutations_reject_id_collision
      BEFORE INSERT ON block_mutations
      WHEN EXISTS (
        SELECT 1
        FROM block_mutations existing
        WHERE existing.mutation_id = NEW.mutation_id
          AND (
            existing.project_id <> NEW.project_id
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
            AND relocation.project_id = NEW.project_id
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
        OR NEW.project_id <> OLD.project_id
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
          'block_tree_snapshot_v2', 'canvas_scene_json_v1'
        )
        AND (
          length(NEW.state_vector) <> 0
          OR json_valid(CAST(NEW.full_update_blob AS TEXT)) = 0
          OR json_type(CAST(NEW.full_update_blob AS TEXT)) <> 'object'
        )
      ) OR NEW.checkpoint_format NOT IN (
        'yjs_update_v1', 'block_tree_snapshot_v2', 'canvas_scene_json_v1'
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
CREATE TRIGGER "visibility_dirty_projects_insert"
BEFORE INSERT ON "projects"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'projects', 'insert', NULL, json_object('id', NEW."id", 'name', NEW."name", 'description', NEW."description", 'created', NEW."created", 'updated', NEW."updated", 'library_id', NEW."library_id", 'database_block_id', NEW."database_block_id", 'lifecycle', NEW."lifecycle", 'binding_revision', NEW."binding_revision", 'appearance_color', NEW."appearance_color", 'appearance_marker_kind', NEW."appearance_marker_kind", 'appearance_marker_value', NEW."appearance_marker_value")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_projects_update"
BEFORE UPDATE OF "library_id", "database_block_id", "lifecycle" ON "projects"
WHEN (1) AND (OLD."library_id" IS NOT NEW."library_id" OR OLD."database_block_id" IS NOT NEW."database_block_id" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'projects', 'update', json_object('id', OLD."id", 'name', OLD."name", 'description', OLD."description", 'created', OLD."created", 'updated', OLD."updated", 'library_id', OLD."library_id", 'database_block_id', OLD."database_block_id", 'lifecycle', OLD."lifecycle", 'binding_revision', OLD."binding_revision", 'appearance_color', OLD."appearance_color", 'appearance_marker_kind', OLD."appearance_marker_kind", 'appearance_marker_value', OLD."appearance_marker_value"), json_object('id', NEW."id", 'name', NEW."name", 'description', NEW."description", 'created', NEW."created", 'updated', NEW."updated", 'library_id', NEW."library_id", 'database_block_id', NEW."database_block_id", 'lifecycle', NEW."lifecycle", 'binding_revision', NEW."binding_revision", 'appearance_color', NEW."appearance_color", 'appearance_marker_kind', NEW."appearance_marker_kind", 'appearance_marker_value', NEW."appearance_marker_value")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_projects_delete"
BEFORE DELETE ON "projects"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'projects', 'delete', json_object('id', OLD."id", 'name', OLD."name", 'description', OLD."description", 'created', OLD."created", 'updated', OLD."updated", 'library_id', OLD."library_id", 'database_block_id', OLD."database_block_id", 'lifecycle', OLD."lifecycle", 'binding_revision', OLD."binding_revision", 'appearance_color', OLD."appearance_color", 'appearance_marker_kind', OLD."appearance_marker_kind", 'appearance_marker_value', OLD."appearance_marker_value"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_project_database_bindings_insert"
BEFORE INSERT ON "project_database_bindings"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'project_database_bindings', 'insert', NULL, json_object('project_id', NEW."project_id", 'library_id', NEW."library_id", 'database_block_id', NEW."database_block_id", 'lifecycle', NEW."lifecycle", 'revision', NEW."revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_project_database_bindings_update"
BEFORE UPDATE OF "project_id", "library_id", "database_block_id", "lifecycle" ON "project_database_bindings"
WHEN (1) AND (OLD."project_id" IS NOT NEW."project_id" OR OLD."library_id" IS NOT NEW."library_id" OR OLD."database_block_id" IS NOT NEW."database_block_id" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'project_database_bindings', 'update', json_object('project_id', OLD."project_id", 'library_id', OLD."library_id", 'database_block_id', OLD."database_block_id", 'lifecycle', OLD."lifecycle", 'revision', OLD."revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('project_id', NEW."project_id", 'library_id', NEW."library_id", 'database_block_id', NEW."database_block_id", 'lifecycle', NEW."lifecycle", 'revision', NEW."revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_project_database_bindings_delete"
BEFORE DELETE ON "project_database_bindings"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'project_database_bindings', 'delete', json_object('project_id', OLD."project_id", 'library_id', OLD."library_id", 'database_block_id', OLD."database_block_id", 'lifecycle', OLD."lifecycle", 'revision', OLD."revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_database_containers_insert"
BEFORE INSERT ON "database_containers"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'database_containers', 'insert', NULL, json_object('block_id', NEW."block_id", 'library_id', NEW."library_id", 'name', NEW."name", 'lifecycle', NEW."lifecycle", 'default_view_id', NEW."default_view_id", 'access_revision', NEW."access_revision", 'metadata_revision', NEW."metadata_revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_database_containers_update"
BEFORE UPDATE OF "block_id", "library_id", "lifecycle" ON "database_containers"
WHEN (1) AND (OLD."block_id" IS NOT NEW."block_id" OR OLD."library_id" IS NOT NEW."library_id" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'database_containers', 'update', json_object('block_id', OLD."block_id", 'library_id', OLD."library_id", 'name', OLD."name", 'lifecycle', OLD."lifecycle", 'default_view_id', OLD."default_view_id", 'access_revision', OLD."access_revision", 'metadata_revision', OLD."metadata_revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('block_id', NEW."block_id", 'library_id', NEW."library_id", 'name', NEW."name", 'lifecycle', NEW."lifecycle", 'default_view_id', NEW."default_view_id", 'access_revision', NEW."access_revision", 'metadata_revision', NEW."metadata_revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_database_containers_delete"
BEFORE DELETE ON "database_containers"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'database_containers', 'delete', json_object('block_id', OLD."block_id", 'library_id', OLD."library_id", 'name', OLD."name", 'lifecycle', OLD."lifecycle", 'default_view_id', OLD."default_view_id", 'access_revision', OLD."access_revision", 'metadata_revision', OLD."metadata_revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_data_sources_insert"
BEFORE INSERT ON "data_sources"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'data_sources', 'insert', NULL, json_object('id', NEW."id", 'library_id', NEW."library_id", 'home_database_block_id', NEW."home_database_block_id", 'name', NEW."name", 'schema_key', NEW."schema_key", 'schema_revision', NEW."schema_revision", 'lifecycle', NEW."lifecycle", 'rank_key', NEW."rank_key", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_data_sources_update"
BEFORE UPDATE OF "id", "library_id", "home_database_block_id", "lifecycle" ON "data_sources"
WHEN (1) AND (OLD."id" IS NOT NEW."id" OR OLD."library_id" IS NOT NEW."library_id" OR OLD."home_database_block_id" IS NOT NEW."home_database_block_id" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'data_sources', 'update', json_object('id', OLD."id", 'library_id', OLD."library_id", 'home_database_block_id', OLD."home_database_block_id", 'name', OLD."name", 'schema_key', OLD."schema_key", 'schema_revision', OLD."schema_revision", 'lifecycle', OLD."lifecycle", 'rank_key', OLD."rank_key", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('id', NEW."id", 'library_id', NEW."library_id", 'home_database_block_id', NEW."home_database_block_id", 'name', NEW."name", 'schema_key', NEW."schema_key", 'schema_revision', NEW."schema_revision", 'lifecycle', NEW."lifecycle", 'rank_key', NEW."rank_key", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_data_sources_delete"
BEFORE DELETE ON "data_sources"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'data_sources', 'delete', json_object('id', OLD."id", 'library_id', OLD."library_id", 'home_database_block_id', OLD."home_database_block_id", 'name', OLD."name", 'schema_key', OLD."schema_key", 'schema_revision', OLD."schema_revision", 'lifecycle', OLD."lifecycle", 'rank_key', OLD."rank_key", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_canvas_owners_insert"
BEFORE INSERT ON "canvas_owners"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'canvas_owners', 'insert', NULL, json_object('block_id', NEW."block_id", 'library_id', NEW."library_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_canvas_owners_update"
BEFORE UPDATE OF "block_id", "library_id" ON "canvas_owners"
WHEN (1) AND (OLD."block_id" IS NOT NEW."block_id" OR OLD."library_id" IS NOT NEW."library_id")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'canvas_owners', 'update', json_object('block_id', OLD."block_id", 'library_id', OLD."library_id", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('block_id', NEW."block_id", 'library_id', NEW."library_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_canvas_owners_delete"
BEFORE DELETE ON "canvas_owners"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'canvas_owners', 'delete', json_object('block_id', OLD."block_id", 'library_id', OLD."library_id", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
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
BEFORE INSERT ON database_view_page_positions
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
BEFORE UPDATE OF view_id, page_block_id ON database_view_page_positions
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
CREATE TRIGGER "visibility_dirty_database_views_insert"
BEFORE INSERT ON "database_views"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'database_views', 'insert', NULL, json_object('id', NEW."id", 'database_block_id', NEW."database_block_id", 'data_source_id', NEW."data_source_id", 'name', NEW."name", 'default_layout', NEW."default_layout", 'config_json', NEW."config_json", 'revision', NEW."revision", 'rank_key', NEW."rank_key", 'lifecycle', NEW."lifecycle", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_database_views_update"
BEFORE UPDATE OF "id", "database_block_id", "data_source_id", "lifecycle" ON "database_views"
WHEN (1) AND (OLD."id" IS NOT NEW."id" OR OLD."database_block_id" IS NOT NEW."database_block_id" OR OLD."data_source_id" IS NOT NEW."data_source_id" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'database_views', 'update', json_object('id', OLD."id", 'database_block_id', OLD."database_block_id", 'data_source_id', OLD."data_source_id", 'name', OLD."name", 'default_layout', OLD."default_layout", 'config_json', OLD."config_json", 'revision', OLD."revision", 'rank_key', OLD."rank_key", 'lifecycle', OLD."lifecycle", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('id', NEW."id", 'database_block_id', NEW."database_block_id", 'data_source_id', NEW."data_source_id", 'name', NEW."name", 'default_layout', NEW."default_layout", 'config_json', NEW."config_json", 'revision', NEW."revision", 'rank_key', NEW."rank_key", 'lifecycle', NEW."lifecycle", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_database_views_delete"
BEFORE DELETE ON "database_views"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'database_views', 'delete', json_object('id', OLD."id", 'database_block_id', OLD."database_block_id", 'data_source_id', OLD."data_source_id", 'name', OLD."name", 'default_layout', OLD."default_layout", 'config_json', OLD."config_json", 'revision', OLD."revision", 'rank_key', OLD."rank_key", 'lifecycle', OLD."lifecycle", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_data_source_page_memberships_insert"
BEFORE INSERT ON "data_source_page_memberships"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'data_source_page_memberships', 'insert', NULL, json_object('id', NEW."id", 'data_source_id', NEW."data_source_id", 'page_block_id', NEW."page_block_id", 'revision', NEW."revision", 'created_at', NEW."created_at", 'removed_at', NEW."removed_at", 'completed_at', NEW."completed_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_data_source_page_memberships_update"
BEFORE UPDATE OF "id", "data_source_id", "page_block_id", "removed_at" ON "data_source_page_memberships"
WHEN (1) AND (OLD."id" IS NOT NEW."id" OR OLD."data_source_id" IS NOT NEW."data_source_id" OR OLD."page_block_id" IS NOT NEW."page_block_id" OR OLD."removed_at" IS NOT NEW."removed_at")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'data_source_page_memberships', 'update', json_object('id', OLD."id", 'data_source_id', OLD."data_source_id", 'page_block_id', OLD."page_block_id", 'revision', OLD."revision", 'created_at', OLD."created_at", 'removed_at', OLD."removed_at", 'completed_at', OLD."completed_at"), json_object('id', NEW."id", 'data_source_id', NEW."data_source_id", 'page_block_id', NEW."page_block_id", 'revision', NEW."revision", 'created_at', NEW."created_at", 'removed_at', NEW."removed_at", 'completed_at', NEW."completed_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_data_source_page_memberships_delete"
BEFORE DELETE ON "data_source_page_memberships"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'data_source_page_memberships', 'delete', json_object('id', OLD."id", 'data_source_id', OLD."data_source_id", 'page_block_id', OLD."page_block_id", 'revision', OLD."revision", 'created_at', OLD."created_at", 'removed_at', OLD."removed_at", 'completed_at', OLD."completed_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
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
  JOIN blocks target_block ON target_block.id = NEW.target_page_block_id
  JOIN pages target_page
    ON target_page.block_id = target_block.id
   AND target_page.library_id = target_block.library_id
  JOIN data_source_page_memberships target_membership
    ON target_membership.page_block_id = target_block.id
   AND target_membership.data_source_id = relation.target_data_source_id
   AND target_membership.removed_at IS NULL
  WHERE relation.data_source_id = NEW.source_data_source_id
    AND relation.property_id = NEW.property_id
    AND value.value_type = 'relation'
    AND json_type(value.value_json) = 'null'
    AND target_block.type = 'page'
    AND target_block.lifecycle = 'active'
) BEGIN
  SELECT RAISE(ABORT, 'Relation edge requires an active target Page in the configured Data Source');
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
  OR OLD.project_id <> NEW.project_id
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
CREATE TRIGGER page_file_versions_validate_insert
BEFORE INSERT ON page_file_versions
WHEN NOT EXISTS (
  SELECT 1 FROM page_file_manifests manifest
  WHERE manifest.page_id = NEW.owner_page_id
    AND manifest.library_id = NEW.library_id
    AND manifest.revision = NEW.manifest_revision
) OR (
  NEW.blob_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_blobs blob
    WHERE blob.content_hash = NEW.blob_hash AND blob.byte_length = NEW.byte_length
  )
) OR (
  NEW.change_kind = 'rehome' AND NOT EXISTS (
    SELECT 1
    FROM page_files file
    JOIN page_file_versions previous
      ON previous.file_id = file.file_id
     AND previous.version = file.current_version
    WHERE file.file_id = NEW.file_id
      AND file.library_id = NEW.library_id
      AND file.owner_page_id <> NEW.owner_page_id
      AND file.state = 'live'
      AND NEW.version = file.current_version + 1
      AND previous.blob_hash = NEW.blob_hash
      AND previous.mime_type = NEW.mime_type
      AND previous.byte_length = NEW.byte_length
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Page File version authority is invalid');
END;
CREATE TRIGGER page_file_versions_are_immutable
BEFORE UPDATE ON page_file_versions
BEGIN
  SELECT RAISE(ABORT, 'Page File versions are immutable');
END;
CREATE TRIGGER page_files_validate_insert
BEFORE INSERT ON page_files
WHEN NOT EXISTS (
  SELECT 1 FROM page_file_versions version
  WHERE version.file_id = NEW.file_id
    AND version.version = NEW.current_version
    AND version.library_id = NEW.library_id
    AND version.owner_page_id = NEW.owner_page_id
    AND version.logical_path = NEW.logical_path
    AND version.path_key = NEW.path_key
    AND version.mime_type = NEW.mime_type
    AND version.byte_length = NEW.byte_length
    AND (
      (NEW.state = 'live' AND version.change_kind <> 'delete' AND version.blob_hash IS NOT NULL)
      OR (NEW.state = 'deleted' AND version.change_kind = 'delete' AND version.blob_hash IS NULL)
    )
) OR (
  NEW.state = 'live' AND NOT EXISTS (
    SELECT 1 FROM page_file_namespace namespace
    WHERE namespace.owner_page_id = NEW.owner_page_id
      AND namespace.library_id = NEW.library_id
      AND namespace.path_key = NEW.path_key
      AND namespace.file_id = NEW.file_id
  )
) OR (
  NEW.state = 'deleted' AND EXISTS (
    SELECT 1 FROM page_file_namespace namespace WHERE namespace.file_id = NEW.file_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Page File head does not match its current version');
END;
CREATE TRIGGER page_files_validate_update
BEFORE UPDATE ON page_files
WHEN OLD.file_id <> NEW.file_id
  OR OLD.library_id <> NEW.library_id
  OR OLD.created_by_actor_id <> NEW.created_by_actor_id
  OR OLD.created_by_turn_id IS NOT NEW.created_by_turn_id
  OR OLD.created_at <> NEW.created_at
  OR NEW.current_version <> OLD.current_version + 1
  OR NOT EXISTS (
    SELECT 1 FROM page_file_versions version
    WHERE version.file_id = NEW.file_id
      AND version.version = NEW.current_version
      AND version.library_id = NEW.library_id
      AND version.owner_page_id = NEW.owner_page_id
      AND version.logical_path = NEW.logical_path
      AND version.path_key = NEW.path_key
      AND version.mime_type = NEW.mime_type
      AND version.byte_length = NEW.byte_length
      AND (
        (OLD.owner_page_id <> NEW.owner_page_id AND version.change_kind = 'rehome')
        OR (OLD.owner_page_id = NEW.owner_page_id AND version.change_kind <> 'rehome')
      )
      AND (
        (NEW.state = 'live' AND version.change_kind <> 'delete' AND version.blob_hash IS NOT NULL)
        OR (NEW.state = 'deleted' AND version.change_kind = 'delete' AND version.blob_hash IS NULL)
      )
  )
  OR (
    NEW.state = 'live' AND NOT EXISTS (
      SELECT 1 FROM page_file_namespace namespace
      WHERE namespace.owner_page_id = NEW.owner_page_id
        AND namespace.library_id = NEW.library_id
        AND namespace.path_key = NEW.path_key
        AND namespace.file_id = NEW.file_id
    )
  )
  OR (
    NEW.state = 'deleted' AND EXISTS (
      SELECT 1 FROM page_file_namespace namespace WHERE namespace.file_id = NEW.file_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Page File head transition is invalid');
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
  NEW.page_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM page_files file
    JOIN page_file_versions version
      ON version.file_id = file.file_id AND version.version = file.current_version
    WHERE file.file_id = NEW.page_file_id
      AND file.library_id = NEW.library_id
      AND file.state = 'live'
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
  NEW.page_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM page_files file
    JOIN page_file_versions version
      ON version.file_id = file.file_id AND version.version = file.current_version
    WHERE file.file_id = NEW.page_file_id
      AND file.library_id = NEW.library_id
      AND file.state = 'live'
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
  SELECT 1 FROM projects actor
  JOIN documents source
    ON source.id = NEW.source_document_id AND source.library_id = actor.library_id
  LEFT JOIN documents target ON target.id = NEW.target_document_id
  WHERE actor.id = NEW.project_id AND actor.library_id = NEW.library_id
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
                  JOIN projects actor_project
                    ON actor_project.id = NEW.project_id
                   AND actor_project.library_id = block.library_id
                  WHERE block.id = target.value
                )
              )
              OR NOT EXISTS (
                SELECT 1 FROM change_log change
                WHERE change.seq = NEW.change_log_seq
                  AND change.project_id = NEW.project_id
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
          JOIN projects actor_project
            ON actor_project.id = NEW.project_id
           AND actor_project.library_id = document.library_id
          WHERE document.id = NEW.document_id
            AND document.readiness = 'ready'
            AND document.generation = NEW.generation
            AND document.head_seq >= NEW.base_head_seq
            AND document.schema_key = NEW.schema_key
            AND document.schema_version = NEW.schema_version
        ) BEGIN
          SELECT RAISE(ABORT, 'Document version source is not a current ready Document');
        END;
CREATE TRIGGER "visibility_dirty_blocks_insert"
BEFORE INSERT ON "blocks"
WHEN NEW.type IN ('page', 'database', 'canvas')
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'blocks', 'insert', NULL, json_object('id', NEW."id", 'library_id', NEW."library_id", 'type', NEW."type", 'lifecycle', NEW."lifecycle", 'placement_revision', NEW."placement_revision", 'metadata_revision', NEW."metadata_revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_blocks_update"
BEFORE UPDATE OF "library_id", "type", "lifecycle" ON "blocks"
WHEN (OLD.type IN ('page', 'database', 'canvas') OR NEW.type IN ('page', 'database', 'canvas')) AND (OLD."library_id" IS NOT NEW."library_id" OR OLD."type" IS NOT NEW."type" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'blocks', 'update', json_object('id', OLD."id", 'library_id', OLD."library_id", 'type', OLD."type", 'lifecycle', OLD."lifecycle", 'placement_revision', OLD."placement_revision", 'metadata_revision', OLD."metadata_revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('id', NEW."id", 'library_id', NEW."library_id", 'type', NEW."type", 'lifecycle', NEW."lifecycle", 'placement_revision', NEW."placement_revision", 'metadata_revision', NEW."metadata_revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_blocks_delete"
BEFORE DELETE ON "blocks"
WHEN OLD.type IN ('page', 'database', 'canvas')
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'blocks', 'delete', json_object('id', OLD."id", 'library_id', OLD."library_id", 'type', OLD."type", 'lifecycle', OLD."lifecycle", 'placement_revision', OLD."placement_revision", 'metadata_revision', OLD."metadata_revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_documents_insert"
BEFORE INSERT ON "documents"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'documents', 'insert', NULL, json_object('id', NEW."id", 'library_id', NEW."library_id", 'generation', NEW."generation", 'head_seq', NEW."head_seq", 'schema_key', NEW."schema_key", 'schema_version', NEW."schema_version", 'state_vector', CASE WHEN NEW."state_vector" IS NULL THEN NULL ELSE hex(NEW."state_vector") END, 'state_hash', NEW."state_hash", 'readiness', NEW."readiness", 'authority', NEW."authority", 'genesis_source_revision', NEW."genesis_source_revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at", 'sync_engine', NEW."sync_engine")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_documents_update"
BEFORE UPDATE OF "library_id", "readiness" ON "documents"
WHEN (1) AND (OLD."library_id" IS NOT NEW."library_id" OR OLD."readiness" IS NOT NEW."readiness")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'documents', 'update', json_object('id', OLD."id", 'library_id', OLD."library_id", 'generation', OLD."generation", 'head_seq', OLD."head_seq", 'schema_key', OLD."schema_key", 'schema_version', OLD."schema_version", 'state_vector', CASE WHEN OLD."state_vector" IS NULL THEN NULL ELSE hex(OLD."state_vector") END, 'state_hash', OLD."state_hash", 'readiness', OLD."readiness", 'authority', OLD."authority", 'genesis_source_revision', OLD."genesis_source_revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at", 'sync_engine', OLD."sync_engine"), json_object('id', NEW."id", 'library_id', NEW."library_id", 'generation', NEW."generation", 'head_seq', NEW."head_seq", 'schema_key', NEW."schema_key", 'schema_version', NEW."schema_version", 'state_vector', CASE WHEN NEW."state_vector" IS NULL THEN NULL ELSE hex(NEW."state_vector") END, 'state_hash', NEW."state_hash", 'readiness', NEW."readiness", 'authority', NEW."authority", 'genesis_source_revision', NEW."genesis_source_revision", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at", 'sync_engine', NEW."sync_engine")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_documents_delete"
BEFORE DELETE ON "documents"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'documents', 'delete', json_object('id', OLD."id", 'library_id', OLD."library_id", 'generation', OLD."generation", 'head_seq', OLD."head_seq", 'schema_key', OLD."schema_key", 'schema_version', OLD."schema_version", 'state_vector', CASE WHEN OLD."state_vector" IS NULL THEN NULL ELSE hex(OLD."state_vector") END, 'state_hash', OLD."state_hash", 'readiness', OLD."readiness", 'authority', OLD."authority", 'genesis_source_revision', OLD."genesis_source_revision", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at", 'sync_engine', OLD."sync_engine"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_block_documents_insert"
BEFORE INSERT ON "block_documents"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'block_documents', 'insert', NULL, json_object('block_id', NEW."block_id", 'document_id', NEW."document_id", 'library_id', NEW."library_id", 'created_at', NEW."created_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_block_documents_update"
BEFORE UPDATE OF "block_id", "document_id", "library_id" ON "block_documents"
WHEN (1) AND (OLD."block_id" IS NOT NEW."block_id" OR OLD."document_id" IS NOT NEW."document_id" OR OLD."library_id" IS NOT NEW."library_id")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'block_documents', 'update', json_object('block_id', OLD."block_id", 'document_id', OLD."document_id", 'library_id', OLD."library_id", 'created_at', OLD."created_at"), json_object('block_id', NEW."block_id", 'document_id', NEW."document_id", 'library_id', NEW."library_id", 'created_at', NEW."created_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_block_documents_delete"
BEFORE DELETE ON "block_documents"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'block_documents', 'delete', json_object('block_id', OLD."block_id", 'document_id', OLD."document_id", 'library_id', OLD."library_id", 'created_at', OLD."created_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_pages_insert"
BEFORE INSERT ON "pages"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'pages', 'insert', NULL, json_object('block_id', NEW."block_id", 'library_id', NEW."library_id", 'document_id', NEW."document_id", 'parent_kind', NEW."parent_kind", 'parent_id', NEW."parent_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_pages_update"
BEFORE UPDATE OF "block_id", "library_id", "document_id", "parent_kind", "parent_id" ON "pages"
WHEN (1) AND (OLD."block_id" IS NOT NEW."block_id" OR OLD."library_id" IS NOT NEW."library_id" OR OLD."document_id" IS NOT NEW."document_id" OR OLD."parent_kind" IS NOT NEW."parent_kind" OR OLD."parent_id" IS NOT NEW."parent_id")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'pages', 'update', json_object('block_id', OLD."block_id", 'library_id', OLD."library_id", 'document_id', OLD."document_id", 'parent_kind', OLD."parent_kind", 'parent_id', OLD."parent_id", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('block_id', NEW."block_id", 'library_id', NEW."library_id", 'document_id', NEW."document_id", 'parent_kind', NEW."parent_kind", 'parent_id', NEW."parent_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_pages_delete"
BEFORE DELETE ON "pages"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'pages', 'delete', json_object('block_id', OLD."block_id", 'library_id', OLD."library_id", 'document_id', OLD."document_id", 'parent_kind', OLD."parent_kind", 'parent_id', OLD."parent_id", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER project_resource_grants_validate_active_root_insert
BEFORE INSERT ON project_resource_grants
WHEN NEW.lifecycle = 'active' AND (
  NOT EXISTS (
    SELECT 1 FROM projects project
    WHERE project.id = NEW.project_id AND project.library_id = NEW.library_id
  ) OR NOT EXISTS (
    SELECT 1 FROM blocks block
    WHERE block.id = NEW.root_id AND block.library_id = NEW.library_id
      AND block.type = NEW.root_kind
  ) OR (
    NEW.root_kind = 'canvas' AND EXISTS (
      SELECT 1 FROM blocks block
      WHERE block.id = NEW.root_id AND block.lifecycle <> 'deleted'
    ) AND (
      NOT EXISTS (
        SELECT 1 FROM library_block_placements placement
        WHERE placement.block_id = NEW.root_id AND placement.library_id = NEW.library_id
      ) OR EXISTS (
        SELECT 1 FROM document_block_index containing
        WHERE containing.block_id = NEW.root_id
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Active Project resource grant requires a matching Library root');
END;
CREATE TRIGGER project_resource_grants_validate_active_root_update
BEFORE UPDATE OF project_id, library_id, root_kind, root_id, lifecycle
ON project_resource_grants
WHEN NEW.lifecycle = 'active' AND (
  NOT EXISTS (
    SELECT 1 FROM projects project
    WHERE project.id = NEW.project_id AND project.library_id = NEW.library_id
  ) OR NOT EXISTS (
    SELECT 1 FROM blocks block
    WHERE block.id = NEW.root_id AND block.library_id = NEW.library_id
      AND block.type = NEW.root_kind
  ) OR (
    NEW.root_kind = 'canvas' AND EXISTS (
      SELECT 1 FROM blocks block
      WHERE block.id = NEW.root_id AND block.lifecycle <> 'deleted'
    ) AND (
      NOT EXISTS (
        SELECT 1 FROM library_block_placements placement
        WHERE placement.block_id = NEW.root_id AND placement.library_id = NEW.library_id
      ) OR EXISTS (
        SELECT 1 FROM document_block_index containing
        WHERE containing.block_id = NEW.root_id
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Active Project resource grant requires a matching Library root');
END;
CREATE TRIGGER "visibility_dirty_project_resource_grants_insert"
BEFORE INSERT ON "project_resource_grants"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'project_resource_grants', 'insert', NULL, json_object('id', NEW."id", 'project_id', NEW."project_id", 'library_id', NEW."library_id", 'root_kind', NEW."root_kind", 'root_id', NEW."root_id", 'access', NEW."access", 'recursive', NEW."recursive", 'revision', NEW."revision", 'lifecycle', NEW."lifecycle", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_project_resource_grants_update"
BEFORE UPDATE OF "project_id", "library_id", "root_kind", "root_id", "access", "recursive", "lifecycle" ON "project_resource_grants"
WHEN (1) AND (OLD."project_id" IS NOT NEW."project_id" OR OLD."library_id" IS NOT NEW."library_id" OR OLD."root_kind" IS NOT NEW."root_kind" OR OLD."root_id" IS NOT NEW."root_id" OR OLD."access" IS NOT NEW."access" OR OLD."recursive" IS NOT NEW."recursive" OR OLD."lifecycle" IS NOT NEW."lifecycle")
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'project_resource_grants', 'update', json_object('id', OLD."id", 'project_id', OLD."project_id", 'library_id', OLD."library_id", 'root_kind', OLD."root_kind", 'root_id', OLD."root_id", 'access', OLD."access", 'recursive', OLD."recursive", 'revision', OLD."revision", 'lifecycle', OLD."lifecycle", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), json_object('id', NEW."id", 'project_id', NEW."project_id", 'library_id', NEW."library_id", 'root_kind', NEW."root_kind", 'root_id', NEW."root_id", 'access', NEW."access", 'recursive', NEW."recursive", 'revision', NEW."revision", 'lifecycle', NEW."lifecycle", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at")
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
END;
CREATE TRIGGER "visibility_dirty_project_resource_grants_delete"
BEFORE DELETE ON "project_resource_grants"
WHEN 1
BEGIN
SELECT CASE WHEN NOT EXISTS (
SELECT 1 FROM local_commit_visibility_context
WHERE id = 1 AND mode IN ('active', 'overlay', 'maintenance')
) THEN RAISE(ABORT, 'authority-bearing write requires VisibilityDeltaJournal') END;
INSERT INTO local_commit_visibility_dirty_facts(
store_epoch, commit_seq, relation_kind, operation, old_row_json, new_row_json
)
SELECT store_epoch, commit_seq, 'project_resource_grants', 'delete', json_object('id', OLD."id", 'project_id', OLD."project_id", 'library_id', OLD."library_id", 'root_kind', OLD."root_kind", 'root_id', OLD."root_id", 'access', OLD."access", 'recursive', OLD."recursive", 'revision', OLD."revision", 'lifecycle', OLD."lifecycle", 'created_at', OLD."created_at", 'updated_at', OLD."updated_at"), NULL
FROM local_commit_visibility_context WHERE id = 1 AND mode = 'active';
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
  AND OLD.project_id = NEW.project_id
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
WHEN NOT (OLD.state = 'available'
  AND NEW.state IN ('consumed', 'superseded')
  AND NEW.consumed_at IS NOT NULL
  AND OLD.recipe_operation_id = NEW.recipe_operation_id
  AND OLD.library_id = NEW.library_id
  AND OLD.project_id = NEW.project_id
  AND OLD.store_epoch = NEW.store_epoch
  AND OLD.recipe_hash = NEW.recipe_hash
  AND OLD.recipe_json = NEW.recipe_json
  AND OLD.created_at = NEW.created_at)
BEGIN
  SELECT RAISE(ABORT, 'Structural history recipe transition is invalid');
END;
CREATE TRIGGER structural_retention_members_are_immutable
BEFORE UPDATE ON structural_retention_members
BEGIN
  SELECT RAISE(ABORT, 'Structural retention members are immutable');
END;
CREATE TABLE codex_queued_follow_up_ledgers (
  thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  ledger_hash TEXT NOT NULL CHECK (length(ledger_hash) = 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_queued_follow_up_payload_manifests (
  payload_sha256 TEXT PRIMARY KEY CHECK (length(payload_sha256) = 64),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  asset_uri TEXT NOT NULL UNIQUE CHECK (
    asset_uri LIKE 'nodex://assets/queued-follow-up-v1-%.json'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 2)
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_queued_follow_up_payload_asset_refs (
  payload_sha256 TEXT NOT NULL REFERENCES codex_queued_follow_up_payload_manifests(payload_sha256) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  asset_uri TEXT NOT NULL CHECK (asset_uri LIKE 'nodex://assets/%'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  PRIMARY KEY (payload_sha256, ordinal),
  UNIQUE (payload_sha256, asset_uri)
) WITHOUT ROWID, STRICT;
CREATE TABLE codex_queued_follow_up_entries (
  thread_id TEXT NOT NULL REFERENCES codex_queued_follow_up_ledgers(thread_id) ON DELETE CASCADE,
  follow_up_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  client_user_message_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  pause_kind TEXT CHECK (pause_kind IN ('interrupted', 'failed')),
  pause_reason TEXT,
  payload_sha256 TEXT NOT NULL REFERENCES codex_queued_follow_up_payload_manifests(payload_sha256),
  PRIMARY KEY (thread_id, follow_up_id),
  UNIQUE (thread_id, position),
  UNIQUE (thread_id, client_user_message_id),
  CHECK (length(trim(follow_up_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(client_user_message_id)) BETWEEN 1 AND 512),
  CHECK (
    (pause_kind IS NULL AND pause_reason IS NULL)
    OR (pause_kind IS NOT NULL AND length(trim(pause_reason)) BETWEEN 1 AND 4096)
  )
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_codex_queued_follow_up_entries_payload
  ON codex_queued_follow_up_entries(payload_sha256);
CREATE TABLE codex_queued_follow_up_manifest_gc (
  asset_uri TEXT PRIMARY KEY CHECK (
    asset_uri LIKE 'nodex://assets/queued-follow-up-v1-%.json'
  ),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  enqueued_at TEXT NOT NULL CHECK (length(enqueued_at) > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR length(last_attempt_at) > 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 4096)
) WITHOUT ROWID, STRICT;
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
PRAGMA user_version = 141;
