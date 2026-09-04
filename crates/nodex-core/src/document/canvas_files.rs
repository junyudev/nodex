//! Canvas scene-file IDs bind exact Library File versions. Two slots may use
//! different versions of the same File without following its mutable head.

use nodex_core_contracts::BoundModuleContext;
use rusqlite::{Connection, OptionalExtension, params};

use super::DocumentAuthorityRow;
use super::canvas_scene::CanvasFile;
use crate::domain::files::FileSnapshotTarget;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(crate) fn content_evidence(
    connection: &Connection,
    document_id: &str,
    file: &CanvasFile,
) -> Result<(String, i64), StoreError> {
    let library_id = connection.query_row(
        "SELECT library_id FROM documents WHERE id = ?1",
        [document_id],
        |row| row.get::<_, String>(0),
    )?;
    version_evidence(connection, &library_id, file)
}

fn version_evidence(
    connection: &Connection,
    library_id: &str,
    file: &CanvasFile,
) -> Result<(String, i64), StoreError> {
    let evidence = connection.query_row(
        "SELECT blob_hash, byte_length, mime_type FROM file_versions WHERE library_id = ?1 AND file_id = ?2 AND version = ?3",
        params![library_id, file.target_file_id, file.file_version],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
    ).optional()?.ok_or_else(|| invalid("Canvas File version is unavailable in this Library"))?;
    if evidence.2 != file.mime_type
        || !evidence.2.starts_with("image/")
        || evidence.1 > 10 * 1024 * 1024
    {
        return Err(invalid(
            "Canvas File must bind a supported image version of at most 10 MiB",
        ));
    }
    Ok((evidence.0, evidence.1))
}

/// New client-provided bindings need direct File authority or an exact current
/// Canvas binding. A scene-file ID and a bare File URI are not capabilities.
pub(super) fn authorize_additions<'a>(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    files: impl IntoIterator<Item = &'a CanvasFile>,
) -> Result<(), StoreError> {
    for file in files {
        content_evidence(connection, &authority.head.id, file)?;
        let (name, live) = connection.query_row(
            "SELECT default_name, lifecycle = 'live' FROM library_files WHERE library_id = ?1 AND file_id = ?2",
            params![authority.head.library_id, file.target_file_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )?;
        if !live {
            return Err(invalid("A trashed File cannot be added to a Canvas"));
        }
        let existing = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM canvas_scene_file_refs reference JOIN documents document ON document.id = reference.document_id WHERE reference.document_id = ?1
             AND reference.target_file_id = ?2 AND reference.file_version = ?3 AND reference.default_name = ?4
             AND reference.document_generation = document.generation AND reference.projected_seq = document.head_seq)",
            params![
                authority.head.id,
                file.target_file_id,
                file.file_version,
                file.default_name
            ],
            |row| row.get::<_, bool>(0),
        )?;
        if existing {
            continue;
        }
        let direct = match &context.project_id {
            Some(project) => crate::library::file_grant_authorization_proof(
                connection,
                &context.library_id.0,
                &project.0,
                &file.target_file_id,
                false,
            )?
            .is_some(),
            None => true, // The Document boundary has already checked trusted Library authority.
        };
        if !direct || name != file.default_name {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Canvas File binding has no matching read authority",
                false,
            ));
        }
    }
    Ok(())
}

pub(super) fn capture_recovery_target(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
    file: &CanvasFile,
) -> Result<Option<FileSnapshotTarget>, StoreError> {
    if let Err(error) = version_evidence(connection, &context.library_id.0, file) {
        if matches!(
            error.code,
            StoreErrorCode::InvalidInput | StoreErrorCode::NotFound
        ) {
            return Ok(None);
        }
        return Err(error);
    }
    let current = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM canvas_scene_file_refs reference JOIN documents document ON document.id = reference.document_id WHERE reference.document_id = ?1 AND reference.target_file_id = ?2 AND reference.file_version = ?3 AND reference.default_name = ?4 AND reference.document_generation = document.generation AND reference.projected_seq = document.head_seq)",
        params![document_id, file.target_file_id, file.file_version, file.default_name], |row| row.get::<_, bool>(0),
    )?;
    if !current {
        if let Some(project) = &context.project_id
            && crate::library::file_grant_authorization_proof(
                connection,
                &context.library_id.0,
                &project.0,
                &file.target_file_id,
                false,
            )?
            .is_none()
        {
            return Ok(None);
        }
        let name: String = connection.query_row(
            "SELECT default_name FROM library_files WHERE file_id = ?1 AND library_id = ?2",
            params![file.target_file_id, context.library_id.0],
            |row| row.get(0),
        )?;
        if name != file.default_name {
            return Ok(None);
        }
    }
    Ok(Some(FileSnapshotTarget {
        version: file.file_version,
        default_name: file.default_name.clone(),
    }))
}

pub(crate) fn resolve_current_target(
    connection: &Connection,
    context: &BoundModuleContext,
    canvas_id: &str,
    scene_file_id: &str,
    file_id: &str,
) -> Result<FileSnapshotTarget, StoreError> {
    let document_id = connection.query_row(
        "SELECT owned.document_id FROM block_documents owned JOIN blocks block ON block.id = owned.block_id
         WHERE owned.block_id = ?1 AND owned.library_id = ?2 AND block.type = 'canvas' AND block.lifecycle = 'active'",
        params![canvas_id, context.library_id.0], |row| row.get::<_, String>(0),
    ).optional()?.ok_or_else(|| StoreError::new(StoreErrorCode::NotFound, "Canvas is unavailable", false))?;
    super::require_owned_document_read_access(connection, context, &document_id)?;
    let json = connection
        .query_row(
            "SELECT file_json FROM canvas_scene_files WHERE document_id = ?1 AND file_id = ?2",
            params![document_id, scene_file_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Canvas File slot is unavailable",
                false,
            )
        })?;
    let value = serde_json::from_str(&json).map_err(|_| corrupt("Canvas File JSON is invalid"))?;
    let file = super::canvas_scene::parse_stored_file(&value, scene_file_id)?;
    if file.target_file_id != file_id {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Canvas slot does not reference this File",
            false,
        ));
    }
    let evidence = content_evidence(connection, &document_id, &file)?;
    let indexed = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM canvas_scene_file_refs reference JOIN documents document ON document.id = reference.document_id
         WHERE reference.document_id = ?1 AND reference.file_id = ?2 AND reference.target_file_id = ?3
          AND reference.file_version = ?4 AND reference.default_name = ?5 AND reference.asset_hash = ?6
          AND reference.byte_length = ?7 AND reference.mime_type = ?8
          AND reference.document_generation = document.generation AND reference.projected_seq = document.head_seq)",
        params![document_id, scene_file_id, file_id, file.file_version, file.default_name, evidence.0, evidence.1, file.mime_type],
        |row| row.get::<_, bool>(0),
    )?;
    if !indexed {
        return Err(corrupt(
            "Canvas File projection disagrees with its canonical binding",
        ));
    }
    Ok(FileSnapshotTarget {
        version: file.file_version,
        default_name: file.default_name,
    })
}

pub(super) fn validated_revision_scene(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
    revision_id: &str,
) -> Result<super::canvas_scene::CanvasScene, StoreError> {
    super::require_owned_document_read_access(connection, context, document_id)?;
    let authority = super::read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Canvas revision lost its Document"))?;
    let version = super::history::get_document_version(connection, &authority, revision_id)?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Canvas revision is unavailable",
                false,
            )
        })?;
    let hash = version
        .summary
        .get("checkpointHash")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| corrupt("Canvas checkpoint hash is unavailable"))?;
    super::file_snapshots::validate_index(
        connection,
        &super::file_snapshots::plan_index(connection, revision_id, hash, &version)?,
    )?;
    version
        .canvas_scene
        .ok_or_else(|| invalid("Revision does not contain a Canvas scene"))
}

pub(crate) fn resolve_revision_target(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
    revision_id: &str,
    scene_file_id: &str,
    file_id: &str,
) -> Result<FileSnapshotTarget, StoreError> {
    let scene = validated_revision_scene(connection, context, document_id, revision_id)?;
    let file = scene
        .files
        .get(scene_file_id)
        .filter(|file| file.target_file_id == file_id)
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Canvas revision slot does not reference this File",
                false,
            )
        })?;
    Ok(FileSnapshotTarget {
        version: file.file_version,
        default_name: file.default_name.clone(),
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

/// Canvas slots already freeze versions. Live Files retain those bindings;
/// restoring a trashed File forks each distinct retained presentation once.
pub(super) fn plan_restore(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    scene: &super::canvas_scene::CanvasScene,
) -> Result<
    (
        super::canvas_scene::CanvasScene,
        Vec<crate::library::FileRestorePlan>,
    ),
    StoreError,
> {
    use std::collections::BTreeMap;
    let mut replacements = BTreeMap::<(String, i64, String), String>::new();
    let mut plans = Vec::new();
    let mut value = scene.canonical_value();
    for file in scene.files.values() {
        version_evidence(connection, library_id, file)?;
        let live: bool = connection.query_row(
            "SELECT lifecycle = 'live' FROM library_files WHERE library_id = ?1 AND file_id = ?2",
            params![library_id, file.target_file_id],
            |row| row.get(0),
        )?;
        if live {
            continue;
        }
        let key = (
            file.target_file_id.clone(),
            file.file_version,
            file.default_name.clone(),
        );
        let replacement = match replacements.get(&key) {
            Some(id) => id.clone(),
            None => {
                let identity = crate::domain::identity::stable_uuid_v7(
                    operation_id,
                    "restored_canvas_target",
                    &serde_json::to_string(&key)
                        .map_err(|_| invalid("Canvas File target cannot be encoded"))?,
                );
                let plan = crate::library::plan_file_restore(
                    connection,
                    library_id,
                    &identity,
                    &crate::domain::files::FileSnapshotManifest {
                        files: BTreeMap::from([(
                            file.target_file_id.clone(),
                            FileSnapshotTarget {
                                version: file.file_version,
                                default_name: file.default_name.clone(),
                            },
                        )]),
                    },
                )?;
                let id = plan.mapping[&file.target_file_id].clone();
                replacements.insert(key, id.clone());
                plans.push(plan);
                id
            }
        };
        value["files"][&file.id]["source"] =
            serde_json::json!(format!("nodex://files/{replacement}"));
        value["files"][&file.id]["fileVersion"] = serde_json::json!(1);
    }
    Ok((super::canvas_scene::parse_canvas_scene(&value)?, plans))
}

pub(super) fn apply_restore(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &BoundModuleContext,
    plans: &[crate::library::FileRestorePlan],
) -> Result<crate::library::RestoredFiles, StoreError> {
    let mut restored = crate::library::RestoredFiles::default();
    for plan in plans {
        restored.merge(crate::library::apply_file_restore(scope, context, plan)?);
    }
    Ok(restored)
}
