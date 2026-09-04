//! File lifecycle follows relationships, not a Page owner or a byte refcount.
//! These checks run in the caller's mutation transaction. User-facing errors
//! disclose no inaccessible owner identity or hidden usage count.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, params};

pub(super) fn has_current_use(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_file_entries WHERE library_id = ?1 AND file_id = ?2)
         OR EXISTS(SELECT 1 FROM block_asset_refs WHERE library_id = ?1 AND file_id = ?2)
         OR EXISTS(SELECT 1 FROM canvas_scene_file_refs WHERE library_id = ?1 AND target_file_id = ?2)",
        params![library_id, file_id], |row| row.get(0),
    )?)
}

pub(super) fn require_no_current_use(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<(), StoreError> {
    if has_current_use(connection, library_id, file_id)? {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "File is still used by current or recoverable Page or Canvas content",
            false,
        ));
    }
    Ok(())
}

pub(super) fn has_retained_use(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM document_version_file_refs WHERE library_id = ?1 AND file_id = ?2)
         OR EXISTS(SELECT 1 FROM document_recovery_file_refs WHERE library_id = ?1 AND file_id = ?2)
         OR EXISTS(SELECT 1 FROM structural_retention_members WHERE library_id = ?1 AND member_kind = 'file' AND member_id = ?2)
         OR EXISTS(SELECT 1 FROM document_recovery_drafts draft LEFT JOIN document_recovery_file_snapshots snapshot
             ON snapshot.library_id = draft.library_id AND snapshot.draft_id = draft.draft_id
             WHERE draft.library_id = ?1 AND (snapshot.draft_id IS NULL OR json_extract(snapshot.snapshot_json, '$.complete') <> 1))",
        params![library_id, file_id], |row| row.get(0),
    )?)
}

pub(super) fn require_unretained(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<(), StoreError> {
    require_no_current_use(connection, library_id, file_id)?;
    if has_retained_use(connection, library_id, file_id)? {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "File is retained by history or saved edits and cannot be permanently deleted",
            false,
        ));
    }
    Ok(())
}
