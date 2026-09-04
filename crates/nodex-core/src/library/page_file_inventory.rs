use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryPageFileInventory, LibraryPageFileItem, LibraryPageFileSelector,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::{cursor, file_access, files, page_file_entries};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const INVENTORY: &str = "WITH uses AS (
    SELECT file_id AS file_id, count(*) AS body_count FROM block_asset_refs
    WHERE library_id = ?1 AND owner_block_id = ?2 AND file_id IS NOT NULL GROUP BY file_id
  ), inventory AS (
    SELECT entry.file_id, entry.logical_path, entry.path_key, COALESCE(uses.body_count, 0) AS body_count
    FROM page_file_entries entry LEFT JOIN uses ON uses.file_id = entry.file_id
    WHERE entry.library_id = ?1 AND entry.page_id = ?2
    UNION ALL
    SELECT uses.file_id, NULL, NULL, uses.body_count FROM uses
    WHERE NOT EXISTS(SELECT 1 FROM page_file_entries entry WHERE entry.page_id = ?2 AND entry.file_id = uses.file_id)
  )";

const FILTER: &str = "file.library_id = ?1 AND file.lifecycle = 'live'
    AND (instr(lower(COALESCE(inventory.logical_path, '')), lower(?3)) > 0
      OR instr(lower(file.default_name), lower(?3)) > 0)";

pub(super) fn require_page(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    write_required: bool,
) -> Result<(), StoreError> {
    if let Some(project_id) = &context.project_id {
        return if write_required {
            super::require_page_write_access(
                connection,
                &context.library_id.0,
                &project_id.0,
                page_id,
            )
        } else {
            super::require_page_read_access(
                connection,
                &context.library_id.0,
                &project_id.0,
                page_id,
            )
        };
    }
    super::require_trusted_library_authority(context)?;
    revisions(connection, &context.library_id.0, page_id)?;
    Ok(())
}

pub(super) fn revisions(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(i64, i64), StoreError> {
    connection.query_row(
        "SELECT manifest.revision, manifest.body_usage_revision FROM page_file_manifests manifest
         JOIN blocks page ON page.id = manifest.page_id AND page.library_id = manifest.library_id
         WHERE manifest.page_id = ?1 AND manifest.library_id = ?2 AND page.type = 'page' AND page.lifecycle = 'active'",
        params![page_id, library_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?.ok_or_else(|| error(StoreErrorCode::NotFound, "Page is unavailable"))
}

pub(super) fn resolve(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    selector: &LibraryPageFileSelector,
) -> Result<LibraryPageFileItem, StoreError> {
    require_page(connection, context, page_id, false)?;
    let file_id = match selector {
        LibraryPageFileSelector::FileId { file_id } => file_id.clone(),
        LibraryPageFileSelector::Path { logical_path } => {
            page_file_entries::resolve_path(
                connection,
                &context.library_id.0,
                page_id,
                logical_path,
            )?
            .file_id
        }
    };
    file_access::require_page_use(connection, context, page_id, &file_id)?;
    let file = files::metadata(connection, &context.library_id.0, &file_id)?;
    let logical_path = connection.query_row(
        "SELECT logical_path FROM page_file_entries WHERE page_id = ?1 AND file_id = ?2 AND library_id = ?3",
        params![page_id, file_id, context.library_id.0], |row| row.get::<_, String>(0),
    ).optional()?;
    let body_count: i64 = connection.query_row(
        "SELECT count(*) FROM block_asset_refs WHERE library_id = ?1 AND owner_block_id = ?2 AND file_id = ?3",
        params![context.library_id.0, page_id, file_id], |row| row.get(0),
    )?;
    Ok(LibraryPageFileItem {
        file,
        logical_path,
        body_count: body_count as u64,
    })
}

pub(super) fn list(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    query: Option<&str>,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
) -> Result<LibraryPageFileInventory, StoreError> {
    require_page(connection, context, page_id, false)?;
    let can_write = write_capability(
        connection,
        &context.library_id.0,
        context.project_id.as_ref().map(|id| id.0.as_str()),
        page_id,
    )?;
    list_authorized_page(
        connection,
        &context.library_id.0,
        page_id,
        query,
        requested_cursor,
        requested_limit,
        can_write,
    )
}

/// Reads an already-authorized Page projection. Callers must establish Page
/// read authority before entering this narrow projection seam.
pub(super) fn list_authorized_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    query: Option<&str>,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
    can_write: bool,
) -> Result<LibraryPageFileInventory, StoreError> {
    let (revision, body_usage_revision) = revisions(connection, library_id, page_id)?;
    let query = query.unwrap_or_default().trim();
    if query.len() > 512 {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "Page File query exceeds 512 bytes",
        ));
    }
    let limit = requested_limit.unwrap_or(50);
    if limit == 0 || limit > 100 {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "Page File limit must be between 1 and 100",
        ));
    }
    let subject = vec![
        "page_file_inventory".to_owned(),
        page_id.to_owned(),
        query.to_owned(),
    ];
    let coordinate = requested_cursor
        .map(|encoded| cursor::decode(connection, encoded, library_id, &subject))
        .transpose()?;
    let (after_section, after_path, after_id) = match coordinate {
        None => (None, None, None),
        Some(cursor::KeysetCoordinate { values, stable_id }) => match values.as_slice() {
            [
                cursor::KeysetValue::Integer { value: section },
                cursor::KeysetValue::Text { value: path },
            ] if (0..=1).contains(section) => (Some(*section), Some(path.clone()), Some(stable_id)),
            _ => {
                return Err(error(
                    StoreErrorCode::InvalidInput,
                    "Page File cursor coordinates are invalid",
                ));
            }
        },
    };
    let (total, unplaced_total, placed_total) = connection.query_row(&format!(
        "{INVENTORY} SELECT count(*), COALESCE(sum(inventory.body_count = 0), 0), COALESCE(sum(inventory.body_count > 0), 0)
         FROM inventory JOIN library_files file ON file.file_id = inventory.file_id WHERE {FILTER}"
    ), params![library_id, page_id, query], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))?;
    let mut files = connection.prepare(&format!(
        "{INVENTORY} SELECT {columns}, inventory.logical_path, inventory.body_count,
             COALESCE(inventory.path_key, lower(file.default_name)) AS sort_path
         {joins} JOIN inventory ON inventory.file_id = file.file_id
         WHERE {FILTER} AND (?4 IS NULL OR (inventory.body_count > 0) > ?4
           OR ((inventory.body_count > 0) = ?4 AND (sort_path > ?5 OR (sort_path = ?5 AND file.file_id > ?6))))
         ORDER BY (inventory.body_count > 0), sort_path, file.file_id LIMIT ?7",
        columns = files::FILE_COLUMNS,
        joins = files::FILE_TABLES,
    ))?.query_map(params![library_id, page_id, query, after_section, after_path, after_id, i64::from(limit) + 1], |row| {
        let body_count: i64 = row.get(14)?;
        Ok((LibraryPageFileItem { file: files::file_from_row(row)?, logical_path: row.get(13)?, body_count: body_count as u64 }, row.get::<_, String>(15)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = files.len() > limit as usize;
    files.truncate(limit as usize);
    let next_cursor = if has_more {
        let (last, sort_path) = files
            .last()
            .ok_or_else(|| error(StoreErrorCode::Internal, "Page File cursor window is empty"))?;
        Some(cursor::mint(
            connection,
            library_id,
            &subject,
            cursor::KeysetCoordinate {
                values: vec![
                    cursor::KeysetValue::Integer {
                        value: i64::from(last.body_count > 0),
                    },
                    cursor::KeysetValue::Text {
                        value: sort_path.clone(),
                    },
                ],
                stable_id: last.file.file_id.clone(),
            },
        )?)
    } else {
        None
    };
    Ok(LibraryPageFileInventory {
        can_write,
        page_id: page_id.to_owned(),
        revision,
        body_usage_revision,
        files: files.into_iter().map(|(item, _)| item).collect(),
        next_cursor,
        has_more,
        total: total as u64,
        unplaced_total: unplaced_total as u64,
        placed_total: placed_total as u64,
    })
}

fn error(code: StoreErrorCode, message: &'static str) -> StoreError {
    StoreError::new(code, message, false)
}

/// A caller must establish Page read authority before requesting its write capability.
pub(super) fn write_capability(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    page_id: &str,
) -> Result<bool, StoreError> {
    let Some(project_id) = project_id else {
        return Ok(true);
    };
    match super::require_page_write_access(connection, library_id, project_id, page_id) {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.code,
                StoreErrorCode::Unauthorized | StoreErrorCode::NotFound
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}
