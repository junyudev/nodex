//! Core freezes File targets when accepting a retained edit package. The source
//! envelope remains lossless; this canonical companion and its derived roots
//! preserve the File presentation at acceptance, independently of later heads.

use nodex_core_contracts::BoundModuleContext;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::domain::files::{FileSnapshotManifest, FileSnapshotTarget};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryFileSnapshot {
    format_version: u32,
    complete: bool,
    files: BTreeMap<String, Option<FileSnapshotTarget>>,
    canvas_files: BTreeMap<String, RecoveryCanvasFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCanvasFile {
    file_id: String,
    target: Option<FileSnapshotTarget>,
}

pub(super) enum RetainedFileUses {
    Unresolved,
    Body(Vec<String>),
    Canvas(Vec<super::canvas_scene::CanvasFile>),
}

impl RecoveryFileSnapshot {
    pub(super) fn covers_canvas(&self, scene: &super::canvas_scene::CanvasScene) -> bool {
        self.complete
            && scene.files.values().all(|file| {
                self.canvas_files.get(&file.id).is_some_and(|binding| {
                    binding.file_id == file.target_file_id
                        && binding.target.as_ref().is_some_and(|target| {
                            target.version == file.file_version
                                && target.default_name == file.default_name
                        })
                })
            })
    }

    /// A retained element may only address its captured slot binding. Later
    /// unrelated scene content remains untouched, and missing slots can be
    /// reconstructed from the exact companion without consulting mutable heads.
    pub(super) fn prepare_canvas_mutation(
        &self,
        connection: &Connection,
        library_id: &str,
        current: &super::canvas_scene::CanvasScene,
        mutation: &super::canvas_scene::CanvasMutation,
    ) -> Result<Option<super::canvas_scene::CanvasMutation>, StoreError> {
        if !self.complete {
            return Ok(None);
        }
        let mut value = mutation.canonical_value.clone();
        for element in &mutation.element_candidates {
            if element
                .value
                .get("type")
                .and_then(serde_json::Value::as_str)
                != Some("image")
                || element
                    .value
                    .get("isDeleted")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
            {
                continue;
            }
            let Some(slot) = element
                .value
                .get("fileId")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let Some(binding) = self.canvas_files.get(slot) else {
                return Ok(None);
            };
            let Some(target) = &binding.target else {
                return Ok(None);
            };
            let matches = |file: &super::canvas_scene::CanvasFile| {
                file.target_file_id == binding.file_id
                    && file.file_version == target.version
                    && file.default_name == target.default_name
            };
            if current.files.get(slot).is_some_and(|file| !matches(file))
                || mutation
                    .file_additions
                    .get(slot)
                    .is_some_and(|file| !matches(file))
            {
                return Ok(None);
            }
            if current.files.contains_key(slot) || mutation.file_additions.contains_key(slot) {
                continue;
            }
            let mime: String = connection.query_row(
                "SELECT mime_type FROM file_versions WHERE library_id = ?1 AND file_id = ?2 AND version = ?3",
                params![library_id, binding.file_id, target.version], |row| row.get(0),
            )?;
            value["fileAdditions"][slot] = serde_json::json!({
                "id": slot, "mimeType": mime, "source": format!("nodex://files/{}", binding.file_id),
                "fileVersion": target.version, "defaultName": target.default_name,
            });
        }
        super::canvas_scene::parse_canvas_mutation(&value).map(Some)
    }

    pub(super) fn canvas_target(&self, slot: &str, file_id: &str) -> Option<FileSnapshotTarget> {
        self.canvas_files
            .get(slot)
            .filter(|binding| binding.file_id == file_id)
            .and_then(|binding| binding.target.clone())
    }
    pub(super) fn target(&self, file_id: &str) -> Option<FileSnapshotTarget> {
        self.files.get(file_id).cloned().flatten()
    }
    pub(super) fn exact(&self) -> Option<FileSnapshotManifest> {
        if !self.complete {
            return None;
        }
        Some(FileSnapshotManifest {
            files: self
                .files
                .iter()
                .map(|(id, target)| Some((id.clone(), target.clone()?)))
                .collect::<Option<BTreeMap<_, _>>>()?,
        })
    }
}

pub(super) fn capture(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
    draft_id: &str,
    uses: RetainedFileUses,
) -> Result<usize, StoreError> {
    let complete = !matches!(uses, RetainedFileUses::Unresolved);
    let mut files = BTreeMap::new();
    let mut canvas_files = BTreeMap::new();
    match uses {
        RetainedFileUses::Unresolved => {}
        RetainedFileUses::Body(ids) => {
            for id in ids {
                let target = crate::library::capture_recovery_file_target(
                    connection,
                    context,
                    document_id,
                    &id,
                )?;
                files.insert(id, target);
            }
        }
        RetainedFileUses::Canvas(bindings) => {
            for file in bindings {
                let target = super::canvas_files::capture_recovery_target(
                    connection,
                    context,
                    document_id,
                    &file,
                )?;
                canvas_files.insert(
                    file.id,
                    RecoveryCanvasFile {
                        file_id: file.target_file_id,
                        target,
                    },
                );
            }
        }
    }
    let snapshot = RecoveryFileSnapshot {
        format_version: 2,
        complete,
        files,
        canvas_files,
    };
    let bytes = canonical_bytes(&snapshot)?;
    let hash = super::sha256(&bytes);
    let byte_length = bytes.len();
    let json =
        String::from_utf8(bytes).map_err(|_| corrupt("Recovery File snapshot is not UTF-8"))?;
    connection.execute("INSERT INTO document_recovery_file_snapshots(library_id, draft_id, snapshot_json, snapshot_hash) VALUES (?1, ?2, ?3, ?4)", params![context.library_id.0, draft_id, json, hash])?;
    for (kind, binding_id, file_id, target) in bindings(&snapshot) {
        connection.execute("INSERT INTO document_recovery_file_refs(library_id, draft_id, binding_kind, binding_id, file_id, file_version, default_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![context.library_id.0, draft_id, kind, binding_id, file_id, target.as_ref().map(|target| target.version), target.as_ref().map(|target| target.default_name.as_str())])?;
    }
    Ok(byte_length)
}

pub(super) fn load(
    connection: &Connection,
    library_id: &str,
    draft_id: &str,
) -> Result<Option<RecoveryFileSnapshot>, StoreError> {
    let row = connection.query_row("SELECT snapshot_json, snapshot_hash FROM document_recovery_file_snapshots WHERE library_id = ?1 AND draft_id = ?2", params![library_id, draft_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional()?;
    let Some((json, hash)) = row else {
        return Ok(None);
    };
    let snapshot: RecoveryFileSnapshot = serde_json::from_str(&json)
        .map_err(|_| corrupt("Recovery File snapshot cannot be decoded"))?;
    let canonical = canonical_bytes(&snapshot)?;
    if snapshot.format_version != 2
        || canonical != json.as_bytes()
        || super::sha256(&canonical) != hash
    {
        return Err(corrupt("Recovery File snapshot identity diverges"));
    }
    let expected = bindings(&snapshot)
        .map(|(kind, id, file_id, target)| {
            (
                (kind.to_owned(), id.to_owned()),
                (file_id.to_owned(), target.clone()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for ((_, id), (file_id, target)) in &expected {
        crate::domain::files::validate_file_identity(id, "Recovery binding")?;
        crate::domain::files::validate_file_identity(file_id, "Recovery File")?;
        if let Some(target) = target {
            FileSnapshotManifest {
                files: BTreeMap::from([(file_id.clone(), target.clone())]),
            }
            .validate()?;
        }
    }
    let rows = connection.prepare("SELECT binding_kind, binding_id, file_id, file_version, default_name FROM document_recovery_file_refs WHERE library_id = ?1 AND draft_id = ?2 ORDER BY binding_kind, binding_id")?
        .query_map(params![library_id, draft_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<String>>(4)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() != expected.len() {
        return Err(corrupt("Recovery File index is incomplete"));
    }
    for (kind, id, file_id, version, name) in rows {
        let Some((expected_id, target)) = expected.get(&(kind, id)) else {
            return Err(corrupt("Recovery File index has an extra target"));
        };
        if file_id != *expected_id
            || version != target.as_ref().map(|target| target.version)
            || name.as_deref() != target.as_ref().map(|target| target.default_name.as_str())
        {
            return Err(corrupt("Recovery File index target diverges"));
        }
    }
    Ok(Some(snapshot))
}

fn bindings(
    snapshot: &RecoveryFileSnapshot,
) -> impl Iterator<Item = (&str, &str, &str, &Option<FileSnapshotTarget>)> {
    snapshot
        .files
        .iter()
        .map(|(id, target)| ("body", id.as_str(), id.as_str(), target))
        .chain(snapshot.canvas_files.iter().map(|(id, binding)| {
            (
                "canvas",
                id.as_str(),
                binding.file_id.as_str(),
                &binding.target,
            )
        }))
}

fn canonical_bytes(snapshot: &RecoveryFileSnapshot) -> Result<Vec<u8>, StoreError> {
    super::history::canonical_json_bytes(
        serde_json::to_value(snapshot)
            .map_err(|_| corrupt("Recovery File snapshot cannot be encoded"))?,
    )
}

fn corrupt(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
