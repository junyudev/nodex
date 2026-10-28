use serde::{Deserialize, Serialize};
use thiserror::Error;
use yrs::{Doc, Out, ReadTxn, Transact};

use crate::domain::block_tree::{
    BlockTree, BlockTreeError, TextDelta, decode_block_tree,
    decode_block_tree_allowing_illegal_children, decode_text_delta, encode_block_tree,
    replace_text_delta,
};

use super::create_compatible_document;

pub const PAGE_SCHEMA_KEY: &str = "nodex.page";
pub const PAGE_SCHEMA_VERSION: u32 = 4;
pub const SYNCED_BLOCK_SCHEMA_KEY: &str = "nodex.synced-block";
pub const SYNCED_BLOCK_SCHEMA_VERSION: u32 = 3;
pub const REUSABLE_TEMPLATE_SCHEMA_KEY: &str = "nodex.reusable-template";
pub const REUSABLE_TEMPLATE_SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockDocumentSchema {
    PageV4,
    SyncedBlockV3,
    ReusableTemplateV3,
}

pub(crate) fn decode_block_document_allowing_illegal_children(
    document: &Doc,
    schema: BlockDocumentSchema,
) -> Result<DecodedBlockDocument, BlockDocumentError> {
    let transaction = document.transact();
    validate_roots(&transaction, schema)?;
    let title = if schema.has_title() {
        Some(
            transaction
                .get_text("title")
                .map(|title| decode_text_delta(&title, &transaction))
                .transpose()?
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let body = transaction
        .get_xml_fragment("body")
        .ok_or(BlockDocumentError::MissingBody)?;
    let block_tree = decode_block_tree_allowing_illegal_children(&body, &transaction)?;
    Ok(DecodedBlockDocument {
        document_id: document.guid().to_string(),
        schema,
        title,
        block_tree,
    })
}

impl BlockDocumentSchema {
    pub fn from_identity(schema_key: &str, schema_version: i64) -> Option<Self> {
        match (schema_key, schema_version) {
            (PAGE_SCHEMA_KEY, 4) => Some(Self::PageV4),
            (SYNCED_BLOCK_SCHEMA_KEY, 3) => Some(Self::SyncedBlockV3),
            (REUSABLE_TEMPLATE_SCHEMA_KEY, 3) => Some(Self::ReusableTemplateV3),
            _ => None,
        }
    }

    pub fn schema_key(self) -> &'static str {
        match self {
            Self::PageV4 => PAGE_SCHEMA_KEY,
            Self::SyncedBlockV3 => SYNCED_BLOCK_SCHEMA_KEY,
            Self::ReusableTemplateV3 => REUSABLE_TEMPLATE_SCHEMA_KEY,
        }
    }

    pub fn schema_version(self) -> u32 {
        match self {
            Self::PageV4 => PAGE_SCHEMA_VERSION,
            Self::SyncedBlockV3 => SYNCED_BLOCK_SCHEMA_VERSION,
            Self::ReusableTemplateV3 => REUSABLE_TEMPLATE_SCHEMA_VERSION,
        }
    }

    pub fn has_title(self) -> bool {
        matches!(self, Self::PageV4)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedBlockDocument {
    pub document_id: String,
    pub schema: BlockDocumentSchema,
    pub title: Option<Vec<TextDelta>>,
    pub block_tree: BlockTree,
}

#[derive(Debug, Error, PartialEq)]
pub enum BlockDocumentError {
    #[error("document contains unsupported named root {0}")]
    UnexpectedRoot(String),
    #[error("document root {name} has incompatible type {actual}")]
    IncompatibleRoot { name: String, actual: String },
    #[error("document is missing required body root")]
    MissingBody,
    #[error(transparent)]
    BlockTree(#[from] BlockTreeError),
}

pub fn decode_block_document(
    document: &Doc,
    schema: BlockDocumentSchema,
) -> Result<DecodedBlockDocument, BlockDocumentError> {
    let transaction = document.transact();
    validate_roots(&transaction, schema)?;

    let title = if schema.has_title() {
        match transaction.get_text("title") {
            Some(title) => {
                let delta = decode_text_delta(&title, &transaction)?;
                Some(delta)
            }
            None => Some(Vec::new()),
        }
    } else {
        None
    };
    let body = transaction
        .get_xml_fragment("body")
        .ok_or(BlockDocumentError::MissingBody)?;
    let block_tree = decode_block_tree(&body, &transaction)?;

    Ok(DecodedBlockDocument {
        document_id: document.guid().to_string(),
        schema,
        title,
        block_tree,
    })
}

pub fn encode_block_document(
    document_id: &str,
    schema: BlockDocumentSchema,
    title: Option<&[TextDelta]>,
    block_tree: &BlockTree,
) -> Result<Doc, BlockDocumentError> {
    let document = create_compatible_document(document_id);
    if schema.has_title() {
        let title_delta = title.unwrap_or_default();
        let title_root = document.get_or_insert_text("title");
        replace_text_delta(&title_root, &mut document.transact_mut(), title_delta);
    } else if title.is_some() {
        return Err(BlockDocumentError::UnexpectedRoot("title".to_owned()));
    }

    let body = document.get_or_insert_xml_fragment("body");
    encode_block_tree(&body, &mut document.transact_mut(), block_tree)?;
    Ok(document)
}

fn validate_roots<T: ReadTxn>(
    transaction: &T,
    schema: BlockDocumentSchema,
) -> Result<(), BlockDocumentError> {
    for (name, root) in transaction.root_refs() {
        if name != "body" && !(schema.has_title() && name == "title") {
            return Err(BlockDocumentError::UnexpectedRoot(name.to_owned()));
        }
        let compatible = matches!(
            (name, &root),
            ("title", Out::YText(_) | Out::UndefinedRef(_))
                | ("body", Out::YXmlFragment(_) | Out::UndefinedRef(_))
        );
        if compatible {
            continue;
        }
        return Err(BlockDocumentError::IncompatibleRoot {
            name: name.to_owned(),
            actual: root_kind(&root).to_owned(),
        });
    }
    Ok(())
}

fn root_kind(root: &Out) -> &'static str {
    match root {
        Out::Any(_) => "value",
        Out::YText(_) => "text",
        Out::YArray(_) => "array",
        Out::YMap(_) => "map",
        Out::YXmlElement(_) => "xml_element",
        Out::YXmlFragment(_) => "xml_fragment",
        Out::YXmlText(_) => "xml_text",
        Out::YDoc(_) => "subdocument",
        Out::UndefinedRef(_) => "undefined",
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use yrs::updates::decoder::Decode;
    use yrs::{Map, Transact, Update};

    use crate::document::create_compatible_document;

    use super::*;

    #[test]
    fn decodes_a_page_fixture_with_exact_schema_identity() {
        let document = create_compatible_document("page-document");
        let bytes = std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/yjs-yrs/matrix-base.bin"),
        )
        .expect("fixture");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&bytes).expect("valid fixture"))
            .expect("fixture applies");

        let decoded = decode_block_document(&document, BlockDocumentSchema::PageV4)
            .expect("valid Page document");
        assert_eq!(decoded.schema.schema_key(), PAGE_SCHEMA_KEY);
        assert_eq!(decoded.schema.schema_version(), PAGE_SCHEMA_VERSION);
        assert_eq!(decoded.block_tree.blocks.len(), 18);
        assert!(decoded.title.is_some());
    }

    #[test]
    fn body_only_schema_rejects_a_hidden_title_root() {
        let document = create_compatible_document("body-only");
        document.get_or_insert_text("title");
        document.get_or_insert_xml_fragment("body");
        let error = decode_block_document(&document, BlockDocumentSchema::SyncedBlockV3)
            .expect_err("title is not valid for a body-only document");
        assert_eq!(
            error,
            BlockDocumentError::UnexpectedRoot("title".to_owned())
        );
    }

    #[test]
    fn page_schema_rejects_an_incompatible_root_type() {
        let document = create_compatible_document("wrong-root");
        document.get_or_insert_map("title").insert(
            &mut document.transact_mut(),
            "value",
            "not text",
        );
        let error = decode_block_document(&document, BlockDocumentSchema::PageV4)
            .expect_err("wrong root type");
        assert_eq!(
            error,
            BlockDocumentError::IncompatibleRoot {
                name: "title".to_owned(),
                actual: "map".to_owned(),
            }
        );
    }

    #[test]
    fn decoded_page_round_trips_through_the_engine_neutral_model() {
        let source = create_compatible_document("page-roundtrip-source");
        let bytes = std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/yjs-yrs/matrix-base.bin"),
        )
        .expect("fixture");
        source
            .transact_mut()
            .apply_update(Update::decode_v1(&bytes).expect("valid fixture"))
            .expect("fixture applies");
        let decoded =
            decode_block_document(&source, BlockDocumentSchema::PageV4).expect("decode source");

        let target = encode_block_document(
            "page-roundtrip-target",
            decoded.schema,
            decoded.title.as_deref(),
            &decoded.block_tree,
        )
        .expect("encode target");
        let roundtrip =
            decode_block_document(&target, BlockDocumentSchema::PageV4).expect("decode target");
        assert_eq!(roundtrip.title, decoded.title);
        assert_eq!(roundtrip.block_tree, decoded.block_tree);
    }
}
