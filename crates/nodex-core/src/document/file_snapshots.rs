//! The canonical checkpoint owns File bindings. These rows are a rebuildable
//! retention/query index, including explicitly unresolved legacy references.

use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;

use super::history::StoredDocumentVersion;

pub(crate) fn resolve_target(
    connection: &Connection,
    context: &nodex_core_contracts::BoundModuleContext,
    document_id: &str,
    version_id: &str,
    file_id: &str,
) -> Result<FileSnapshotTarget, StoreError> {
    super::require_owned_document_read_access(connection, context, document_id)?;
    let authority = super::read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Document File source lost its Document"))?;
    let version = super::history::get_document_version(connection, &authority, version_id)?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Document version is unavailable",
                false,
            )
        })?;
    let target = version
        .file_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.files.get(file_id))
        .cloned()
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Document version has no exact target for this File",
                false,
            )
        })?;
    let hash = version
        .summary
        .get("checkpointHash")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| corrupt("Document checkpoint hash is unavailable"))?;
    validate_index(
        connection,
        &plan_index(connection, version_id, hash, &version)?,
    )?;
    Ok(target)
}
use crate::domain::files::FileSnapshotTarget;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

#[derive(Clone, Debug)]
pub(super) struct FileSnapshotIndexPlan {
    version_id: String,
    library_id: String,
    checkpoint_hash: String,
    targets: BTreeMap<(String, String), IndexedFileTarget>,
}

#[derive(Clone, Debug)]
struct IndexedFileTarget {
    file_id: String,
    target: Option<FileSnapshotTarget>,
}

pub(super) fn plan_index(
    connection: &Connection,
    version_id: &str,
    checkpoint_hash: &str,
    version: &StoredDocumentVersion,
) -> Result<FileSnapshotIndexPlan, StoreError> {
    let library_id = connection.query_row(
        "SELECT document.library_id FROM document_versions version JOIN documents document ON document.id = version.document_id WHERE version.version_id = ?1",
        [version_id], |row| row.get::<_, String>(0),
    )?;
    let file_ids = version
        .block_materialization
        .as_ref()
        .map(|value| value.file_ids())
        .unwrap_or_default();
    let mut targets = file_ids
        .into_iter()
        .map(|file_id| {
            let target = version
                .file_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.files.get(&file_id))
                .cloned();
            (
                ("body".to_owned(), file_id.clone()),
                IndexedFileTarget { file_id, target },
            )
        })
        .collect::<BTreeMap<_, _>>();
    if let Some(scene) = &version.canvas_scene {
        for (slot, file) in &scene.files {
            targets.insert(
                ("canvas".to_owned(), slot.clone()),
                IndexedFileTarget {
                    file_id: file.target_file_id.clone(),
                    target: Some(FileSnapshotTarget {
                        version: file.file_version,
                        default_name: file.default_name.clone(),
                    }),
                },
            );
        }
    }
    Ok(FileSnapshotIndexPlan {
        version_id: version_id.to_owned(),
        library_id,
        checkpoint_hash: checkpoint_hash.to_owned(),
        targets,
    })
}

pub(super) fn ensure_index(
    connection: &Connection,
    plan: &FileSnapshotIndexPlan,
) -> Result<(), StoreError> {
    let marker = connection.query_row(
        "SELECT checkpoint_hash, file_count FROM document_version_file_index WHERE version_id = ?1",
        [&plan.version_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    ).optional()?;
    if let Some(marker) = marker {
        if marker != (plan.checkpoint_hash.clone(), plan.targets.len() as i64) {
            return Err(corrupt("Document File snapshot index identity diverges"));
        }
        return validate_targets(connection, plan);
    }
    // An absent marker is explicitly incomplete. Rebuild from canonical bytes
    // in the same writer transaction, never from current File heads or dates.
    connection.execute(
        "DELETE FROM document_version_file_refs WHERE version_id = ?1",
        [&plan.version_id],
    )?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO document_version_file_refs(version_id, binding_kind, binding_id, file_id, library_id, file_version, default_name, resolution) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for ((kind, binding_id), binding) in &plan.targets {
        let target = &binding.target;
        insert.execute(params![
            plan.version_id,
            kind,
            binding_id,
            binding.file_id,
            plan.library_id,
            target.as_ref().map(|target| target.version),
            target.as_ref().map(|target| target.default_name.as_str()),
            if target.is_some() {
                "exact"
            } else {
                "unresolved_legacy"
            }
        ])?;
    }
    connection.execute("INSERT INTO document_version_file_index(version_id, checkpoint_hash, file_count) VALUES (?1, ?2, ?3)",
        params![plan.version_id, plan.checkpoint_hash, plan.targets.len() as i64])?;
    Ok(())
}

pub(super) fn validate_index(
    connection: &Connection,
    plan: &FileSnapshotIndexPlan,
) -> Result<(), StoreError> {
    let valid = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM document_version_file_index WHERE version_id = ?1 AND checkpoint_hash = ?2 AND file_count = ?3)",
        params![plan.version_id, plan.checkpoint_hash, plan.targets.len() as i64], |row| row.get::<_, bool>(0),
    )?;
    if !valid {
        return Err(corrupt("Document File snapshot index is incomplete"));
    }
    validate_targets(connection, plan)
}

fn validate_targets(
    connection: &Connection,
    plan: &FileSnapshotIndexPlan,
) -> Result<(), StoreError> {
    let rows = connection.prepare(
        "SELECT binding_kind, binding_id, file_id, library_id, file_version, default_name, resolution FROM document_version_file_refs WHERE version_id = ?1 ORDER BY binding_kind, binding_id",
    )?.query_map([&plan.version_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
        row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<i64>>(4)?,
        row.get::<_, Option<String>>(5)?, row.get::<_, String>(6)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() != plan.targets.len() {
        return Err(corrupt("Document File snapshot index count diverges"));
    }
    for (kind, binding_id, file_id, library_id, version, name, resolution) in rows {
        let Some(binding) = plan.targets.get(&(kind, binding_id)) else {
            return Err(corrupt("Document File snapshot index has an extra target"));
        };
        let expected = &binding.target;
        if file_id != binding.file_id
            || library_id != plan.library_id
            || version != expected.as_ref().map(|target| target.version)
            || name.as_deref() != expected.as_ref().map(|target| target.default_name.as_str())
            || resolution
                != if expected.is_some() {
                    "exact"
                } else {
                    "unresolved_legacy"
                }
        {
            return Err(corrupt("Document File snapshot index target diverges"));
        }
    }
    Ok(())
}

fn corrupt(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
