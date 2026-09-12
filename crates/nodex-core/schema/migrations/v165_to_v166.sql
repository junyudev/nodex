-- Preserve exact retained JSON bytes and hashes while admitting binary packages.
CREATE TEMP TABLE migration166_recovery AS SELECT * FROM document_recovery_drafts;
DROP TABLE document_recovery_drafts;
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
    target_document_id TEXT,
    CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
    PRIMARY KEY (library_id, draft_id)
) WITHOUT ROWID;
CREATE INDEX document_recovery_drafts_document
    ON document_recovery_drafts(library_id, document_id, draft_id);
CREATE INDEX document_recovery_drafts_retention
    ON document_recovery_drafts(library_id, resolved_at) WHERE resolution IS NOT NULL;
INSERT INTO document_recovery_drafts (library_id, draft_id, document_id, source_store_epoch, generation, revision, created_at, received_at, payload_encoding, payload, payload_hash, byte_length, resolution, resolved_at, resolution_operation_id, target_owner_id, target_document_id) SELECT library_id, draft_id, document_id, source_store_epoch, generation, revision, created_at, received_at, 'legacy_json', CAST(payload_json AS BLOB), payload_hash, byte_length, resolution, resolved_at, resolution_operation_id, target_owner_id, target_document_id FROM migration166_recovery;
DROP TABLE migration166_recovery;
