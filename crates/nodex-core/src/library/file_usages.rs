//! Direct File authority may inspect only independently authorized usage owners.
//! Pagination contains no hidden owner IDs or global usage totals.
use super::{cursor, file_access, file_retention, files};
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
    file_access::require_direct(connection, context, file_id, false)?;
    let file = files::metadata(connection, &context.library_id.0, file_id)?;
    let limit = requested_limit.unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(invalid("File usage limit must be between 1 and 200"));
    }
    let subject = vec![
        "file_usages".to_owned(),
        context
            .project_id
            .as_ref()
            .map(|id| id.0.clone())
            .unwrap_or_default(),
        file_id.to_owned(),
    ];
    let mut after = match requested_cursor
        .map(|value| cursor::decode(connection, value, &context.library_id.0, &subject))
        .transpose()?
    {
        Some(coordinate) if coordinate.values.is_empty() => coordinate.stable_id,
        Some(_) => return Err(invalid("File usage cursor has invalid coordinates")),
        None => String::new(),
    };
    let mut visible = Vec::new();
    while visible.len() <= limit as usize {
        let rows = connection.prepare(
            "WITH uses(owner_id, kind, logical_path, occurrence_count) AS (
                SELECT page_id, 'page', logical_path, 0 FROM page_file_entries WHERE library_id = ?1 AND file_id = ?2
                UNION ALL SELECT owner_block_id, 'page', NULL, count(*) FROM block_asset_refs WHERE library_id = ?1 AND file_id = ?2 GROUP BY owner_block_id
                UNION ALL SELECT reference.owner_block_id, 'canvas', NULL, count(*) FROM canvas_scene_file_refs reference
                    JOIN canvas_scene_elements element ON element.document_id = reference.document_id AND element.referenced_file_id = reference.file_id AND element.is_deleted = 0
                    WHERE reference.library_id = ?1 AND reference.target_file_id = ?2 GROUP BY reference.owner_block_id
            ) SELECT owner_id, kind, max(logical_path), sum(occurrence_count) FROM uses
              WHERE owner_id > ?3 GROUP BY owner_id, kind ORDER BY owner_id LIMIT 256"
        )?.query_map(params![context.library_id.0, file_id, after], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,i64>(3)? as u64)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            break;
        }
        for (owner, kind, logical_path, occurrence_count) in rows {
            after = owner.clone();
            if let Some(project) = &context.project_id {
                let authority = match kind.as_str() {
                    "page" => super::history::require_page_lifecycle_read_access(
                        connection,
                        &context.library_id.0,
                        &project.0,
                        &owner,
                    ),
                    "canvas" => super::history::require_canvas_lifecycle_read_access(
                        connection,
                        &context.library_id.0,
                        &project.0,
                        &owner,
                    ),
                    _ => return Err(invalid("File usage owner kind is invalid")),
                };
                match authority {
                    Ok(()) => {}
                    Err(error)
                        if matches!(
                            error.code,
                            StoreErrorCode::Unauthorized | StoreErrorCode::NotFound
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            let (title, lifecycle): (String, String) = connection.query_row(
                "SELECT COALESCE(materialization.title, json_extract(property.value_json, '$'), ?3), block.lifecycle
                 FROM blocks block
                 LEFT JOIN pages page ON page.block_id = block.id
                 LEFT JOIN document_materializations materialization ON materialization.document_id = page.document_id
                 LEFT JOIN block_properties property ON property.block_id = block.id AND property.property_key = 'document.display_name'
                 WHERE block.id = ?1 AND block.library_id = ?2",
                params![owner, context.library_id.0, if kind == "page" { "Untitled Page" } else { "Canvas" }],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let target = if kind == "page" {
                LibraryPlacedResourceTarget::Page {
                    page_id: owner.clone(),
                }
            } else {
                LibraryPlacedResourceTarget::Canvas {
                    canvas_id: owner.clone(),
                }
            };
            visible.push((
                owner,
                LibraryFileUsage {
                    title,
                    lifecycle: match lifecycle.as_str() {
                        "active" => {
                            nodex_core_contracts::library::LibraryPageLifecycleState::Active
                        }
                        "archived" => {
                            nodex_core_contracts::library::LibraryPageLifecycleState::Archived
                        }
                        "deleted" => {
                            nodex_core_contracts::library::LibraryPageLifecycleState::Deleted
                        }
                        _ => return Err(invalid("File usage lifecycle is invalid")),
                    },
                    target,
                    logical_path,
                    occurrence_count,
                },
            ));
            if visible.len() > limit as usize {
                break;
            }
        }
    }
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
    let writable = match file_access::require_direct(connection, context, file_id, true) {
        Ok(()) => true,
        Err(error) if error.code == StoreErrorCode::Unauthorized => false,
        Err(error) => return Err(error),
    };
    let used = file_retention::has_current_use(connection, &context.library_id.0, file_id)?;
    let retained = file_retention::has_retained_use(connection, &context.library_id.0, file_id)?;
    let trashed = file.lifecycle == LibraryFileLifecycle::Trashed;
    Ok(LibraryFileUsagePage {
        items: visible.into_iter().map(|(_, item)| item).collect(),
        next_cursor,
        has_more,
        can_write: writable,
        can_trash: writable && !trashed && !used,
        can_restore: writable && trashed,
        can_purge: writable && trashed && !used && !retained,
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
