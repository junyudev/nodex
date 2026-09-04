//! One-way v151 to v152 conversion from Page-owned attachments to Library Files.
//!
//! The migration deliberately has no compatibility mode. It rebuilds the few
//! changed tables from the immutable published v152 schema, converts every known
//! durable byte owner, and only then publishes the new Store revision.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::domain::file_path::normalize_file_name;

use super::managed_blobs::BlobWriter;
use super::schema::{read_schema_inventory, validate_schema_identity};
use super::sqlite::{StoreError, StoreErrorCode};

const BATCH_SIZE: i64 = 128;
const LEGACY_PREFIX: &str = "__nodex_v151_";
const CHANGED_TABLES: &[&str] = &[
    "block_asset_refs",
    "canvas_scene_file_refs",
    "codex_queued_follow_up_payload_asset_refs",
    "codex_queued_follow_up_payload_manifests",
    "document_versions",
    "local_commit_revocations",
    "project_resource_grants",
    "structural_retention_members",
];
const ADDED_TABLES: &[&str] = &[
    "document_version_file_index",
    "library_files",
    "file_versions",
    "page_file_entries",
    "retired_file_ids",
    "file_import_events",
    "document_version_file_refs",
    "codex_thread_asset_refs",
    "document_recovery_file_snapshots",
    "document_recovery_file_refs",
];

struct LegacyFile {
    file_id: String,
    library_id: String,
    owner_page_id: String,
    logical_path: String,
    path_key: String,
    current_version: i64,
    live: bool,
    actor_id: String,
    turn_id: Option<String>,
    created_at: String,
    updated_at: String,
    readable_version: Option<i64>,
}

#[derive(Default)]
struct BlobCatalog {
    by_legacy_name: BTreeMap<String, (String, i64)>,
    retained_legacy_sources: u64,
}

/// Runs inside the migration framework's schema-rebuild transaction. Published
/// content-addressed bytes can outlive a rollback; their old source files and
/// the pre-migration database backup remain untouched until the commit.
pub(crate) fn migrate_v151_to_v152(
    connection: &Connection,
    completed_at_unix_ms: i64,
) -> Result<String, StoreError> {
    if connection.is_autocommit() {
        return Err(corrupt("File migration requires an outer transaction"));
    }
    let now = timestamp(connection, completed_at_unix_ms)?;
    let assets_root = profile_assets_root(connection)?;
    let target = target_schema_objects()?;

    migration_stage(
        "drop secondary schema objects",
        drop_secondary_schema_objects(connection),
    )?;
    connection.pragma_update(None, "legacy_alter_table", true)?;
    migration_stage("rename changed tables", rename_changed_tables(connection))?;
    migration_stage(
        "create target tables",
        create_target_tables(connection, &target),
    )?;
    migration_stage("copy compatible tables", copy_compatible_tables(connection))?;

    let mut blobs = normalize_managed_blobs(connection, &assets_root, &now)?;
    let page_files = migrate_page_file_records(connection)?;
    let grants = migrate_page_file_grants(connection)?;
    let structural_files = retain_legacy_structural_files(connection)?;
    let canvas_files = migrate_current_canvas_files(connection, &assets_root, &now, &mut blobs)?;
    let canvas_versions = migrate_canvas_history(connection, &assets_root, &now, &mut blobs)?;
    let recovery_drafts = migrate_recovery_companions(connection)?;
    let queue_manifests = migrate_queued_follow_ups(connection, &assets_root, &now, &mut blobs)?;
    let retained_legacy_blob_sources = blobs.retained_legacy_sources;

    crate::document::backfill_migrated_document_history(connection)?;
    let next_epoch = format!(
        "epoch:{}",
        crate::domain::identity::random_uuid_v7()
            .map_err(|_| internal("Migrated Store epoch entropy failed"))?
    );
    connection.execute(
        "UPDATE block_store_metadata SET store_epoch = ?1, updated_at = ?2 WHERE id = 1",
        params![next_epoch, now],
    )?;
    let baselines = crate::document::insert_migrated_file_baselines(connection, &now)?;

    drop_legacy_tables(connection)?;
    recreate_secondary_schema_objects(connection, &target)?;
    connection.pragma_update(None, "legacy_alter_table", false)?;

    serde_json::to_string(&json!({
        "libraryFiles": page_files,
        "materializedFileGrants": grants,
        "structuralFileRoots": structural_files,
        "canvasFiles": canvas_files,
        "canvasHistoryVersions": canvas_versions,
        "recoveryDraftCompanions": recovery_drafts,
        "queuedFollowUpManifests": queue_manifests,
        "retainedLegacyBlobSources": retained_legacy_blob_sources,
        "exactCurrentBaselines": baselines,
        "storeEpochRotated": true,
    }))
    .map_err(|_| internal("File migration evidence cannot be encoded"))
}

fn target_schema_objects() -> Result<BTreeMap<(String, String), String>, StoreError> {
    let target = Connection::open_in_memory()?;
    // Historical migrations must not borrow future tables, triggers, or columns.
    target.execute_batch(include_str!("../../schema/published/v152.sql"))?;
    validate_schema_identity(&target, 152)?;
    target
        .prepare(
            "SELECT type, name, sql FROM sqlite_schema \
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )?
        .query_map([], |row| {
            Ok(((row.get(0)?, row.get(1)?), row.get::<_, String>(2)?))
        })?
        .collect::<rusqlite::Result<_>>()
        .map_err(StoreError::from)
}

fn drop_secondary_schema_objects(connection: &Connection) -> Result<(), StoreError> {
    let inventory = read_schema_inventory(connection)?;
    for kind in ["trigger", "index"] {
        for key in inventory.keys().filter(|key| key.object_type == kind) {
            connection.execute_batch(&format!(
                "DROP {} IF EXISTS {}",
                kind.to_ascii_uppercase(),
                quoted(&key.name)
            ))?;
        }
    }
    Ok(())
}

fn rename_changed_tables(connection: &Connection) -> Result<(), StoreError> {
    for table in CHANGED_TABLES {
        connection.execute_batch(&format!(
            "ALTER TABLE {} RENAME TO {}",
            quoted(table),
            quoted(&legacy_name(table))
        ))?;
    }
    Ok(())
}

fn create_target_tables(
    connection: &Connection,
    target: &BTreeMap<(String, String), String>,
) -> Result<(), StoreError> {
    for table in CHANGED_TABLES.iter().chain(ADDED_TABLES) {
        let sql = target
            .get(&("table".to_owned(), (*table).to_owned()))
            .ok_or_else(|| internal(format!("Target schema lost table {table}")))?;
        connection.execute_batch(sql)?;
    }
    Ok(())
}

fn copy_compatible_tables(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(&format!(
        "INSERT INTO document_versions SELECT * FROM {document_versions};
         INSERT INTO local_commit_revocations SELECT * FROM {local_commit_revocations};
         INSERT INTO project_resource_grants SELECT * FROM {project_resource_grants};
         INSERT INTO structural_retention_members SELECT * FROM {structural_retention_members};
         INSERT INTO block_asset_refs(
           document_id, block_id, owner_block_id, library_id, document_generation,
           projected_seq, projection_version, role, ordinal, asset_uri, asset_hash,
           file_id, updated_at
         ) SELECT document_id, block_id, owner_block_id, library_id, document_generation,
           projected_seq, projection_version, role, ordinal, asset_uri, asset_hash,
           page_file_id, updated_at FROM {block_asset_refs};",
        document_versions = quoted(&legacy_name("document_versions")),
        local_commit_revocations = quoted(&legacy_name("local_commit_revocations")),
        project_resource_grants = quoted(&legacy_name("project_resource_grants")),
        structural_retention_members = quoted(&legacy_name("structural_retention_members")),
        block_asset_refs = quoted(&legacy_name("block_asset_refs")),
    ))?;
    Ok(())
}

fn recreate_secondary_schema_objects(
    connection: &Connection,
    target: &BTreeMap<(String, String), String>,
) -> Result<(), StoreError> {
    for kind in ["index", "trigger"] {
        for ((object_kind, _), sql) in target {
            if object_kind == kind {
                connection.execute_batch(sql)?;
            }
        }
    }
    Ok(())
}

fn drop_legacy_tables(connection: &Connection) -> Result<(), StoreError> {
    for table in [
        "codex_queued_follow_up_manifest_gc",
        "page_file_namespace",
        "page_file_versions",
        "page_files",
    ] {
        connection.execute_batch(&format!("DROP TABLE {}", quoted(table)))?;
    }
    for table in CHANGED_TABLES.iter().rev() {
        connection.execute_batch(&format!("DROP TABLE {}", quoted(&legacy_name(table))))?;
    }
    Ok(())
}

fn legacy_name(table: &str) -> String {
    format!("{LEGACY_PREFIX}{table}")
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn profile_assets_root(connection: &Connection) -> Result<PathBuf, StoreError> {
    let database_path: String = connection.query_row(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
        [],
        |row| row.get(0),
    )?;
    let parent = Path::new(&database_path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| corrupt("Migrated Store has no Profile directory"))?;
    Ok(parent.join("assets"))
}

fn normalize_managed_blobs(
    connection: &Connection,
    assets_root: &Path,
    now: &str,
) -> Result<BlobCatalog, StoreError> {
    let rows = connection
        .prepare(
            "SELECT content_hash, physical_asset_name, byte_length \
             FROM managed_blobs ORDER BY content_hash",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut catalog = BlobCatalog::default();
    for (hash, name, length) in rows {
        publish_legacy_blob(
            connection,
            assets_root,
            &name,
            Some((&hash, length)),
            now,
            &mut catalog,
        )?;
    }
    Ok(catalog)
}

fn publish_legacy_blob(
    connection: &Connection,
    assets_root: &Path,
    legacy_name: &str,
    expected: Option<(&str, i64)>,
    now: &str,
    catalog: &mut BlobCatalog,
) -> Result<(String, i64), StoreError> {
    if let Some(value) = catalog.by_legacy_name.get(legacy_name) {
        if expected.is_some_and(|expected| expected.0 != value.0 || expected.1 != value.1) {
            return Err(corrupt("Legacy Blob evidence is inconsistent"));
        }
        return Ok(value.clone());
    }
    super::managed_blobs::validate_physical_name(legacy_name)?;
    let mut source = File::open(assets_root.join(legacy_name))
        .map_err(|_| corrupt("Legacy managed bytes are unavailable"))?;
    let expected_length = expected.map(|value| value.1).unwrap_or_else(|| {
        source
            .metadata()
            .map(|value| value.len() as i64)
            .unwrap_or(-1)
    });
    if expected_length < 0 {
        return Err(corrupt("Legacy Blob length is invalid"));
    }
    let mut writer = BlobWriter::new(assets_root, expected_length as u64)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| corrupt("Legacy managed bytes cannot be read"))?;
        if read == 0 {
            break;
        }
        writer.write_chunk(&buffer[..read])?;
    }
    let published = writer.finish()?;
    let length = i64::try_from(published.byte_length)
        .map_err(|_| corrupt("Legacy Blob length exceeds SQLite"))?;
    if expected.is_some_and(|value| value.0 != published.content_hash || value.1 != length) {
        return Err(corrupt("Legacy Blob bytes disagree with stored evidence"));
    }
    connection.execute(
        "INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) \
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(content_hash) DO UPDATE SET \
           physical_asset_name = excluded.physical_asset_name",
        params![
            published.content_hash,
            published.physical_asset_name,
            length,
            now
        ],
    )?;
    let value = (published.content_hash.clone(), length);
    if legacy_name != published.physical_asset_name {
        catalog.retained_legacy_sources += 1;
    }
    catalog
        .by_legacy_name
        .insert(legacy_name.to_owned(), value.clone());
    Ok(value)
}

fn migrate_page_file_records(connection: &Connection) -> Result<u64, StoreError> {
    let mut after = String::new();
    let mut count = 0;
    loop {
        let batch = read_batch(connection, &after)?;
        if batch.is_empty() {
            return Ok(count);
        }
        for file in batch {
            migrate_record(connection, &file)?;
            after = file.file_id;
            count += 1;
        }
    }
}

fn read_batch(connection: &Connection, after: &str) -> Result<Vec<LegacyFile>, StoreError> {
    Ok(connection.prepare(
        "SELECT file.file_id, file.library_id, file.owner_page_id, file.logical_path, \
                file.path_key, file.current_version, file.state = 'live', \
                file.created_by_actor_id, file.created_by_turn_id, file.created_at, file.updated_at, \
                (SELECT max(version.version) FROM page_file_versions version \
                 WHERE version.file_id = file.file_id AND version.library_id = file.library_id \
                   AND version.version <= file.current_version AND version.blob_hash IS NOT NULL) \
         FROM page_files file WHERE file.file_id > ?1 ORDER BY file.file_id LIMIT ?2",
    )?.query_map(params![after, BATCH_SIZE], |row| Ok(LegacyFile {
        file_id: row.get(0)?, library_id: row.get(1)?, owner_page_id: row.get(2)?,
        logical_path: row.get(3)?, path_key: row.get(4)?, current_version: row.get(5)?,
        live: row.get(6)?, actor_id: row.get(7)?, turn_id: row.get(8)?,
        created_at: row.get(9)?, updated_at: row.get(10)?, readable_version: row.get(11)?,
    }))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn migrate_record(connection: &Connection, file: &LegacyFile) -> Result<(), StoreError> {
    let head = file
        .readable_version
        .ok_or_else(|| corrupt("Page File has no retained readable version"))?;
    let default_name =
        normalize_file_name(file.logical_path.rsplit('/').next().unwrap_or_default())?;
    let lifecycle = if file.live { "live" } else { "trashed" };
    if file.live && head != file.current_version {
        return Err(corrupt("Live Page File head has no exact bytes"));
    }
    let referenced_deleted = !file.live
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM block_asset_refs WHERE file_id = ?1)",
            [&file.file_id],
            |row| row.get::<_, bool>(0),
        )?;
    if referenced_deleted {
        return Err(corrupt(
            "Deleted Page File still has current body references",
        ));
    }
    connection.execute(
        "INSERT INTO library_files(file_id, library_id, default_name, head_version, revision, lifecycle, \
           created_by_actor_id, created_by_turn_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![file.file_id, file.library_id, default_name, head, file.current_version, lifecycle,
            file.actor_id, file.turn_id, file.created_at, file.updated_at],
    )?;
    migrate_versions(connection, &file.file_id)?;
    if file.live {
        connection.execute(
            "INSERT INTO page_file_entries(page_id, library_id, file_id, logical_path, path_key) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                file.owner_page_id,
                file.library_id,
                file.file_id,
                file.logical_path,
                file.path_key
            ],
        )?;
    }
    Ok(())
}

fn migrate_versions(connection: &Connection, file_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO file_versions(file_id, version, library_id, blob_hash, mime_type, byte_length, \
           actor_id, turn_id, operation_id, occurred_at) \
         SELECT file_id, version, library_id, blob_hash, mime_type, byte_length, \
           actor_id, turn_id, operation_id, occurred_at FROM page_file_versions \
         WHERE file_id = ?1 AND blob_hash IS NOT NULL",
        [file_id],
    )?;
    let mut evidence = connection.prepare(
        "SELECT version, json_object('fileId', file_id, 'version', version, 'libraryId', library_id, \
           'ownerPageId', owner_page_id, 'manifestRevision', manifest_revision, 'changeKind', change_kind, \
           'logicalPath', logical_path, 'pathKey', path_key, 'mimeType', mime_type, 'blobHash', blob_hash, \
           'byteLength', byte_length, 'actorId', actor_id, 'turnId', turn_id, 'operationId', operation_id, \
           'occurredAt', occurred_at) FROM page_file_versions WHERE file_id = ?1 ORDER BY version",
    )?;
    let mut rows = evidence.query([file_id])?;
    while let Some(row) = rows.next()? {
        connection.execute(
            "INSERT INTO file_import_events(file_id, source_version, evidence_json) VALUES (?1, ?2, ?3)",
            params![file_id, row.get::<_, i64>(0)?, row.get::<_, String>(1)?],
        )?;
    }
    Ok(())
}

fn migrate_page_file_grants(connection: &Connection) -> Result<u64, StoreError> {
    let files = connection
        .prepare(
            "SELECT file_id, library_id, owner_page_id, updated_at FROM page_files ORDER BY file_id",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut inserted = 0_u64;
    for (file_id, library_id, page_id, updated_at) in files {
        let (pages, database) = page_authority_chain(connection, &library_id, &page_id)?;
        let projects = connection
            .prepare(
                "SELECT project.id, project.lifecycle, COALESCE(project.database_block_id, ( \
                   SELECT binding.database_block_id FROM project_database_bindings binding \
                   WHERE binding.project_id = project.id AND binding.library_id = project.library_id \
                     AND binding.lifecycle = 'active')) \
                 FROM projects project WHERE project.library_id = ?1 ORDER BY project.id",
            )?
            .query_map([&library_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (project_id, lifecycle, primary_database) in projects {
            let mut access = if database.as_ref() == primary_database.as_ref() {
                database.as_ref().map(|_| "read_write".to_owned())
            } else {
                None
            };
            let grants = connection
                .prepare(
                    "SELECT root_kind, root_id, access FROM project_resource_grants \
                     WHERE project_id = ?1 AND lifecycle = 'active'",
                )?
                .query_map([&project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (kind, id, candidate) in grants {
                let applies = (kind == "page" && pages.contains(&id))
                    || (kind == "database" && database.as_deref() == Some(id.as_str()));
                if applies && (access.as_deref() != Some("read_write") || candidate == "read_write")
                {
                    access = Some(candidate);
                }
            }
            let Some(mut access) = access else {
                continue;
            };
            if lifecycle != "active" {
                access = "read".to_owned();
            }
            let grant_id = format!(
                "grant:file:{}",
                hex::encode(Sha256::digest(
                    format!("{project_id}\0{file_id}").as_bytes()
                ))
            );
            inserted += connection.execute(
                "INSERT INTO project_resource_grants( \
                   id, project_id, library_id, root_kind, root_id, access, recursive, \
                   revision, lifecycle, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 'file', ?4, ?5, 0, 1, 'active', ?6, ?6)",
                params![
                    grant_id, project_id, library_id, file_id, access, updated_at
                ],
            )? as u64;
        }
    }
    Ok(inserted)
}

fn page_authority_chain(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(BTreeSet<String>, Option<String>), StoreError> {
    let rows = connection
        .prepare(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, path) AS ( \
               SELECT page.block_id, page.parent_kind, page.parent_id, '|' || page.block_id || '|' \
               FROM pages page JOIN blocks block ON block.id = page.block_id \
               WHERE page.block_id = ?1 AND page.library_id = ?2 \
                 AND block.library_id = page.library_id AND block.lifecycle <> 'deleted' \
               UNION ALL \
               SELECT parent.block_id, parent.parent_kind, parent.parent_id, ancestors.path || parent.block_id || '|' \
               FROM ancestors JOIN pages parent ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               JOIN blocks block ON block.id = parent.block_id \
               WHERE parent.library_id = ?2 AND block.library_id = parent.library_id AND block.lifecycle <> 'deleted' \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0 \
             ) SELECT page_id, parent_kind, parent_id FROM ancestors",
        )?
        .query_map(params![page_id, library_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let pages = rows.iter().map(|row| row.0.clone()).collect();
    let database =
        rows.iter()
            .find(|row| row.1 == "data_source")
            .map(|row| row.2.clone())
            .map(|source_id| {
                connection.query_row(
            "SELECT home_database_block_id FROM data_sources WHERE id = ?1 AND library_id = ?2",
            params![source_id, library_id], |row| row.get::<_, String>(0))
            })
            .transpose()?;
    Ok((pages, database))
}

fn retain_legacy_structural_files(connection: &Connection) -> Result<u64, StoreError> {
    let mut inserted = 0_u64;
    for (authority_kind, table, id_column, json_column) in [
        (
            "clipboard_bundle",
            "structural_clipboard_bundles",
            "bundle_id",
            "snapshot_json",
        ),
        (
            "history_recipe",
            "structural_history_recipes",
            "recipe_operation_id",
            "recipe_json",
        ),
    ] {
        let sql = format!(
            "SELECT {id_column}, library_id, {json_column} FROM {table} ORDER BY {id_column}"
        );
        let rows = connection
            .prepare(&sql)?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (authority_id, library_id, encoded) in rows {
            let value: Value = serde_json::from_str(&encoded)
                .map_err(|_| corrupt("Legacy structural evidence is invalid"))?;
            let mut file_ids = BTreeSet::new();
            collect_named_string_arrays(&value, "hostPageFileIds", &mut file_ids)?;
            for file_id in file_ids {
                inserted += connection.execute(
                    "INSERT OR IGNORE INTO structural_retention_members(authority_kind, authority_id, library_id, member_kind, member_id) VALUES (?1, ?2, ?3, 'file', ?4)",
                    params![authority_kind, authority_id, library_id, file_id],
                )? as u64;
            }
        }
    }
    Ok(inserted)
}

fn collect_named_string_arrays(
    value: &Value,
    key: &str,
    output: &mut BTreeSet<String>,
) -> Result<(), StoreError> {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_named_string_arrays(value, key, output)?;
            }
        }
        Value::Object(object) => {
            if let Some(values) = object.get(key) {
                for value in values
                    .as_array()
                    .ok_or_else(|| corrupt("Legacy structural File list is invalid"))?
                {
                    output.insert(
                        value
                            .as_str()
                            .ok_or_else(|| corrupt("Legacy structural File ID is invalid"))?
                            .to_owned(),
                    );
                }
            }
            for value in object.values() {
                collect_named_string_arrays(value, key, output)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn migrate_current_canvas_files(
    connection: &Connection,
    assets_root: &Path,
    now: &str,
    blobs: &mut BlobCatalog,
) -> Result<u64, StoreError> {
    let legacy = legacy_name("canvas_scene_file_refs");
    let rows = connection.prepare(&format!(
        "SELECT reference.document_id, reference.file_id, reference.library_id, reference.mime_type, \
                reference.managed_file_name, reference.asset_hash, reference.byte_length, file.file_json \
         FROM {} reference JOIN canvas_scene_files file ON file.document_id = reference.document_id AND file.file_id = reference.file_id \
         ORDER BY reference.document_id, reference.file_id", quoted(&legacy)))?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, i64>(6)?, row.get::<_, String>(7)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (document_id, slot, library_id, mime, name, hash, length, file_json) in &rows {
        publish_legacy_blob(
            connection,
            assets_root,
            name,
            Some((hash, *length)),
            now,
            blobs,
        )?;
        let target = ensure_canvas_file(
            connection,
            library_id,
            document_id,
            slot,
            hash,
            *length,
            mime,
            name,
            now,
        )?;
        let mut value: Value = serde_json::from_str(file_json)
            .map_err(|_| corrupt("Legacy Canvas File JSON is invalid"))?;
        rewrite_canvas_file_value(&mut value, slot, mime, &target.0, &target.1);
        let encoded = crate::document::canonical_canvas_json(&value)?;
        connection.execute(
            "UPDATE canvas_scene_files SET asset_uri = ?1, file_json = ?2, file_hash = ?3 WHERE document_id = ?4 AND file_id = ?5",
            params![format!("nodex://files/{}", target.0), encoded, sha256(encoded.as_bytes()), document_id, slot],
        )?;
    }
    // Empty scenes also change schema identity, even when no File slot was rewritten.
    let documents = connection
        .prepare(
            "SELECT document.id FROM documents document \
             JOIN block_documents ownership ON ownership.document_id = document.id \
               AND ownership.library_id = document.library_id \
             WHERE document.sync_engine = 'canvas_scene' ORDER BY document.id",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for document_id in documents {
        crate::document::rebuild_migrated_canvas_scene(connection, &document_id, assets_root, now)?;
    }
    Ok(rows.len() as u64)
}

fn migrate_canvas_history(
    connection: &Connection,
    assets_root: &Path,
    now: &str,
    blobs: &mut BlobCatalog,
) -> Result<u64, StoreError> {
    let rows = connection.prepare(
        "SELECT version.version_id, version.document_id, document.library_id, CAST(version.full_update_blob AS TEXT) \
         FROM document_versions version JOIN documents document ON document.id = version.document_id \
         WHERE version.checkpoint_format = 'canvas_scene_json_v1' ORDER BY version.version_id")?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (version_id, document_id, library_id, encoded) in &rows {
        let mut value: Value = serde_json::from_str(encoded)
            .map_err(|_| corrupt("Legacy Canvas checkpoint is invalid"))?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| corrupt("Legacy Canvas checkpoint is not an object"))?;
        if object.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
            return Err(corrupt("Legacy Canvas checkpoint version is invalid"));
        }
        let files = object
            .get_mut("files")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| corrupt("Legacy Canvas checkpoint Files are invalid"))?;
        for (slot, file) in files {
            let file_object = file
                .as_object()
                .ok_or_else(|| corrupt("Legacy Canvas File is invalid"))?;
            let mime = file_object
                .get("mimeType")
                .and_then(Value::as_str)
                .ok_or_else(|| corrupt("Legacy Canvas MIME type is missing"))?
                .to_owned();
            let name = asset_name(
                file_object
                    .get("source")
                    .and_then(Value::as_str)
                    .ok_or_else(|| corrupt("Legacy Canvas source is missing"))?,
            )?;
            let (hash, length) =
                publish_legacy_blob(connection, assets_root, &name, None, now, blobs)?;
            let target = ensure_canvas_file(
                connection,
                library_id,
                document_id,
                slot,
                &hash,
                length,
                &mime,
                &name,
                now,
            )?;
            rewrite_canvas_file_value(file, slot, &mime, &target.0, &target.1);
        }
        object.insert("schemaVersion".to_owned(), Value::from(2));
        crate::document::parse_migrated_canvas_checkpoint(&value)?;
        let bytes = crate::document::canonical_document_checkpoint(value)?;
        let hash = sha256(&bytes);
        connection.execute(
            "DELETE FROM document_version_retention_index WHERE version_id = ?1",
            [version_id],
        )?;
        let length = bytes.len() as i64;
        connection.execute(
            "UPDATE document_versions SET schema_version = 2, checkpoint_format = 'canvas_scene_json_v2', full_update_blob = ?1, checkpoint_hash = ?2, byte_length = ?3 WHERE version_id = ?4",
            params![bytes, hash, length, version_id],
        )?;
    }
    Ok(rows.len() as u64)
}

#[allow(clippy::too_many_arguments)]
fn ensure_canvas_file(
    connection: &Connection,
    library_id: &str,
    document_id: &str,
    slot: &str,
    hash: &str,
    length: i64,
    mime: &str,
    legacy_name: &str,
    now: &str,
) -> Result<(String, String), StoreError> {
    let file_id = format!(
        "file:migrated-canvas:{}",
        hex::encode(Sha256::digest(
            format!("{library_id}\0{document_id}\0{slot}\0{hash}").as_bytes()
        ))
    );
    let default_name = migrated_canvas_name(legacy_name, hash)?;
    connection.execute(
        "INSERT OR IGNORE INTO library_files(file_id, library_id, default_name, head_version, revision, lifecycle, created_by_actor_id, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1, 'live', 'store-migration:v152', ?4, ?4)",
        params![file_id, library_id, default_name, now],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO file_versions(file_id, version, library_id, blob_hash, mime_type, byte_length, actor_id, operation_id, occurred_at) VALUES (?1, 1, ?2, ?3, ?4, ?5, 'store-migration:v152', ?6, ?7)",
        params![file_id, library_id, hash, mime, length, format!("migrate-canvas:{file_id}"), now],
    )?;
    Ok((file_id, default_name))
}

fn rewrite_canvas_file_value(
    value: &mut Value,
    slot: &str,
    mime: &str,
    file_id: &str,
    default_name: &str,
) {
    let created = value.get("created").cloned();
    let mut object = Map::new();
    object.insert("id".to_owned(), Value::String(slot.to_owned()));
    object.insert("mimeType".to_owned(), Value::String(mime.to_owned()));
    object.insert(
        "source".to_owned(),
        Value::String(format!("nodex://files/{file_id}")),
    );
    object.insert("fileVersion".to_owned(), Value::from(1));
    object.insert(
        "defaultName".to_owned(),
        Value::String(default_name.to_owned()),
    );
    if let Some(created) = created {
        object.insert("created".to_owned(), created);
    }
    *value = Value::Object(object);
}

fn migrated_canvas_name(legacy_name: &str, hash: &str) -> Result<String, StoreError> {
    let extension = Path::new(legacy_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 12
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default();
    normalize_file_name(&format!("canvas-{}{}", &hash[..16], extension))
}

fn migrate_recovery_companions(connection: &Connection) -> Result<u64, StoreError> {
    let json = r#"{"canvasFiles":{},"complete":false,"files":{},"formatVersion":2}"#;
    let hash = sha256(json.as_bytes());
    let inserted = connection.execute(
        "INSERT INTO document_recovery_file_snapshots(library_id, draft_id, snapshot_json, snapshot_hash) SELECT library_id, draft_id, ?1, ?2 FROM document_recovery_drafts",
        params![json, hash],
    )?;
    Ok(inserted as u64)
}

fn migrate_queued_follow_ups(
    connection: &Connection,
    assets_root: &Path,
    now: &str,
    blobs: &mut BlobCatalog,
) -> Result<u64, StoreError> {
    let manifest_table = quoted(&legacy_name("codex_queued_follow_up_payload_manifests"));
    let reference_table = quoted(&legacy_name("codex_queued_follow_up_payload_asset_refs"));
    let manifests = connection.prepare(&format!("SELECT payload_sha256, asset_uri, byte_length FROM {manifest_table} ORDER BY payload_sha256"))?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (old_hash, old_uri, old_length) in &manifests {
        let old_name = asset_name(old_uri)?;
        publish_legacy_blob(
            connection,
            assets_root,
            &old_name,
            Some((old_hash, *old_length)),
            now,
            blobs,
        )?;
        let references = connection.prepare(&format!("SELECT ordinal, asset_uri, sha256, byte_length FROM {reference_table} WHERE payload_sha256 = ?1 ORDER BY ordinal"))?
            .query_map([old_hash], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let bytes = std::fs::read(assets_root.join(&old_name))
            .map_err(|_| corrupt("Queued follow-up manifest bytes are unavailable"))?;
        let legacy: Value = serde_json::from_slice(&bytes)
            .map_err(|_| corrupt("Legacy queued follow-up manifest is invalid"))?;
        if legacy.get("schema_version").and_then(Value::as_i64) != Some(1) {
            return Err(corrupt("Legacy queued follow-up schema is invalid"));
        }
        let mut payload = legacy
            .get("payload")
            .cloned()
            .ok_or_else(|| corrupt("Legacy queued follow-up payload is missing"))?;
        let mut migrated_references = Vec::with_capacity(references.len());
        for (ordinal, uri, hash, length) in references {
            let name = asset_name(&uri)?;
            publish_legacy_blob(
                connection,
                assets_root,
                &name,
                Some((&hash, length)),
                now,
                blobs,
            )?;
            let next_uri = format!("nodex://assets/{hash}.blob");
            replace_string_value(&mut payload, &uri, &next_uri);
            migrated_references.push((ordinal, next_uri, hash, length, infer_mime_type(&name)));
        }
        let manifest = json!({
            "schema_version": 2,
            "payload": payload,
            "asset_references": migrated_references.iter().map(|value| json!({"asset_uri": value.1, "sha256": value.2, "byte_length": value.3, "mime_type": value.4})).collect::<Vec<_>>(),
        });
        let migrated_bytes = serde_json::to_vec(&manifest)
            .map_err(|_| corrupt("Migrated queued follow-up manifest cannot encode"))?;
        let mut writer = BlobWriter::new(assets_root, migrated_bytes.len() as u64)?;
        writer.write_chunk(&migrated_bytes)?;
        let published = writer.finish()?;
        connection.execute("INSERT OR IGNORE INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) VALUES (?1, ?2, ?3, ?4)", params![published.content_hash, published.physical_asset_name, published.byte_length as i64, now])?;
        connection.execute("INSERT OR IGNORE INTO codex_queued_follow_up_payload_manifests(payload_sha256, schema_version, asset_uri, byte_length) VALUES (?1, 2, ?2, ?3)", params![published.content_hash, format!("nodex://assets/{}.blob", published.content_hash), published.byte_length as i64])?;
        for (ordinal, uri, hash, length, mime) in migrated_references {
            connection.execute("INSERT OR IGNORE INTO codex_queued_follow_up_payload_asset_refs(payload_sha256, ordinal, asset_uri, sha256, byte_length, mime_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![published.content_hash, ordinal, uri, hash, length, mime])?;
        }
        connection.execute("UPDATE codex_queued_follow_up_entries SET payload_sha256 = ?1 WHERE payload_sha256 = ?2", params![published.content_hash, old_hash])?;
    }
    crate::workspace::queued_follow_up::refresh_migrated_queued_follow_up_ledgers(connection)?;
    Ok(manifests.len() as u64)
}

fn replace_string_value(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::String(text) if text == from => *text = to.to_owned(),
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| replace_string_value(value, from, to)),
        Value::Object(object) => object
            .values_mut()
            .for_each(|value| replace_string_value(value, from, to)),
        _ => {}
    }
}

fn asset_name(uri: &str) -> Result<String, StoreError> {
    let name = uri
        .strip_prefix("nodex://assets/")
        .ok_or_else(|| corrupt("Legacy managed asset URI is invalid"))?;
    super::managed_blobs::validate_physical_name(name)?;
    Ok(name.to_owned())
}

fn infer_mime_type(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn timestamp(connection: &Connection, unix_ms: i64) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1 / 1000.0, 'unixepoch')",
            [unix_ms],
            |row| row.get::<_, String>(0),
        )
        .map_err(StoreError::from)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn corrupt(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message.into(), true)
}

fn migration_stage<T>(label: &str, result: Result<T, StoreError>) -> Result<T, StoreError> {
    result.map_err(|error| StoreError {
        message: format!("File migration could not {label}: {}", error.message),
        ..error
    })
}
