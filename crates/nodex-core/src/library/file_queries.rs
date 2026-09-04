use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryFile, LibraryFileLifecycle, LibraryFilePage, LibraryFileReadSource,
    LibraryFileUsageFilter, LibraryFileVersionPage,
};
use rusqlite::{Connection, params};

use super::{cursor, file_access, files};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const CATALOG_FILTER: &str = "file.library_id = ?1 AND file.lifecycle = ?2
    AND instr(lower(file.default_name), lower(?3)) > 0
    AND (?4 IS NULL OR EXISTS(
        SELECT 1 FROM project_resource_grants grant_row
        JOIN projects project ON project.id = grant_row.project_id AND project.library_id = grant_row.library_id
        WHERE grant_row.root_kind = 'file' AND grant_row.root_id = file.file_id
          AND grant_row.library_id = file.library_id AND grant_row.project_id = ?4
          AND grant_row.lifecycle = 'active' AND grant_row.recursive = 0
          AND project.lifecycle IN ('active', 'inactive')
    ))
    AND (?5 = 0 OR (
      NOT EXISTS(SELECT 1 FROM page_file_entries entry
        WHERE entry.library_id = file.library_id AND entry.file_id = file.file_id)
      AND NOT EXISTS(SELECT 1 FROM block_asset_refs body_ref
        WHERE body_ref.library_id = file.library_id AND body_ref.file_id = file.file_id)
      AND NOT EXISTS(SELECT 1 FROM canvas_scene_file_refs canvas_ref
        WHERE canvas_ref.library_id = file.library_id AND canvas_ref.target_file_id = file.file_id)
    ))";

fn catalog_items_sql() -> String {
    format!(
        "{} WHERE {CATALOG_FILTER}
        AND (?6 IS NULL OR file.default_name COLLATE NOCASE > ?6
          OR (file.default_name COLLATE NOCASE = ?6 AND file.file_id > ?7))
        ORDER BY file.default_name COLLATE NOCASE, file.file_id LIMIT ?8",
        files::select_sql()
    )
}

pub(super) fn metadata(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
) -> Result<LibraryFile, StoreError> {
    file_access::require_direct(connection, context, file_id, false)?;
    files::metadata(connection, &context.library_id.0, file_id)
}

pub(super) fn presentation(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
    source: &LibraryFileReadSource,
    requested_version: Option<i64>,
) -> Result<nodex_core_contracts::library::LibraryFilePresentation, StoreError> {
    let (bound_version, default_name) = match source {
        LibraryFileReadSource::Direct => {
            file_access::require_direct(connection, context, file_id, false)?;
            let file = files::metadata(connection, &context.library_id.0, file_id)?;
            (
                requested_version.unwrap_or(file.head_version),
                file.default_name,
            )
        }
        LibraryFileReadSource::Page { page_id } => {
            file_access::require_page_use(connection, context, page_id, file_id)?;
            let file = files::metadata(connection, &context.library_id.0, file_id)?;
            (file.head_version, file.default_name)
        }
        LibraryFileReadSource::DocumentRevision {
            document_id,
            revision_id,
        } => {
            let target = crate::document::resolve_document_file_target(
                connection,
                context,
                document_id,
                revision_id,
                file_id,
            )?;
            (target.version, target.default_name)
        }
        LibraryFileReadSource::Canvas {
            canvas_id,
            scene_file_id,
        } => {
            let target = crate::document::resolve_canvas_file_target(
                connection,
                context,
                canvas_id,
                scene_file_id,
                file_id,
            )?;
            (target.version, target.default_name)
        }
        LibraryFileReadSource::CanvasRevision {
            document_id,
            revision_id,
            scene_file_id,
        } => {
            let target = crate::document::resolve_canvas_revision_file_target(
                connection,
                context,
                document_id,
                revision_id,
                scene_file_id,
                file_id,
            )?;
            (target.version, target.default_name)
        }
        LibraryFileReadSource::CanvasRecovery {
            document_id,
            draft_id,
            scene_file_id,
        } => {
            let target = crate::document::resolve_recovery_canvas_file_target(
                connection,
                context,
                document_id,
                draft_id,
                scene_file_id,
                file_id,
            )?;
            (target.version, target.default_name)
        }
        LibraryFileReadSource::RecoveryDraft {
            document_id,
            draft_id,
        } => {
            let target = crate::document::resolve_recovery_file_target(
                connection,
                context,
                document_id,
                draft_id,
                file_id,
            )?;
            (target.version, target.default_name)
        }
    };
    if requested_version.is_some_and(|version| version != bound_version) {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "This File source only permits its bound version",
            false,
        ));
    }
    let version = files::read_version(connection, &context.library_id.0, file_id, bound_version)?;
    Ok(nodex_core_contracts::library::LibraryFilePresentation {
        file_id: file_id.to_owned(),
        version: version.version,
        default_name,
        mime_type: version.mime_type,
        byte_length: version.byte_length,
        blob_etag: version.blob_etag,
    })
}

pub(super) fn catalog(
    connection: &Connection,
    context: &BoundModuleContext,
    query: Option<&str>,
    lifecycle: LibraryFileLifecycle,
    usage: LibraryFileUsageFilter,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
) -> Result<LibraryFilePage, StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project| project.0.as_str());
    if project_id.is_none() {
        super::require_trusted_library_authority(context)?;
    }
    let query = query.unwrap_or_default().trim();
    if query.len() > 512 {
        return Err(invalid("File query exceeds 512 bytes"));
    }
    let lifecycle = match lifecycle {
        LibraryFileLifecycle::Live => "live",
        LibraryFileLifecycle::Trashed => "trashed",
    };
    let unused_only = usage == LibraryFileUsageFilter::Unused;
    let subject = vec![
        "files".to_owned(),
        project_id.unwrap_or_default().to_owned(),
        query.to_owned(),
        lifecycle.to_owned(),
        if unused_only { "unused" } else { "all" }.to_owned(),
    ];
    let coordinate = requested_cursor
        .map(|encoded| cursor::decode(connection, encoded, &context.library_id.0, &subject))
        .transpose()?;
    let (after_name, after_id) = match coordinate {
        None => (None, None),
        Some(cursor::KeysetCoordinate { values, stable_id }) => match values.as_slice() {
            [cursor::KeysetValue::Text { value }] => (Some(value.clone()), Some(stable_id)),
            _ => return Err(invalid("File cursor has invalid coordinates")),
        },
    };
    let limit = limit(requested_limit)?;
    let total = connection.query_row(
        &format!("SELECT count(*) FROM library_files file WHERE {CATALOG_FILTER}"),
        params![
            context.library_id.0,
            lifecycle,
            query,
            project_id,
            unused_only
        ],
        |row| row.get::<_, i64>(0),
    )?;
    let mut items = connection
        .prepare(&catalog_items_sql())?
        .query_map(
            params![
                context.library_id.0,
                lifecycle,
                query,
                project_id,
                unused_only,
                after_name,
                after_id,
                limit as i64 + 1
            ],
            files::file_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = if has_more {
        let last = items
            .last()
            .ok_or_else(|| invalid("File cursor window is empty"))?;
        Some(cursor::mint(
            connection,
            &context.library_id.0,
            &subject,
            cursor::KeysetCoordinate {
                values: vec![cursor::KeysetValue::Text {
                    value: last.default_name.clone(),
                }],
                stable_id: last.file_id.clone(),
            },
        )?)
    } else {
        None
    };
    Ok(LibraryFilePage {
        items,
        next_cursor,
        has_more,
        total: total as u64,
    })
}

pub(super) fn versions(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
) -> Result<LibraryFileVersionPage, StoreError> {
    file_access::require_direct(connection, context, file_id, false)?;
    let subject = vec![
        "file_versions".to_owned(),
        file_id.to_owned(),
        context
            .project_id
            .as_ref()
            .map(|id| id.0.clone())
            .unwrap_or_default(),
    ];
    let coordinate = requested_cursor
        .map(|encoded| cursor::decode(connection, encoded, &context.library_id.0, &subject))
        .transpose()?;
    let after_version = match coordinate {
        None => None,
        Some(cursor::KeysetCoordinate { values, stable_id }) if stable_id == file_id => {
            match values.as_slice() {
                [cursor::KeysetValue::Integer { value }] if *value > 0 => Some(*value),
                _ => return Err(invalid("File version cursor has invalid coordinates")),
            }
        }
        Some(_) => return Err(invalid("File version cursor targets another File")),
    };
    let limit = limit(requested_limit)?;
    let mut items = connection
        .prepare(
            "SELECT file_id, version, mime_type, byte_length, blob_hash, actor_id, turn_id, operation_id, occurred_at FROM file_versions WHERE file_id = ?1 AND library_id = ?2
        AND (?3 IS NULL OR version < ?3) ORDER BY version DESC LIMIT ?4",
        )?
        .query_map(
            params![
                file_id,
                context.library_id.0,
                after_version,
                limit as i64 + 1
            ],
            files::version_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = if has_more {
        let last = items
            .last()
            .ok_or_else(|| invalid("File version cursor window is empty"))?;
        Some(cursor::mint(
            connection,
            &context.library_id.0,
            &subject,
            cursor::KeysetCoordinate {
                values: vec![cursor::KeysetValue::Integer {
                    value: last.version,
                }],
                stable_id: file_id.to_owned(),
            },
        )?)
    } else {
        None
    };
    Ok(LibraryFileVersionPage {
        items,
        next_cursor,
        has_more,
    })
}

fn limit(value: Option<u32>) -> Result<usize, StoreError> {
    let value = value.unwrap_or(50);
    if value == 0 || value > 200 {
        return Err(invalid("File result limit must be between 1 and 200"));
    }
    Ok(value as usize)
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryWriteParent,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest, ProfileId, StoreEpoch,
    };
    use rusqlite::params;

    use super::*;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    const NOW: &str = "2026-09-05T00:00:00.000Z";
    const BLOB_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: None,
            connection_id: "library-file-pressure".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    #[test]
    fn library_file_catalog_stays_indexed_with_ten_thousand_files() {
        let home = tempfile::tempdir().unwrap();
        let kernel = SqliteStoreKernel::open_test(&home.path().canonicalize().unwrap()).unwrap();
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project-1', 'library-1', 'Files', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .unwrap();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &kernel);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "create-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page-1".to_owned(),
                        document_id: "document-1".to_owned(),
                        title: "File pressure".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .unwrap();
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at)
                         VALUES (?1, ?2, 1, ?3)",
                        params![BLOB_HASH, format!("{BLOB_HASH}.blob"), NOW],
                    )?;
                    let mut insert_version = transaction.prepare(
                        "INSERT INTO file_versions(file_id, version, library_id, blob_hash, mime_type,
                           byte_length, actor_id, operation_id, occurred_at)
                         VALUES (?1, 1, 'library-1', ?2, 'text/plain', 1, 'pressure', ?1, ?3)",
                    )?;
                    let mut insert_file = transaction.prepare(
                        "INSERT INTO library_files(file_id, library_id, default_name, head_version,
                           revision, lifecycle, created_by_actor_id, created_at, updated_at)
                         VALUES (?1, 'library-1', ?2, 1, 1, 'live', 'pressure', ?3, ?3)",
                    )?;
                    let mut insert_entry = transaction.prepare(
                        "INSERT INTO page_file_entries(page_id, library_id, file_id, logical_path, path_key)
                         VALUES ('page-1', 'library-1', ?1, ?2, ?2)",
                    )?;
                    for index in 0..10_000 {
                        let file_id = format!("file-{index:05}");
                        let name = if index == 9_999 {
                            "needle-09999.txt".to_owned()
                        } else {
                            format!("document-{index:05}.txt")
                        };
                        insert_version.execute(params![file_id, BLOB_HASH, NOW])?;
                        insert_file.execute(params![file_id, name, NOW])?;
                        if index % 100 == 0 {
                            insert_entry.execute(params![file_id, format!("sparse/{index:05}.txt")])?;
                        }
                    }
                    Ok(())
                })
            })
            .unwrap();

        kernel
            .writer()
            .call(|connection| {
                let started = Instant::now();
                let all = catalog(
                    connection,
                    &context(),
                    None,
                    LibraryFileLifecycle::Live,
                    LibraryFileUsageFilter::All,
                    None,
                    Some(50),
                )?;
                let all_elapsed = started.elapsed();
                assert_eq!((all.total, all.items.len(), all.has_more), (10_000, 50, true));

                let started = Instant::now();
                let unused = catalog(
                    connection,
                    &context(),
                    None,
                    LibraryFileLifecycle::Live,
                    LibraryFileUsageFilter::Unused,
                    None,
                    Some(50),
                )?;
                let unused_elapsed = started.elapsed();
                assert_eq!((unused.total, unused.items.len()), (9_900, 50));

                let started = Instant::now();
                let search = catalog(
                    connection,
                    &context(),
                    Some("needle-09999"),
                    LibraryFileLifecycle::Live,
                    LibraryFileUsageFilter::All,
                    None,
                    Some(50),
                )?;
                let search_elapsed = started.elapsed();
                assert_eq!(search.items.len(), 1);
                assert_eq!(search.items[0].file_id, "file-09999");

                let started = Instant::now();
                let direct = files::metadata(connection, "library-1", "file-09999")?;
                let direct_elapsed = started.elapsed();
                assert_eq!(direct.default_name, "needle-09999.txt");

                let started = Instant::now();
                let path_file_id = connection.query_row(
                    "SELECT file_id FROM page_file_entries WHERE page_id = ?1 AND path_key = ?2",
                    params!["page-1", "sparse/00000.txt"],
                    |row| row.get::<_, String>(0),
                )?;
                let path_elapsed = started.elapsed();
                assert_eq!(path_file_id, "file-00000");

                let plans = connection
                    .prepare(&format!("EXPLAIN QUERY PLAN {}", catalog_items_sql()))?
                    .query_map(
                        params![
                            "library-1",
                            "live",
                            "",
                            Option::<String>::None,
                            true,
                            Option::<String>::None,
                            Option::<String>::None,
                            51_i64
                        ],
                        |row| row.get::<_, String>(3),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let plan = plans.join("\n");
                assert!(plan.contains("idx_library_files_catalog"), "{plan}");
                assert!(plan.contains("idx_page_file_entries_file"), "{plan}");
                assert!(plan.contains("idx_block_asset_refs_page_file"), "{plan}");
                assert!(plan.contains("idx_canvas_scene_file_refs_target_file"), "{plan}");

                let path_plan = connection
                    .query_row(
                        "EXPLAIN QUERY PLAN SELECT file_id FROM page_file_entries
                         WHERE page_id = ?1 AND path_key = ?2",
                        params!["page-1", "sparse/00000.txt"],
                        |row| row.get::<_, String>(3),
                    )?;
                assert!(path_plan.contains("page_file_entries"), "{path_plan}");

                let total_elapsed =
                    all_elapsed + unused_elapsed + search_elapsed + direct_elapsed + path_elapsed;
                eprintln!(
                    "library File pressure: all={all_elapsed:?} unused={unused_elapsed:?} search={search_elapsed:?} direct={direct_elapsed:?} path={path_elapsed:?}\n{plan}\n{path_plan}"
                );
                assert!(
                    total_elapsed < Duration::from_secs(1),
                    "bounded File queries took {total_elapsed:?}"
                );
                Ok(())
            })
            .unwrap();
    }
}
