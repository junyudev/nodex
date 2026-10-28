use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::block_materialization::MaterializedBlockNode;
use super::block_tree::MAX_BLOCK_ID_LENGTH;
use nodex_markdown::links::parse_page_link as parse_page_deep_link;
use serde_json::Value;

const MAX_REFERENCE_DISPLAY_HINT_LENGTH: usize = 512;
const NODEX_ASSET_SCHEME: &str = "nodex://assets/";
const NODEX_FILE_SCHEME: &str = "nodex://files/";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum BlockDocumentReference {
    #[serde(rename = "page")]
    Page {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "targetPageId")]
        target_page_id: String,
        presentation: PageReferencePresentation,
        #[serde(rename = "occurrenceCount")]
        occurrence_count: u32,
    },
    #[serde(rename = "block")]
    Block {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "targetBlockId")]
        target_block_id: String,
        #[serde(rename = "displayHint", skip_serializing_if = "Option::is_none")]
        display_hint: Option<String>,
    },
    #[serde(rename = "database_view")]
    DatabaseView {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "databaseViewId")]
        database_view_id: String,
        #[serde(rename = "displayHint", skip_serializing_if = "Option::is_none")]
        display_hint: Option<String>,
    },
    #[serde(rename = "session")]
    Session {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "targetSessionId")]
        target_session_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageReferencePresentation {
    Mention,
    ReferenceBlock,
    Link,
}

impl BlockDocumentReference {
    pub(crate) fn target_block_id(&self) -> Option<&str> {
        match self {
            Self::Page { target_page_id, .. } => Some(target_page_id),
            Self::Block {
                target_block_id, ..
            } => Some(target_block_id),
            Self::DatabaseView { .. } | Self::Session { .. } => None,
        }
    }

    pub(crate) fn database_view_id(&self) -> Option<&str> {
        match self {
            Self::DatabaseView {
                database_view_id, ..
            } => Some(database_view_id),
            Self::Page { .. } | Self::Block { .. } | Self::Session { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockDocumentAssetKind {
    Image,
    Attachment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDocumentAssetReference {
    pub source_block_id: String,
    pub kind: BlockDocumentAssetKind,
    pub source: String,
    pub managed_file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDocumentDerivedRecords {
    pub references: Vec<BlockDocumentReference>,
    pub asset_refs: Vec<BlockDocumentAssetReference>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DerivedRecordsError {
    #[error(
        "{label} must be a non-empty stable identity no longer than {MAX_BLOCK_ID_LENGTH} characters"
    )]
    InvalidReferenceId { label: &'static str },
    #[error(
        "Reference display hints must not exceed {MAX_REFERENCE_DISPLAY_HINT_LENGTH} characters"
    )]
    DisplayHintTooLong,
}

pub fn derive_block_document_records(
    block_tree: &[MaterializedBlockNode],
) -> Result<BlockDocumentDerivedRecords, DerivedRecordsError> {
    let mut records = BlockDocumentDerivedRecords {
        references: Vec::new(),
        asset_refs: Vec::new(),
    };
    collect_records(block_tree, &mut records)?;
    Ok(records)
}

fn collect_records(
    blocks: &[MaterializedBlockNode],
    records: &mut BlockDocumentDerivedRecords,
) -> Result<(), DerivedRecordsError> {
    for block in blocks {
        if let Some(content) = &block.content {
            collect_inline_records(&block.id, content, records)?;
        }
        let prop = |key: &str| {
            block
                .props
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        match block.block_type.as_str() {
            "image" => append_asset_reference(
                &mut records.asset_refs,
                &block.id,
                BlockDocumentAssetKind::Image,
                prop("url"),
            ),
            "pageRef" => {
                let target = prop("targetBlockId");
                assert_reference_id(target, "targetBlockId")?;
                append_page_reference(
                    &mut records.references,
                    block.id.clone(),
                    target.into(),
                    PageReferencePresentation::ReferenceBlock,
                );
            }
            "databaseViewRef" => {
                let target = prop("databaseViewId");
                assert_reference_id(target, "databaseViewId")?;
                records
                    .references
                    .push(BlockDocumentReference::DatabaseView {
                        source_block_id: block.id.clone(),
                        database_view_id: target.into(),
                        display_hint: read_display_hint(
                            &block
                                .props
                                .get("displayHint")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        )?,
                    });
            }
            "syncedBlockRef" | "templateRef" => {
                let target = prop("sourceBlockId");
                assert_reference_id(target, "sourceBlockId")?;
                records.references.push(BlockDocumentReference::Block {
                    source_block_id: block.id.clone(),
                    target_block_id: target.into(),
                    display_hint: read_display_hint(
                        &block
                            .props
                            .get("displayHint")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    )?,
                });
            }
            _ => {}
        }
        collect_records(&block.children, records)?;
    }
    Ok(())
}

fn collect_inline_records(
    source_block_id: &str,
    value: &Value,
    records: &mut BlockDocumentDerivedRecords,
) -> Result<(), DerivedRecordsError> {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_inline_records(source_block_id, item, records)?;
            }
        }
        Value::Object(object) => {
            let prop = |key: &str| {
                object
                    .get("props")
                    .and_then(|props| props.get(key))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            };
            match object.get("type").and_then(Value::as_str) {
                Some("pageMention") => {
                    let target = prop("targetPageId");
                    assert_reference_id(target, "targetPageId")?;
                    append_page_reference(
                        &mut records.references,
                        source_block_id.into(),
                        target.into(),
                        PageReferencePresentation::Mention,
                    );
                }
                Some("link") => {
                    if let Some(target) = object
                        .get("href")
                        .and_then(Value::as_str)
                        .and_then(parse_page_deep_link)
                    {
                        append_page_reference(
                            &mut records.references,
                            source_block_id.into(),
                            target,
                            PageReferencePresentation::Link,
                        );
                    }
                }
                Some("threadMention") => {
                    let target = prop("uuid");
                    assert_reference_id(target, "sessionId")?;
                    records.references.push(BlockDocumentReference::Session {
                        source_block_id: source_block_id.into(),
                        target_session_id: target.into(),
                    });
                }
                Some("attachment") => append_asset_reference(
                    &mut records.asset_refs,
                    source_block_id,
                    BlockDocumentAssetKind::Attachment,
                    prop("source"),
                ),
                Some("inlineImage") => {
                    append_asset_reference(
                        &mut records.asset_refs,
                        source_block_id,
                        BlockDocumentAssetKind::Image,
                        prop("url"),
                    );
                    if let Some(target) = parse_page_deep_link(prop("href")) {
                        append_page_reference(
                            &mut records.references,
                            source_block_id.into(),
                            target,
                            PageReferencePresentation::Link,
                        );
                    }
                }
                _ => {}
            }
            for key in ["content", "rows", "cells"] {
                if let Some(child) = object.get(key) {
                    collect_inline_records(source_block_id, child, records)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn append_page_reference(
    references: &mut Vec<BlockDocumentReference>,
    source_block_id: String,
    target_page_id: String,
    presentation: PageReferencePresentation,
) {
    if let Some(BlockDocumentReference::Page {
        occurrence_count, ..
    }) = references.iter_mut().find(|reference| {
        matches!(
            reference,
            BlockDocumentReference::Page {
                source_block_id: existing_source,
                target_page_id: existing_target,
                presentation: existing_presentation,
                ..
            } if existing_source == &source_block_id
                && existing_target == &target_page_id
                && *existing_presentation == presentation
        )
    }) {
        *occurrence_count = occurrence_count.saturating_add(1);
        return;
    }
    references.push(BlockDocumentReference::Page {
        source_block_id,
        target_page_id,
        presentation,
        occurrence_count: 1,
    });
}

fn append_asset_reference(
    output: &mut Vec<BlockDocumentAssetReference>,
    source_block_id: &str,
    kind: BlockDocumentAssetKind,
    source: &str,
) {
    if source.is_empty() {
        return;
    }
    output.push(BlockDocumentAssetReference {
        source_block_id: source_block_id.to_owned(),
        kind,
        source: source.to_owned(),
        managed_file_name: parse_asset_source(source),
        file_id: parse_page_file_source(source),
    });
}

fn assert_reference_id(value: &str, label: &'static str) -> Result<(), DerivedRecordsError> {
    if value.is_empty() || value.trim() != value || value.len() > MAX_BLOCK_ID_LENGTH {
        return Err(DerivedRecordsError::InvalidReferenceId { label });
    }
    Ok(())
}

fn read_display_hint(value: &Option<String>) -> Result<Option<String>, DerivedRecordsError> {
    let Some(value) = value.as_ref().filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > MAX_REFERENCE_DISPLAY_HINT_LENGTH {
        return Err(DerivedRecordsError::DisplayHintTooLong);
    }
    Ok(Some(value.clone()))
}

pub(crate) fn parse_asset_source(source: &str) -> Option<String> {
    let encoded = source.strip_prefix(NODEX_ASSET_SCHEME)?;
    if encoded.is_empty() || encoded.contains('/') {
        return None;
    }
    let decoded = percent_decode(encoded)?;
    decoded
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        .then_some(decoded)
}

pub(crate) fn parse_page_file_source(source: &str) -> Option<String> {
    let file_id = source.strip_prefix(NODEX_FILE_SCHEME)?;
    if file_id.is_empty()
        || file_id.len() > MAX_BLOCK_ID_LENGTH
        || file_id.trim() != file_id
        || file_id.contains('/')
        || file_id.contains('%')
        || file_id.chars().any(char::is_control)
    {
        return None;
    }
    Some(file_id.to_owned())
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        output.push(hex_value(high)? * 16 + hex_value(low)?);
        index += 3;
    }
    String::from_utf8(output).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::Value;
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, Update};

    use crate::document::create_compatible_document;
    use crate::domain::block_materialization::materialize_block_tree;
    use crate::domain::block_tree::decode_block_tree;

    use super::*;

    #[test]
    fn inline_images_are_assets_and_caption_markup_is_plain_text() {
        let blocks: Vec<MaterializedBlockNode> = serde_json::from_value(serde_json::json!([
            {"id":"text","type":"paragraph","props":{},"content":[{"type":"inlineImage","props":{"url":"nodex://files/inline","alt":"Searchable badge","width":32,"href":"nodex://pages/linked"}},{"type":"threadMention","props":{"uuid":"session"}}],"children":[]},
            {"id":"image","type":"image","props":{"url":"nodex://files/block","caption":"Literal **caption** :attachment{source=hidden}"},"children":[]}
        ])).unwrap();
        let records = derive_block_document_records(&blocks).unwrap();
        assert_eq!(
            records
                .asset_refs
                .iter()
                .map(|asset| asset.file_id.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["inline", "block"]
        );
        assert!(records.references.iter().any(|reference| matches!(reference,BlockDocumentReference::Session { target_session_id, .. } if target_session_id=="session")));
        assert!(records.references.iter().any(|reference| matches!(reference,BlockDocumentReference::Page { target_page_id, presentation:PageReferencePresentation::Link, .. } if target_page_id=="linked")));
        let text = crate::domain::markdown::materialize_markdown(&blocks)
            .unwrap()
            .plain_text;
        assert!(text.contains("Searchable badge"));
        assert!(text.contains("Literal **caption** :attachment{source=hidden}"));
        let mut copied = blocks.clone();
        crate::domain::files::remap_block_files(
            &mut copied,
            &std::collections::BTreeMap::from([("inline".into(), "copied".into())]),
        );
        assert_eq!(
            copied[0].content.as_ref().unwrap()[0]["props"]["url"],
            "nodex://files/copied"
        );
        assert_eq!(
            copied[0].content.as_ref().unwrap()[0]["props"]["href"],
            "nodex://pages/linked"
        );
        assert_eq!(copied[1].props, blocks[1].props);
    }

    #[test]
    fn matches_the_typescript_reference_and_asset_oracle() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let document = create_compatible_document("derived-record-matrix");
        let update = std::fs::read(root.join("matrix-base.bin")).expect("matrix fixture");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&update).expect("valid fixture"))
            .expect("fixture applies");
        let transaction = document.transact();
        let body = transaction.get_xml_fragment("body").expect("body root");
        let tree = decode_block_tree(&body, &transaction).expect("BlockTree");
        let blocks = materialize_block_tree(&tree).expect("BlockNote materialization");
        let actual =
            serde_json::to_value(derive_block_document_records(&blocks).expect("derived records"))
                .expect("serialize derived records");
        let expected: Value = serde_json::from_slice(
            &std::fs::read(root.join("matrix-materialization.json")).expect("oracle fixture"),
        )
        .expect("valid oracle fixture");

        assert_eq!(actual["references"], expected["references"]);
        assert_eq!(actual["assetRefs"], expected["assetRefs"]);
    }

    #[test]
    fn accepts_only_safe_managed_asset_sources() {
        assert_eq!(
            parse_asset_source("nodex://assets/example%2Etxt"),
            Some("example.txt".to_owned())
        );
        assert_eq!(parse_asset_source("nodex://assets/../secret"), None);
        assert_eq!(parse_asset_source("https://nodex.local/example.txt"), None);
    }
}
