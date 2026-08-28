DROP TRIGGER block_asset_refs_validate_insert;
DROP TRIGGER block_asset_refs_validate_update;

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
