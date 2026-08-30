use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
use nodex_core_contracts::library::LibraryPageFileInvalidation;
use nodex_core_contracts::library::{
    LibraryPageFileBodyUsage, LibraryPageFileChange, LibraryPageFileChangeKind,
    LibraryPageFileCollisionPolicy, LibraryPageFileManifest, LibraryPageFileMutationReceipt,
    LibraryPageFileState, LibraryPageFileSummary, LibraryPageFileVersion,
    LibraryPageFileVersionPage,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, ModuleName};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::domain::identity::stable_uuid_v7;
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::cursor::{self, KeysetCoordinate, KeysetValue};
use super::mutation::{
    MutationEffects, library_commit_result, resolve_library_mutation_authority, seal_mutation,
    sqlite_now,
};
use super::page_file_path::{
    MAX_PAGE_FILE_COMPONENT_BYTES, MAX_PAGE_FILE_PATH_BYTES, PortablePageFilePath,
};
use super::{LibraryApplyOutcome, require_page_read_access, require_page_write_access};

const MODULE_NAME: &str = "library";
const OPERATION_KIND: &str = "apply_page_file_changes";
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;
const MAX_CHANGES: usize = 100;
const MAX_ID_BYTES: usize = 512;
const MAX_MIME_TYPE_BYTES: usize = 255;

#[derive(Clone)]
struct CurrentFile {
    file_id: String,
    logical_path: String,
    path_key: String,
    mime_type: String,
    byte_length: u64,
    current_version: i64,
    state: LibraryPageFileState,
    blob_hash: Option<String>,
    created_by_actor_id: String,
    created_by_turn_id: Option<String>,
    created_at: String,
}

#[derive(Clone)]
struct DesiredFile {
    file_id: String,
    logical_path: String,
    path_key: String,
    mime_type: String,
    byte_length: u64,
    version: i64,
    state: LibraryPageFileState,
    blob_hash: Option<String>,
    change_kind: LibraryPageFileChangeKind,
    created_by_actor_id: String,
    created_by_turn_id: Option<String>,
    created_at: String,
    is_new: bool,
}

struct DesiredFileUpdate {
    change_kind: LibraryPageFileChangeKind,
    logical_path: String,
    path_key: String,
    mime_type: String,
    byte_length: u64,
    blob_hash: Option<String>,
    state: LibraryPageFileState,
}

struct FilePersistenceContext<'a> {
    connection: &'a Connection,
    library_id: &'a str,
    page_id: &'a str,
    manifest_revision: i64,
    operation_id: &'a str,
    actor_id: &'a str,
    turn_id: Option<&'a str>,
    now: &'a str,
}

struct PreparedBlob {
    receipt_id: String,
    content_hash: String,
    byte_length: u64,
}

struct PageFileCursorCoordinate {
    section: Option<i64>,
    path_key: Option<String>,
    file_id: Option<String>,
}

pub(super) fn list(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    requested_query: Option<&str>,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
    include_deleted: bool,
) -> Result<LibraryPageFileManifest, StoreError> {
    let revision = manifest_revision(connection, library_id, page_id)?;
    let body_usage_revision = body_usage_revision(connection, library_id, page_id)?;
    let limit = read_limit(requested_limit)?;
    let query_pattern = page_file_query_pattern(requested_query)?;
    let subject = vec![
        "page_files".to_owned(),
        page_id.to_owned(),
        if include_deleted { "all" } else { "live" }.to_owned(),
        query_pattern.clone().unwrap_or_default(),
    ];
    let after = requested_cursor
        .map(|encoded| cursor::decode(connection, encoded, library_id, &subject))
        .transpose()?;
    let PageFileCursorCoordinate {
        section: after_section,
        path_key: after_path_key,
        file_id: after_file_id,
    } = page_file_cursor_coordinate(after.as_ref())?;
    let query_limit = i64::try_from(limit.saturating_add(1))
        .map_err(|_| invalid("Page File limit overflowed"))?;
    let mut files = connection
        .prepare(
            "WITH base AS ( \
               SELECT file.file_id, file.owner_page_id, file.logical_path, file.mime_type, \
                      file.byte_length, file.current_version, file.state, \
                      COALESCE(current_version.blob_hash, ( \
                        SELECT prior.blob_hash FROM page_file_versions prior \
                        WHERE prior.file_id = file.file_id AND prior.blob_hash IS NOT NULL \
                        ORDER BY prior.version DESC LIMIT 1 \
                      )) AS blob_hash, file.created_by_actor_id, file.created_by_turn_id, \
                      file.created_at, file.updated_at, file.path_key, \
                      (SELECT COUNT(*) FROM block_asset_refs reference \
                       WHERE reference.page_file_id = file.file_id \
                         AND reference.owner_block_id = file.owner_page_id) AS placement_count \
               FROM page_files file \
               JOIN page_file_versions current_version \
                 ON current_version.file_id = file.file_id \
                AND current_version.version = file.current_version \
               WHERE file.library_id = ?1 AND file.owner_page_id = ?2 \
                 AND (?3 = 1 OR file.state = 'live') \
                 AND (?4 IS NULL OR LOWER(file.logical_path) LIKE ?4 ESCAPE '\\') \
             ), ranked AS ( \
               SELECT base.*, CASE \
                 WHEN state = 'deleted' THEN 2 \
                 WHEN placement_count = 0 THEN 0 \
                 ELSE 1 END AS section_order \
               FROM base \
             ) \
             SELECT file_id, owner_page_id, logical_path, mime_type, byte_length, \
                    current_version, state, blob_hash, created_by_actor_id, \
                    created_by_turn_id, created_at, updated_at, path_key, placement_count \
             FROM ranked \
             WHERE (?5 IS NULL OR section_order > ?5 \
               OR (section_order = ?5 AND path_key > ?6) \
               OR (section_order = ?5 AND path_key = ?6 AND file_id > ?7)) \
             ORDER BY section_order, path_key, file_id LIMIT ?8",
        )?
        .query_map(
            params![
                library_id,
                page_id,
                include_deleted,
                query_pattern,
                after_section,
                after_path_key,
                after_file_id,
                query_limit,
            ],
            summary_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = files.len() > limit;
    files.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let last = files
                .last()
                .ok_or_else(|| corrupt("Page File continuation has no entry"))?;
            let path_key = PortablePageFilePath::parse(&last.logical_path)?
                .collision_key()
                .to_owned();
            cursor::mint(
                connection,
                library_id,
                &subject,
                KeysetCoordinate {
                    values: vec![
                        KeysetValue::Integer {
                            value: page_file_section(last),
                        },
                        KeysetValue::Text { value: path_key },
                    ],
                    stable_id: last.file_id.clone(),
                },
            )
        })
        .transpose()?;
    let (total, live_total, unplaced_total, placed_total, deleted_total): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = connection.query_row(
        "WITH inventory AS ( \
           SELECT file.state, (SELECT COUNT(*) FROM block_asset_refs reference \
             WHERE reference.page_file_id = file.file_id \
               AND reference.owner_block_id = file.owner_page_id) AS placement_count \
           FROM page_files file \
           WHERE file.library_id = ?1 AND file.owner_page_id = ?2 \
             AND (?4 IS NULL OR LOWER(file.logical_path) LIKE ?4 ESCAPE '\\') \
         ) \
         SELECT COALESCE(SUM(CASE WHEN ?3 = 1 OR state = 'live' THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state = 'live' THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state = 'live' AND placement_count = 0 THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state = 'live' AND placement_count > 0 THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state = 'deleted' THEN 1 ELSE 0 END), 0) \
         FROM inventory",
        params![library_id, page_id, include_deleted, query_pattern],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    Ok(LibraryPageFileManifest {
        page_id: page_id.to_owned(),
        revision,
        body_usage_revision,
        files,
        next_cursor,
        has_more,
        total: u64::try_from(total).map_err(|_| corrupt("Page File count is invalid"))?,
        live_total: u64::try_from(live_total)
            .map_err(|_| corrupt("Live Page File count is invalid"))?,
        unplaced_total: u64::try_from(unplaced_total)
            .map_err(|_| corrupt("Unplaced Page File count is invalid"))?,
        placed_total: u64::try_from(placed_total)
            .map_err(|_| corrupt("Placed Page File count is invalid"))?,
        deleted_total: u64::try_from(deleted_total)
            .map_err(|_| corrupt("Deleted Page File count is invalid"))?,
    })
}

/** Agent draft projections intentionally carry the complete direct manifest. */
pub(super) fn list_complete(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    include_deleted: bool,
) -> Result<LibraryPageFileManifest, StoreError> {
    let mut complete = list(
        connection,
        library_id,
        page_id,
        None,
        None,
        Some(MAX_LIMIT as u32),
        include_deleted,
    )?;
    while let Some(cursor) = complete.next_cursor.take() {
        let page = list(
            connection,
            library_id,
            page_id,
            None,
            Some(&cursor),
            Some(MAX_LIMIT as u32),
            include_deleted,
        )?;
        if page.revision != complete.revision
            || page.body_usage_revision != complete.body_usage_revision
            || page.total != complete.total
        {
            return Err(revision_conflict(
                "Page Files changed while the draft was projected",
            ));
        }
        complete.files.extend(page.files);
        complete.next_cursor = page.next_cursor;
    }
    complete.has_more = false;
    Ok(complete)
}

pub(super) fn metadata(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    file_id: &str,
) -> Result<LibraryPageFileSummary, StoreError> {
    validate_id(page_id, "Page")?;
    validate_id(file_id, "Page File")?;
    require_current_file_access(connection, library_id, page_id, file_id)?;
    metadata_by_id(connection, library_id, file_id)
}

fn owned_metadata(
    connection: &Connection,
    library_id: &str,
    owner_page_id: &str,
    file_id: &str,
) -> Result<LibraryPageFileSummary, StoreError> {
    validate_id(owner_page_id, "Page")?;
    validate_id(file_id, "Page File")?;
    let summary = metadata_by_id(connection, library_id, file_id)?;
    if summary.owner_page_id == owner_page_id {
        return Ok(summary);
    }
    Err(not_found("Page File is unavailable"))
}

fn metadata_by_id(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<LibraryPageFileSummary, StoreError> {
    connection
        .query_row(
            "SELECT file.file_id, file.owner_page_id, file.logical_path, file.mime_type, \
                    file.byte_length, file.current_version, file.state, \
                    COALESCE(current_version.blob_hash, ( \
                      SELECT prior.blob_hash FROM page_file_versions prior \
                      WHERE prior.file_id = file.file_id AND prior.blob_hash IS NOT NULL \
                      ORDER BY prior.version DESC LIMIT 1 \
                    )), file.created_by_actor_id, file.created_by_turn_id, \
                    file.created_at, file.updated_at, file.path_key, \
                    (SELECT COUNT(*) FROM block_asset_refs reference \
                     WHERE reference.page_file_id = file.file_id \
                       AND reference.owner_block_id = file.owner_page_id) \
             FROM page_files file \
             JOIN page_file_versions current_version \
               ON current_version.file_id = file.file_id \
              AND current_version.version = file.current_version \
             WHERE file.library_id = ?1 AND file.file_id = ?2",
            params![library_id, file_id],
            summary_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("Page File is unavailable"))
}

/// Resolves current File content through either its owner Page or a canonical
/// placement in the Page named by the caller. The placement grants only the
/// current presentation surface; manifest mutations and version history remain
/// owner-authorized operations.
pub(super) fn require_current_file_access(
    connection: &Connection,
    library_id: &str,
    access_page_id: &str,
    file_id: &str,
) -> Result<(), StoreError> {
    validate_id(access_page_id, "Page")?;
    validate_id(file_id, "Page File")?;
    let accessible = connection.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM page_files file \
           JOIN page_file_versions version \
             ON version.file_id = file.file_id AND version.version = file.current_version \
           WHERE file.file_id = ?1 AND file.library_id = ?2 AND file.state = 'live' \
             AND version.blob_hash IS NOT NULL \
             AND (file.owner_page_id = ?3 OR EXISTS( \
               SELECT 1 FROM block_asset_refs reference \
               WHERE reference.page_file_id = file.file_id \
                 AND reference.owner_block_id = ?3 \
             )) \
         )",
        params![file_id, library_id, access_page_id],
        |row| row.get::<_, bool>(0),
    )?;
    if accessible {
        return Ok(());
    }
    Err(not_found("Page File is unavailable"))
}

pub(super) fn require_owned_file_access(
    connection: &Connection,
    library_id: &str,
    owner_page_id: &str,
    file_id: &str,
) -> Result<(), StoreError> {
    validate_id(owner_page_id, "Page")?;
    validate_id(file_id, "Page File")?;
    let owned = connection.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM page_files file \
           WHERE file.file_id = ?1 AND file.library_id = ?2 \
             AND file.owner_page_id = ?3 \
         )",
        params![file_id, library_id, owner_page_id],
        |row| row.get::<_, bool>(0),
    )?;
    if owned {
        return Ok(());
    }
    Err(not_found("Page File is unavailable"))
}

pub(super) fn versions(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    file_id: &str,
    requested_cursor: Option<&str>,
    requested_limit: Option<u32>,
) -> Result<LibraryPageFileVersionPage, StoreError> {
    owned_metadata(connection, library_id, page_id, file_id)?;
    let limit = read_limit(requested_limit)?;
    let subject = vec![
        "page_file_versions".to_owned(),
        page_id.to_owned(),
        file_id.to_owned(),
    ];
    let after = requested_cursor
        .map(|encoded| cursor::decode(connection, encoded, library_id, &subject))
        .transpose()?;
    let after_version = integer_cursor_coordinate(after.as_ref(), file_id)?;
    let query_limit = i64::try_from(limit.saturating_add(1))
        .map_err(|_| invalid("Page File version limit overflowed"))?;
    let mut entries = connection
        .prepare(
            "SELECT version.file_id, version.version, version.owner_page_id, \
                    version.manifest_revision, version.change_kind, version.logical_path, \
                    version.mime_type, version.byte_length, version.blob_hash, version.actor_id, \
                    version.turn_id, version.operation_id, version.occurred_at \
             FROM page_file_versions version \
             WHERE version.library_id = ?1 AND version.file_id = ?2 \
               AND (?3 IS NULL OR version.version < ?3) \
             ORDER BY version.version DESC LIMIT ?4",
        )?
        .query_map(
            params![library_id, file_id, after_version, query_limit],
            version_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let last = entries
                .last()
                .ok_or_else(|| corrupt("Page File version continuation has no entry"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                KeysetCoordinate {
                    values: vec![KeysetValue::Integer {
                        value: last.version,
                    }],
                    stable_id: file_id.to_owned(),
                },
            )
        })
        .transpose()?;
    Ok(LibraryPageFileVersionPage {
        page_id: page_id.to_owned(),
        file_id: file_id.to_owned(),
        versions: entries,
        next_cursor,
        has_more,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_manifest_revision: i64,
    changes: &[LibraryPageFileChange],
    turn_id: Option<&str>,
) -> Result<LibraryApplyOutcome, StoreError> {
    validate_id(page_id, "Page")?;
    validate_id(operation_id, "Operation")?;
    validate_optional_id(turn_id, "Agent turn")?;
    if expected_manifest_revision < 0 {
        return Err(invalid("Page File manifest revision cannot be negative"));
    }
    if changes.is_empty() || changes.len() > MAX_CHANGES {
        return Err(invalid("Page File mutation must contain 1 to 100 changes"));
    }

    let authority = resolve_library_mutation_authority(connection, context, library_id)?;
    if let Some(project_id) = authority.requesting_project_id.as_deref() {
        require_page_write_access(connection, library_id, project_id, page_id)?;
    } else if !trusted_root_adapter(&context.adapter) {
        return Err(unauthorized("Page File writes require Page write access"));
    }
    require_active_page(connection, library_id, page_id)?;
    let current_revision = manifest_revision(connection, library_id, page_id)?;
    if current_revision != expected_manifest_revision {
        return Err(revision_conflict("Page File manifest revision changed"));
    }

    let now = sqlite_now(connection)?;
    let current_files = load_current_files(connection, library_id, page_id)?;
    let (planned, receipt) = plan_changes(
        connection,
        context,
        store_epoch,
        library_id,
        operation_id,
        page_id,
        expected_manifest_revision + 1,
        changes,
        turn_id,
        &authority.actor_project_id,
        &now,
        &current_files,
    )?;
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let updated = connection.execute(
                "UPDATE page_file_manifests SET revision = ?1, updated_at = ?2 \
                 WHERE page_id = ?3 AND library_id = ?4 AND revision = ?5",
                params![
                    receipt.manifest_revision,
                    now,
                    page_id,
                    library_id,
                    expected_manifest_revision,
                ],
            )?;
            if updated != 1 {
                return Err(revision_conflict("Page File manifest revision changed"));
            }
            replace_namespace_paths(connection, library_id, page_id, &planned)?;
            let persistence = FilePersistenceContext {
                connection,
                library_id,
                page_id,
                manifest_revision: receipt.manifest_revision,
                operation_id,
                actor_id: &authority.actor_project_id,
                turn_id,
                now: &now,
            };
            for desired in &planned {
                persist_desired_file(&persistence, desired)?;
            }
            for receipt_id in &receipt.consumed_blob_receipt_ids {
                let consumed = connection.execute(
                    "UPDATE prepared_blob_receipts \
                     SET state = 'consumed', consumed_commit_seq = ?1, updated_at = ?2 \
                     WHERE receipt_id = ?3 AND state = 'prepared'",
                    params![scope.evidence().commit_seq(), now, receipt_id],
                )?;
                if consumed != 1 {
                    return Err(revision_conflict(
                        "Prepared Blob receipt is no longer available",
                    ));
                }
            }
            let placement_page_ids = foreign_placement_page_ids(
                connection,
                library_id,
                page_id,
                &receipt.updated_file_ids,
            )?;
            let mut affected_page_ids = vec![page_id.to_owned()];
            affected_page_ids.extend(placement_page_ids.iter().cloned());
            let mut committed_revisions =
                BTreeMap::from([(format!("pageFiles:{page_id}"), receipt.manifest_revision)]);
            committed_revisions.extend(placement_page_ids.into_iter().map(|placement_page_id| {
                (
                    format!("pageFileContent:{placement_page_id}"),
                    scope.evidence().commit_seq(),
                )
            }));
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: authority.actor_project_id.clone(),
                    operation_kind: OPERATION_KIND,
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys: Vec::new(),
                    affected_block_ids: Vec::new(),
                    affected_page_ids,
                    affected_database_ids: Vec::new(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids: Vec::new(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    page_files: Some(receipt.clone()),
                    canvas_mutation: None,
                    block_transfer: None,
                    block_transfer_undo: None,
                    page_relocation_undo: None,
                    structural_edit: None,
                    page_lifecycle: None,
                    block_property_mutation: None,
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: Some(json!({
                        "operationKind": OPERATION_KIND,
                        "pageId": page_id,
                        "manifestRevision": receipt.manifest_revision,
                        "createdFileIds": receipt.created_file_ids,
                        "updatedFileIds": receipt.updated_file_ids,
                        "deletedFileIds": receipt.deleted_file_ids,
                    })),
                    committed_at: now.clone(),
                },
            )
        },
    )?;
    library_commit_result(connection, result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn put(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    file_id: &str,
    logical_path: &str,
    mime_type: &str,
    prepared_blob_receipt_id: &str,
    turn_id: Option<&str>,
) -> Result<LibraryApplyOutcome, StoreError> {
    let expected_manifest_revision = manifest_revision(connection, library_id, page_id)?;
    apply(
        connection,
        context,
        store_epoch,
        library_id,
        operation_id,
        request_hash,
        page_id,
        expected_manifest_revision,
        &[LibraryPageFileChange::Put {
            file_id: file_id.to_owned(),
            logical_path: logical_path.to_owned(),
            mime_type: mime_type.to_owned(),
            prepared_blob_receipt_id: prepared_blob_receipt_id.to_owned(),
        }],
        turn_id,
    )
}

fn foreign_placement_page_ids(
    connection: &Connection,
    library_id: &str,
    owner_page_id: &str,
    file_ids: &[String],
) -> Result<Vec<String>, StoreError> {
    let file_ids_json = json!(file_ids).to_string();
    connection
        .prepare(
            "SELECT DISTINCT reference.owner_block_id \
             FROM block_asset_refs reference \
             WHERE reference.library_id = ?1 \
               AND reference.owner_block_id <> ?2 \
               AND reference.page_file_id IN (SELECT value FROM json_each(?3)) \
             ORDER BY reference.owner_block_id",
        )?
        .query_map(params![library_id, owner_page_id, file_ids_json], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Replaces the changed part of a Page's path namespace before advancing File
/// heads. The namespace table is the deep module that makes a batch's final
/// paths authoritative without exposing SQLite's row-by-row UNIQUE timing;
/// this is what permits atomic `a ↔ b` swaps.
fn replace_namespace_paths(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    planned: &[DesiredFile],
) -> Result<(), StoreError> {
    for desired in planned {
        connection.execute(
            "DELETE FROM page_file_namespace WHERE file_id = ?1",
            [&desired.file_id],
        )?;
    }
    for desired in planned {
        if desired.state != LibraryPageFileState::Live {
            continue;
        }
        connection.execute(
            "INSERT INTO page_file_namespace(owner_page_id, library_id, path_key, file_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![page_id, library_id, desired.path_key, desired.file_id],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn plan_changes(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    page_id: &str,
    manifest_revision: i64,
    changes: &[LibraryPageFileChange],
    turn_id: Option<&str>,
    actor_id: &str,
    now: &str,
    current_files: &BTreeMap<String, CurrentFile>,
) -> Result<(Vec<DesiredFile>, LibraryPageFileMutationReceipt), StoreError> {
    let mut planned = Vec::with_capacity(changes.len());
    let mut changed_file_ids = BTreeSet::new();
    let mut consumed_receipts = BTreeSet::new();
    let mut created_file_ids = Vec::new();
    let mut updated_file_ids = Vec::new();
    let mut deleted_file_ids = Vec::new();
    let mut suffix_file_ids = BTreeSet::new();

    for change in changes {
        let desired = match change {
            LibraryPageFileChange::Put {
                file_id,
                logical_path,
                mime_type,
                prepared_blob_receipt_id,
            } => {
                let path = PortablePageFilePath::parse(logical_path)?;
                let prepared = prepared_blob(
                    connection,
                    store_epoch,
                    library_id,
                    actor_id,
                    operation_id,
                    prepared_blob_receipt_id,
                )?;
                mark_consumed_receipt(&mut consumed_receipts, &prepared.receipt_id)?;
                let existing = current_files.values().find(|current| {
                    current.state == LibraryPageFileState::Live
                        && current.path_key == path.collision_key()
                });
                match existing {
                    Some(current) => {
                        mark_changed_file(&mut changed_file_ids, &current.file_id)?;
                        updated_file_ids.push(current.file_id.clone());
                        desired_from_current(
                            current,
                            DesiredFileUpdate {
                                change_kind: LibraryPageFileChangeKind::Replace,
                                logical_path: path.display().to_owned(),
                                path_key: path.collision_key().to_owned(),
                                mime_type: validate_mime_type(mime_type)?,
                                byte_length: prepared.byte_length,
                                blob_hash: Some(prepared.content_hash),
                                state: LibraryPageFileState::Live,
                            },
                        )
                    }
                    None => {
                        validate_new_file_id(connection, file_id)?;
                        mark_changed_file(&mut changed_file_ids, file_id)?;
                        created_file_ids.push(file_id.clone());
                        DesiredFile {
                            file_id: file_id.clone(),
                            logical_path: path.display().to_owned(),
                            path_key: path.collision_key().to_owned(),
                            mime_type: validate_mime_type(mime_type)?,
                            byte_length: prepared.byte_length,
                            version: 1,
                            state: LibraryPageFileState::Live,
                            blob_hash: Some(prepared.content_hash),
                            change_kind: LibraryPageFileChangeKind::Create,
                            created_by_actor_id: actor_id.to_owned(),
                            created_by_turn_id: turn_id.map(str::to_owned),
                            created_at: now.to_owned(),
                            is_new: true,
                        }
                    }
                }
            }
            LibraryPageFileChange::Create {
                file_id,
                logical_path,
                mime_type,
                prepared_blob_receipt_id,
                collision_policy,
            } => {
                validate_new_file_id(connection, file_id)?;
                mark_changed_file(&mut changed_file_ids, file_id)?;
                let path = PortablePageFilePath::parse(logical_path)?;
                let prepared = prepared_blob(
                    connection,
                    store_epoch,
                    library_id,
                    actor_id,
                    operation_id,
                    prepared_blob_receipt_id,
                )?;
                mark_consumed_receipt(&mut consumed_receipts, &prepared.receipt_id)?;
                if *collision_policy == LibraryPageFileCollisionPolicy::Suffix {
                    suffix_file_ids.insert(file_id.clone());
                }
                created_file_ids.push(file_id.clone());
                DesiredFile {
                    file_id: file_id.clone(),
                    logical_path: path.display().to_owned(),
                    path_key: path.collision_key().to_owned(),
                    mime_type: validate_mime_type(mime_type)?,
                    byte_length: prepared.byte_length,
                    version: 1,
                    state: LibraryPageFileState::Live,
                    blob_hash: Some(prepared.content_hash),
                    change_kind: LibraryPageFileChangeKind::Create,
                    created_by_actor_id: actor_id.to_owned(),
                    created_by_turn_id: turn_id.map(str::to_owned),
                    created_at: now.to_owned(),
                    is_new: true,
                }
            }
            LibraryPageFileChange::ReplaceContent {
                file_id,
                expected_version,
                mime_type,
                prepared_blob_receipt_id,
            } => {
                let current = current_live_file(current_files, file_id, *expected_version)?;
                mark_changed_file(&mut changed_file_ids, file_id)?;
                let prepared = prepared_blob(
                    connection,
                    store_epoch,
                    library_id,
                    actor_id,
                    operation_id,
                    prepared_blob_receipt_id,
                )?;
                mark_consumed_receipt(&mut consumed_receipts, &prepared.receipt_id)?;
                updated_file_ids.push(file_id.clone());
                desired_from_current(
                    current,
                    DesiredFileUpdate {
                        change_kind: LibraryPageFileChangeKind::Replace,
                        logical_path: current.logical_path.clone(),
                        path_key: current.path_key.clone(),
                        mime_type: validate_mime_type(mime_type)?,
                        byte_length: prepared.byte_length,
                        blob_hash: Some(prepared.content_hash),
                        state: LibraryPageFileState::Live,
                    },
                )
            }
            LibraryPageFileChange::Rename {
                file_id,
                expected_version,
                logical_path,
            } => {
                let current = current_live_file(current_files, file_id, *expected_version)?;
                mark_changed_file(&mut changed_file_ids, file_id)?;
                let path = PortablePageFilePath::parse(logical_path)?;
                updated_file_ids.push(file_id.clone());
                desired_from_current(
                    current,
                    DesiredFileUpdate {
                        change_kind: LibraryPageFileChangeKind::Rename,
                        logical_path: path.display().to_owned(),
                        path_key: path.collision_key().to_owned(),
                        mime_type: current.mime_type.clone(),
                        byte_length: current.byte_length,
                        blob_hash: current.blob_hash.clone(),
                        state: LibraryPageFileState::Live,
                    },
                )
            }
            LibraryPageFileChange::Delete {
                file_id,
                expected_version,
            } => {
                let current = current_live_file(current_files, file_id, *expected_version)?;
                reject_referenced_file_deletion(connection, file_id)?;
                mark_changed_file(&mut changed_file_ids, file_id)?;
                deleted_file_ids.push(file_id.clone());
                desired_from_current(
                    current,
                    DesiredFileUpdate {
                        change_kind: LibraryPageFileChangeKind::Delete,
                        logical_path: current.logical_path.clone(),
                        path_key: current.path_key.clone(),
                        mime_type: current.mime_type.clone(),
                        byte_length: 0,
                        blob_hash: None,
                        state: LibraryPageFileState::Deleted,
                    },
                )
            }
            LibraryPageFileChange::RestoreVersion {
                file_id,
                expected_version,
                source_version,
            } => {
                let current = current_file(current_files, file_id, *expected_version)?;
                mark_changed_file(&mut changed_file_ids, file_id)?;
                let source = load_restorable_version(
                    connection,
                    library_id,
                    page_id,
                    file_id,
                    *source_version,
                )?;
                updated_file_ids.push(file_id.clone());
                desired_from_current(
                    current,
                    DesiredFileUpdate {
                        change_kind: LibraryPageFileChangeKind::Restore,
                        logical_path: source.logical_path,
                        path_key: source.path_key,
                        mime_type: source.mime_type,
                        byte_length: source.byte_length,
                        blob_hash: source.blob_hash,
                        state: LibraryPageFileState::Live,
                    },
                )
            }
            LibraryPageFileChange::CloneIntoPage {
                source_page_id,
                source_file_id,
                target_file_id,
                logical_path,
            } => {
                validate_new_file_id(connection, target_file_id)?;
                mark_changed_file(&mut changed_file_ids, target_file_id)?;
                authorize_clone_source(connection, context, library_id, source_page_id)?;
                let source =
                    load_live_file(connection, library_id, source_page_id, source_file_id)?;
                let path = PortablePageFilePath::parse(logical_path)?;
                created_file_ids.push(target_file_id.clone());
                DesiredFile {
                    file_id: target_file_id.clone(),
                    logical_path: path.display().to_owned(),
                    path_key: path.collision_key().to_owned(),
                    mime_type: source.mime_type,
                    byte_length: source.byte_length,
                    version: 1,
                    state: LibraryPageFileState::Live,
                    blob_hash: source.blob_hash,
                    change_kind: LibraryPageFileChangeKind::Clone,
                    created_by_actor_id: actor_id.to_owned(),
                    created_by_turn_id: turn_id.map(str::to_owned),
                    created_at: now.to_owned(),
                    is_new: true,
                }
            }
        };
        planned.push(desired);
    }

    if !suffix_file_ids.is_empty() {
        allocate_created_paths(current_files, &mut planned, &suffix_file_ids)?;
    }

    validate_final_namespace(current_files, &planned)?;
    created_file_ids.sort();
    updated_file_ids.sort();
    deleted_file_ids.sort();
    Ok((
        planned,
        LibraryPageFileMutationReceipt {
            page_id: page_id.to_owned(),
            manifest_revision,
            created_file_ids,
            updated_file_ids,
            deleted_file_ids,
            consumed_blob_receipt_ids: consumed_receipts.into_iter().collect(),
        },
    ))
}

fn reject_referenced_file_deletion(
    connection: &Connection,
    file_id: &str,
) -> Result<(), StoreError> {
    let referenced = connection
        .query_row(
            "SELECT 1 FROM block_asset_refs WHERE page_file_id = ?1 LIMIT 1",
            [file_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !referenced {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::ProtectedOwnerDeletion,
        "Page File is still placed in a Page body",
        false,
    ))
}

fn allocate_created_paths(
    current_files: &BTreeMap<String, CurrentFile>,
    planned: &mut [DesiredFile],
    suffix_file_ids: &BTreeSet<String>,
) -> Result<(), StoreError> {
    let planned_ids = planned
        .iter()
        .map(|file| file.file_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut occupied = current_files
        .values()
        .filter(|file| {
            file.state == LibraryPageFileState::Live && !planned_ids.contains(file.file_id.as_str())
        })
        .map(|file| file.path_key.clone())
        .collect::<BTreeSet<_>>();

    for file in planned.iter().filter(|file| {
        file.state == LibraryPageFileState::Live && !suffix_file_ids.contains(&file.file_id)
    }) {
        occupied.insert(file.path_key.clone());
    }
    for file in planned.iter_mut().filter(|file| {
        file.state == LibraryPageFileState::Live && suffix_file_ids.contains(&file.file_id)
    }) {
        let (logical_path, path_key) =
            allocate_created_path(&file.logical_path, &file.file_id, &mut occupied)?;
        file.logical_path = logical_path;
        file.path_key = path_key;
    }
    Ok(())
}

fn allocate_created_path(
    preferred_path: &str,
    file_id: &str,
    occupied: &mut BTreeSet<String>,
) -> Result<(String, String), StoreError> {
    if let Some(path) = allocate_numbered_path(preferred_path, occupied)? {
        return Ok(path);
    }
    let fallback = format!("files/{file_id}");
    let path = PortablePageFilePath::parse(&fallback)?;
    if !occupied.insert(path.collision_key().to_owned()) {
        return Err(invalid("Page File namespace is exhausted"));
    }
    Ok((path.display().to_owned(), path.collision_key().to_owned()))
}

pub(super) fn allocate_numbered_path(
    preferred_path: &str,
    occupied: &mut BTreeSet<String>,
) -> Result<Option<(String, String)>, StoreError> {
    let preferred = PortablePageFilePath::parse(preferred_path)?;
    if occupied.insert(preferred.collision_key().to_owned()) {
        return Ok(Some((
            preferred.display().to_owned(),
            preferred.collision_key().to_owned(),
        )));
    }
    let (directory, basename) = preferred_path
        .rsplit_once('/')
        .map_or(("", preferred_path), |(directory, basename)| {
            (directory, basename)
        });
    let (stem, extension) = basename
        .rfind('.')
        .filter(|index| *index > 0)
        .map_or((basename, ""), |index| basename.split_at(index));
    for copy_number in 2..=10_000 {
        let suffix = format!(" ({copy_number})");
        let Some(candidate) = suffixed_path(directory, stem, extension, &suffix) else {
            return Ok(None);
        };
        let path = PortablePageFilePath::parse(&candidate)?;
        if occupied.insert(path.collision_key().to_owned()) {
            return Ok(Some((
                path.display().to_owned(),
                path.collision_key().to_owned(),
            )));
        }
    }
    Ok(None)
}

fn suffixed_path(directory: &str, stem: &str, extension: &str, suffix: &str) -> Option<String> {
    let directory_bytes = directory.len() + usize::from(!directory.is_empty());
    let basename_limit =
        MAX_PAGE_FILE_COMPONENT_BYTES.min(MAX_PAGE_FILE_PATH_BYTES.checked_sub(directory_bytes)?);
    let stem_limit = basename_limit.checked_sub(suffix.len() + extension.len())?;
    let mut stem_end = stem.len().min(stem_limit);
    while stem_end > 0 && !stem.is_char_boundary(stem_end) {
        stem_end -= 1;
    }
    if stem_end == 0 {
        return None;
    }
    let basename = format!("{}{suffix}{extension}", &stem[..stem_end]);
    Some(if directory.is_empty() {
        basename
    } else {
        format!("{directory}/{basename}")
    })
}

fn persist_desired_file(
    context: &FilePersistenceContext<'_>,
    desired: &DesiredFile,
) -> Result<(), StoreError> {
    let byte_length = i64::try_from(desired.byte_length)
        .map_err(|_| invalid("Page File byte length exceeds the Store bound"))?;
    context.connection.execute(
        "INSERT INTO page_file_versions( \
           file_id, version, library_id, owner_page_id, manifest_revision, change_kind, \
           logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, turn_id, \
           operation_id, occurred_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            desired.file_id,
            desired.version,
            context.library_id,
            context.page_id,
            context.manifest_revision,
            change_kind_name(desired.change_kind),
            desired.logical_path,
            desired.path_key,
            desired.mime_type,
            desired.blob_hash,
            byte_length,
            context.actor_id,
            context.turn_id,
            context.operation_id,
            context.now,
        ],
    )?;
    if desired.is_new {
        context.connection.execute(
            "INSERT INTO page_files( \
               file_id, library_id, owner_page_id, logical_path, path_key, mime_type, \
               byte_length, current_version, state, created_by_actor_id, created_by_turn_id, \
               created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                desired.file_id,
                context.library_id,
                context.page_id,
                desired.logical_path,
                desired.path_key,
                desired.mime_type,
                byte_length,
                desired.version,
                state_name(desired.state),
                desired.created_by_actor_id,
                desired.created_by_turn_id,
                desired.created_at,
            ],
        )?;
        return Ok(());
    }
    let updated = context.connection.execute(
        "UPDATE page_files SET logical_path = ?1, path_key = ?2, mime_type = ?3, \
           byte_length = ?4, current_version = ?5, state = ?6, updated_at = ?7 \
         WHERE file_id = ?8 AND library_id = ?9 AND owner_page_id = ?10 \
           AND current_version = ?11",
        params![
            desired.logical_path,
            desired.path_key,
            desired.mime_type,
            byte_length,
            desired.version,
            state_name(desired.state),
            context.now,
            desired.file_id,
            context.library_id,
            context.page_id,
            desired.version - 1,
        ],
    )?;
    if updated != 1 {
        return Err(revision_conflict("Page File version changed"));
    }
    Ok(())
}

pub(super) struct PageFileCopyClosure {
    pub(super) manifest_revisions: BTreeMap<String, i64>,
    pub(super) file_ids: BTreeMap<String, String>,
}

/// Starts copied Pages with fresh File identities and one current-state
/// history entry while reusing immutable Blob bytes. Only directly owned Files
/// receive new identities; foreign placements keep their existing identity.
pub(super) fn clone_for_page_copy(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    actor_id: &str,
    now: &str,
    source_to_target_page_ids: &BTreeMap<String, String>,
) -> Result<PageFileCopyClosure, StoreError> {
    let mut manifest_revisions = BTreeMap::new();
    let mut file_ids = BTreeMap::new();
    for (source_page_id, target_page_id) in source_to_target_page_ids {
        let files = connection
            .prepare(
                "SELECT file.file_id, file.logical_path, file.path_key, file.mime_type, \
                        file.byte_length, version.blob_hash \
                 FROM page_files file \
                 JOIN page_file_versions version ON version.file_id = file.file_id \
                   AND version.version = file.current_version \
                 WHERE file.library_id = ?1 AND file.owner_page_id = ?2 \
                   AND file.state = 'live' AND version.blob_hash IS NOT NULL \
                 ORDER BY file.path_key, file.file_id",
            )?
            .query_map(params![library_id, source_page_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if files.is_empty() {
            continue;
        }
        let advanced = connection.execute(
            "UPDATE page_file_manifests SET revision = 1, updated_at = ?1 \
             WHERE page_id = ?2 AND library_id = ?3 AND revision = 0",
            params![now, target_page_id, library_id],
        )?;
        if advanced != 1 {
            return Err(corrupt("Copied Page File manifest is unavailable"));
        }
        for (source_file_id, logical_path, path_key, mime_type, byte_length, blob_hash) in files {
            let target_file_id = stable_uuid_v7(
                operation_id,
                "page_file",
                &format!("{source_file_id}:{target_page_id}"),
            );
            connection.execute(
                "INSERT INTO page_file_namespace(owner_page_id, library_id, path_key, file_id) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![target_page_id, library_id, path_key, target_file_id],
            )?;
            connection.execute(
                "INSERT INTO page_file_versions( \
                   file_id, version, library_id, owner_page_id, manifest_revision, change_kind, \
                   logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, turn_id, \
                   operation_id, occurred_at \
                 ) VALUES (?1, 1, ?2, ?3, 1, 'clone', ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
                params![
                    target_file_id,
                    library_id,
                    target_page_id,
                    logical_path,
                    path_key,
                    mime_type,
                    blob_hash,
                    byte_length,
                    actor_id,
                    operation_id,
                    now,
                ],
            )?;
            connection.execute(
                "INSERT INTO page_files( \
                   file_id, library_id, owner_page_id, logical_path, path_key, mime_type, \
                   byte_length, current_version, state, created_by_actor_id, created_by_turn_id, \
                   created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 'live', ?8, NULL, ?9, ?9)",
                params![
                    target_file_id,
                    library_id,
                    target_page_id,
                    logical_path,
                    path_key,
                    mime_type,
                    byte_length,
                    actor_id,
                    now,
                ],
            )?;
            file_ids.insert(source_file_id, target_file_id);
        }
        manifest_revisions.insert(target_page_id.clone(), 1);
    }
    Ok(PageFileCopyClosure {
        manifest_revisions,
        file_ids,
    })
}

fn load_current_files(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<BTreeMap<String, CurrentFile>, StoreError> {
    connection
        .prepare(
            "SELECT file.file_id, file.logical_path, file.path_key, \
                    file.mime_type, file.byte_length, file.current_version, file.state, \
                    version.blob_hash, file.created_by_actor_id, file.created_by_turn_id, \
                    file.created_at \
             FROM page_files file \
             JOIN page_file_versions version \
               ON version.file_id = file.file_id AND version.version = file.current_version \
             WHERE file.library_id = ?1 AND file.owner_page_id = ?2",
        )?
        .query_map(params![library_id, page_id], current_file_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|file| Ok((file.file_id.clone(), file)))
        .collect()
}

fn load_live_file(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    file_id: &str,
) -> Result<CurrentFile, StoreError> {
    validate_id(page_id, "Source Page")?;
    validate_id(file_id, "Source Page File")?;
    connection
        .query_row(
            "SELECT file.file_id, file.logical_path, file.path_key, \
                    file.mime_type, file.byte_length, file.current_version, file.state, \
                    version.blob_hash, file.created_by_actor_id, file.created_by_turn_id, \
                    file.created_at \
             FROM page_files file \
             JOIN page_file_versions version \
               ON version.file_id = file.file_id AND version.version = file.current_version \
             WHERE file.library_id = ?1 AND file.owner_page_id = ?2 \
               AND file.file_id = ?3 AND file.state = 'live'",
            params![library_id, page_id, file_id],
            current_file_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("Source Page File is unavailable"))
}

fn load_restorable_version(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    file_id: &str,
    source_version: i64,
) -> Result<CurrentFile, StoreError> {
    if source_version < 1 {
        return Err(invalid("Source Page File version must be positive"));
    }
    connection
        .query_row(
            "SELECT version.file_id, version.logical_path, \
                    version.path_key, version.mime_type, version.byte_length, version.version, \
                    'live', version.blob_hash, version.actor_id, version.turn_id, \
                    version.occurred_at \
             FROM page_file_versions version \
             WHERE version.library_id = ?1 AND version.owner_page_id = ?2 \
               AND version.file_id = ?3 AND version.version = ?4 \
               AND version.change_kind <> 'delete' AND version.blob_hash IS NOT NULL",
            params![library_id, page_id, file_id, source_version],
            current_file_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("Restorable Page File version is unavailable"))
}

fn prepared_blob(
    connection: &Connection,
    store_epoch: &str,
    library_id: &str,
    project_id: &str,
    operation_id: &str,
    receipt_id: &str,
) -> Result<PreparedBlob, StoreError> {
    validate_id(receipt_id, "Prepared Blob receipt")?;
    connection
        .query_row(
            "SELECT receipt.receipt_id, receipt.content_hash, receipt.byte_length \
             FROM prepared_blob_receipts receipt \
             JOIN managed_blobs blob ON blob.content_hash = receipt.content_hash \
               AND blob.byte_length = receipt.byte_length \
             WHERE receipt.receipt_id = ?1 AND receipt.project_id = ?2 \
               AND receipt.library_id = ?3 AND receipt.store_epoch = ?4 \
               AND receipt.operation_id = ?5 AND receipt.state = 'prepared' \
               AND receipt.expires_at_unix_ms >= \
                 CAST(strftime('%s', 'now') AS INTEGER) * 1000",
            params![
                receipt_id,
                project_id,
                library_id,
                store_epoch,
                operation_id
            ],
            |row| {
                let byte_length = row.get::<_, i64>(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    byte_length,
                ))
            },
        )
        .optional()?
        .map(|(receipt_id, content_hash, byte_length)| {
            Ok::<PreparedBlob, StoreError>(PreparedBlob {
                receipt_id,
                content_hash,
                byte_length: u64::try_from(byte_length)
                    .map_err(|_| corrupt("Prepared Blob length is invalid"))?,
            })
        })
        .transpose()?
        .ok_or_else(|| not_found("Prepared Blob receipt is unavailable"))
}

fn validate_final_namespace(
    current_files: &BTreeMap<String, CurrentFile>,
    planned: &[DesiredFile],
) -> Result<(), StoreError> {
    let mut final_files = current_files
        .values()
        .map(|file| (file.file_id.clone(), (file.path_key.clone(), file.state)))
        .collect::<BTreeMap<_, _>>();
    for desired in planned {
        final_files.insert(
            desired.file_id.clone(),
            (desired.path_key.clone(), desired.state),
        );
    }
    let mut live_paths = BTreeMap::new();
    for (file_id, (path_key, state)) in final_files {
        if state == LibraryPageFileState::Deleted {
            continue;
        }
        if let Some(existing_file_id) = live_paths.insert(path_key, file_id.clone()) {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                format!(
                    "Page File path collides with another live File ({existing_file_id}, {file_id})"
                ),
                false,
            ));
        }
    }
    Ok(())
}

fn current_file<'a>(
    current_files: &'a BTreeMap<String, CurrentFile>,
    file_id: &str,
    expected_version: i64,
) -> Result<&'a CurrentFile, StoreError> {
    validate_id(file_id, "Page File")?;
    let current = current_files
        .get(file_id)
        .ok_or_else(|| not_found("Page File is unavailable"))?;
    if current.current_version != expected_version {
        return Err(revision_conflict("Page File version changed"));
    }
    Ok(current)
}

fn current_live_file<'a>(
    current_files: &'a BTreeMap<String, CurrentFile>,
    file_id: &str,
    expected_version: i64,
) -> Result<&'a CurrentFile, StoreError> {
    let current = current_file(current_files, file_id, expected_version)?;
    if current.state != LibraryPageFileState::Live || current.blob_hash.is_none() {
        return Err(not_found("Live Page File is unavailable"));
    }
    Ok(current)
}

fn desired_from_current(current: &CurrentFile, update: DesiredFileUpdate) -> DesiredFile {
    DesiredFile {
        file_id: current.file_id.clone(),
        logical_path: update.logical_path,
        path_key: update.path_key,
        mime_type: update.mime_type,
        byte_length: update.byte_length,
        version: current.current_version + 1,
        state: update.state,
        blob_hash: update.blob_hash,
        change_kind: update.change_kind,
        created_by_actor_id: current.created_by_actor_id.clone(),
        created_by_turn_id: current.created_by_turn_id.clone(),
        created_at: current.created_at.clone(),
        is_new: false,
    }
}

fn authorize_clone_source(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    source_page_id: &str,
) -> Result<(), StoreError> {
    validate_id(source_page_id, "Source Page")?;
    if let Some(project_id) = context.project_id.as_ref() {
        return require_page_read_access(connection, library_id, &project_id.0, source_page_id);
    }
    if trusted_root_adapter(&context.adapter) {
        return require_active_page(connection, library_id, source_page_id);
    }
    Err(unauthorized("Source Page File requires Page read access"))
}

fn require_active_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.type = 'page' AND block.lifecycle = 'active'",
            params![page_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    exists.ok_or_else(|| not_found("Page is unavailable"))
}

fn manifest_revision(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<i64, StoreError> {
    validate_id(page_id, "Page")?;
    connection
        .query_row(
            "SELECT manifest.revision FROM page_file_manifests manifest \
             JOIN pages page ON page.block_id = manifest.page_id \
               AND page.library_id = manifest.library_id \
             WHERE manifest.page_id = ?1 AND manifest.library_id = ?2",
            params![page_id, library_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page File manifest is unavailable"))
}

fn validate_new_file_id(connection: &Connection, file_id: &str) -> Result<(), StoreError> {
    validate_id(file_id, "Page File")?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM page_files WHERE file_id = ?1",
            [file_id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Page File identity already exists",
            false,
        ));
    }
    Ok(())
}

fn mark_changed_file(changed: &mut BTreeSet<String>, file_id: &str) -> Result<(), StoreError> {
    if !changed.insert(file_id.to_owned()) {
        return Err(invalid(
            "One Page File can only appear once in a mutation batch",
        ));
    }
    Ok(())
}

fn mark_consumed_receipt(
    receipts: &mut BTreeSet<String>,
    receipt_id: &str,
) -> Result<(), StoreError> {
    if !receipts.insert(receipt_id.to_owned()) {
        return Err(invalid(
            "One Prepared Blob receipt can only publish one Page File version",
        ));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{label} identity is invalid")));
    }
    Ok(())
}

fn validate_optional_id(value: Option<&str>, label: &str) -> Result<(), StoreError> {
    value.map_or(Ok(()), |value| validate_id(value, label))
}

fn validate_mime_type(value: &str) -> Result<String, StoreError> {
    if value.is_empty()
        || value.len() > MAX_MIME_TYPE_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
        || !value.contains('/')
    {
        return Err(invalid("Page File MIME type is invalid"));
    }
    Ok(value.to_ascii_lowercase())
}

fn read_limit(requested: Option<u32>) -> Result<usize, StoreError> {
    let limit = usize::try_from(requested.unwrap_or(DEFAULT_LIMIT as u32))
        .map_err(|_| invalid("Page File limit is invalid"))?;
    if limit == 0 || limit > MAX_LIMIT {
        return Err(invalid("Page File limit must be between 1 and 100"));
    }
    Ok(limit)
}

fn page_file_query_pattern(requested: Option<&str>) -> Result<Option<String>, StoreError> {
    let Some(query) = requested.map(str::trim).filter(|query| !query.is_empty()) else {
        return Ok(None);
    };
    if query.len() > MAX_PAGE_FILE_PATH_BYTES || query.chars().any(char::is_control) {
        return Err(invalid("Page File query is invalid"));
    }
    let escaped = query
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Ok(Some(format!("%{escaped}%")))
}

fn page_file_cursor_coordinate(
    coordinate: Option<&KeysetCoordinate>,
) -> Result<PageFileCursorCoordinate, StoreError> {
    let Some(coordinate) = coordinate else {
        return Ok(PageFileCursorCoordinate {
            section: None,
            path_key: None,
            file_id: None,
        });
    };
    let [
        KeysetValue::Integer { value: section },
        KeysetValue::Text { value: path_key },
    ] = coordinate.values.as_slice()
    else {
        return Err(invalid("Page File cursor coordinate is invalid"));
    };
    if !(0..=2).contains(section) {
        return Err(invalid("Page File cursor section is invalid"));
    }
    Ok(PageFileCursorCoordinate {
        section: Some(*section),
        path_key: Some(path_key.clone()),
        file_id: Some(coordinate.stable_id.clone()),
    })
}

fn page_file_section(file: &LibraryPageFileSummary) -> i64 {
    if file.state == LibraryPageFileState::Deleted {
        return 2;
    }
    match file.body_usage {
        LibraryPageFileBodyUsage::NotInBody => 0,
        LibraryPageFileBodyUsage::Placed { .. } => 1,
    }
}

fn integer_cursor_coordinate(
    coordinate: Option<&KeysetCoordinate>,
    file_id: &str,
) -> Result<Option<i64>, StoreError> {
    let Some(coordinate) = coordinate else {
        return Ok(None);
    };
    let [KeysetValue::Integer { value }] = coordinate.values.as_slice() else {
        return Err(invalid("Page File version cursor coordinate is invalid"));
    };
    if coordinate.stable_id != file_id || *value < 1 {
        return Err(invalid("Page File version cursor identity is invalid"));
    }
    Ok(Some(*value))
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryPageFileSummary> {
    let byte_length = row.get::<_, i64>(4)?;
    let state = state_from_name(&row.get::<_, String>(6)?)?;
    let blob_etag = row.get::<_, Option<String>>(7)?.unwrap_or_default();
    let placement_count = row.get::<_, i64>(13)?;
    let body_usage = if placement_count == 0 {
        LibraryPageFileBodyUsage::NotInBody
    } else {
        LibraryPageFileBodyUsage::Placed {
            placement_count: u64::try_from(placement_count)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(13, placement_count))?,
        }
    };
    Ok(LibraryPageFileSummary {
        file_id: row.get(0)?,
        owner_page_id: row.get(1)?,
        logical_path: row.get(2)?,
        mime_type: row.get(3)?,
        byte_length: u64::try_from(byte_length)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(4, byte_length))?,
        version: row.get(5)?,
        blob_etag,
        state,
        created_by_actor_id: row.get(8)?,
        created_by_turn_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        body_usage,
    })
}

fn body_usage_revision(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT body_usage_revision FROM page_file_manifests \
             WHERE library_id = ?1 AND page_id = ?2",
            params![library_id, page_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page File body usage is unavailable"))
}

fn current_file_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CurrentFile> {
    let byte_length = row.get::<_, i64>(4)?;
    Ok(CurrentFile {
        file_id: row.get(0)?,
        logical_path: row.get(1)?,
        path_key: row.get(2)?,
        mime_type: row.get(3)?,
        byte_length: u64::try_from(byte_length)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(4, byte_length))?,
        current_version: row.get(5)?,
        state: state_from_name(&row.get::<_, String>(6)?)?,
        blob_hash: row.get(7)?,
        created_by_actor_id: row.get(8)?,
        created_by_turn_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn version_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryPageFileVersion> {
    let byte_length = row.get::<_, i64>(7)?;
    Ok(LibraryPageFileVersion {
        file_id: row.get(0)?,
        version: row.get(1)?,
        owner_page_id: row.get(2)?,
        manifest_revision: row.get(3)?,
        change_kind: change_kind_from_name(&row.get::<_, String>(4)?)?,
        logical_path: row.get(5)?,
        mime_type: row.get(6)?,
        byte_length: u64::try_from(byte_length)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(7, byte_length))?,
        blob_etag: row.get(8)?,
        actor_id: row.get(9)?,
        turn_id: row.get(10)?,
        operation_id: row.get(11)?,
        occurred_at: row.get(12)?,
    })
}

fn state_name(state: LibraryPageFileState) -> &'static str {
    match state {
        LibraryPageFileState::Live => "live",
        LibraryPageFileState::Deleted => "deleted",
    }
}

fn state_from_name(value: &str) -> rusqlite::Result<LibraryPageFileState> {
    match value {
        "live" => Ok(LibraryPageFileState::Live),
        "deleted" => Ok(LibraryPageFileState::Deleted),
        _ => Err(rusqlite::Error::InvalidColumnType(
            0,
            "state".to_owned(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn change_kind_name(kind: LibraryPageFileChangeKind) -> &'static str {
    match kind {
        LibraryPageFileChangeKind::Create => "create",
        LibraryPageFileChangeKind::Replace => "replace",
        LibraryPageFileChangeKind::Rename => "rename",
        LibraryPageFileChangeKind::Delete => "delete",
        LibraryPageFileChangeKind::Restore => "restore",
        LibraryPageFileChangeKind::Clone => "clone",
        LibraryPageFileChangeKind::Rehome => "rehome",
    }
}

fn change_kind_from_name(value: &str) -> rusqlite::Result<LibraryPageFileChangeKind> {
    match value {
        "create" => Ok(LibraryPageFileChangeKind::Create),
        "replace" => Ok(LibraryPageFileChangeKind::Replace),
        "rename" => Ok(LibraryPageFileChangeKind::Rename),
        "delete" => Ok(LibraryPageFileChangeKind::Delete),
        "restore" => Ok(LibraryPageFileChangeKind::Restore),
        "clone" => Ok(LibraryPageFileChangeKind::Clone),
        "rehome" => Ok(LibraryPageFileChangeKind::Rehome),
        _ => Err(rusqlite::Error::InvalidColumnType(
            0,
            "change_kind".to_owned(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn trusted_root_adapter(adapter: &AdapterKind) -> bool {
    matches!(
        adapter,
        AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn revision_conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryBlockTransferDocumentHead,
        LibraryBlockTransferLogicalIntent, LibraryBlockTransferMode, LibraryBlockTransferSource,
        LibraryBlockTransferTarget, LibraryDocumentHead, LibraryIntent, LibraryPagePromotionPolicy,
        LibraryRead, LibraryReadValue, LibraryStructuralDeleteDirection,
        LibraryStructuralDeleteReason, LibraryStructuralEditCommand, LibraryStructuralReplacement,
        LibraryStructuralReplacementBlock, LibraryStructuralSelection, LibraryStructuralTarget,
        LibraryWriteParent,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, DeliveryAtomPayload, LibraryId, ModuleApplyRequest,
        ModuleReadRequest, ProfileId, ProjectId, ResourceKey, StoreEpoch,
        document::PageFileReferenceChange,
    };
    use rusqlite::params;
    use tempfile::tempdir;

    use super::*;
    use crate::infrastructure::event_log::CoreEventLog;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    const NOW: &str = "2026-08-28T00:00:00.000Z";

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:page-files".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn seeded_library() -> (
        tempfile::TempDir,
        SqliteStoreKernel,
        super::super::LibraryModule,
    ) {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Page Files', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed Library");
        let module = super::super::LibraryModule::new("profile-1", "library-1", &kernel);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page-1".to_owned(),
                        document_id: "document-1".to_owned(),
                        title: "Files".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Page");
        (directory, kernel, module)
    }

    fn seed_receipt(kernel: &SqliteStoreKernel, operation_id: &str, receipt_id: &str, fill: char) {
        let hash = fill.to_string().repeat(64);
        let operation_id = operation_id.to_owned();
        let receipt_id = receipt_id.to_owned();
        kernel
            .writer()
            .call(move |connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO managed_blobs( \
                           content_hash, physical_asset_name, byte_length, created_at \
                         ) VALUES (?1, ?1, 4, ?2)",
                        params![hash, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO prepared_blob_receipts( \
                           receipt_id, project_id, library_id, store_epoch, content_hash, \
                           byte_length, state, operation_id, expires_at_unix_ms, \
                           consumed_commit_seq, created_at, updated_at \
                         ) VALUES (?1, 'project-1', 'library-1', 'epoch-1', ?2, 4, \
                           'prepared', ?3, 4102444800000, NULL, ?4, ?4)",
                        params![receipt_id, hash, operation_id, NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed prepared Blob receipt");
    }

    fn create_page(
        module: &super::super::LibraryModule,
        operation_id: &str,
        page_id: &str,
        document_id: &str,
    ) {
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: page_id.to_owned(),
                        document_id: document_id.to_owned(),
                        title: page_id.to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Page");
    }

    fn apply_request(
        operation_id: &str,
        expected_manifest_revision: i64,
        changes: Vec<LibraryPageFileChange>,
    ) -> ModuleApplyRequest<LibraryIntent> {
        apply_request_for("page-1", operation_id, expected_manifest_revision, changes)
    }

    fn apply_request_for(
        page_id: &str,
        operation_id: &str,
        expected_manifest_revision: i64,
        changes: Vec<LibraryPageFileChange>,
    ) -> ModuleApplyRequest<LibraryIntent> {
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::ApplyPageFileChanges {
                page_id: page_id.to_owned(),
                expected_manifest_revision,
                changes,
                turn_id: Some("turn-1".to_owned()),
            },
        }
    }

    fn manifest(
        module: &super::super::LibraryModule,
        include_deleted: bool,
    ) -> LibraryPageFileManifest {
        manifest_for(module, "page-1", include_deleted)
    }

    fn manifest_for(
        module: &super::super::LibraryModule,
        page_id: &str,
        include_deleted: bool,
    ) -> LibraryPageFileManifest {
        let read = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFiles {
                        page_id: page_id.to_owned(),
                        query: None,
                        cursor: None,
                        limit: Some(100),
                        include_deleted: Some(include_deleted),
                    },
                },
            )
            .expect("read Page Files");
        let LibraryReadValue::PageFiles { value } = read.value else {
            panic!("Page Files value");
        };
        *value
    }

    #[test]
    fn exclusive_structural_move_transfers_page_file_ownership() {
        let (_directory, kernel, module) = seeded_library();
        create_page(
            &module,
            "operation:create-target-page",
            "page-2",
            "document-2",
        );
        seed_receipt(&kernel, "operation:create-file", "receipt-a", 'a');
        seed_receipt(
            &kernel,
            "operation:create-target-collision",
            "receipt-target",
            'b',
        );
        module
            .apply(
                &context(),
                apply_request(
                    "operation:create-file",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-a".to_owned(),
                        logical_path: "image.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "receipt-a".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create File");
        module
            .apply(
                &context(),
                apply_request_for(
                    "page-2",
                    "operation:create-target-collision",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-target".to_owned(),
                        logical_path: "image.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "receipt-target".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create target namespace collision");

        let (source_placeholder, source_head) = kernel
            .readers()
            .read_default(|connection| {
                let placeholder = connection.query_row(
                    "SELECT block_id FROM document_block_index \
                     WHERE document_id = 'document-1' ORDER BY ordinal LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                let head = connection.query_row(
                    "SELECT generation, head_seq FROM documents WHERE id = 'document-1'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                Ok((placeholder, head))
            })
            .expect("source Page authority");
        let inserted = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:place-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![source_placeholder],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![
                                    LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([{
                                            "type": "text",
                                            "text": "Promote this",
                                            "styles": {},
                                        }])),
                                        children: vec![LibraryStructuralReplacementBlock {
                                            block_type: "image".to_owned(),
                                            props: BTreeMap::from([
                                                (
                                                    "url".to_owned(),
                                                    serde_json::json!("nodex://files/file-a"),
                                                ),
                                                ("name".to_owned(), serde_json::json!("image.png")),
                                                ("caption".to_owned(), serde_json::json!("")),
                                            ]),
                                            content: None,
                                            children: Vec::new(),
                                        }],
                                    },
                                    LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([])),
                                        children: Vec::new(),
                                    },
                                ],
                            },
                        }),
                    },
                },
            )
            .expect("place File in source Page");
        let image_block_id = inserted
            .committed
            .value
            .structural_edit
            .expect("placement result")
            .result_root_block_ids[0]
            .clone();
        let (source_head, target_head) = kernel
            .readers()
            .read_default(|connection| {
                let read_head = |document_id: &str| {
                    connection.query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [document_id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                };
                Ok((read_head("document-1")?, read_head("document-2")?))
            })
            .expect("move heads");

        let moved = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-file-placement".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::MoveSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![image_block_id.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTarget {
                                target_document_id: "document-2".to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: LibraryDocumentHead {
                                    document_id: "document-2".to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("move File placement");

        let move_result = moved
            .committed
            .value
            .structural_edit
            .as_ref()
            .expect("move result");
        assert_eq!(move_result.file_ownership_moves.len(), 1);
        assert_eq!(move_result.file_ownership_moves[0].file_id, "file-a");
        assert_eq!(
            move_result.file_ownership_moves[0].previous_owner_page_id,
            "page-1"
        );
        assert_eq!(move_result.file_ownership_moves[0].owner_page_id, "page-2");
        assert_eq!(
            move_result.file_ownership_moves[0].logical_path,
            "image (2).png"
        );
        assert_eq!(
            moved.committed.receipt.committed_revisions["pageFiles:page-1"],
            2
        );
        assert_eq!(
            moved.committed.receipt.committed_revisions["pageFiles:page-2"],
            2
        );
        assert_eq!(
            moved.committed.receipt.committed_revisions["pageFileContent:page-1"],
            moved.committed.receipt.commit_seq
        );
        assert_eq!(
            moved.committed.receipt.committed_revisions["pageFileContent:page-2"],
            moved.committed.receipt.commit_seq
        );

        let delivery = CoreEventLog::new(kernel.readers())
            .authorized_packet(
                moved.committed.receipt.commit_seq,
                &BoundModuleContext {
                    project_id: None,
                    connection_id: "connection:page-files-root".to_owned(),
                    ..context()
                },
                None,
                true,
            )
            .expect("resolve ownership move delivery")
            .expect("ownership move delivery packet");
        assert_eq!(delivery.document_effects.len(), 2);
        let page_file_atoms = delivery
            .atoms
            .iter()
            .filter_map(|atom| {
                let DeliveryAtomPayload::Library { event, .. } = &atom.payload else {
                    return None;
                };
                (!event.page_file_manifest_invalidations.is_empty()).then_some((atom, event))
            })
            .collect::<Vec<_>>();
        assert_eq!(page_file_atoms.len(), 2);
        for (page_id, manifest_revision) in [("page-1", 2), ("page-2", 2)] {
            let (atom, event) = page_file_atoms
                .iter()
                .find(|(_, event)| event.page_file_manifest_invalidations.contains_key(page_id))
                .expect("Page File manifest delivery atom");
            assert_eq!(
                event.page_file_manifest_invalidations.get(page_id),
                Some(&LibraryPageFileInvalidation::Exact {
                    revision: manifest_revision,
                    file_ids: vec!["file-a".to_owned()],
                })
            );
            assert_eq!(
                event.page_file_content_invalidations.get(page_id),
                Some(&LibraryPageFileInvalidation::Exact {
                    revision: moved.committed.receipt.commit_seq,
                    file_ids: vec!["file-a".to_owned()],
                })
            );
            assert!(
                atom.descriptor
                    .required_resources
                    .contains(&ResourceKey::Page {
                        page_id: page_id.to_owned(),
                    })
            );
        }
        let reference_changes = delivery
            .atoms
            .iter()
            .filter_map(|atom| {
                let DeliveryAtomPayload::OwnedDocument { event, .. } = &atom.payload else {
                    return None;
                };
                let nodex_core_contracts::AuthorizedOwnedDocumentEvent::PageFileReferencesChanged {
                    document_id,
                    change,
                    ..
                } = event
                else {
                    return None;
                };
                Some((document_id.clone(), change.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            reference_changes,
            BTreeMap::from([
                (
                    "document-1".to_owned(),
                    PageFileReferenceChange::Exact {
                        added_file_ids: Vec::new(),
                        removed_file_ids: vec!["file-a".to_owned()],
                    },
                ),
                (
                    "document-2".to_owned(),
                    PageFileReferenceChange::Exact {
                        added_file_ids: vec!["file-a".to_owned()],
                        removed_file_ids: Vec::new(),
                    },
                ),
            ])
        );

        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Unrelated', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed unrelated Project");
        let unauthorized = CoreEventLog::new(kernel.readers())
            .authorized_packet(
                moved.committed.receipt.commit_seq,
                &BoundModuleContext {
                    project_id: Some(ProjectId("project-2".to_owned())),
                    connection_id: "connection:unrelated".to_owned(),
                    ..context()
                },
                None,
                true,
            )
            .expect("resolve unrelated delivery");
        assert!(unauthorized.is_none());

        assert!(manifest_for(&module, "page-1", false).files.is_empty());
        let target = manifest_for(&module, "page-2", false);
        assert_eq!(target.files.len(), 2);
        let moved_file = target
            .files
            .iter()
            .find(|file| file.file_id == "file-a")
            .expect("moved File");
        assert_eq!(moved_file.owner_page_id, "page-2");
        assert_eq!(moved_file.logical_path, "image (2).png");
        assert_eq!(moved_file.version, 2);

        let undone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:undo-move-file-placement".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: move_result.history.clone().expect("move history"),
                    },
                },
            )
            .expect("undo File placement move");
        let undo_result = undone.committed.value.structural_edit.expect("Undo result");
        assert_eq!(undo_result.file_ownership_moves.len(), 1);
        assert_eq!(
            undo_result.file_ownership_moves[0].previous_owner_page_id,
            "page-2"
        );
        assert_eq!(undo_result.file_ownership_moves[0].owner_page_id, "page-1");
        let source = manifest_for(&module, "page-1", false);
        assert_eq!(source.files[0].file_id, "file-a");
        assert_eq!(source.files[0].owner_page_id, "page-1");
        assert_eq!(source.files[0].logical_path, "image (2).png");
        assert_eq!(source.files[0].version, 3);
        assert_eq!(manifest_for(&module, "page-2", false).files.len(), 1);

        let read_head = |document_id: &str| {
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT generation, head_seq FROM documents WHERE id = ?1",
                            [document_id],
                            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                        )
                        .map_err(Into::into)
                })
                .expect("Document head")
        };
        let source_head = read_head("document-1");
        let captured = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:capture-file-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::CaptureClipboard {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![image_block_id.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("capture File placement for cut");
        let clipboard = captured
            .committed
            .value
            .structural_edit
            .expect("capture result")
            .clipboard
            .expect("clipboard token");
        let cut_head = read_head("document-1");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:cut-file-placement".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![image_block_id.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: cut_head.0,
                                    head_seq: cut_head.1,
                                },
                            },
                            reason: LibraryStructuralDeleteReason::Cut {
                                bundle: clipboard.clone(),
                            },
                            direction: LibraryStructuralDeleteDirection::Backward,
                        }),
                    },
                },
            )
            .expect("cut File placement");
        assert_eq!(manifest_for(&module, "page-1", false).files[0].version, 3);
        let target_head = read_head("document-2");
        let pasted = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:paste-cut-file-placement".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::PasteClipboard {
                            bundle: clipboard,
                            target: LibraryStructuralTarget {
                                target_document_id: "document-2".to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: LibraryDocumentHead {
                                    document_id: "document-2".to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("paste cut File placement");
        let paste_result = pasted
            .committed
            .value
            .structural_edit
            .expect("paste result");
        assert_eq!(paste_result.file_ownership_moves.len(), 1);
        assert_eq!(paste_result.file_ownership_moves[0].owner_page_id, "page-2");
        let target = manifest_for(&module, "page-2", false);
        assert_eq!(target.files.len(), 2);
        assert_eq!(
            target
                .files
                .iter()
                .find(|file| file.file_id == "file-a")
                .expect("cut-moved File")
                .version,
            4
        );

        create_page(
            &module,
            "operation:create-third-page",
            "page-3",
            "document-3",
        );
        let (third_placeholder, third_head) = kernel
            .readers()
            .read_default(|connection| {
                let placeholder = connection.query_row(
                    "SELECT block_id FROM document_block_index \
                     WHERE document_id = 'document-3' ORDER BY ordinal LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                let head = connection.query_row(
                    "SELECT generation, head_seq FROM documents WHERE id = 'document-3'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                Ok((placeholder, head))
            })
            .expect("third Page authority");
        let third_placement = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:place-third-file-reference".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-3".to_owned(),
                                root_block_ids: vec![third_placeholder],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-3".to_owned(),
                                    generation: third_head.0,
                                    head_seq: third_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![LibraryStructuralReplacementBlock {
                                    block_type: "image".to_owned(),
                                    props: BTreeMap::from([
                                        (
                                            "url".to_owned(),
                                            serde_json::json!("nodex://files/file-a"),
                                        ),
                                        ("name".to_owned(), serde_json::json!("image (2).png")),
                                        ("caption".to_owned(), serde_json::json!("")),
                                    ]),
                                    content: None,
                                    children: Vec::new(),
                                }],
                            },
                        }),
                    },
                },
            )
            .expect("place third-Page File reference");
        let third_image_block_id = third_placement
            .committed
            .value
            .structural_edit
            .expect("third placement result")
            .result_root_block_ids[0]
            .clone();
        let source_head = read_head("document-2");
        let target_head = read_head("document-1");
        let ambiguous_move = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-with-third-placement".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::MoveSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-2".to_owned(),
                                root_block_ids: vec![image_block_id.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-2".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTarget {
                                target_document_id: "document-1".to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("move File placement with third placement");
        assert!(
            ambiguous_move
                .committed
                .value
                .structural_edit
                .expect("ambiguous move result")
                .file_ownership_moves
                .is_empty()
        );
        let owner_manifest = manifest_for(&module, "page-2", false);
        let stable_file = owner_manifest
            .files
            .iter()
            .find(|file| file.file_id == "file-a")
            .expect("stable owner File");
        assert_eq!(stable_file.owner_page_id, "page-2");
        assert_eq!(stable_file.version, 4);

        let third_head = read_head("document-3");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:remove-third-file-reference".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-3".to_owned(),
                                root_block_ids: vec![third_image_block_id],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-3".to_owned(),
                                    generation: third_head.0,
                                    head_seq: third_head.1,
                                },
                            },
                            reason: LibraryStructuralDeleteReason::Delete,
                            direction: LibraryStructuralDeleteDirection::Backward,
                        }),
                    },
                },
            )
            .expect("remove third-Page File reference");
        let source_head = read_head("document-1");
        let target_head = read_head("document-3");
        let foreign_move = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-foreign-file-placement".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::MoveSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![image_block_id],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTarget {
                                target_document_id: "document-3".to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: LibraryDocumentHead {
                                    document_id: "document-3".to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("move foreign File placement");
        assert!(
            foreign_move
                .committed
                .value
                .structural_edit
                .expect("foreign move result")
                .file_ownership_moves
                .is_empty()
        );
        let stable_file = manifest_for(&module, "page-2", false)
            .files
            .into_iter()
            .find(|file| file.file_id == "file-a")
            .expect("foreign placement owner File");
        assert_eq!(stable_file.owner_page_id, "page-2");
        assert_eq!(stable_file.version, 4);
    }

    #[test]
    fn clipboard_replacement_rehomes_an_exclusively_moved_page_file() {
        let (_directory, kernel, module) = seeded_library();
        create_page(
            &module,
            "operation:create-replacement-target",
            "page-2",
            "document-2",
        );
        seed_receipt(
            &kernel,
            "operation:create-replacement-file",
            "receipt-replacement",
            'c',
        );
        module
            .apply(
                &context(),
                apply_request(
                    "operation:create-replacement-file",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-replacement".to_owned(),
                        logical_path: "replacement.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "receipt-replacement".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create replacement File");

        let document_state = |document_id: &str| {
            kernel
                .readers()
                .read_default(|connection| {
                    let root = connection.query_row(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = ?1 AND parent_block_id IS NULL ORDER BY ordinal LIMIT 1",
                        [document_id],
                        |row| row.get::<_, String>(0),
                    )?;
                    let head = connection.query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [document_id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )?;
                    Ok((root, head))
                })
                .expect("Document state")
        };
        let (source_placeholder, source_head) = document_state("document-1");
        let placed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:place-replacement-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![source_placeholder],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![LibraryStructuralReplacementBlock {
                                    block_type: "image".to_owned(),
                                    props: BTreeMap::from([
                                        (
                                            "url".to_owned(),
                                            serde_json::json!("nodex://files/file-replacement"),
                                        ),
                                        ("name".to_owned(), serde_json::json!("replacement.png")),
                                        ("caption".to_owned(), serde_json::json!("")),
                                    ]),
                                    content: None,
                                    children: Vec::new(),
                                }],
                            },
                        }),
                    },
                },
            )
            .expect("place replacement File");
        let image_block_id = placed
            .committed
            .value
            .structural_edit
            .expect("placement result")
            .result_root_block_ids[0]
            .clone();

        let (_, source_head) = document_state("document-1");
        let captured = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:capture-replacement-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::CaptureClipboard {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![image_block_id.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("capture replacement cut");
        let clipboard = captured
            .committed
            .value
            .structural_edit
            .expect("capture result")
            .clipboard
            .expect("clipboard token");
        let (_, cut_head) = document_state("document-1");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:delete-replacement-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![image_block_id.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: cut_head.0,
                                    head_seq: cut_head.1,
                                },
                            },
                            reason: LibraryStructuralDeleteReason::Cut {
                                bundle: clipboard.clone(),
                            },
                            direction: LibraryStructuralDeleteDirection::Backward,
                        }),
                    },
                },
            )
            .expect("delete replacement cut");

        let (target_placeholder, target_head) = document_state("document-2");
        let replaced = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:paste-replacement-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-2".to_owned(),
                                root_block_ids: vec![target_placeholder.clone()],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-2".to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Clipboard {
                                bundle: clipboard,
                            },
                        }),
                    },
                },
            )
            .expect("replace target from cut clipboard");
        assert_eq!(
            replaced.committed.receipt.committed_revisions["pageFileContent:page-1"],
            replaced.committed.receipt.commit_seq
        );
        assert_eq!(
            replaced.committed.receipt.committed_revisions["pageFileContent:page-2"],
            replaced.committed.receipt.commit_seq
        );
        let result = replaced
            .committed
            .value
            .structural_edit
            .expect("replacement result");
        assert_eq!(result.result_root_block_ids, [image_block_id.as_str()]);
        assert_eq!(result.file_ownership_moves.len(), 1);
        assert_eq!(result.file_ownership_moves[0].file_id, "file-replacement");
        assert_eq!(
            result.file_ownership_moves[0].previous_owner_page_id,
            "page-1"
        );
        assert_eq!(result.file_ownership_moves[0].owner_page_id, "page-2");
        assert!(manifest_for(&module, "page-1", false).files.is_empty());
        let target = manifest_for(&module, "page-2", false);
        assert_eq!(target.files.len(), 1);
        assert_eq!(target.files[0].file_id, "file-replacement");

        let undone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:undo-replacement-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: result.history.expect("replacement history"),
                    },
                },
            )
            .expect("undo replacement cut");
        let undo_result = undone
            .committed
            .value
            .structural_edit
            .expect("replacement Undo result");
        assert_eq!(undo_result.file_ownership_moves.len(), 1);
        assert_eq!(document_state("document-1").0, image_block_id);
        assert_eq!(document_state("document-2").0, target_placeholder);
        assert_eq!(manifest_for(&module, "page-1", false).files.len(), 1);
        assert!(manifest_for(&module, "page-2", false).files.is_empty());

        let redone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:redo-replacement-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: undo_result.history.expect("replacement Redo history"),
                    },
                },
            )
            .expect("redo replacement cut");
        let redo_result = redone
            .committed
            .value
            .structural_edit
            .expect("replacement Redo result");
        assert_eq!(redo_result.file_ownership_moves.len(), 1);
        assert_eq!(document_state("document-2").0, image_block_id);
        assert!(manifest_for(&module, "page-1", false).files.is_empty());
        assert_eq!(manifest_for(&module, "page-2", false).files.len(), 1);
    }

    #[test]
    fn block_promotion_and_undo_move_exclusive_page_file_ownership() {
        let (_directory, kernel, module) = seeded_library();
        seed_receipt(&kernel, "operation:create-file", "receipt-a", 'a');
        module
            .apply(
                &context(),
                apply_request(
                    "operation:create-file",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-a".to_owned(),
                        logical_path: "image.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "receipt-a".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create File");
        let (placeholder, source_head) = kernel
            .readers()
            .read_default(|connection| {
                let placeholder = connection.query_row(
                    "SELECT block_id FROM document_block_index \
                     WHERE document_id = 'document-1' ORDER BY ordinal LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                let head = connection.query_row(
                    "SELECT generation, head_seq FROM documents WHERE id = 'document-1'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                Ok((placeholder, head))
            })
            .expect("source Page authority");
        let placed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:place-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: "document-1".to_owned(),
                                root_block_ids: vec![placeholder],
                                source_head: LibraryDocumentHead {
                                    document_id: "document-1".to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![
                                    LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([{
                                            "type": "text",
                                            "text": "Promote this",
                                            "styles": {},
                                        }])),
                                        children: vec![LibraryStructuralReplacementBlock {
                                            block_type: "image".to_owned(),
                                            props: BTreeMap::from([
                                                (
                                                    "url".to_owned(),
                                                    serde_json::json!("nodex://files/file-a"),
                                                ),
                                                ("name".to_owned(), serde_json::json!("image.png")),
                                                ("caption".to_owned(), serde_json::json!("")),
                                            ]),
                                            content: None,
                                            children: Vec::new(),
                                        }],
                                    },
                                    LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([])),
                                        children: Vec::new(),
                                    },
                                ],
                            },
                        }),
                    },
                },
            )
            .expect("place File");
        let promotion_root_id = placed
            .committed
            .value
            .structural_edit
            .expect("placement result")
            .result_root_block_ids[0]
            .clone();
        let source_head = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = 'document-1'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(Into::into)
            })
            .expect("source head");
        let promoted = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:promote-image".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::TransferBlocks {
                        intent: LibraryBlockTransferLogicalIntent {
                            actor: serde_json::json!({ "kind": "test" }),
                            mode: LibraryBlockTransferMode::Move,
                            root_block_ids: vec![promotion_root_id],
                            causal_dependencies: vec![LibraryBlockTransferDocumentHead {
                                document_id: "document-1".to_owned(),
                                generation: source_head.0,
                                expected_head_seq: source_head.1,
                            }],
                            source: LibraryBlockTransferSource::Document {
                                document_id: "document-1".to_owned(),
                            },
                            target: LibraryBlockTransferTarget::Library {
                                library_id: "library-1".to_owned(),
                                before_block_id: None,
                            },
                            promotion_policy: LibraryPagePromotionPolicy::Literal,
                        },
                    },
                },
            )
            .expect("promote image Block");
        let result = promoted
            .committed
            .value
            .block_transfer
            .expect("promotion result");
        let promoted_page_id = result.result_root_block_ids[0].clone();
        assert_eq!(result.file_ownership_moves.len(), 1);
        assert_eq!(
            result.file_ownership_moves[0].owner_page_id,
            promoted_page_id
        );
        assert!(manifest_for(&module, "page-1", false).files.is_empty());
        assert_eq!(
            manifest_for(&module, &promoted_page_id, false).files[0].file_id,
            "file-a"
        );

        let undone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:undo-promote-image".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::UndoBlockTransfer {
                        token: result.undo_token.expect("promotion Undo token"),
                    },
                },
            )
            .expect("undo image promotion");
        let undo = undone
            .committed
            .value
            .block_transfer_undo
            .expect("Undo result");
        assert_eq!(undo.file_ownership_moves.len(), 1);
        assert_eq!(undo.file_ownership_moves[0].owner_page_id, "page-1");
        assert_eq!(manifest_for(&module, "page-1", false).files[0].version, 3);
        assert_eq!(
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT count(*) FROM pages WHERE block_id = ?1",
                            [&promoted_page_id],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(Into::into)
                })
                .expect("promoted Page count"),
            0
        );
    }

    #[test]
    fn manifest_batch_supports_path_swaps_cas_and_idempotent_replay() {
        let (_directory, kernel, module) = seeded_library();
        seed_receipt(&kernel, "operation:create-files", "receipt-a", 'a');
        seed_receipt(&kernel, "operation:create-files", "receipt-b", 'b');
        let create = apply_request(
            "operation:create-files",
            0,
            vec![
                LibraryPageFileChange::Create {
                    file_id: "file-a".to_owned(),
                    logical_path: "references/a.md".to_owned(),
                    mime_type: "text/markdown".to_owned(),
                    prepared_blob_receipt_id: "receipt-a".to_owned(),
                    collision_policy: LibraryPageFileCollisionPolicy::Reject,
                },
                LibraryPageFileChange::Create {
                    file_id: "file-b".to_owned(),
                    logical_path: "references/b.md".to_owned(),
                    mime_type: "text/markdown".to_owned(),
                    prepared_blob_receipt_id: "receipt-b".to_owned(),
                    collision_policy: LibraryPageFileCollisionPolicy::Reject,
                },
            ],
        );
        let created = module
            .apply(&context(), create.clone())
            .expect("create Files");
        assert_eq!(
            created
                .committed
                .value
                .page_files
                .as_ref()
                .unwrap()
                .manifest_revision,
            1
        );

        let replay = module
            .apply(&context(), create)
            .expect("replay create Files");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(manifest(&module, false).revision, 1);

        let swapped = module
            .apply(
                &context(),
                apply_request(
                    "operation:swap-files",
                    1,
                    vec![
                        LibraryPageFileChange::Rename {
                            file_id: "file-a".to_owned(),
                            expected_version: 1,
                            logical_path: "references/b.md".to_owned(),
                        },
                        LibraryPageFileChange::Rename {
                            file_id: "file-b".to_owned(),
                            expected_version: 1,
                            logical_path: "references/a.md".to_owned(),
                        },
                    ],
                ),
            )
            .expect("swap final namespace");
        assert_eq!(
            swapped
                .committed
                .value
                .page_files
                .as_ref()
                .unwrap()
                .manifest_revision,
            2
        );
        let paths = manifest(&module, false)
            .files
            .into_iter()
            .map(|file| (file.file_id, file.logical_path))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(paths["file-a"], "references/b.md");
        assert_eq!(paths["file-b"], "references/a.md");

        let stale = module
            .apply(
                &context(),
                apply_request(
                    "operation:stale-rename",
                    1,
                    vec![LibraryPageFileChange::Rename {
                        file_id: "file-a".to_owned(),
                        expected_version: 2,
                        logical_path: "stale.md".to_owned(),
                    }],
                ),
            )
            .expect_err("stale manifest must fail");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );
        assert_eq!(manifest(&module, false).revision, 2);
    }

    #[test]
    fn core_allocates_suffixes_and_filters_the_bounded_inventory() {
        let (_directory, kernel, module) = seeded_library();
        seed_receipt(&kernel, "operation:suffix-files", "receipt-a", 'a');
        seed_receipt(&kernel, "operation:suffix-files", "receipt-b", 'b');
        module
            .apply(
                &context(),
                apply_request(
                    "operation:suffix-files",
                    0,
                    vec![
                        LibraryPageFileChange::Create {
                            file_id: "file-a".to_owned(),
                            logical_path: "references/brief.md".to_owned(),
                            mime_type: "text/markdown".to_owned(),
                            prepared_blob_receipt_id: "receipt-a".to_owned(),
                            collision_policy: LibraryPageFileCollisionPolicy::Suffix,
                        },
                        LibraryPageFileChange::Create {
                            file_id: "file-b".to_owned(),
                            logical_path: "references/BRIEF.md".to_owned(),
                            mime_type: "text/markdown".to_owned(),
                            prepared_blob_receipt_id: "receipt-b".to_owned(),
                            collision_policy: LibraryPageFileCollisionPolicy::Suffix,
                        },
                    ],
                ),
            )
            .expect("create collision-safe Files");

        let read = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFiles {
                        page_id: "page-1".to_owned(),
                        query: Some("(2)".to_owned()),
                        cursor: None,
                        limit: Some(1),
                        include_deleted: Some(true),
                    },
                },
            )
            .expect("filter Page Files");
        let LibraryReadValue::PageFiles { value } = read.value else {
            panic!("Page Files value");
        };
        assert_eq!(value.files[0].logical_path, "references/BRIEF (2).md");
        assert_eq!(value.total, 1);
        assert_eq!(value.live_total, 1);
        assert_eq!(value.unplaced_total, 1);
        assert_eq!(value.placed_total, 0);
    }

    #[test]
    fn semantic_put_replays_exactly_and_preserves_file_identity() {
        let (_directory, kernel, module) = seeded_library();
        seed_receipt(&kernel, "operation:put-a", "receipt-a", 'a');
        let create = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "operation:put-a".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::PutPageFile {
                page_id: "page-1".to_owned(),
                file_id: "file-a".to_owned(),
                logical_path: "brief.md".to_owned(),
                mime_type: "text/markdown".to_owned(),
                prepared_blob_receipt_id: "receipt-a".to_owned(),
                turn_id: Some("turn-a".to_owned()),
            },
        };
        let created = module
            .apply(&context(), create.clone())
            .expect("put new File");
        assert_eq!(
            created
                .committed
                .value
                .page_files
                .as_ref()
                .expect("Page File receipt")
                .created_file_ids,
            ["file-a"]
        );

        let replayed = module.apply(&context(), create).expect("replay put");
        assert!(replayed.committed.receipt.mutation.duplicate);
        assert_eq!(manifest(&module, false).revision, 1);

        seed_receipt(&kernel, "operation:put-b", "receipt-b", 'b');
        let replaced = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:put-b".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::PutPageFile {
                        page_id: "page-1".to_owned(),
                        file_id: "file-b-unused".to_owned(),
                        logical_path: "BRIEF.md".to_owned(),
                        mime_type: "text/plain".to_owned(),
                        prepared_blob_receipt_id: "receipt-b".to_owned(),
                        turn_id: None,
                    },
                },
            )
            .expect("put existing path");
        assert_eq!(
            replaced
                .committed
                .value
                .page_files
                .as_ref()
                .expect("Page File receipt")
                .updated_file_ids,
            ["file-a"]
        );
        let file = &manifest(&module, false).files[0];
        assert_eq!(file.file_id, "file-a");
        assert_eq!(file.version, 2);
        assert_eq!(file.mime_type, "text/plain");
    }

    #[test]
    fn agent_manifest_reads_every_live_and_deleted_file() {
        let (_directory, kernel, _module) = seeded_library();
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |connection| {
                    let blob_hash = "a".repeat(64);
                    connection.execute(
                        "INSERT INTO managed_blobs( \
                       content_hash, physical_asset_name, byte_length, created_at \
                     ) VALUES (?1, 'agent-manifest-fixture', 1, ?2)",
                        params![blob_hash, NOW],
                    )?;
                    connection.execute(
                        "UPDATE page_file_manifests SET revision = 1 WHERE page_id = 'page-1'",
                        [],
                    )?;
                    for index in 0..101 {
                        let file_id = format!("file-{index:03}");
                        let path = format!("references/file-{index:03}.txt");
                        let state = if index == 100 { "deleted" } else { "live" };
                        let change_kind = if index == 100 { "delete" } else { "create" };
                        let byte_length = if index == 100 { 0 } else { 1 };
                        let file_blob_hash = (index != 100).then_some(blob_hash.as_str());
                        if index != 100 {
                            connection.execute(
                                "INSERT INTO page_file_namespace( \
                               owner_page_id, library_id, path_key, file_id \
                             ) VALUES ('page-1', 'library-1', ?1, ?2)",
                                params![path, file_id],
                            )?;
                        }
                        connection.execute(
                            "INSERT INTO page_file_versions( \
                           file_id, version, library_id, owner_page_id, manifest_revision, \
                           change_kind, logical_path, path_key, mime_type, blob_hash, byte_length, \
                           actor_id, turn_id, operation_id, occurred_at \
                         ) VALUES (?1, 1, 'library-1', 'page-1', 1, ?2, ?3, ?3, \
                           'text/plain', ?4, ?5, 'project-1', NULL, 'seed-files', ?6)",
                            params![file_id, change_kind, path, file_blob_hash, byte_length, NOW],
                        )?;
                        connection.execute(
                            "INSERT INTO page_files( \
                           file_id, library_id, owner_page_id, logical_path, path_key, mime_type, \
                           byte_length, current_version, state, created_by_actor_id, \
                           created_by_turn_id, created_at, updated_at \
                         ) VALUES (?1, 'library-1', 'page-1', ?2, ?2, 'text/plain', ?3, 1, ?4, \
                           'project-1', NULL, ?5, ?5)",
                            params![file_id, path, byte_length, state, NOW],
                        )?;
                    }
                    let projected = list_complete(connection, "library-1", "page-1", true)?;
                    assert_eq!(projected.files.len(), 101);
                    assert_eq!(projected.live_total, 100);
                    assert_eq!(projected.deleted_total, 1);
                    assert!(!projected.has_more);
                    assert!(projected.next_cursor.is_none());
                    Ok(())
                })
            })
            .expect("read complete Agent manifest");
    }

    #[test]
    fn deleted_files_leave_live_namespace_but_remain_restorable() {
        let (_directory, kernel, module) = seeded_library();
        seed_receipt(&kernel, "operation:create-file", "receipt-a", 'c');
        module
            .apply(
                &context(),
                apply_request(
                    "operation:create-file",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-a".to_owned(),
                        logical_path: "brief.md".to_owned(),
                        mime_type: "text/markdown".to_owned(),
                        prepared_blob_receipt_id: "receipt-a".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create File");
        module
            .apply(
                &context(),
                apply_request(
                    "operation:delete-file",
                    1,
                    vec![LibraryPageFileChange::Delete {
                        file_id: "file-a".to_owned(),
                        expected_version: 1,
                    }],
                ),
            )
            .expect("delete File");

        assert!(manifest(&module, false).files.is_empty());
        let deleted = manifest(&module, true);
        assert_eq!(deleted.files[0].state, LibraryPageFileState::Deleted);
        assert_eq!(deleted.files[0].version, 2);

        module
            .apply(
                &context(),
                apply_request(
                    "operation:restore-file",
                    2,
                    vec![LibraryPageFileChange::RestoreVersion {
                        file_id: "file-a".to_owned(),
                        expected_version: 2,
                        source_version: 1,
                    }],
                ),
            )
            .expect("restore File");
        let restored = manifest(&module, false);
        assert_eq!(restored.files[0].state, LibraryPageFileState::Live);
        assert_eq!(restored.files[0].version, 3);
        assert_eq!(restored.files[0].logical_path, "brief.md");
    }

    #[test]
    fn manifest_projects_body_placement_counts_without_advancing_file_revision() {
        let (_directory, kernel, module) = seeded_library();
        seed_receipt(&kernel, "operation:create-file", "receipt-a", 'a');
        module
            .apply(
                &context(),
                apply_request(
                    "operation:create-file",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-a".to_owned(),
                        logical_path: "diagram.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "receipt-a".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create File");

        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let (block_id, projected_seq) = transaction.query_row(
                        "SELECT block_id, projected_seq FROM document_block_index \
                         WHERE document_id = 'document-1' ORDER BY ordinal LIMIT 1",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )?;
                    transaction.execute(
                        "INSERT INTO block_asset_refs( \
                           document_id, block_id, owner_block_id, library_id, document_generation, \
                           projected_seq, projection_version, role, ordinal, asset_uri, asset_hash, \
                           page_file_id, updated_at \
                         ) VALUES( \
                           'document-1', ?1, 'page-1', 'library-1', 1, ?2, 1, \
                           'image', 0, 'nodex://files/file-a', ?3, 'file-a', ?4 \
                         )",
                        params![block_id, projected_seq, "a".repeat(64), NOW],
                    )?;
                    transaction.execute(
                        "UPDATE page_file_manifests \
                         SET body_usage_revision = 1, updated_at = ?1 \
                         WHERE page_id = 'page-1' AND library_id = 'library-1'",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("place File in Page body projection");

        let placed = manifest(&module, false);
        assert_eq!(placed.revision, 1);
        assert_eq!(placed.body_usage_revision, 1);
        assert_eq!(
            placed.files[0].body_usage,
            LibraryPageFileBodyUsage::Placed { placement_count: 1 },
        );

        module
            .apply(
                &context(),
                apply_request(
                    "operation:rename-file",
                    1,
                    vec![LibraryPageFileChange::Rename {
                        file_id: "file-a".to_owned(),
                        expected_version: 1,
                        logical_path: "renamed.png".to_owned(),
                    }],
                ),
            )
            .expect("rename File");
        let renamed = manifest(&module, false);
        assert_eq!(renamed.revision, 2);
        assert_eq!(renamed.body_usage_revision, 1);
    }

    #[test]
    fn current_file_content_is_readable_through_a_foreign_page_placement() {
        let (_directory, kernel, module) = seeded_library();
        create_page(
            &module,
            "operation:create-placement-page",
            "page-2",
            "document-2",
        );
        create_page(
            &module,
            "operation:create-unrelated-page",
            "page-3",
            "document-3",
        );
        seed_receipt(&kernel, "operation:create-file", "receipt-a", 'a');
        fs::create_dir_all(module.page_file_blob_root().expect("Blob root"))
            .expect("create Blob root");
        fs::write(
            module
                .page_file_blob_root()
                .expect("Blob root")
                .join("a".repeat(64)),
            b"data",
        )
        .expect("write Blob");
        module
            .apply(
                &context(),
                apply_request(
                    "operation:create-file",
                    0,
                    vec![LibraryPageFileChange::Create {
                        file_id: "file-a".to_owned(),
                        logical_path: "diagram.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "receipt-a".to_owned(),
                        collision_policy: LibraryPageFileCollisionPolicy::Reject,
                    }],
                ),
            )
            .expect("create File");

        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let (block_id, projected_seq) = transaction.query_row(
                        "SELECT block_id, projected_seq FROM document_block_index \
                         WHERE document_id = 'document-2' ORDER BY ordinal LIMIT 1",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )?;
                    transaction.execute(
                        "INSERT INTO block_asset_refs( \
                           document_id, block_id, owner_block_id, library_id, document_generation, \
                           projected_seq, projection_version, role, ordinal, asset_uri, asset_hash, \
                           page_file_id, updated_at \
                         ) VALUES( \
                           'document-2', ?1, 'page-2', 'library-1', 1, ?2, 1, \
                           'image', 0, 'nodex://files/file-a', ?3, 'file-a', ?4 \
                         )",
                        params![block_id, projected_seq, "a".repeat(64), NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("place File in another Page");

        let metadata = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFileMetadata {
                        page_id: "page-2".to_owned(),
                        file_id: "file-a".to_owned(),
                    },
                },
            )
            .expect("read placement metadata");
        let LibraryReadValue::PageFileMetadata { value } = metadata.value else {
            panic!("Page File metadata value");
        };
        assert_eq!(value.owner_page_id, "page-1");
        assert_eq!(value.logical_path, "diagram.png");
        assert_eq!(
            manifest(&module, false).files[0].body_usage,
            LibraryPageFileBodyUsage::NotInBody,
        );

        let blob = module
            .resolve_page_file_blob(&context(), "page-2", "file-a", None)
            .expect("resolve current Blob through placement");
        assert_eq!(fs::read(blob.physical_path).expect("read Blob"), b"data");

        let renamed = module
            .apply(
                &context(),
                apply_request(
                    "operation:rename-placed-file",
                    1,
                    vec![LibraryPageFileChange::Rename {
                        file_id: "file-a".to_owned(),
                        expected_version: 1,
                        logical_path: "renamed.png".to_owned(),
                    }],
                ),
            )
            .expect("rename placed File");
        assert!(renamed.committed.receipt.committed_revisions["pageFileContent:page-2"] > 0);
        let delivery = CoreEventLog::new(kernel.readers())
            .authorized_packet(
                renamed.committed.receipt.commit_seq,
                &BoundModuleContext {
                    project_id: None,
                    connection_id: "connection:foreign-placement-root".to_owned(),
                    ..context()
                },
                None,
                true,
            )
            .expect("resolve File rename delivery")
            .expect("File rename delivery packet");
        let page_events = delivery
            .atoms
            .iter()
            .filter_map(|atom| {
                let DeliveryAtomPayload::Library { event, .. } = &atom.payload else {
                    return None;
                };
                event.page_ids.first().map(|page_id| (page_id, event))
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            page_events[&"page-1".to_owned()]
                .page_file_manifest_invalidations
                .get("page-1"),
            Some(&LibraryPageFileInvalidation::Exact {
                revision: 2,
                file_ids: vec!["file-a".to_owned()],
            })
        );
        assert_eq!(
            page_events[&"page-2".to_owned()]
                .page_file_content_invalidations
                .get("page-2"),
            Some(&LibraryPageFileInvalidation::Exact {
                revision: renamed.committed.receipt.commit_seq,
                file_ids: vec!["file-a".to_owned()],
            })
        );
        let renamed_metadata = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFileMetadata {
                        page_id: "page-2".to_owned(),
                        file_id: "file-a".to_owned(),
                    },
                },
            )
            .expect("read renamed placement metadata");
        let LibraryReadValue::PageFileMetadata {
            value: renamed_metadata,
        } = renamed_metadata.value
        else {
            panic!("renamed Page File metadata value");
        };
        assert_eq!(renamed_metadata.logical_path, "renamed.png");

        let unrelated = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFileMetadata {
                        page_id: "page-3".to_owned(),
                        file_id: "file-a".to_owned(),
                    },
                },
            )
            .expect_err("an unrelated Page must not resolve the File");
        assert_eq!(
            unrelated.code,
            nodex_core_contracts::CoreErrorCode::NotFound
        );

        let history = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFileVersions {
                        page_id: "page-2".to_owned(),
                        file_id: "file-a".to_owned(),
                        cursor: None,
                        limit: Some(10),
                    },
                },
            )
            .expect_err("a placement must not expose owner history");
        assert_eq!(history.code, nodex_core_contracts::CoreErrorCode::NotFound);
    }
}
