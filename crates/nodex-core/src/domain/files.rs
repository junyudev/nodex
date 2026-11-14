use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
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

static GENERATED_IMAGE_STEM: LazyLock<Regex> = LazyLock::new(|| {
    // Chat storage uses thread-prefixed UUIDs and may prefix materialized names with a digest.
    Regex::new(concat!(
        r"(?i)^(?:",
        r"(?:[a-z0-9_]+-)*[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-[a-z0-9]{1,10})?",
        r"|[a-f0-9]{16}-[a-z0-9._-]+|[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64}|image-[a-f0-9]{8})$"
    ))
    .expect("valid generated image name pattern")
});

static UNNAMED_CHAT_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^image(?: [0-9]+)?$").expect("valid unnamed chat image pattern")
});

/// Choose a default at import. Existing File names can also be copied or explicitly renamed.
pub(crate) fn imported_file_name<'a>(name: &'a str, mime_type: &str) -> Cow<'a, str> {
    let mime = mime_type.to_ascii_lowercase();
    let Some(subtype) = mime
        .split(';')
        .next()
        .and_then(|mime| mime.trim().strip_prefix("image/"))
    else {
        return name.into();
    };
    // Only inspect portable basenames. A directory in a supplied name is still invalid.
    if name.contains(['/', '\\']) {
        return name.into();
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let pasted = stem.strip_prefix("pasted-image-").is_some_and(|suffix| {
        suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    let label = if name == "Pasted image" || pasted {
        "Pasted image"
    } else if name.trim().is_empty()
        || GENERATED_IMAGE_STEM.is_match(stem)
        || UNNAMED_CHAT_IMAGE.is_match(name)
    {
        "Image"
    } else {
        return name.into();
    };
    let extension = match subtype {
        "jpeg" | "pjpeg" => "jpg",
        "x-png" => "png",
        "svg+xml" => "svg",
        "vnd.microsoft.icon" | "x-icon" => "ico",
        "x-ms-bmp" => "bmp",
        subtype
            if !subtype.is_empty() && subtype.bytes().all(|byte| byte.is_ascii_alphanumeric()) =>
        {
            subtype
        }
        _ => return label.into(),
    };
    format!("{label}.{extension}").into()
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
    let sources = mapping
        .iter()
        .map(|(source, target)| {
            (
                format!("nodex://files/{source}"),
                format!("nodex://files/{target}"),
            )
        })
        .collect();
    remap_block_asset_sources(blocks, &sources);
}

/// Rewrites only image and attachment source fields, including inline images. Code,
/// ordinary links, names and other metadata remain verbatim.
pub(crate) fn remap_block_asset_sources(
    blocks: &mut [super::block_materialization::MaterializedBlockNode],
    mapping: &BTreeMap<String, String>,
) {
    for block in blocks {
        if block.block_type == "image"
            && let Some(source) = block.props.get_mut("url")
        {
            remap_source(source, mapping);
        }
        if let Some(content) = &mut block.content {
            remap_inline_files(content, mapping);
        }
        remap_block_asset_sources(&mut block.children, mapping);
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
            if object.get("type").and_then(serde_json::Value::as_str) == Some("inlineImage") {
                if let Some(source) = object
                    .get_mut("props")
                    .and_then(|props| props.get_mut("url"))
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
    mapping
        .get(source)
        .filter(|target| *target != source)
        .cloned()
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_image_names_use_the_mime_type_when_the_source_has_no_name() {
        let uuid = "600ee52b-c6b1-4424-b821-fe75ff6a48a3";
        let hash = "b".repeat(64);
        for (name, mime_type, expected) in [
            ("", "image/png", "Image.png"),
            ("   ", "image/webp", "Image.webp"),
            ("Pasted image", "image/jpeg", "Pasted image.jpg"),
            ("Image 1", "image/gif", "Image.gif"),
            ("pasted-image-deadbeef.png", "image/png", "Pasted image.png"),
            ("image-deadbeef.png", "image/png", "Image.png"),
            (&format!("{uuid}.png"), "image/jpeg", "Image.jpg"),
            (&format!("thread-{uuid}.png"), "image/png", "Image.png"),
            (&format!("thread-{uuid}-png.png"), "image/png", "Image.png"),
            (&format!("{hash}.blob"), "image/svg+xml", "Image.svg"),
            ("a3b59d798871d6b0-image.png", "image/png", "Image.png"),
            ("flamegraph.png", "image/png", "flamegraph.png"),
            ("image.png", "image/png", "image.png"),
            (
                "Screenshot 2026-11-14 at 22.17.03.png",
                "image/png",
                "Screenshot 2026-11-14 at 22.17.03.png",
            ),
            (
                &format!("{uuid}.png"),
                "application/octet-stream",
                &format!("{uuid}.png"),
            ),
        ] {
            assert_eq!(imported_file_name(name, mime_type), expected, "{name}");
        }
    }

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
