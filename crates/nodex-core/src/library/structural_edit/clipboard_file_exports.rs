//! Clipboard exports bind bytes without changing live File identity or Cut history.
use super::*;

const PAYLOAD_VERSION: u32 = 1;
const MAX_EXPORT_FILES: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ClipboardBundlePayload {
    format_version: u32,
    pub(super) selection: OwnershipClosureSnapshot,
    capture_project_id: Option<String>,
    file_exports: FileExports,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum FileExports {
    NotRequested,
    Unavailable,
    Complete {
        bindings: BTreeMap<String, FileBinding>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileBinding {
    version: i64,
    default_name: String,
}

pub(crate) struct FileExportTarget {
    pub version: i64,
    pub default_name: String,
    pub source_document_id: String,
}

pub(super) fn capture(
    connection: &Connection,
    context: &BoundModuleContext,
    selection: OwnershipClosureSnapshot,
    candidates: Option<&[String]>,
) -> ClipboardBundlePayload {
    let file_exports = match candidates {
        None => FileExports::NotRequested,
        Some(candidates) => capture_bindings(connection, context, &selection, candidates)
            .map(|bindings| FileExports::Complete { bindings })
            .unwrap_or(FileExports::Unavailable),
    };
    ClipboardBundlePayload {
        format_version: PAYLOAD_VERSION,
        selection,
        capture_project_id: context.project_id.as_ref().map(|id| id.0.clone()),
        file_exports,
    }
}

fn capture_bindings(
    connection: &Connection,
    context: &BoundModuleContext,
    selection: &OwnershipClosureSnapshot,
    candidates: &[String],
) -> Result<BTreeMap<String, FileBinding>, StoreError> {
    if candidates.len() > MAX_EXPORT_FILES {
        return Err(invalid("Clipboard File export exceeds its bound"));
    }
    let mut members: BTreeSet<_> = structural_file_ids(&selection.roots)?.into_iter().collect();
    for document in &selection.documents {
        let OwnedDocumentBody::Yjs { blocks, .. } = &document.body else {
            // Canvas occurrences can bind different versions of one File locator.
            return Err(invalid("Clipboard File export has ambiguous versions"));
        };
        members.extend(structural_file_ids(blocks)?);
    }
    candidates
        .iter()
        .map(|file_id| {
            if !members.contains(file_id) {
                return Err(unauthorized("Clipboard File is not a selected occurrence"));
            }
            let file = super::super::files::metadata(connection, &context.library_id.0, file_id)?;
            Ok((
                file_id.clone(),
                FileBinding {
                    version: file.head_version,
                    default_name: file.default_name,
                },
            ))
        })
        .collect()
}

pub(super) fn decode(json: &str) -> Result<ClipboardBundlePayload, StoreError> {
    ensure_payload_bound(json, "Structural clipboard snapshot")?;
    // Historical bundles retain copy/paste semantics, but cannot invent frozen bytes.
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| corrupt("Structural clipboard snapshot is invalid"))?;
    if value.get("formatVersion").is_none() {
        let selection = serde_json::from_value(value)
            .map_err(|_| corrupt("Structural clipboard snapshot is invalid"))?;
        return Ok(ClipboardBundlePayload {
            format_version: PAYLOAD_VERSION,
            selection,
            capture_project_id: None,
            file_exports: FileExports::Unavailable,
        });
    }
    let payload: ClipboardBundlePayload = serde_json::from_value(value)
        .map_err(|_| corrupt("Structural clipboard payload is invalid"))?;
    if payload.format_version != PAYLOAD_VERSION {
        return Err(corrupt(
            "Structural clipboard payload version is unsupported",
        ));
    }
    Ok(payload)
}

pub(crate) fn resolve(
    connection: &Connection,
    context: &BoundModuleContext,
    token: &LibraryStructuralClipboardToken,
    file_id: &str,
) -> Result<FileExportTarget, StoreError> {
    let epoch = crate::document::read_store_epoch(connection)?;
    let payload = read_bundle_payload(connection, &context.library_id.0, &epoch, token)?;
    if payload.capture_project_id.as_deref() != context.project_id.as_ref().map(|id| id.0.as_str())
    {
        return Err(unauthorized(
            "Clipboard File export belongs to another access scope",
        ));
    }
    let parent = load_parent_document(connection, &payload.selection.source.document_id)?;
    authorize_parent_access(connection, context, &parent, false)?;
    let FileExports::Complete { mut bindings } = payload.file_exports else {
        return Err(unauthorized("Clipboard File export is unavailable"));
    };
    let binding = bindings
        .remove(file_id)
        .ok_or_else(|| unauthorized("File is not bound by this clipboard"))?;
    Ok(FileExportTarget {
        version: binding.version,
        default_name: binding.default_name,
        source_document_id: payload.selection.source.document_id,
    })
}
