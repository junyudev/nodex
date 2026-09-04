use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::domain::block_materialization::{
    BlockMaterializationError, MaterializedBlockNode, materialize_block_tree,
};
use crate::domain::block_tree::scan_block_tree;
use crate::domain::derived_records::{
    BlockDocumentAssetReference, BlockDocumentReference, DerivedRecordsError,
    derive_block_document_records,
};
use crate::domain::nfm::{NfmMaterializationError, materialize_nfm};
use crate::domain::rich_text::{
    RichTextError, RichTextItem, RichTextMaterialization, materialize_rich_text,
};

use super::{
    BlockDocumentSchema, DecodedBlockDocument, PAGE_SCHEMA_KEY, REUSABLE_TEMPLATE_SCHEMA_KEY,
    SYNCED_BLOCK_SCHEMA_KEY,
};

const PAGE_OWNER_TYPE: &str = "page";
const SYNCED_BLOCK_OWNER_TYPE: &str = "synced_block_source";
const REUSABLE_TEMPLATE_OWNER_TYPE: &str = "reusable_template_source";

/// Version of the code that derives persisted Document projections.
///
/// This is deliberately independent from `DocumentMaterialization::schema_version`:
/// the latter describes the Yrs document shape, while this value describes the
/// interpretation of its derived records.
pub(crate) const CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockDocumentKind {
    Page,
    SyncedBlock,
    ReusableTemplate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentSearchMarkerKind {
    DocumentTitle,
    DocumentMarker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDocumentSchemaMetadata {
    pub kind: BlockDocumentKind,
    pub owner_type: String,
    pub schema_key: String,
    pub schema_version: u32,
    pub title: bool,
    pub nfm_genesis: bool,
    pub nfm_replace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlockSearchUnit {
    pub block_id: String,
    pub parent_block_id: Option<String>,
    pub ordinal: usize,
    pub block_type: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMaterialization {
    pub kind: BlockDocumentKind,
    pub schema: BlockDocumentSchemaMetadata,
    pub schema_version: u32,
    pub title: String,
    pub rich_title: Vec<RichTextItem>,
    pub block_tree: Vec<MaterializedBlockNode>,
    pub nfm: String,
    pub plain_text: String,
    pub preview: String,
    pub references: Vec<BlockDocumentReference>,
    pub asset_refs: Vec<BlockDocumentAssetReference>,
    pub search_marker_kind: DocumentSearchMarkerKind,
    pub search_units: Vec<DocumentBlockSearchUnit>,
}

impl DocumentMaterialization {
    pub(crate) fn file_ids(&self) -> Vec<String> {
        self.asset_refs
            .iter()
            .filter_map(|reference| reference.file_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DocumentPlacementDelta {
    pub(crate) parent_changed_block_ids: BTreeSet<String>,
    pub(crate) reordered_block_ids: BTreeSet<String>,
}

fn collect_document_blocks<'a>(
    blocks: &'a [MaterializedBlockNode],
    by_id: &mut HashMap<&'a str, &'a MaterializedBlockNode>,
) {
    for block in blocks {
        by_id.insert(block.id.as_str(), block);
        collect_document_blocks(&block.children, by_id);
    }
}

/// Returns application identities whose direct canonical node state changed.
/// Children are excluded because hierarchy/order is handled separately; a
/// descendant edit must not make every ancestor look content-touched.
pub(crate) fn derive_document_node_delta(
    before: &DocumentMaterialization,
    after: &DocumentMaterialization,
) -> BTreeSet<String> {
    let mut before_by_id = HashMap::new();
    collect_document_blocks(&before.block_tree, &mut before_by_id);
    let mut after_by_id = HashMap::new();
    collect_document_blocks(&after.block_tree, &mut after_by_id);

    before_by_id
        .keys()
        .chain(after_by_id.keys())
        .filter(
            |block_id| match (before_by_id.get(**block_id), after_by_id.get(**block_id)) {
                (Some(previous), Some(next)) => {
                    previous.block_type != next.block_type
                        || previous.props != next.props
                        || previous.content != next.content
                }
                _ => true,
            },
        )
        .map(|block_id| (*block_id).to_owned())
        .collect()
}

#[derive(Default)]
struct DocumentPlacementSnapshot {
    parents: HashMap<String, Option<String>>,
    sibling_orders: HashMap<Option<String>, Vec<String>>,
}

fn collect_document_placement(
    blocks: &[MaterializedBlockNode],
    parent_block_id: Option<&str>,
    snapshot: &mut DocumentPlacementSnapshot,
) {
    let parent = parent_block_id.map(str::to_owned);
    for block in blocks {
        snapshot
            .sibling_orders
            .entry(parent.clone())
            .or_default()
            .push(block.id.clone());
        snapshot.parents.insert(block.id.clone(), parent.clone());
        collect_document_placement(&block.children, Some(&block.id), snapshot);
    }
}

/// Derives logical placement changes from canonical Document trees.
///
/// Parent changes are unambiguous. Same-parent ordering is represented by dense
/// projection ordinals, so the delta compares only Blocks that existed under
/// that same parent on both sides. Inserts, deletes, and parent changes cannot
/// therefore make untouched siblings look reordered merely because their dense
/// ordinal shifted.
pub(crate) fn derive_document_placement_delta(
    before: &DocumentMaterialization,
    after: &DocumentMaterialization,
) -> DocumentPlacementDelta {
    let mut before_snapshot = DocumentPlacementSnapshot::default();
    collect_document_placement(&before.block_tree, None, &mut before_snapshot);
    let mut after_snapshot = DocumentPlacementSnapshot::default();
    collect_document_placement(&after.block_tree, None, &mut after_snapshot);
    let common_ids = before_snapshot
        .parents
        .keys()
        .filter(|block_id| after_snapshot.parents.contains_key(*block_id))
        .cloned()
        .collect::<HashSet<_>>();
    let parent_changed_block_ids = common_ids
        .iter()
        .filter(|block_id| before_snapshot.parents[*block_id] != after_snapshot.parents[*block_id])
        .cloned()
        .collect::<BTreeSet<_>>();
    let stable_parent_ids = common_ids
        .iter()
        .filter(|block_id| !parent_changed_block_ids.contains(*block_id))
        .cloned()
        .collect::<HashSet<_>>();
    let parent_ids = stable_parent_ids
        .iter()
        .map(|block_id| before_snapshot.parents[block_id].clone())
        .collect::<HashSet<_>>();
    let mut reordered_block_ids = BTreeSet::new();

    for parent_block_id in parent_ids {
        let stable_order = |snapshot: &DocumentPlacementSnapshot| {
            snapshot
                .sibling_orders
                .get(&parent_block_id)
                .into_iter()
                .flatten()
                .filter(|block_id| stable_parent_ids.contains(*block_id))
                .cloned()
                .collect::<Vec<_>>()
        };
        let previous = stable_order(&before_snapshot);
        let next = stable_order(&after_snapshot);
        if previous == next {
            continue;
        }
        for (index, block_id) in previous.iter().enumerate() {
            if next.get(index) != Some(block_id) {
                reordered_block_ids.insert(block_id.clone());
            }
        }
        for (index, block_id) in next.iter().enumerate() {
            if previous.get(index) != Some(block_id) {
                reordered_block_ids.insert(block_id.clone());
            }
        }
    }

    DocumentPlacementDelta {
        parent_changed_block_ids,
        reordered_block_ids,
    }
}

/// Verifies that a typed compiler's declared move roots explain the complete
/// surviving-tree placement transition. Removing those roots must leave every
/// other stable sibling sequence unchanged; dense ordinal shifts caused by the
/// declared moves are therefore allowed without hiding an undeclared move.
pub(crate) fn exact_moves_explain_document_placement(
    before: &DocumentMaterialization,
    after: &DocumentMaterialization,
    exact_moved_block_ids: &HashSet<&str>,
) -> bool {
    let mut before_snapshot = DocumentPlacementSnapshot::default();
    collect_document_placement(&before.block_tree, None, &mut before_snapshot);
    let mut after_snapshot = DocumentPlacementSnapshot::default();
    collect_document_placement(&after.block_tree, None, &mut after_snapshot);
    let common_ids = before_snapshot
        .parents
        .keys()
        .filter(|block_id| after_snapshot.parents.contains_key(*block_id))
        .collect::<HashSet<_>>();

    if common_ids.iter().any(|block_id| {
        before_snapshot.parents[*block_id] != after_snapshot.parents[*block_id]
            && !exact_moved_block_ids.contains(block_id.as_str())
    }) {
        return false;
    }

    let stable_non_exact_ids = common_ids
        .into_iter()
        .filter(|block_id| {
            !exact_moved_block_ids.contains(block_id.as_str())
                && before_snapshot.parents[*block_id] == after_snapshot.parents[*block_id]
        })
        .cloned()
        .collect::<HashSet<_>>();
    let parent_ids = stable_non_exact_ids
        .iter()
        .map(|block_id| before_snapshot.parents[block_id].clone())
        .collect::<HashSet<_>>();

    parent_ids.into_iter().all(|parent_block_id| {
        let stable_order = |snapshot: &DocumentPlacementSnapshot| {
            snapshot
                .sibling_orders
                .get(&parent_block_id)
                .into_iter()
                .flatten()
                .filter(|block_id| stable_non_exact_ids.contains(*block_id))
                .cloned()
                .collect::<Vec<_>>()
        };
        stable_order(&before_snapshot) == stable_order(&after_snapshot)
    })
}

#[derive(Debug, Error, PartialEq)]
pub enum DocumentMaterializationError {
    #[error(transparent)]
    Blocks(#[from] BlockMaterializationError),
    #[error(transparent)]
    Nfm(#[from] NfmMaterializationError),
    #[error(transparent)]
    RichTitle(#[from] RichTextError),
    #[error(transparent)]
    DerivedRecords(#[from] DerivedRecordsError),
    #[error(
        "Reusable Template content cannot own nested document-bearing Block {block_id} ({block_type})"
    )]
    NestedDocumentBearingBlock {
        block_id: String,
        block_type: String,
    },
}

pub fn materialize_decoded_document(
    document: &DecodedBlockDocument,
) -> Result<DocumentMaterialization, DocumentMaterializationError> {
    validate_schema_specific_body(document)?;
    let block_tree = materialize_block_tree(&document.block_tree)?;
    let nfm = materialize_nfm(&block_tree)?;
    let records = derive_block_document_records(&block_tree, &nfm.blocks)?;
    let title = match &document.title {
        Some(title) => materialize_rich_text(title)?,
        None => RichTextMaterialization {
            rich_text: Vec::new(),
            plain_text: String::new(),
        },
    };
    let search_units = scan_block_tree(&document.block_tree)
        .into_iter()
        .enumerate()
        .map(|(ordinal, block)| DocumentBlockSearchUnit {
            block_id: block.id,
            parent_block_id: block.parent_block_id,
            ordinal,
            block_type: block.block_type,
            text: block.text,
        })
        .collect();
    let schema = schema_metadata(document.schema);

    Ok(DocumentMaterialization {
        kind: schema.kind,
        schema_version: schema.schema_version,
        title: title.plain_text,
        rich_title: title.rich_text,
        block_tree,
        nfm: nfm.nfm,
        plain_text: nfm.plain_text,
        preview: nfm.preview,
        references: records.references,
        asset_refs: records.asset_refs,
        search_marker_kind: if schema.title {
            DocumentSearchMarkerKind::DocumentTitle
        } else {
            DocumentSearchMarkerKind::DocumentMarker
        },
        search_units,
        schema,
    })
}

pub fn schema_metadata(schema: BlockDocumentSchema) -> BlockDocumentSchemaMetadata {
    match schema {
        BlockDocumentSchema::PageV3 => BlockDocumentSchemaMetadata {
            kind: BlockDocumentKind::Page,
            owner_type: PAGE_OWNER_TYPE.to_owned(),
            schema_key: PAGE_SCHEMA_KEY.to_owned(),
            schema_version: schema.schema_version(),
            title: true,
            nfm_genesis: true,
            nfm_replace: true,
        },
        BlockDocumentSchema::SyncedBlockV2 => BlockDocumentSchemaMetadata {
            kind: BlockDocumentKind::SyncedBlock,
            owner_type: SYNCED_BLOCK_OWNER_TYPE.to_owned(),
            schema_key: SYNCED_BLOCK_SCHEMA_KEY.to_owned(),
            schema_version: schema.schema_version(),
            title: false,
            nfm_genesis: true,
            nfm_replace: false,
        },
        BlockDocumentSchema::ReusableTemplateV2 => BlockDocumentSchemaMetadata {
            kind: BlockDocumentKind::ReusableTemplate,
            owner_type: REUSABLE_TEMPLATE_OWNER_TYPE.to_owned(),
            schema_key: REUSABLE_TEMPLATE_SCHEMA_KEY.to_owned(),
            schema_version: schema.schema_version(),
            title: false,
            nfm_genesis: true,
            nfm_replace: false,
        },
    }
}

fn validate_schema_specific_body(
    document: &DecodedBlockDocument,
) -> Result<(), DocumentMaterializationError> {
    if document.schema != BlockDocumentSchema::ReusableTemplateV2 {
        return Ok(());
    }
    let block = scan_block_tree(&document.block_tree)
        .into_iter()
        .find(|block| {
            matches!(
                block.block_type.as_str(),
                "page" | SYNCED_BLOCK_OWNER_TYPE | REUSABLE_TEMPLATE_OWNER_TYPE
            )
        });
    let Some(block) = block else {
        return Ok(());
    };
    Err(DocumentMaterializationError::NestedDocumentBearingBlock {
        block_id: block.id,
        block_type: block.block_type,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::Value;
    use yrs::updates::decoder::Decode;
    use yrs::{Transact, Update};

    use crate::document::{BlockDocumentSchema, create_compatible_document, decode_block_document};

    use super::*;

    fn page_matrix() -> (DocumentMaterialization, Value) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let document = create_compatible_document("document-materialization-matrix");
        let update = std::fs::read(root.join("matrix-base.bin")).expect("matrix fixture");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&update).expect("valid fixture"))
            .expect("fixture applies");
        let decoded = decode_block_document(&document, BlockDocumentSchema::PageV3)
            .expect("decoded Page document");
        let actual = materialize_decoded_document(&decoded).expect("materialization");
        let expected = serde_json::from_slice(
            &std::fs::read(root.join("matrix-materialization.json")).expect("oracle fixture"),
        )
        .expect("valid oracle fixture");
        (actual, expected)
    }

    #[test]
    fn atomically_matches_every_typescript_page_materialization_field() {
        let (actual, expected) = page_matrix();
        let actual = serde_json::to_value(actual).expect("serialize materialization");

        for field in [
            "schemaVersion",
            "title",
            "richTitle",
            "blockTree",
            "nfm",
            "plainText",
            "preview",
            "references",
            "assetRefs",
            "searchUnits",
        ] {
            assert_eq!(actual[field], expected[field], "field {field}");
        }
    }

    #[test]
    fn body_only_metadata_has_no_invented_title_capability() {
        let metadata = schema_metadata(BlockDocumentSchema::SyncedBlockV2);

        assert_eq!(metadata.kind, BlockDocumentKind::SyncedBlock);
        assert!(!metadata.title);
        assert!(!metadata.nfm_replace);
        assert_eq!(metadata.schema_key, "nodex.synced-block");
    }

    #[test]
    fn direct_node_delta_detects_props_and_rich_content_without_touching_ancestors() {
        let (actual, _) = page_matrix();
        let mut props_changed = actual.clone();
        let root_id = props_changed.block_tree[0].id.clone();
        props_changed.block_tree[0]
            .props
            .insert("textColor".to_owned(), Value::String("red".to_owned()));
        assert_eq!(
            derive_document_node_delta(&actual, &props_changed),
            BTreeSet::from([root_id.clone()]),
        );

        let mut child_content_changed = actual.clone();
        let child = child_content_changed
            .block_tree
            .iter_mut()
            .find_map(|root| root.children.first_mut())
            .expect("matrix contains a nested Block");
        let child_id = child.id.clone();
        child.content = Some(serde_json::json!([{
            "type": "text",
            "text": "Styled child edit",
            "styles": { "bold": true },
        }]));
        assert_eq!(
            derive_document_node_delta(&actual, &child_content_changed),
            BTreeSet::from([child_id]),
            "direct-node diagnostics must not mark the ancestor content-touched",
        );
        assert!(!derive_document_node_delta(&actual, &child_content_changed).contains(&root_id));
    }
}
