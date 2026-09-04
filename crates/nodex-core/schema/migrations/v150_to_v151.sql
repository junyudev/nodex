CREATE TABLE document_recovery_drafts (
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    draft_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    source_store_epoch TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    resolution TEXT CHECK (resolution IN ('already_saved', 'restored', 'copied', 'discarded')),
    resolved_at TEXT,
    resolution_operation_id TEXT,
    target_owner_id TEXT,
    target_document_id TEXT,
    CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
    PRIMARY KEY (library_id, draft_id)
) WITHOUT ROWID;
CREATE INDEX document_recovery_drafts_document
    ON document_recovery_drafts(library_id, document_id, draft_id);
CREATE INDEX document_recovery_drafts_retention
    ON document_recovery_drafts(library_id, resolved_at) WHERE resolution IS NOT NULL;
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
