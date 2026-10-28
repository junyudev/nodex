use crate::domain::block_children::normalize_block_children_forest;
use crate::domain::block_materialization::{
    MaterializedBlockNode, dematerialize_block_tree_allowing_illegal_children,
    materialize_block_tree,
};
use crate::domain::rich_text::rich_text_to_delta;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::{
    BlockDocumentSchema, DecodedBlockDocument, DocumentMaterialization,
    materialize_decoded_document,
};

/// Resolves current identities and the published Block-children and Nodex
/// Markdown migration baselines. Durable clipboard and Undo capabilities retain their
/// original bytes and hashes, so compatibility happens only after those bytes
/// have been authenticated.
pub(crate) fn current_schema_for_stored_identity(
    schema_key: &str,
    schema_version: i64,
) -> Result<BlockDocumentSchema, StoreError> {
    if let Some(schema) = BlockDocumentSchema::from_identity(schema_key, schema_version) {
        return Ok(schema);
    }
    match (schema_key, schema_version) {
        ("nodex.page", 2 | 3) => Ok(BlockDocumentSchema::PageV4),
        ("nodex.synced-block", 1 | 2) => Ok(BlockDocumentSchema::SyncedBlockV3),
        ("nodex.reusable-template", 1 | 2) => Ok(BlockDocumentSchema::ReusableTemplateV3),
        _ => Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            format!("Stored Document schema {schema_key}@{schema_version} is unsupported"),
            false,
        )),
    }
}

pub(crate) fn normalize_stored_materialized_forest(
    blocks: &[MaterializedBlockNode],
) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    normalize_stored_forest(blocks, "stored-blocks")
}

pub(super) fn normalize_stored_forest(
    blocks: &[MaterializedBlockNode],
    document_id: &str,
) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    let tree = decode_stored_materialized_forest(blocks, document_id)?;
    let normalized = normalize_block_children_forest(tree.blocks);
    materialize_block_tree(&crate::domain::block_tree::BlockTree {
        root_attributes: tree.root_attributes,
        blocks: normalized.blocks,
    })
    .map_err(corrupt)
}

/// Re-derives the full current materialization instead of editing only schema
/// metadata. This keeps Markdown, search, references, assets, and Block coordinates
/// mutually consistent after child lifting.
pub(crate) fn normalize_stored_document_materialization(
    document_id: &str,
    schema: BlockDocumentSchema,
    stored: &DocumentMaterialization,
) -> Result<DocumentMaterialization, StoreError> {
    let blocks = normalize_stored_forest(&stored.block_tree, document_id)?;
    let block_tree =
        dematerialize_block_tree_allowing_illegal_children(&blocks).map_err(corrupt)?;
    let title = schema
        .has_title()
        .then(|| rich_text_to_delta(&stored.rich_title))
        .transpose()
        .map_err(corrupt)?;
    materialize_decoded_document(&DecodedBlockDocument {
        document_id: document_id.to_owned(),
        schema,
        title,
        block_tree,
    })
    .map_err(corrupt)
}

/// This is the first step of the unreleased Nodex Markdown document schema.
/// Caption text, image colors, and Session mention identities can join this
/// version before release; they are intentionally not transformed here.
/// Retired markers have no ownership: their children become siblings in place.
pub(super) fn normalize_nodex_markdown_forest(
    blocks: Vec<crate::domain::block_tree::BlockNode>,
    document_id: &str,
) -> (crate::domain::block_children::NormalizedBlockForest, usize) {
    fn remove(
        blocks: Vec<crate::domain::block_tree::BlockNode>,
        count: &mut usize,
        first: &mut Option<String>,
    ) -> Vec<crate::domain::block_tree::BlockNode> {
        blocks
            .into_iter()
            .flat_map(|mut block| {
                if block.content.name == "threadSection" {
                    *count += 1;
                    first.get_or_insert_with(|| block.id.clone());
                    return remove(block.children, count, first);
                }
                block.children = remove(block.children, count, first);
                vec![block]
            })
            .collect()
    }
    let mut count = 0;
    let mut first = None;
    let mut blocks = remove(blocks, &mut count, &mut first);
    if blocks.is_empty()
        && let Some(id) = first
    {
        blocks.push(empty_markdown_body(&id, document_id));
    }
    let mut normalized = normalize_block_children_forest(blocks);
    normalized.changed |= count > 0;
    (normalized, count)
}

pub(super) fn decode_stored_materialized_forest(
    blocks: &[MaterializedBlockNode],
    document_id: &str,
) -> Result<crate::domain::block_tree::BlockTree, StoreError> {
    let (blocks, first_removed) = remove_stored_prompt_markers(blocks);
    let mut tree = dematerialize_block_tree_allowing_illegal_children(&blocks).map_err(corrupt)?;
    if tree.blocks.is_empty()
        && let Some(id) = first_removed
    {
        tree.blocks.push(empty_markdown_body(&id, document_id));
    }
    Ok(tree)
}

fn remove_stored_prompt_markers(
    blocks: &[MaterializedBlockNode],
) -> (Vec<MaterializedBlockNode>, Option<String>) {
    let mut first = None;
    let blocks = blocks
        .iter()
        .flat_map(|block| {
            let (children, child_marker) = remove_stored_prompt_markers(&block.children);
            if block.block_type == "threadSection" {
                first.get_or_insert_with(|| block.id.clone());
                return children;
            }
            // Empty nested groups are legal; only an empty document body gets a paragraph.
            first = first.take().or(child_marker);
            vec![MaterializedBlockNode {
                children,
                ..block.clone()
            }]
        })
        .collect();
    (blocks, first)
}

fn empty_markdown_body(marker_id: &str, document_id: &str) -> crate::domain::block_tree::BlockNode {
    use crate::domain::block_tree::{BlockNode, PortableValue, XmlElementNode};
    use std::collections::BTreeMap;
    let id = crate::domain::identity::stable_uuid_v7(
        "nodex-markdown-empty-body",
        document_id,
        marker_id,
    );
    BlockNode {
        container_attributes: BTreeMap::from([(
            "id".to_owned(),
            PortableValue::String(id.clone()),
        )]),
        id,
        content: XmlElementNode {
            name: "paragraph".to_owned(),
            attributes: BTreeMap::new(),
            children: Vec::new(),
        },
        children: Vec::new(),
    }
}

fn corrupt(error: impl std::fmt::Display) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, error.to_string(), false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;

    fn block(
        id: &str,
        block_type: &str,
        children: Vec<MaterializedBlockNode>,
    ) -> MaterializedBlockNode {
        MaterializedBlockNode {
            id: id.to_owned(),
            block_type: block_type.to_owned(),
            props: BTreeMap::new(),
            content: Some(json!([])),
            children,
        }
    }

    #[test]
    fn authenticated_baseline_payloads_adapt_to_the_current_schema_without_rewriting() {
        assert_eq!(
            current_schema_for_stored_identity("nodex.page", 2).expect("baseline Page"),
            BlockDocumentSchema::PageV4
        );
        assert_eq!(
            current_schema_for_stored_identity("nodex.synced-block", 1)
                .expect("baseline synced Block"),
            BlockDocumentSchema::SyncedBlockV3
        );
        assert_eq!(
            current_schema_for_stored_identity("nodex.reusable-template", 1)
                .expect("baseline template"),
            BlockDocumentSchema::ReusableTemplateV3
        );

        let stored = vec![block(
            "code",
            "codeBlock",
            vec![block("lifted", "paragraph", Vec::new())],
        )];
        let normalized =
            normalize_stored_materialized_forest(&stored).expect("current Block forest");
        assert_eq!(
            normalized
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            ["code", "lifted"]
        );
        assert_eq!(stored[0].children[0].id, "lifted");
    }
    #[test]
    fn authenticated_markers_preserve_following_content_and_converge() {
        let mut marker = block(
            "marker",
            "threadSection",
            vec![block("child", "paragraph", Vec::new())],
        );
        marker.content = None;
        let following = block("following", "paragraph", Vec::new());
        let stored = vec![marker, following.clone()];
        let current = normalize_stored_materialized_forest(&stored).unwrap();
        assert_eq!(
            current
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            ["child", "following"]
        );
        assert_eq!(current[1], following);
        assert_eq!(stored[0].block_type, "threadSection");
        assert_eq!(
            normalize_stored_materialized_forest(&current).unwrap(),
            current
        );
        for (key, previous, current_version) in [
            ("nodex.page", 3, 4),
            ("nodex.synced-block", 2, 3),
            ("nodex.reusable-template", 2, 3),
        ] {
            assert_eq!(
                current_schema_for_stored_identity(key, previous)
                    .unwrap()
                    .schema_version(),
                current_version
            );
        }
    }

    #[test]
    fn authenticated_marker_only_payload_restores_a_stable_empty_paragraph() {
        let mut marker = block("marker", "threadSection", Vec::new());
        marker.content = None;
        let current = normalize_stored_materialized_forest(&[marker.clone()]).unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].block_type, "paragraph");
        assert_eq!(current[0].content, Some(json!([])));
        assert_eq!(
            normalize_stored_materialized_forest(&[marker]).unwrap(),
            current
        );
    }
    #[test]
    fn empty_body_identity_is_scoped_to_the_retained_document() {
        let mut marker = block("same-marker", "threadSection", Vec::new());
        marker.content = None;
        let first = normalize_stored_forest(&[marker.clone()], "document-1").unwrap();
        let second = normalize_stored_forest(&[marker.clone()], "document-2").unwrap();
        assert_ne!(first[0].id, second[0].id);
        assert_eq!(
            normalize_stored_forest(&[marker], "document-1").unwrap(),
            first
        );
    }
}
