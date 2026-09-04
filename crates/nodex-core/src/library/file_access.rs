use nodex_core_contracts::{BoundModuleContext, ResourceKey};
use rusqlite::{Connection, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

/// Direct File grants never inherit Page or Database authority. A Page read
/// instead proves its own current relationship through `require_page_use`.
pub(crate) fn file_grant_authorization_proof(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    file_id: &str,
    write_required: bool,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let authorized = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM library_files file
           JOIN projects project ON project.library_id = file.library_id
           JOIN project_resource_grants grant_row
             ON grant_row.project_id = project.id AND grant_row.library_id = file.library_id
            AND grant_row.root_kind = 'file' AND grant_row.root_id = file.file_id
           WHERE file.file_id = ?1 AND file.library_id = ?2 AND project.id = ?3
             AND project.lifecycle IN ('active', 'inactive')
             AND grant_row.lifecycle = 'active' AND grant_row.recursive = 0
             AND (?4 = 0 OR (project.lifecycle = 'active' AND grant_row.access = 'read_write'))
         )",
        params![file_id, library_id, project_id, i64::from(write_required)],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(authorized.then(|| {
        vec![ResourceKey::File {
            file_id: file_id.to_owned(),
        }]
    }))
}

pub(super) fn require_direct(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
    write_required: bool,
) -> Result<(), StoreError> {
    super::files::metadata(connection, &context.library_id.0, file_id)?;
    let Some(project_id) = &context.project_id else {
        return super::require_trusted_library_authority(context);
    };
    if file_grant_authorization_proof(
        connection,
        &context.library_id.0,
        &project_id.0,
        file_id,
        write_required,
    )?
    .is_some()
    {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "File access is unavailable",
        false,
    ))
}

/// Page authority only exposes a live File's current content. It grants no
/// access to historical versions, global changes, or another Page's entries.
pub(super) fn require_page_use(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    file_id: &str,
) -> Result<(), StoreError> {
    if let Some(project_id) = &context.project_id {
        super::require_page_read_access(connection, &context.library_id.0, &project_id.0, page_id)?;
    } else {
        super::require_trusted_library_authority(context)?;
    }
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
