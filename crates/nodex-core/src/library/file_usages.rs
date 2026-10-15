//! Paged File relationships across the current Profile Library.
use super::{cursor, file_retention, files};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    BoundModuleContext,
    library::{
        LibraryFileLifecycle, LibraryFileUsage, LibraryFileUsagePage, LibraryPlacedResourceTarget,
    },
};
use rusqlite::{Connection, params};

pub(super) fn read(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
) -> Result<LibraryFileUsagePage, StoreError> {
    let file = files::metadata(connection, &context.library_id.0, file_id)?;
    let limit = requested_limit.unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(invalid("File usage limit must be between 1 and 200"));
    }
    let subject = vec!["file_usages".to_owned(), file_id.to_owned()];
    let after = match requested_cursor
        .map(|value| cursor::decode(connection, value, &context.library_id.0, &subject))
        .transpose()?
    {
        Some(coordinate) if coordinate.values.is_empty() => coordinate.stable_id,
        Some(_) => return Err(invalid("File usage cursor has invalid coordinates")),
        None => String::new(),
    };
    let rows = connection.prepare(
        "WITH uses(owner_id, kind, logical_path, occurrence_count) AS (
            SELECT page_id, 'page', logical_path, 0 FROM page_file_entries WHERE library_id = ?1 AND file_id = ?2
            UNION ALL SELECT owner_block_id, 'page', NULL, count(*) FROM block_asset_refs WHERE library_id = ?1 AND file_id = ?2 GROUP BY owner_block_id
            UNION ALL SELECT reference.owner_block_id, 'canvas', NULL, count(*) FROM canvas_scene_file_refs reference
                JOIN canvas_scene_elements element ON element.document_id = reference.document_id AND element.referenced_file_id = reference.file_id AND element.is_deleted = 0
                WHERE reference.library_id = ?1 AND reference.target_file_id = ?2 GROUP BY reference.owner_block_id
        ) SELECT uses.owner_id, uses.kind, max(uses.logical_path), sum(uses.occurrence_count),
            COALESCE(materialization.title, json_extract(property.value_json, '$'), CASE uses.kind WHEN 'page' THEN 'Untitled Page' ELSE 'Canvas' END), block.lifecycle
          FROM uses JOIN blocks block ON block.id = uses.owner_id AND block.library_id = ?1
          LEFT JOIN pages page ON page.block_id = block.id
          LEFT JOIN document_materializations materialization ON materialization.document_id = page.document_id
          LEFT JOIN block_properties property ON property.block_id = block.id AND property.property_key = 'document.display_name'
          WHERE uses.owner_id > ?3 GROUP BY uses.owner_id, uses.kind ORDER BY uses.owner_id LIMIT ?4"
    )?.query_map(params![context.library_id.0, file_id, after, i64::from(limit) + 1], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)? as u64, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut visible = rows
        .into_iter()
        .map(
            |(owner, kind, logical_path, occurrence_count, title, lifecycle)| {
                let target = match kind.as_str() {
                    "page" => LibraryPlacedResourceTarget::Page {
                        page_id: owner.clone(),
                    },
                    "canvas" => LibraryPlacedResourceTarget::Canvas {
                        canvas_id: owner.clone(),
                    },
                    _ => return Err(invalid("File usage owner kind is invalid")),
                };
                let lifecycle = match lifecycle.as_str() {
                    "active" => nodex_core_contracts::library::LibraryPageLifecycleState::Active,
                    "archived" => {
                        nodex_core_contracts::library::LibraryPageLifecycleState::Archived
                    }
                    "deleted" => nodex_core_contracts::library::LibraryPageLifecycleState::Deleted,
                    _ => return Err(invalid("File usage lifecycle is invalid")),
                };
                Ok((
                    owner,
                    LibraryFileUsage {
                        title,
                        lifecycle,
                        target,
                        logical_path,
                        occurrence_count,
                    },
                ))
            },
        )
        .collect::<Result<Vec<_>, StoreError>>()?;
    let has_more = visible.len() > limit as usize;
    visible.truncate(limit as usize);
    let next_cursor = if has_more {
        visible
            .last()
            .map(|(id, _)| {
                cursor::mint(
                    connection,
                    &context.library_id.0,
                    &subject,
                    cursor::KeysetCoordinate {
                        values: Vec::new(),
                        stable_id: id.clone(),
                    },
                )
            })
            .transpose()?
    } else {
        None
    };
    let used = file_retention::has_current_use(connection, &context.library_id.0, file_id)?;
    let retained = file_retention::has_retained_use(connection, &context.library_id.0, file_id)?;
    let trashed = file.lifecycle == LibraryFileLifecycle::Trashed;
    Ok(LibraryFileUsagePage {
        items: visible.into_iter().map(|(_, item)| item).collect(),
        next_cursor,
        has_more,
        can_trash: !trashed && !used,
        can_restore: trashed,
        can_purge: trashed && !used && !retained,
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
