//! Preview bindings come from the same captured/current sources used by forward recovery.
use super::*;
use nodex_core_contracts::library::{LibraryFileReadBinding, LibraryFileReadSource};
use std::collections::BTreeMap;

type Bindings = BTreeMap<String, LibraryFileReadBinding>;

pub(super) fn set_preview_files(preview: &mut RecoveryPreview, bindings: Bindings) {
    match preview {
        RecoveryPreview::Document { files, .. } | RecoveryPreview::Canvas { files, .. } => {
            *files = bindings
        }
    }
}

pub(super) fn retained_body_bindings(
    connection: &Connection,
    context: &BoundModuleContext,
    capture: &RecoveryDraftCapture,
    materialization: &DocumentMaterialization,
) -> Result<Bindings, StoreError> {
    let snapshot = crate::document::recovery_files::load(
        connection,
        &context.library_id.0,
        &capture.draft_id,
    )?;
    Ok(materialization
        .file_ids()
        .into_iter()
        .filter_map(|id| {
            let target = snapshot.as_ref()?.target(&id)?;
            Some((
                id.clone(),
                LibraryFileReadBinding {
                    file_id: id,
                    version: target.version,
                    source: LibraryFileReadSource::RecoveryDraft {
                        document_id: capture.document_id.clone(),
                        draft_id: capture.draft_id.clone(),
                    },
                },
            ))
        })
        .collect())
}

pub(super) fn current_body_bindings(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
) -> Result<Bindings, StoreError> {
    let ids = materialization.file_ids();
    let snapshot = crate::library::capture_file_snapshot(
        connection,
        &context.library_id.0,
        ids.iter().map(String::as_str),
    )?;
    Ok(snapshot
        .files
        .into_iter()
        .map(|(id, target)| {
            (
                id.clone(),
                LibraryFileReadBinding {
                    file_id: id,
                    version: target.version,
                    source: LibraryFileReadSource::Page {
                        page_id: authority.owner_block_id.clone(),
                    },
                },
            )
        })
        .collect())
}

pub(super) fn canvas_preview_bindings(
    capture: &RecoveryDraftCapture,
    scene: &crate::document::canvas_scene::CanvasScene,
    captured: Option<&crate::document::recovery_files::RecoveryFileSnapshot>,
    current: Option<(
        &DocumentAuthorityRow,
        &crate::document::canvas_scene::CanvasScene,
    )>,
) -> Bindings {
    scene
        .files
        .iter()
        .filter_map(|(slot, file)| {
            let captured_target =
                captured.and_then(|snapshot| snapshot.canvas_target(slot, &file.target_file_id));
            let source = if captured_target.is_some_and(|target| {
                target.version == file.file_version && target.default_name == file.default_name
            }) {
                LibraryFileReadSource::CanvasRecovery {
                    document_id: capture.document_id.clone(),
                    draft_id: capture.draft_id.clone(),
                    scene_file_id: slot.clone(),
                }
            } else {
                let (authority, current_scene) = current?;
                let current_file = current_scene.files.get(slot)?;
                if current_file.target_file_id != file.target_file_id
                    || current_file.file_version != file.file_version
                    || current_file.default_name != file.default_name
                {
                    return None;
                }
                LibraryFileReadSource::Canvas {
                    canvas_id: authority.owner_block_id.clone(),
                    scene_file_id: slot.clone(),
                }
            };
            Some((
                slot.clone(),
                LibraryFileReadBinding {
                    file_id: file.target_file_id.clone(),
                    version: file.file_version,
                    source,
                },
            ))
        })
        .collect()
}

/// Captured identity wins wherever the merged body still uses it; unknown captures fail closed.
pub(super) fn merged_body_bindings(
    ids: &[String],
    retained_ids: &[String],
    retained: &Bindings,
    current: &Bindings,
) -> Bindings {
    ids.iter()
        .filter_map(|id| {
            let bindings = if retained_ids.contains(id) {
                retained
            } else {
                current
            };
            bindings
                .get(id)
                .cloned()
                .map(|binding| (id.clone(), binding))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merged_body_preserves_captured_targets_and_current_only_additions_without_guessing_unknowns()
    {
        let binding = |id: &str, version, source| LibraryFileReadBinding {
            file_id: id.to_owned(),
            version,
            source,
        };
        let captured = LibraryFileReadSource::RecoveryDraft {
            document_id: "doc".into(),
            draft_id: "draft".into(),
        };
        let page = LibraryFileReadSource::Page {
            page_id: "page".into(),
        };
        let retained = BTreeMap::from([("shared".into(), binding("shared", 1, captured.clone()))]);
        let current = BTreeMap::from([
            ("shared".into(), binding("shared", 2, page.clone())),
            ("later".into(), binding("later", 3, page.clone())),
            ("unknown".into(), binding("unknown", 4, page.clone())),
            ("removed".into(), binding("removed", 1, page)),
        ]);
        let result = merged_body_bindings(
            &["shared".into(), "later".into(), "unknown".into()],
            &["shared".into(), "unknown".into()],
            &retained,
            &current,
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result["shared"], retained["shared"]);
        assert_eq!(result["later"], current["later"]);
        assert!(!result.contains_key("unknown"));
        assert!(!result.contains_key("removed"));
    }
}
