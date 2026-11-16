use nodex_core_contracts::library::{
    LibraryContentAssetReference, LibraryContentReference, LibraryPageContent,
    LibraryPageReferencePresentation,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::domain::derived_records::{BlockDocumentReference, PageReferencePresentation};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_IDENTITY_BYTES: usize = 512;
const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_DERIVED_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_DERIVED_RECORDS: usize = 10_000;

struct RawPageContent {
    page_id: String,
    metadata_revision: i64,
    document_id: String,
    document_generation: i64,
    document_head_seq: i64,
    schema_key: String,
    schema_version: i64,
    readiness: String,
    materialization_generation: Option<i64>,
    projected_seq: Option<i64>,
    materialization_schema_version: Option<i64>,
    title: Option<String>,
    rich_title_json: Option<String>,
    markdown: Option<String>,
    plain_text: Option<String>,
    preview: Option<String>,
    references_json: Option<String>,
    asset_refs_json: Option<String>,
}

pub(super) fn page_content(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    page_id: &str,
) -> Result<LibraryPageContent, StoreError> {
    validate_identity(page_id, "Page content identity")?;
    let row = connection
        .query_row(
            "SELECT page.block_id, owner.metadata_revision, page.document_id, \
               document.generation, document.head_seq, document.schema_key, \
               document.schema_version, document.readiness, materialization.generation, \
               materialization.projected_seq, materialization.schema_version, \
               materialization.title, materialization.title_rich_json, materialization.markdown, \
               materialization.plain_text, materialization.preview, \
               materialization.references_json, materialization.asset_refs_json \
             FROM pages page JOIN blocks owner \
               ON owner.id = page.block_id AND owner.library_id = page.library_id \
             JOIN documents document \
               ON document.id = page.document_id AND document.library_id = page.library_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND owner.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| {
                Ok(RawPageContent {
                    page_id: row.get(0)?,
                    metadata_revision: row.get(1)?,
                    document_id: row.get(2)?,
                    document_generation: row.get(3)?,
                    document_head_seq: row.get(4)?,
                    schema_key: row.get(5)?,
                    schema_version: row.get(6)?,
                    readiness: row.get(7)?,
                    materialization_generation: row.get(8)?,
                    projected_seq: row.get(9)?,
                    materialization_schema_version: row.get(10)?,
                    title: row.get(11)?,
                    rich_title_json: row.get(12)?,
                    markdown: row.get(13)?,
                    plain_text: row.get(14)?,
                    preview: row.get(15)?,
                    references_json: row.get(16)?,
                    asset_refs_json: row.get(17)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library Page content is unavailable"))?;
    let exact = row.readiness == "ready"
        && row.document_generation >= 1
        && row.document_head_seq >= 0
        && row.schema_version >= 1
        && row.materialization_generation == Some(row.document_generation)
        && row.projected_seq == Some(row.document_head_seq)
        && row.materialization_schema_version == Some(row.schema_version);
    if !exact {
        return Err(revision_conflict(
            "Library Page does not have an exact current materialization",
        ));
    }
    let title = require_content(row.title, "Page title")?;
    let rich_title = parse_rich_title(row.rich_title_json)?;
    let body_markdown = require_content(row.markdown, "Page Nodex Markdown")?;
    let plain_text = require_content(row.plain_text, "Page plain text")?;
    let preview = require_content(row.preview, "Page preview")?;
    let references = parse_json_array::<BlockDocumentReference>(
        row.references_json,
        "Page references",
        MAX_DERIVED_JSON_BYTES,
        MAX_DERIVED_RECORDS,
    )?
    .into_iter()
    .map(content_reference)
    .collect();
    let asset_refs = parse_json_array::<LibraryContentAssetReference>(
        row.asset_refs_json,
        "Page asset references",
        MAX_DERIVED_JSON_BYTES,
        MAX_DERIVED_RECORDS,
    )?;

    Ok(LibraryPageContent {
        library_id: library_id.to_owned(),
        store_epoch: store_epoch.to_owned(),
        commit_seq: commit_head,
        page_id: row.page_id,
        metadata_revision: row.metadata_revision,
        document_id: row.document_id,
        document_generation: row.document_generation,
        document_head_seq: row.document_head_seq,
        schema_key: row.schema_key,
        schema_version: row.schema_version,
        title,
        rich_title,
        body_markdown,
        plain_text,
        preview,
        references,
        asset_refs,
    })
}

// Decode storage through its owner and project every variant explicitly. A
// new canonical reference kind must be handled before Library reads compile.
fn content_reference(reference: BlockDocumentReference) -> LibraryContentReference {
    match reference {
        BlockDocumentReference::Page {
            source_block_id,
            target_page_id,
            presentation,
            occurrence_count,
        } => LibraryContentReference::Page {
            source_block_id,
            target_page_id,
            occurrence_count,
            presentation: match presentation {
                PageReferencePresentation::Mention => LibraryPageReferencePresentation::Mention,
                PageReferencePresentation::ReferenceBlock => {
                    LibraryPageReferencePresentation::ReferenceBlock
                }
                PageReferencePresentation::Link => LibraryPageReferencePresentation::Link,
            },
        },
        BlockDocumentReference::Block {
            source_block_id,
            target_block_id,
            display_hint,
        } => LibraryContentReference::Block {
            source_block_id,
            target_block_id,
            display_hint,
        },
        BlockDocumentReference::DatabaseView {
            source_block_id,
            database_view_id,
            display_hint,
        } => LibraryContentReference::DatabaseView {
            source_block_id,
            database_view_id,
            display_hint,
        },
        BlockDocumentReference::Session {
            source_block_id,
            target_session_id,
        } => LibraryContentReference::Session {
            source_block_id,
            target_session_id,
        },
    }
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= MAX_IDENTITY_BYTES && value.trim() == value {
        return Ok(());
    }
    Err(invalid(&format!("{label} must be canonical and bounded")))
}

fn require_content(value: Option<String>, label: &str) -> Result<String, StoreError> {
    let value =
        value.ok_or_else(|| revision_conflict("Library Page materialization is incomplete"))?;
    if value.len() <= MAX_CONTENT_BYTES {
        return Ok(value);
    }
    Err(corrupt(&format!("{label} exceeds its storage bound")))
}

pub(super) fn parse_rich_title(value: Option<String>) -> Result<Value, StoreError> {
    parse_json_value_array(
        value,
        "Page rich title",
        MAX_DERIVED_JSON_BYTES,
        MAX_DERIVED_RECORDS,
    )
}

fn parse_json_value_array(
    value: Option<String>,
    label: &str,
    maximum_bytes: usize,
    maximum_items: usize,
) -> Result<Value, StoreError> {
    let value =
        value.ok_or_else(|| revision_conflict("Library Page materialization is incomplete"))?;
    if value.len() > maximum_bytes {
        return Err(corrupt(&format!("{label} exceeds its storage bound")));
    }
    let parsed = serde_json::from_str::<Value>(&value)
        .map_err(|_| corrupt(&format!("{label} contains invalid JSON")))?;
    let Value::Array(items) = &parsed else {
        return Err(corrupt(&format!("{label} must be a JSON array")));
    };
    if items.len() > maximum_items {
        return Err(corrupt(&format!("{label} exceeds its item bound")));
    }
    Ok(parsed)
}

fn parse_json_array<T: serde::de::DeserializeOwned>(
    value: Option<String>,
    label: &str,
    maximum_bytes: usize,
    maximum_items: usize,
) -> Result<Vec<T>, StoreError> {
    let value =
        value.ok_or_else(|| revision_conflict("Library Page materialization is incomplete"))?;
    if value.len() > maximum_bytes {
        return Err(corrupt(&format!("{label} exceeds its storage bound")));
    }
    let parsed = serde_json::from_str::<Vec<T>>(&value)
        .map_err(|_| corrupt(&format!("{label} contains invalid JSON")))?;
    if parsed.len() > maximum_items {
        return Err(corrupt(&format!("{label} exceeds its item bound")));
    }
    Ok(parsed)
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn revision_conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::library::{LibraryContentAssetReference, LibraryContentReference};
    use serde_json::json;

    use super::parse_json_array;

    #[test]
    fn projects_every_canonical_reference_kind_without_losing_page_occurrences() {
        use crate::domain::derived_records::BlockDocumentReference;
        let wire = json!([
            { "kind": "page", "sourceBlockId": "source", "targetPageId": "page", "presentation": "mention", "occurrenceCount": 2 },
            { "kind": "page", "sourceBlockId": "source", "targetPageId": "page", "presentation": "reference_block", "occurrenceCount": 1 },
            { "kind": "page", "sourceBlockId": "source", "targetPageId": "page", "presentation": "link", "occurrenceCount": 3 },
            { "kind": "block", "sourceBlockId": "source", "targetBlockId": "block", "displayHint": "Block" },
            { "kind": "database_view", "sourceBlockId": "source", "databaseViewId": "view", "displayHint": "View" },
            { "kind": "session", "sourceBlockId": "source", "targetSessionId": "thread" }
        ]);
        let canonical = parse_json_array::<BlockDocumentReference>(
            Some(wire.to_string()),
            "references",
            4096,
            10,
        )
        .unwrap();
        let projected = canonical
            .into_iter()
            .map(super::content_reference)
            .collect::<Vec<_>>();
        assert_eq!(serde_json::to_value(&projected).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<Vec<LibraryContentReference>>(wire).unwrap(),
            projected
        );
    }

    #[test]
    fn preserves_typed_reference_and_asset_wire_shapes() {
        let references = parse_json_array::<LibraryContentReference>(
            Some(
                r#"[{"kind":"block","sourceBlockId":"source","targetBlockId":"target"}]"#
                    .to_owned(),
            ),
            "references",
            1_024,
            10,
        )
        .expect("references");
        let assets = parse_json_array::<LibraryContentAssetReference>(
            Some(
                r#"[{"sourceBlockId":"source","kind":"image","source":"nodex://assets/file.png","managedFileName":"file.png"}]"#
                    .to_owned(),
            ),
            "assets",
            1_024,
            10,
        )
        .expect("assets");

        assert_eq!(
            serde_json::to_value(references).expect("reference JSON"),
            json!([{
                "kind": "block",
                "sourceBlockId": "source",
                "targetBlockId": "target",
            }])
        );
        assert_eq!(
            serde_json::to_value(assets).expect("asset JSON"),
            json!([{
                "sourceBlockId": "source",
                "kind": "image",
                "source": "nodex://assets/file.png",
                "managedFileName": "file.png",
            }])
        );
    }
}
