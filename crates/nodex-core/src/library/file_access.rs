use nodex_core_contracts::BoundModuleContext;
use rusqlite::{Connection, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

/// Resolves the canonical File inside the bound Library.
pub(super) fn require_direct(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
) -> Result<(), StoreError> {
    super::files::metadata(connection, &context.library_id.0, file_id)?;
    Ok(())
}

/// Resolves a live File actually used by this Page.
pub(super) fn require_page_use(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    file_id: &str,
) -> Result<(), StoreError> {
    super::require_page_read_access(connection, &context.library_id.0, page_id)?;
    let available = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM library_files file
           JOIN blocks page ON page.id = ?3 AND page.library_id = file.library_id
             AND page.type = 'page' AND page.lifecycle = 'active'
           WHERE file.file_id = ?1 AND file.library_id = ?2 AND file.lifecycle = 'live'
             AND (EXISTS(SELECT 1 FROM page_file_entries entry
                         WHERE entry.page_id = ?3 AND entry.file_id = file.file_id)
               OR EXISTS(SELECT 1 FROM block_asset_refs reference
                         WHERE reference.owner_block_id = ?3
                           AND reference.file_id = file.file_id))
         )",
        params![file_id, context.library_id.0, page_id],
        |row| row.get::<_, bool>(0),
    )?;
    if available {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::NotFound,
        "Page File is unavailable",
        false,
    ))
}
