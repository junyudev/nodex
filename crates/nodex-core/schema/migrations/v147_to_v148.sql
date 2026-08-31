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

CREATE TABLE workspace_subagent_lifecycle_operations (
  lifecycle_operation_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  host_id TEXT NOT NULL,
  source_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  root_thread_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('archive', 'delete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(lifecycle_operation_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(library_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(host_id)) BETWEEN 1 AND 512),
  CHECK (length(trim(source_epoch)) BETWEEN 1 AND 512),
  CHECK (length(trim(root_thread_id)) BETWEEN 1 AND 512)
) WITHOUT ROWID, STRICT;

CREATE TABLE workspace_subagent_lifecycle_members (
  lifecycle_operation_id TEXT NOT NULL
    REFERENCES workspace_subagent_lifecycle_operations(lifecycle_operation_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'unresolved', 'failed', 'settled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_reason TEXT,
  observed_at_ms INTEGER,
  PRIMARY KEY (lifecycle_operation_id, thread_id),
  CHECK (last_reason IS NULL OR length(CAST(last_reason AS BLOB)) <= 4096),
  CHECK (observed_at_ms IS NULL OR observed_at_ms >= 0)
) WITHOUT ROWID, STRICT;

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
CREATE INDEX idx_workspace_subagent_lifecycle_unresolved
  ON workspace_subagent_lifecycle_members(lifecycle_operation_id, outcome, thread_id);

PRAGMA user_version = 148;
