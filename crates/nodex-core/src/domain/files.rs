use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::file_path::normalize_file_name;

pub(crate) fn validate_file_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > 512
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            format!("{label} identity is invalid"),
            false,
        ));
    }
    Ok(())
}

pub(crate) fn normalize_file_mime_type(value: &str) -> Result<String, StoreError> {
    if value.is_empty()
        || value.len() > 255
        || value.trim() != value
        || value.chars().any(char::is_control)
        || !value.contains('/')
    {
        return Err(invalid("File MIME type is invalid"));
    }
    Ok(value.to_ascii_lowercase())
}

/// Exact content and fallback presentation captured alongside a Document. The
/// map gives canonical ordering and one binding for every repeated File ID.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileSnapshotManifest {
    pub(crate) files: BTreeMap<String, FileSnapshotTarget>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileSnapshotTarget {
    pub(crate) version: i64,
    pub(crate) default_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileRestoreHead {
    pub(crate) version: i64,
    pub(crate) revision: i64,
    pub(crate) default_name: String,
    pub(crate) live: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FileRestoreAction {
    Reuse {
        file_id: String,
        expected_revision: i64,
    },
    Fork {
        source_file_id: String,
        source_version: i64,
        default_name: String,
        expected_revision: i64,
    },
}

impl FileSnapshotManifest {
    pub(crate) fn validate(&self) -> Result<(), StoreError> {
        for (file_id, target) in &self.files {
            validate_file_identity(file_id, "Snapshot File")?;
            if target.version < 1 {
                return Err(invalid(
                    "File snapshot contains an invalid identity or version",
                ));
            }
            if normalize_file_name(&target.default_name)? != target.default_name {
                return Err(invalid("File snapshot name is not canonical"));
            }
        }
        Ok(())
    }

    /// The caller rechecks every expected revision while applying this plan in
    /// the same transaction as the forward Document restore. Shared heads are
    /// never rolled back, including when only their fallback name has changed.
    pub(crate) fn plan_restore(
        &self,
        heads: &BTreeMap<String, FileRestoreHead>,
    ) -> Result<Vec<FileRestoreAction>, StoreError> {
        self.validate()?;
        self.files
            .iter()
            .map(|(file_id, target)| {
                let head = heads.get(file_id).ok_or_else(|| {
                    StoreError::new(
                        StoreErrorCode::StoreCorrupt,
                        "Retained File snapshot lost its File identity",
                        false,
                    )
                })?;
                if head.live
                    && head.version == target.version
                    && head.default_name == target.default_name
                {
                    return Ok(FileRestoreAction::Reuse {
                        file_id: file_id.clone(),
                        expected_revision: head.revision,
                    });
                }
                Ok(FileRestoreAction::Fork {
                    source_file_id: file_id.clone(),
                    source_version: target.version,
                    default_name: target.default_name.clone(),
                    expected_revision: head.revision,
                })
            })
            .collect()
    }
}

/// Retarget only actual media/attachment occurrences. Text, links, names and
/// other metadata that happen to contain a File URI are preserved verbatim.
pub(crate) fn remap_block_files(
    blocks: &mut [super::block_materialization::MaterializedBlockNode],
    mapping: &BTreeMap<String, String>,
) {
    for block in blocks {
        if block.block_type == "image" {
            if let Some(source) = block.props.get_mut("url") {
                remap_source(source, mapping);
            }
            if let Some(serde_json::Value::String(caption)) = block.props.get_mut("caption") {
                let mut content = super::nfm::parse_inline_content(caption);
                let mut changed = false;
                for item in &mut content {
                    let super::nfm::NfmInlineContent::Attachment { source, .. } = item else {
                        continue;
                    };
                    if let Some(target) = mapped_source(source, mapping) {
                        *source = target;
                        changed = true;
                    }
                }
                if changed {
                    *caption = super::nfm::serialize_inline_content_for_adapter(&content);
                }
            }
        }
        if let Some(content) = &mut block.content {
            remap_inline_files(content, mapping);
        }
        remap_block_files(&mut block.children, mapping);
    }
}

fn remap_inline_files(value: &mut serde_json::Value, mapping: &BTreeMap<String, String>) {
    match value {
        serde_json::Value::Array(items) => items
            .iter_mut()
            .for_each(|item| remap_inline_files(item, mapping)),
        serde_json::Value::Object(object) => {
            if object.get("type").and_then(serde_json::Value::as_str) == Some("attachment") {
                if let Some(source) = object
                    .get_mut("props")
                    .and_then(|props| props.get_mut("source"))
                {
                    remap_source(source, mapping);
                }
                return;
            }
            object
                .values_mut()
                .for_each(|item| remap_inline_files(item, mapping));
        }
        _ => {}
    }
}

fn remap_source(value: &mut serde_json::Value, mapping: &BTreeMap<String, String>) {
    if let Some(source) = value
        .as_str()
        .and_then(|source| mapped_source(source, mapping))
    {
        *value = serde_json::Value::String(source);
    }
}

fn mapped_source(source: &str, mapping: &BTreeMap<String, String>) -> Option<String> {
    let id = super::derived_records::parse_page_file_source(source)?;
    let target = mapping.get(&id)?;
    (target != &id).then(|| format!("nodex://files/{target}"))
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> FileSnapshotManifest {
        FileSnapshotManifest {
            files: BTreeMap::from([(
                "file-image".to_owned(),
                FileSnapshotTarget {
                    version: 1,
                    default_name: "image.png".to_owned(),
                },
            )]),
        }
    }

    fn head() -> FileRestoreHead {
        FileRestoreHead {
            version: 1,
            revision: 1,
            default_name: "image.png".to_owned(),
            live: true,
        }
    }

    #[test]
    fn library_file_restore_reuses_an_unchanged_live_target() {
        let plan = snapshot()
            .plan_restore(&BTreeMap::from([("file-image".to_owned(), head())]))
            .unwrap();
        assert_eq!(
            plan,
            vec![FileRestoreAction::Reuse {
                file_id: "file-image".to_owned(),
                expected_revision: 1,
            }]
        );
    }

    #[test]
    fn library_file_restore_forks_changed_content_name_or_lifecycle() {
        for current in [
            FileRestoreHead {
                version: 2,
                revision: 2,
                ..head()
            },
            FileRestoreHead {
                default_name: "new.png".to_owned(),
                revision: 2,
                ..head()
            },
            FileRestoreHead {
                live: false,
                revision: 2,
                ..head()
            },
        ] {
            let heads = BTreeMap::from([("file-image".to_owned(), current.clone())]);
            let plan = snapshot().plan_restore(&heads).unwrap();
            assert_eq!(
                plan,
                vec![FileRestoreAction::Fork {
                    source_file_id: "file-image".to_owned(),
                    source_version: 1,
                    default_name: "image.png".to_owned(),
                    expected_revision: 2,
                }]
            );
            assert_eq!(heads["file-image"], current);
        }
    }

    #[test]
    fn library_file_snapshot_identity_changes_when_only_content_changes() {
        let before = snapshot();
        let mut after = before.clone();
        after.files.get_mut("file-image").unwrap().version = 2;
        assert_ne!(
            serde_json::to_vec(&before).unwrap(),
            serde_json::to_vec(&after).unwrap()
        );
        assert!(before.plan_restore(&BTreeMap::new()).is_err());
    }
}
