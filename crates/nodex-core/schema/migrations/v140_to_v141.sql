DROP TRIGGER page_file_versions_validate_insert;
DROP TRIGGER page_file_versions_are_immutable;
DROP TRIGGER page_files_validate_insert;
DROP TRIGGER page_files_validate_update;
DROP TRIGGER block_asset_refs_validate_insert;
DROP TRIGGER block_asset_refs_validate_update;
DROP INDEX idx_page_file_versions_owner;
DROP INDEX idx_page_file_versions_blob;

ALTER TABLE page_file_versions RENAME TO page_file_versions_v140;

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

INSERT INTO page_file_versions(
  file_id, version, library_id, owner_page_id, manifest_revision, change_kind,
  logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, turn_id,
  operation_id, occurred_at
)
SELECT
  file_id, version, library_id, owner_page_id, manifest_revision, change_kind,
  logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, turn_id,
  operation_id, occurred_at
FROM page_file_versions_v140;

DROP TABLE page_file_versions_v140;

CREATE INDEX idx_page_file_versions_owner
  ON page_file_versions(owner_page_id, library_id, occurred_at DESC, file_id, version DESC);
CREATE INDEX idx_page_file_versions_blob
  ON page_file_versions(blob_hash, file_id)
  WHERE blob_hash IS NOT NULL;

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
