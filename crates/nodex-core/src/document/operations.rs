use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Doc, Out, ReadTxn, Transact, Update, Xml, XmlElementPrelim, XmlFragment, XmlFragmentRef,
    XmlOut,
};

use crate::domain::block_materialization::{
    BlockMaterializationError, MaterializedBlockNode, dematerialize_block_tree,
};
use crate::domain::block_tree::{
    BLOCK_GROUP_NODE_NAME, BLOCK_ID_ATTRIBUTE, BlockNode, BlockTree, BlockTreeError,
    encode_block_tree, insert_block_nodes, replace_block_content_element, replace_text_delta,
};
use crate::domain::rich_text::{
    RichTextError, RichTextItem, RichTextStyles, canonicalize_rich_text, rich_text_to_delta,
};
use crate::domain::subtree::{
    BlockSubtreeError, BlockSubtreeErrorCode, BlockSubtreeInsertionTarget,
    PortableBlockSubtreeForest, capture_block_subtree_forest, insert_block_subtree_forest,
    move_block_subtree_forest, remap_block_subtree_forest, remove_block_subtree_forest,
};

use super::nfm_input::materialize_document_nfm;
use super::{
    BlockDocumentError, BlockDocumentSchema, DocumentMaterialization, DocumentMaterializationError,
    MAX_DOCUMENT_UPDATE_BYTES, create_compatible_document, decode_block_document,
    decode_state_vector_v1, has_pending_dependencies, materialize_decoded_document,
};

pub const MAX_DOCUMENT_OPERATION_BATCH_SIZE: usize = 512;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentBlockUpdatePatch {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub block_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub unset_content: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocumentBlockOperation {
    /// Library-only, after semantic guards and ownership preservation checks.
    RestoreEditorHistoryForest {
        root_block_ids: Vec<String>,
        replacement_roots: Vec<EditorHistoryRootInsertion>,
    },
    SetTitle {
        title: String,
    },
    SetRichTitle {
        rich_title: Vec<RichTextItem>,
    },
    InsertBlock {
        block: MaterializedBlockNode,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_block_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        before_block_id: Option<String>,
    },
    UpdateBlock {
        block_id: String,
        patch: DocumentBlockUpdatePatch,
    },
    DeleteBlock {
        block_id: String,
    },
    MoveBlock {
        block_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_block_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        before_block_id: Option<String>,
    },
    /// One semantic editor gesture: append an ordinary source Block's inline
    /// content to an earlier target, promote the source's direct children, and
    /// remove only the now-empty source shell.
    MergeBlockBackward {
        target_block_id: String,
        source_block_id: String,
        merged_content: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        promoted_parent_block_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        promoted_before_block_id: Option<String>,
        promoted_child_ids: Vec<String>,
    },
    /// Inverse of `MergeBlockBackward`. The source shell is reactivated by the
    /// Library placement boundary; this operation restores its tree topology.
    RestoreBackwardMerge {
        target_block_id: String,
        target_content: Value,
        source_block: MaterializedBlockNode,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_parent_block_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_before_block_id: Option<String>,
        promoted_child_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorHistoryRootInsertion {
    pub block: MaterializedBlockNode,
    pub before_block_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDocumentOperationUpdate {
    pub update_v1: Vec<u8>,
    pub state_vector_v1: Vec<u8>,
    pub materialization: DocumentMaterialization,
    pub write_fence_block_ids: Vec<String>,
    pub title_write_fence_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactNfmPatch {
    pub old_nfm: String,
    pub new_nfm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_matches: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableSubtreeTransferKind {
    Move,
    Copy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSubtreeDocumentHead {
    pub document_id: String,
    pub schema: BlockDocumentSchema,
    pub full_state_v1: Vec<u8>,
    pub expected_state_vector_v1: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSubtreeTransferRequest {
    pub kind: PortableSubtreeTransferKind,
    pub source: PortableSubtreeDocumentHead,
    pub target: PortableSubtreeDocumentHead,
    pub root_block_ids: Vec<String>,
    pub insertion: BlockSubtreeInsertionTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPortableSubtreeTransfer {
    pub same_document: bool,
    pub source_forest: PortableBlockSubtreeForest,
    pub inserted_forest: PortableBlockSubtreeForest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PreparedDocumentOperationUpdate>,
    pub target: PreparedDocumentOperationUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentOperationErrorCode {
    EmptyBatch,
    BatchTooLarge,
    StaleStateVector,
    DuplicateBlockId,
    BlockNotFound,
    InvalidAnchor,
    AncestorCycle,
    InvalidBlock,
    InvalidOperation,
    InvalidNfm,
    NfmPatchNotFound,
    NfmPatchAmbiguous,
    NfmPatchOverlap,
    NoChange,
    DocumentStateCorrupt,
}

#[derive(Debug, Error)]
pub enum DocumentOperationError {
    #[error("document operation {code:?}: {message}")]
    Operation {
        code: DocumentOperationErrorCode,
        message: String,
        operation_index: Option<usize>,
        block_id: Option<String>,
    },
    #[error("invalid Yrs document state: {0}")]
    Yrs(String),
    #[error(transparent)]
    BlockDocument(#[from] BlockDocumentError),
    #[error(transparent)]
    BlockTree(#[from] BlockTreeError),
    #[error(transparent)]
    BlockMaterialization(#[from] BlockMaterializationError),
    #[error(transparent)]
    RichText(#[from] RichTextError),
    #[error(transparent)]
    Materialization(#[from] DocumentMaterializationError),
}

impl DocumentOperationError {
    pub fn code(&self) -> DocumentOperationErrorCode {
        match self {
            Self::Operation { code, .. } => *code,
            Self::BlockMaterialization(_) => DocumentOperationErrorCode::InvalidBlock,
            Self::RichText(_) => DocumentOperationErrorCode::InvalidOperation,
            Self::Yrs(_)
            | Self::BlockDocument(_)
            | Self::BlockTree(_)
            | Self::Materialization(_) => DocumentOperationErrorCode::DocumentStateCorrupt,
        }
    }

    pub fn operation_index(&self) -> Option<usize> {
        match self {
            Self::Operation {
                operation_index, ..
            } => *operation_index,
            _ => None,
        }
    }

    pub fn block_id(&self) -> Option<&str> {
        match self {
            Self::Operation { block_id, .. } => block_id.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct NfmPatchSpan {
    start: usize,
    end: usize,
    replacement: String,
    patch_index: usize,
}

struct XmlBlockLocation {
    parent_group: yrs::XmlElementRef,
    container: yrs::XmlElementRef,
    sibling_index: u32,
}

/// Prepare one isolated, relative V1 update from an exact durable head. The
/// source bytes are never mutated and the expected state vector is a mandatory
/// structural write barrier rather than advisory conflict metadata.
pub fn prepare_document_operation_update(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state_v1: &[u8],
    expected_state_vector_v1: &[u8],
    operations: &[DocumentBlockOperation],
    allow_transient_empty_result: bool,
) -> Result<PreparedDocumentOperationUpdate, DocumentOperationError> {
    if operations.is_empty() {
        return Err(operation_error(
            DocumentOperationErrorCode::EmptyBatch,
            "Document operation batch must not be empty",
            None,
            None,
        ));
    }
    if operations.len() > MAX_DOCUMENT_OPERATION_BATCH_SIZE {
        return Err(operation_error(
            DocumentOperationErrorCode::BatchTooLarge,
            format!(
                "Document operation batch exceeds {MAX_DOCUMENT_OPERATION_BATCH_SIZE} operations"
            ),
            None,
            None,
        ));
    }
    if full_state_v1.len() > MAX_DOCUMENT_UPDATE_BYTES {
        return Err(DocumentOperationError::Yrs(format!(
            "document state exceeds {MAX_DOCUMENT_UPDATE_BYTES} bytes"
        )));
    }

    let source = load_document(document_id, full_state_v1)?;
    let expected = decode_state_vector_v1(expected_state_vector_v1)
        .map_err(|error| DocumentOperationError::Yrs(error.to_string()))?;
    let source_vector = source.transact().state_vector();
    if expected != source_vector {
        return Err(operation_error(
            DocumentOperationErrorCode::StaleStateVector,
            "Document operation was prepared from a stale structural state",
            None,
            None,
        ));
    }

    let source_decoded = decode_block_document(&source, schema)?;
    let source_materialization = materialize_decoded_document(&source_decoded)?;
    collect_inserted_ids(operations, &source_decoded.block_tree)?;

    let working = load_document(document_id, full_state_v1)?;
    let body = working.get_or_insert_xml_fragment("body");
    let title = schema
        .has_title()
        .then(|| working.get_or_insert_text("title"));
    let mut semantic_blocks = source_materialization.block_tree.clone();
    let mut canonical_tree = source_decoded.block_tree.clone();
    let mut write_fences = BTreeSet::new();
    let mut title_write_fence_required = false;

    {
        let mut transaction = working.transact_mut();
        for (index, operation) in operations.iter().enumerate() {
            apply_operation(
                operation,
                index,
                schema,
                &body,
                title.as_ref(),
                &mut transaction,
                &mut semantic_blocks,
                &mut canonical_tree,
                &mut write_fences,
                &mut title_write_fence_required,
            )?;
        }
    }

    let decoded = decode_block_document(&working, schema)?;
    let materialization = materialize_decoded_document(&decoded)?;
    if !allow_transient_empty_result && materialization.block_tree.is_empty() {
        return Err(operation_error(
            DocumentOperationErrorCode::InvalidOperation,
            "BlockNote-backed Documents must retain one editable root Block",
            None,
            None,
        ));
    }
    if source_materialization.rich_title == materialization.rich_title
        && source_materialization.block_tree == materialization.block_tree
    {
        return Err(operation_error(
            DocumentOperationErrorCode::NoChange,
            "Document operation batch produced no semantic change",
            None,
            None,
        ));
    }

    let transaction = working.transact();
    let update_v1 = transaction.encode_state_as_update_v1(&source_vector);
    let state_vector_v1 = transaction.state_vector().encode_v1();
    Ok(PreparedDocumentOperationUpdate {
        update_v1,
        state_vector_v1,
        materialization,
        write_fence_block_ids: write_fences.into_iter().collect(),
        title_write_fence_required,
    })
}

pub fn apply_exact_nfm_patches(
    source: &str,
    patches: &[ExactNfmPatch],
) -> Result<String, DocumentOperationError> {
    if patches.is_empty() {
        return Err(operation_error(
            DocumentOperationErrorCode::EmptyBatch,
            "NFM patch batch must not be empty",
            None,
            None,
        ));
    }
    let mut spans = Vec::new();
    for (patch_index, patch) in patches.iter().enumerate() {
        if patch.old_nfm.is_empty() {
            return Err(operation_error(
                DocumentOperationErrorCode::InvalidOperation,
                format!("NFM patch {patch_index} must match non-empty content"),
                Some(patch_index),
                None,
            ));
        }
        let expected = patch.expected_matches.unwrap_or(1);
        if !(1..=100).contains(&expected) {
            return Err(operation_error(
                DocumentOperationErrorCode::InvalidOperation,
                format!("NFM patch {patch_index} expectedMatches is out of bounds"),
                Some(patch_index),
                None,
            ));
        }
        let starts = overlapping_match_starts(source, &patch.old_nfm);
        if starts.len() != expected {
            let code = if starts.is_empty() {
                DocumentOperationErrorCode::NfmPatchNotFound
            } else {
                DocumentOperationErrorCode::NfmPatchAmbiguous
            };
            return Err(operation_error(
                code,
                format!(
                    "NFM patch {patch_index} matched {} span(s); expected {expected}",
                    starts.len()
                ),
                Some(patch_index),
                None,
            ));
        }
        spans.extend(starts.into_iter().map(|start| NfmPatchSpan {
            start,
            end: start + patch.old_nfm.len(),
            replacement: patch.new_nfm.clone(),
            patch_index,
        }));
    }
    spans.sort_by_key(|span| (span.start, span.end));
    for pair in spans.windows(2) {
        let [previous, current] = pair else {
            unreachable!();
        };
        if current.start >= previous.end {
            continue;
        }
        return Err(operation_error(
            DocumentOperationErrorCode::NfmPatchOverlap,
            format!(
                "NFM patches {} and {} overlap",
                previous.patch_index, current.patch_index
            ),
            Some(current.patch_index),
            None,
        ));
    }
    spans.sort_by_key(|span| Reverse(span.start));
    let mut result = source.to_owned();
    for span in spans {
        result.replace_range(span.start..span.end, &span.replacement);
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_nfm_replacement_update(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state_v1: &[u8],
    expected_state_vector_v1: &[u8],
    nfm: &str,
    rich_title: Option<&[RichTextItem]>,
    allocate_block_id: &mut impl FnMut() -> String,
) -> Result<PreparedDocumentOperationUpdate, DocumentOperationError> {
    if !super::schema_metadata(schema).nfm_replace {
        return Err(operation_error(
            DocumentOperationErrorCode::InvalidOperation,
            "This Document schema does not support whole-body NFM replacement",
            None,
            None,
        ));
    }
    let target_blocks = materialize_document_nfm(nfm, allocate_block_id).map_err(|error| {
        operation_error(
            DocumentOperationErrorCode::InvalidNfm,
            error.to_string(),
            None,
            None,
        )
    })?;
    let target_tree = dematerialize_block_tree(&target_blocks)?;
    prepare_document_body_replacement_update(
        document_id,
        schema,
        full_state_v1,
        expected_state_vector_v1,
        &target_blocks,
        &target_tree,
        rich_title,
        DocumentBodyReplacementKind::NfmReplacement,
    )
}

pub(crate) fn prepare_document_snapshot_restore_update(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state_v1: &[u8],
    expected_state_vector_v1: &[u8],
    target_blocks: &[MaterializedBlockNode],
    rich_title: Option<&[RichTextItem]>,
) -> Result<PreparedDocumentOperationUpdate, DocumentOperationError> {
    let target_tree = dematerialize_block_tree(target_blocks)?;
    prepare_document_body_replacement_update(
        document_id,
        schema,
        full_state_v1,
        expected_state_vector_v1,
        target_blocks,
        &target_tree,
        rich_title,
        DocumentBodyReplacementKind::SnapshotRestore,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_exact_nfm_patch_update(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state_v1: &[u8],
    expected_state_vector_v1: &[u8],
    patches: &[ExactNfmPatch],
    rich_title: Option<&[RichTextItem]>,
    allocate_block_id: &mut impl FnMut() -> String,
) -> Result<PreparedDocumentOperationUpdate, DocumentOperationError> {
    let source = load_document(document_id, full_state_v1)?;
    let source = materialize_decoded_document(&decode_block_document(&source, schema)?)?;
    let canonical_nfm = if source.nfm.ends_with('\n') {
        source.nfm.clone()
    } else {
        format!("{}\n", source.nfm)
    };
    let nfm = apply_exact_nfm_patches(&canonical_nfm, patches)?;
    prepare_nfm_replacement_update(
        document_id,
        schema,
        full_state_v1,
        expected_state_vector_v1,
        &nfm,
        rich_title,
        allocate_block_id,
    )
}

/// Prepare a portable Block subtree move or copy without mutating either
/// authoritative head. Cross-Document callers must persist the optional source
/// and required target update in one transaction before publishing either.
pub fn prepare_portable_subtree_transfer_updates(
    request: &PortableSubtreeTransferRequest,
    allocate_block_id: &mut impl FnMut(&str) -> String,
) -> Result<PreparedPortableSubtreeTransfer, DocumentOperationError> {
    let same_document = request.source.document_id == request.target.document_id;
    if same_document
        && (request.source.schema != request.target.schema
            || request.source.full_state_v1 != request.target.full_state_v1
            || request.source.expected_state_vector_v1 != request.target.expected_state_vector_v1)
    {
        return Err(operation_error(
            DocumentOperationErrorCode::InvalidOperation,
            "A same-Document subtree transfer must use one exact structural head",
            None,
            None,
        ));
    }

    let source = load_document(&request.source.document_id, &request.source.full_state_v1)?;
    let source_vector = assert_exact_state_vector(
        &source,
        &request.source.expected_state_vector_v1,
        "Subtree source",
    )?;
    let source_decoded = decode_block_document(&source, request.source.schema)?;
    let source_forest =
        capture_block_subtree_forest(&source_decoded.block_tree, &request.root_block_ids)
            .map_err(map_subtree_error)?;
    let inserted_forest = match request.kind {
        PortableSubtreeTransferKind::Move => source_forest.clone(),
        PortableSubtreeTransferKind::Copy => {
            remap_block_subtree_forest(&source_forest, allocate_block_id)
                .map_err(map_subtree_error)?
        }
    };

    if same_document {
        let expected = match request.kind {
            PortableSubtreeTransferKind::Move => {
                move_block_subtree_forest(
                    &source_decoded.block_tree,
                    &request.root_block_ids,
                    &request.insertion,
                )
                .map_err(map_subtree_error)?
                .0
            }
            PortableSubtreeTransferKind::Copy => insert_block_subtree_forest(
                &source_decoded.block_tree,
                &inserted_forest,
                &request.insertion,
            )
            .map_err(map_subtree_error)?,
        };
        let working = load_document(&request.source.document_id, &request.source.full_state_v1)?;
        let body = working.get_or_insert_xml_fragment("body");
        {
            let mut transaction = working.transact_mut();
            if request.kind == PortableSubtreeTransferKind::Move {
                remove_xml_subtree_forest(&body, &mut transaction, &source_forest)?;
            }
            insert_xml_subtree_forest(
                &body,
                &mut transaction,
                &inserted_forest,
                &request.insertion,
            )?;
        }
        let prepared = prepare_subtree_document_result(
            &working,
            request.source.schema,
            &source_vector,
            &expected,
            &inserted_forest.block_ids,
        )?;
        return Ok(PreparedPortableSubtreeTransfer {
            same_document: true,
            source_forest,
            inserted_forest,
            source: None,
            target: prepared,
        });
    }

    let target = load_document(&request.target.document_id, &request.target.full_state_v1)?;
    let target_vector = assert_exact_state_vector(
        &target,
        &request.target.expected_state_vector_v1,
        "Subtree target",
    )?;
    let target_decoded = decode_block_document(&target, request.target.schema)?;
    let source_ids: BTreeSet<_> = current_ids(&source_decoded.block_tree.blocks)
        .into_iter()
        .collect();
    if let Some(conflict) = current_ids(&target_decoded.block_tree.blocks)
        .into_iter()
        .find(|id| source_ids.contains(id))
    {
        return Err(operation_error(
            DocumentOperationErrorCode::DuplicateBlockId,
            format!("Source and target Documents already share Block identity {conflict}"),
            None,
            Some(&conflict),
        ));
    }
    let expected_target = insert_block_subtree_forest(
        &target_decoded.block_tree,
        &inserted_forest,
        &request.insertion,
    )
    .map_err(map_subtree_error)?;
    let target_working = load_document(&request.target.document_id, &request.target.full_state_v1)?;
    let target_body = target_working.get_or_insert_xml_fragment("body");
    {
        let mut transaction = target_working.transact_mut();
        insert_xml_subtree_forest(
            &target_body,
            &mut transaction,
            &inserted_forest,
            &request.insertion,
        )?;
    }
    let prepared_target = prepare_subtree_document_result(
        &target_working,
        request.target.schema,
        &target_vector,
        &expected_target,
        &inserted_forest.block_ids,
    )?;

    let prepared_source = if request.kind == PortableSubtreeTransferKind::Move {
        let expected_source =
            remove_block_subtree_forest(&source_decoded.block_tree, &request.root_block_ids)
                .map_err(map_subtree_error)?
                .0;
        let source_working =
            load_document(&request.source.document_id, &request.source.full_state_v1)?;
        let source_body = source_working.get_or_insert_xml_fragment("body");
        {
            let mut transaction = source_working.transact_mut();
            remove_xml_subtree_forest(&source_body, &mut transaction, &source_forest)?;
        }
        Some(prepare_subtree_document_result(
            &source_working,
            request.source.schema,
            &source_vector,
            &expected_source,
            &source_forest.block_ids,
        )?)
    } else {
        None
    };

    Ok(PreparedPortableSubtreeTransfer {
        same_document: false,
        source_forest,
        inserted_forest,
        source: prepared_source,
        target: prepared_target,
    })
}

fn assert_exact_state_vector(
    document: &Doc,
    expected_state_vector_v1: &[u8],
    label: &str,
) -> Result<yrs::StateVector, DocumentOperationError> {
    let expected = decode_state_vector_v1(expected_state_vector_v1)
        .map_err(|error| DocumentOperationError::Yrs(error.to_string()))?;
    let actual = document.transact().state_vector();
    if actual == expected {
        return Ok(actual);
    }
    Err(operation_error(
        DocumentOperationErrorCode::StaleStateVector,
        format!("{label} was prepared from a stale structural state"),
        None,
        None,
    ))
}

fn remove_xml_subtree_forest(
    body: &XmlFragmentRef,
    transaction: &mut yrs::TransactionMut<'_>,
    forest: &PortableBlockSubtreeForest,
) -> Result<(), DocumentOperationError> {
    for root_id in forest.root_block_ids.iter().rev() {
        let location = locate_xml_block(body, transaction, root_id).ok_or_else(|| {
            operation_error(
                DocumentOperationErrorCode::DocumentStateCorrupt,
                format!("Captured subtree root {root_id} disappeared before preparation"),
                None,
                Some(root_id),
            )
        })?;
        location
            .parent_group
            .remove(transaction, location.sibling_index);
    }
    Ok(())
}

fn insert_xml_subtree_forest(
    body: &XmlFragmentRef,
    transaction: &mut yrs::TransactionMut<'_>,
    forest: &PortableBlockSubtreeForest,
    target: &BlockSubtreeInsertionTarget,
) -> Result<(), DocumentOperationError> {
    let (group, index) = resolve_insertion_group(
        body,
        transaction,
        target.parent_block_id.as_deref(),
        target.before_block_id.as_deref(),
        0,
    )?;
    let blocks: Vec<_> = forest.roots.iter().map(|root| root.block.clone()).collect();
    insert_block_nodes(&group, transaction, index, &blocks);
    Ok(())
}

fn prepare_subtree_document_result(
    working: &Doc,
    schema: BlockDocumentSchema,
    source_vector: &yrs::StateVector,
    expected_tree: &BlockTree,
    write_fence_block_ids: &[String],
) -> Result<PreparedDocumentOperationUpdate, DocumentOperationError> {
    let decoded = decode_block_document(working, schema)?;
    if &decoded.block_tree != expected_tree {
        return Err(operation_error(
            DocumentOperationErrorCode::DocumentStateCorrupt,
            "Portable subtree mutation diverged from its validated canonical result",
            None,
            None,
        ));
    }
    let materialization = materialize_decoded_document(&decoded)?;
    let transaction = working.transact();
    let update_v1 = transaction.encode_state_as_update_v1(source_vector);
    if update_v1.is_empty() {
        return Err(operation_error(
            DocumentOperationErrorCode::NoChange,
            "Portable subtree mutation produced no relative update",
            None,
            None,
        ));
    }
    Ok(PreparedDocumentOperationUpdate {
        update_v1,
        state_vector_v1: transaction.state_vector().encode_v1(),
        materialization,
        write_fence_block_ids: write_fence_block_ids.to_vec(),
        title_write_fence_required: false,
    })
}

fn map_subtree_error(error: BlockSubtreeError) -> DocumentOperationError {
    let code = match error.code {
        BlockSubtreeErrorCode::SourceBlockNotFound => DocumentOperationErrorCode::BlockNotFound,
        BlockSubtreeErrorCode::TargetParentNotFound
        | BlockSubtreeErrorCode::TargetParentRejectsChildren
        | BlockSubtreeErrorCode::TargetAnchorNotFound
        | BlockSubtreeErrorCode::TargetAnchorWrongParent
        | BlockSubtreeErrorCode::TargetAnchorInMovedSubtree => {
            DocumentOperationErrorCode::InvalidAnchor
        }
        BlockSubtreeErrorCode::AncestorCycle => DocumentOperationErrorCode::AncestorCycle,
        BlockSubtreeErrorCode::TargetIdentityConflict
        | BlockSubtreeErrorCode::IdentityRemapConflict
        | BlockSubtreeErrorCode::DuplicateRoot => DocumentOperationErrorCode::DuplicateBlockId,
        BlockSubtreeErrorCode::NoChange => DocumentOperationErrorCode::NoChange,
        BlockSubtreeErrorCode::InvalidDocument | BlockSubtreeErrorCode::PostconditionFailed => {
            DocumentOperationErrorCode::DocumentStateCorrupt
        }
        BlockSubtreeErrorCode::InvalidRootIdentity
        | BlockSubtreeErrorCode::EmptyRootSelection
        | BlockSubtreeErrorCode::OverlappingRoots => DocumentOperationErrorCode::InvalidOperation,
    };
    operation_error(code, error.message, None, error.block_id.as_deref())
}

#[allow(clippy::too_many_arguments)]
fn prepare_document_body_replacement_update(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state_v1: &[u8],
    expected_state_vector_v1: &[u8],
    target_blocks: &[MaterializedBlockNode],
    target_tree: &BlockTree,
    rich_title: Option<&[RichTextItem]>,
    replacement_kind: DocumentBodyReplacementKind,
) -> Result<PreparedDocumentOperationUpdate, DocumentOperationError> {
    let source = load_document(document_id, full_state_v1)?;
    let expected = decode_state_vector_v1(expected_state_vector_v1)
        .map_err(|error| DocumentOperationError::Yrs(error.to_string()))?;
    let source_vector = source.transact().state_vector();
    if source_vector != expected {
        return Err(operation_error(
            DocumentOperationErrorCode::StaleStateVector,
            replacement_kind.stale_state_message(),
            None,
            None,
        ));
    }
    let source_decoded = decode_block_document(&source, schema)?;
    let source_materialization = materialize_decoded_document(&source_decoded)?;
    let old_ids: BTreeSet<_> = current_ids(&source_decoded.block_tree.blocks)
        .into_iter()
        .collect();
    if let Some(reused) = (!replacement_kind.allows_reused_block_ids())
        .then(|| flatten_materialized_ids(target_blocks))
        .into_iter()
        .flatten()
        .find(|id| old_ids.contains(id))
    {
        return Err(operation_error(
            DocumentOperationErrorCode::DuplicateBlockId,
            format!("NFM replacement reused existing Block identity {reused}"),
            None,
            Some(&reused),
        ));
    }

    let working = load_document(document_id, full_state_v1)?;
    let body = working.get_or_insert_xml_fragment("body");
    let title = schema
        .has_title()
        .then(|| working.get_or_insert_text("title"));
    let mut title_write_fence_required = false;
    {
        let mut transaction = working.transact_mut();
        let body_length = body.len(&transaction);
        if body_length > 0 {
            body.remove_range(&mut transaction, 0, body_length);
        }
        encode_block_tree(&body, &mut transaction, target_tree)?;
        if let Some(rich_title) = rich_title {
            replace_title(
                schema,
                title.as_ref(),
                &mut transaction,
                rich_title,
                0,
                &mut title_write_fence_required,
            )?;
        }
    }

    let decoded = decode_block_document(&working, schema)?;
    let materialization = materialize_decoded_document(&decoded)?;
    if materialization.block_tree != target_blocks {
        return Err(operation_error(
            replacement_kind.target_mismatch_code(),
            replacement_kind.target_mismatch_message(),
            None,
            None,
        ));
    }
    if source_materialization.rich_title == materialization.rich_title
        && source_materialization.block_tree == materialization.block_tree
    {
        return Err(operation_error(
            DocumentOperationErrorCode::NoChange,
            replacement_kind.no_change_message(),
            None,
            None,
        ));
    }
    let write_fence_block_ids = match replacement_kind {
        DocumentBodyReplacementKind::NfmReplacement => old_ids,
        DocumentBodyReplacementKind::SnapshotRestore => old_ids
            .into_iter()
            .chain(flatten_materialized_ids(target_blocks))
            .collect(),
    };
    let transaction = working.transact();
    Ok(PreparedDocumentOperationUpdate {
        update_v1: transaction.encode_state_as_update_v1(&source_vector),
        state_vector_v1: transaction.state_vector().encode_v1(),
        materialization,
        write_fence_block_ids: write_fence_block_ids.into_iter().collect(),
        title_write_fence_required,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentBodyReplacementKind {
    NfmReplacement,
    SnapshotRestore,
}

impl DocumentBodyReplacementKind {
    fn allows_reused_block_ids(self) -> bool {
        matches!(self, Self::SnapshotRestore)
    }

    fn stale_state_message(self) -> &'static str {
        match self {
            Self::NfmReplacement => "NFM replacement was prepared from a stale structural state",
            Self::SnapshotRestore => {
                "Document snapshot restore was prepared from a stale structural state"
            }
        }
    }

    fn target_mismatch_code(self) -> DocumentOperationErrorCode {
        match self {
            Self::NfmReplacement => DocumentOperationErrorCode::InvalidNfm,
            Self::SnapshotRestore => DocumentOperationErrorCode::DocumentStateCorrupt,
        }
    }

    fn target_mismatch_message(self) -> &'static str {
        match self {
            Self::NfmReplacement => {
                "NFM replacement did not reproduce its validated target Block tree"
            }
            Self::SnapshotRestore => {
                "Document snapshot restore did not reproduce its validated target Block tree"
            }
        }
    }

    fn no_change_message(self) -> &'static str {
        match self {
            Self::NfmReplacement => "NFM replacement produced no semantic change",
            Self::SnapshotRestore => "Document snapshot restore produced no semantic change",
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_operation(
    operation: &DocumentBlockOperation,
    operation_index: usize,
    schema: BlockDocumentSchema,
    body: &XmlFragmentRef,
    title: Option<&yrs::TextRef>,
    transaction: &mut yrs::TransactionMut<'_>,
    semantic_blocks: &mut Vec<MaterializedBlockNode>,
    canonical_tree: &mut BlockTree,
    write_fences: &mut BTreeSet<String>,
    title_write_fence_required: &mut bool,
) -> Result<(), DocumentOperationError> {
    match operation {
        DocumentBlockOperation::RestoreEditorHistoryForest {
            root_block_ids,
            replacement_roots,
        } => {
            let selected = root_block_ids.iter().collect::<BTreeSet<_>>();
            if selected.len() != root_block_ids.len()
                || root_block_ids
                    .iter()
                    .any(|id| !semantic_blocks.iter().any(|block| &block.id == id))
            {
                return Err(operation_error(
                    DocumentOperationErrorCode::InvalidOperation,
                    "History roots must be distinct current roots",
                    Some(operation_index),
                    None,
                ));
            }
            let mut retained = semantic_blocks
                .iter()
                .filter(|block| !selected.contains(&block.id))
                .flat_map(materialized_ids)
                .collect::<BTreeSet<_>>();
            for insertion in replacement_roots {
                for id in materialized_ids(&insertion.block) {
                    if !retained.insert(id.clone()) {
                        return Err(operation_error(
                            DocumentOperationErrorCode::DuplicateBlockId,
                            "History restoration duplicates a retained Block",
                            Some(operation_index),
                            Some(&id),
                        ));
                    }
                }
            }
            let nested = root_block_ids
                .iter()
                .map(|id| DocumentBlockOperation::DeleteBlock {
                    block_id: id.clone(),
                })
                .chain(replacement_roots.iter().map(|insertion| {
                    DocumentBlockOperation::InsertBlock {
                        block: insertion.block.clone(),
                        parent_block_id: None,
                        before_block_id: insertion.before_block_id.clone(),
                    }
                }));
            for operation in nested {
                apply_operation(
                    &operation,
                    operation_index,
                    schema,
                    body,
                    title,
                    transaction,
                    semantic_blocks,
                    canonical_tree,
                    write_fences,
                    title_write_fence_required,
                )?;
            }
            Ok(())
        }
        DocumentBlockOperation::SetTitle { title: desired } => {
            let desired = if desired.is_empty() {
                Vec::new()
            } else {
                vec![RichTextItem::Text {
                    text: desired.clone(),
                    styles: RichTextStyles::default(),
                }]
            };
            replace_title(
                schema,
                title,
                transaction,
                &desired,
                operation_index,
                title_write_fence_required,
            )
        }
        DocumentBlockOperation::SetRichTitle { rich_title } => replace_title(
            schema,
            title,
            transaction,
            rich_title,
            operation_index,
            title_write_fence_required,
        ),
        DocumentBlockOperation::InsertBlock {
            block,
            parent_block_id,
            before_block_id,
        } => {
            let inserted = dematerialize_block_tree(std::slice::from_ref(block))?;
            let mut next = semantic_blocks.clone();
            insert_semantic_block(
                &mut next,
                block.clone(),
                parent_block_id.as_deref(),
                before_block_id.as_deref(),
                operation_index,
            )?;
            let next_canonical = dematerialize_block_tree(&next)?;
            let target = resolve_insertion_group(
                body,
                transaction,
                parent_block_id.as_deref(),
                before_block_id.as_deref(),
                operation_index,
            )?;
            insert_block_nodes(&target.0, transaction, target.1, &inserted.blocks);
            *semantic_blocks = next;
            *canonical_tree = next_canonical;
            Ok(())
        }
        DocumentBlockOperation::UpdateBlock { block_id, patch } => {
            if patch.content.is_some() && patch.unset_content {
                return Err(operation_error(
                    DocumentOperationErrorCode::InvalidOperation,
                    "Block update cannot replace and unset content together",
                    Some(operation_index),
                    Some(block_id),
                ));
            }
            let current = find_semantic_block(semantic_blocks, block_id)
                .cloned()
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            let mut updated = current.clone();
            if let Some(block_type) = &patch.block_type {
                updated.block_type = block_type.clone();
            }
            if let Some(props) = &patch.props {
                updated.props = props.clone();
            }
            if patch.unset_content {
                updated.content = None;
            } else if let Some(content) = &patch.content {
                updated.content = Some(content.clone());
            }
            if updated == current {
                return Ok(());
            }
            let mut next = semantic_blocks.clone();
            *find_semantic_block_mut(&mut next, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))? = updated;
            let next_canonical = dematerialize_block_tree(&next)?;
            let updated_canonical = find_canonical_block(&next_canonical.blocks, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            let location = locate_xml_block(body, transaction, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            replace_block_content_element(
                &location.container,
                transaction,
                &updated_canonical.content,
            )?;
            write_fences.insert(block_id.clone());
            *semantic_blocks = next;
            *canonical_tree = next_canonical;
            Ok(())
        }
        DocumentBlockOperation::DeleteBlock { block_id } => {
            let removed = remove_semantic_block(semantic_blocks, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            let location = locate_xml_block(body, transaction, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            location
                .parent_group
                .remove(transaction, location.sibling_index);
            collect_materialized_ids(&removed, write_fences);
            *canonical_tree = dematerialize_block_tree(semantic_blocks)?;
            Ok(())
        }
        DocumentBlockOperation::MoveBlock {
            block_id,
            parent_block_id,
            before_block_id,
        } => {
            let source = find_semantic_block(semantic_blocks, block_id)
                .cloned()
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            if parent_block_id
                .as_deref()
                .is_some_and(|parent| contains_materialized_id(&source, parent))
            {
                return Err(operation_error(
                    DocumentOperationErrorCode::AncestorCycle,
                    "Cannot move a Block into its own subtree",
                    Some(operation_index),
                    Some(block_id),
                ));
            }
            if before_block_id
                .as_deref()
                .is_some_and(|anchor| contains_materialized_id(&source, anchor))
            {
                return Err(operation_error(
                    DocumentOperationErrorCode::InvalidAnchor,
                    "Insertion anchor cannot belong to the moved subtree",
                    Some(operation_index),
                    Some(block_id),
                ));
            }
            let mut next = semantic_blocks.clone();
            let removed = remove_semantic_block(&mut next, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            insert_semantic_block(
                &mut next,
                removed,
                parent_block_id.as_deref(),
                before_block_id.as_deref(),
                operation_index,
            )?;
            if &next == semantic_blocks {
                return Ok(());
            }
            let source_canonical = find_canonical_block(&canonical_tree.blocks, block_id)
                .cloned()
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            let source_location = locate_xml_block(body, transaction, block_id)
                .ok_or_else(|| block_not_found(operation_index, block_id))?;
            source_location
                .parent_group
                .remove(transaction, source_location.sibling_index);
            let target = resolve_insertion_group(
                body,
                transaction,
                parent_block_id.as_deref(),
                before_block_id.as_deref(),
                operation_index,
            )?;
            insert_block_nodes(
                &target.0,
                transaction,
                target.1,
                std::slice::from_ref(&source_canonical),
            );
            collect_canonical_ids(&source_canonical, write_fences);
            *semantic_blocks = next;
            *canonical_tree = dematerialize_block_tree(semantic_blocks)?;
            Ok(())
        }
        DocumentBlockOperation::MergeBlockBackward {
            target_block_id,
            source_block_id,
            merged_content,
            promoted_parent_block_id,
            promoted_before_block_id,
            promoted_child_ids,
        } => {
            let source = find_semantic_block(semantic_blocks, source_block_id)
                .cloned()
                .ok_or_else(|| block_not_found(operation_index, source_block_id))?;
            let actual_child_ids = source
                .children
                .iter()
                .map(|child| child.id.clone())
                .collect::<Vec<_>>();
            if actual_child_ids != *promoted_child_ids {
                return Err(operation_error(
                    DocumentOperationErrorCode::InvalidOperation,
                    "Backward merge source children changed before promotion",
                    Some(operation_index),
                    Some(source_block_id),
                ));
            }
            let mut nested = Vec::with_capacity(promoted_child_ids.len() + 2);
            nested.push(DocumentBlockOperation::UpdateBlock {
                block_id: target_block_id.clone(),
                patch: DocumentBlockUpdatePatch {
                    block_type: None,
                    props: None,
                    content: Some(merged_content.clone()),
                    unset_content: false,
                },
            });
            nested.extend(promoted_child_ids.iter().map(|child_id| {
                DocumentBlockOperation::MoveBlock {
                    block_id: child_id.clone(),
                    parent_block_id: promoted_parent_block_id.clone(),
                    before_block_id: promoted_before_block_id.clone(),
                }
            }));
            nested.push(DocumentBlockOperation::DeleteBlock {
                block_id: source_block_id.clone(),
            });
            for operation in &nested {
                apply_operation(
                    operation,
                    operation_index,
                    schema,
                    body,
                    title,
                    transaction,
                    semantic_blocks,
                    canonical_tree,
                    write_fences,
                    title_write_fence_required,
                )?;
            }
            Ok(())
        }
        DocumentBlockOperation::RestoreBackwardMerge {
            target_block_id,
            target_content,
            source_block,
            source_parent_block_id,
            source_before_block_id,
            promoted_child_ids,
        } => {
            if !source_block.children.is_empty() {
                return Err(operation_error(
                    DocumentOperationErrorCode::InvalidOperation,
                    "Backward merge restoration requires a shallow source shell",
                    Some(operation_index),
                    Some(&source_block.id),
                ));
            }
            if find_semantic_block(semantic_blocks, &source_block.id).is_some() {
                return Err(operation_error(
                    DocumentOperationErrorCode::InvalidOperation,
                    "Backward merge source shell is already present",
                    Some(operation_index),
                    Some(&source_block.id),
                ));
            }
            let insertion_anchor = promoted_child_ids
                .first()
                .cloned()
                .or_else(|| source_before_block_id.clone());
            let mut nested = Vec::with_capacity(promoted_child_ids.len() + 2);
            nested.push(DocumentBlockOperation::UpdateBlock {
                block_id: target_block_id.clone(),
                patch: DocumentBlockUpdatePatch {
                    block_type: None,
                    props: None,
                    content: Some(target_content.clone()),
                    unset_content: false,
                },
            });
            nested.push(DocumentBlockOperation::InsertBlock {
                block: source_block.clone(),
                parent_block_id: source_parent_block_id.clone(),
                before_block_id: insertion_anchor,
            });
            nested.extend(promoted_child_ids.iter().map(|child_id| {
                DocumentBlockOperation::MoveBlock {
                    block_id: child_id.clone(),
                    parent_block_id: Some(source_block.id.clone()),
                    before_block_id: None,
                }
            }));
            for operation in &nested {
                apply_operation(
                    operation,
                    operation_index,
                    schema,
                    body,
                    title,
                    transaction,
                    semantic_blocks,
                    canonical_tree,
                    write_fences,
                    title_write_fence_required,
                )?;
            }
            Ok(())
        }
    }
}

fn replace_title(
    schema: BlockDocumentSchema,
    title: Option<&yrs::TextRef>,
    transaction: &mut yrs::TransactionMut<'_>,
    desired: &[RichTextItem],
    operation_index: usize,
    title_write_fence_required: &mut bool,
) -> Result<(), DocumentOperationError> {
    if !schema.has_title() {
        return Err(operation_error(
            DocumentOperationErrorCode::InvalidOperation,
            "This Document schema does not own a title root",
            Some(operation_index),
            None,
        ));
    }
    let title = title.expect("title-capable schema must resolve its title root");
    let desired = canonicalize_rich_text(desired)?;
    let current = crate::domain::block_tree::decode_text_delta(title, transaction)?;
    let current = crate::domain::rich_text::materialize_rich_text(&current)?;
    if current.rich_text == desired.rich_text {
        return Ok(());
    }
    replace_text_delta(title, transaction, &rich_text_to_delta(&desired.rich_text)?);
    *title_write_fence_required = true;
    Ok(())
}

fn load_document(document_id: &str, state: &[u8]) -> Result<Doc, DocumentOperationError> {
    if state.len() > MAX_DOCUMENT_UPDATE_BYTES {
        return Err(DocumentOperationError::Yrs(format!(
            "document state exceeds {MAX_DOCUMENT_UPDATE_BYTES} bytes"
        )));
    }
    let document = create_compatible_document(document_id);
    let update =
        Update::decode_v1(state).map_err(|error| DocumentOperationError::Yrs(error.to_string()))?;
    let mut transaction = document.transact_mut();
    transaction
        .apply_update(update)
        .map_err(|error| DocumentOperationError::Yrs(error.to_string()))?;
    if has_pending_dependencies(&transaction) {
        return Err(DocumentOperationError::Yrs(
            "document state has unresolved causal dependencies".to_owned(),
        ));
    }
    drop(transaction);
    Ok(document)
}

fn collect_inserted_ids(
    operations: &[DocumentBlockOperation],
    current: &BlockTree,
) -> Result<(), DocumentOperationError> {
    let mut ids: BTreeSet<_> = current_ids(&current.blocks).into_iter().collect();
    for (operation_index, operation) in operations.iter().enumerate() {
        let DocumentBlockOperation::InsertBlock { block, .. } = operation else {
            continue;
        };
        for id in materialized_ids(block) {
            if ids.insert(id.clone()) {
                continue;
            }
            return Err(operation_error(
                DocumentOperationErrorCode::DuplicateBlockId,
                format!("Inserted Block identity {id} already exists"),
                Some(operation_index),
                Some(&id),
            ));
        }
    }
    Ok(())
}

fn materialized_ids(block: &MaterializedBlockNode) -> Vec<String> {
    let mut ids = vec![block.id.clone()];
    for child in &block.children {
        ids.extend(materialized_ids(child));
    }
    ids
}

fn flatten_materialized_ids(blocks: &[MaterializedBlockNode]) -> Vec<String> {
    blocks.iter().flat_map(materialized_ids).collect()
}

fn overlapping_match_starts(source: &str, needle: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut from = 0usize;
    while from <= source.len().saturating_sub(needle.len()) {
        let Some(relative) = source[from..].find(needle) else {
            break;
        };
        let start = from + relative;
        starts.push(start);
        let advance = source[start..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
        from = start + advance;
    }
    starts
}

fn current_ids(blocks: &[BlockNode]) -> Vec<String> {
    blocks
        .iter()
        .flat_map(|block| {
            let mut ids = vec![block.id.clone()];
            ids.extend(current_ids(&block.children));
            ids
        })
        .collect()
}

fn locate_xml_block<T: ReadTxn>(
    body: &XmlFragmentRef,
    transaction: &T,
    block_id: &str,
) -> Option<XmlBlockLocation> {
    let root = match body.get(transaction, 0)? {
        XmlOut::Element(root) if root.tag().as_ref() == BLOCK_GROUP_NODE_NAME => root,
        _ => return None,
    };
    locate_in_group(&root, transaction, block_id)
}

fn locate_in_group<T: ReadTxn>(
    group: &yrs::XmlElementRef,
    transaction: &T,
    block_id: &str,
) -> Option<XmlBlockLocation> {
    for (index, child) in group.children(transaction).enumerate() {
        let XmlOut::Element(container) = child else {
            continue;
        };
        if read_string_attribute(&container, transaction, BLOCK_ID_ATTRIBUTE).as_deref()
            == Some(block_id)
        {
            return Some(XmlBlockLocation {
                parent_group: group.clone(),
                container,
                sibling_index: index as u32,
            });
        }
        for nested in container.children(transaction) {
            let XmlOut::Element(nested_group) = nested else {
                continue;
            };
            if nested_group.tag().as_ref() != BLOCK_GROUP_NODE_NAME {
                continue;
            }
            if let Some(location) = locate_in_group(&nested_group, transaction, block_id) {
                return Some(location);
            }
        }
    }
    None
}

fn read_string_attribute<T: ReadTxn>(
    element: &yrs::XmlElementRef,
    transaction: &T,
    key: &str,
) -> Option<String> {
    match element.get_attribute(transaction, key)? {
        Out::Any(Any::String(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn resolve_insertion_group(
    body: &XmlFragmentRef,
    transaction: &mut yrs::TransactionMut<'_>,
    parent_block_id: Option<&str>,
    before_block_id: Option<&str>,
    operation_index: usize,
) -> Result<(yrs::XmlElementRef, u32), DocumentOperationError> {
    let group = match parent_block_id {
        None => match body.get(transaction, 0) {
            Some(XmlOut::Element(group)) if group.tag().as_ref() == BLOCK_GROUP_NODE_NAME => group,
            _ => {
                return Err(operation_error(
                    DocumentOperationErrorCode::DocumentStateCorrupt,
                    "Document body is missing its canonical root group",
                    Some(operation_index),
                    None,
                ));
            }
        },
        Some(parent_id) => {
            let parent = locate_xml_block(body, transaction, parent_id)
                .ok_or_else(|| invalid_anchor(operation_index, parent_id))?;
            let existing = parent.container.children(transaction).find_map(|child| {
                let XmlOut::Element(group) = child else {
                    return None;
                };
                (group.tag().as_ref() == BLOCK_GROUP_NODE_NAME).then_some(group)
            });
            existing.unwrap_or_else(|| {
                let index = parent.container.len(transaction);
                parent.container.insert(
                    transaction,
                    index,
                    XmlElementPrelim::empty(BLOCK_GROUP_NODE_NAME),
                )
            })
        }
    };
    let index = match before_block_id {
        None => group.len(transaction),
        Some(anchor_id) => {
            let anchor = locate_xml_block(body, transaction, anchor_id)
                .ok_or_else(|| invalid_anchor(operation_index, anchor_id))?;
            if anchor.parent_group != group {
                return Err(invalid_anchor(operation_index, anchor_id));
            }
            anchor.sibling_index
        }
    };
    Ok((group, index))
}

fn insert_semantic_block(
    roots: &mut Vec<MaterializedBlockNode>,
    block: MaterializedBlockNode,
    parent_block_id: Option<&str>,
    before_block_id: Option<&str>,
    operation_index: usize,
) -> Result<(), DocumentOperationError> {
    let siblings = match parent_block_id {
        Some(parent_id) => {
            &mut find_semantic_block_mut(roots, parent_id)
                .ok_or_else(|| invalid_anchor(operation_index, parent_id))?
                .children
        }
        None => roots,
    };
    let index = match before_block_id {
        Some(anchor) => siblings
            .iter()
            .position(|candidate| candidate.id == anchor)
            .ok_or_else(|| invalid_anchor(operation_index, anchor))?,
        None => siblings.len(),
    };
    siblings.insert(index, block);
    Ok(())
}

fn find_semantic_block<'a>(
    blocks: &'a [MaterializedBlockNode],
    block_id: &str,
) -> Option<&'a MaterializedBlockNode> {
    for block in blocks {
        if block.id == block_id {
            return Some(block);
        }
        if let Some(found) = find_semantic_block(&block.children, block_id) {
            return Some(found);
        }
    }
    None
}

fn find_semantic_block_mut<'a>(
    blocks: &'a mut [MaterializedBlockNode],
    block_id: &str,
) -> Option<&'a mut MaterializedBlockNode> {
    for block in blocks {
        if block.id == block_id {
            return Some(block);
        }
        if let Some(found) = find_semantic_block_mut(&mut block.children, block_id) {
            return Some(found);
        }
    }
    None
}

fn remove_semantic_block(
    blocks: &mut Vec<MaterializedBlockNode>,
    block_id: &str,
) -> Option<MaterializedBlockNode> {
    if let Some(index) = blocks.iter().position(|block| block.id == block_id) {
        return Some(blocks.remove(index));
    }
    for block in blocks {
        if let Some(removed) = remove_semantic_block(&mut block.children, block_id) {
            return Some(removed);
        }
    }
    None
}

fn find_canonical_block<'a>(blocks: &'a [BlockNode], block_id: &str) -> Option<&'a BlockNode> {
    for block in blocks {
        if block.id == block_id {
            return Some(block);
        }
        if let Some(found) = find_canonical_block(&block.children, block_id) {
            return Some(found);
        }
    }
    None
}

fn contains_materialized_id(block: &MaterializedBlockNode, block_id: &str) -> bool {
    block.id == block_id
        || block
            .children
            .iter()
            .any(|child| contains_materialized_id(child, block_id))
}

fn collect_materialized_ids(block: &MaterializedBlockNode, ids: &mut BTreeSet<String>) {
    ids.insert(block.id.clone());
    for child in &block.children {
        collect_materialized_ids(child, ids);
    }
}

fn collect_canonical_ids(block: &BlockNode, ids: &mut BTreeSet<String>) {
    ids.insert(block.id.clone());
    for child in &block.children {
        collect_canonical_ids(child, ids);
    }
}

fn operation_error(
    code: DocumentOperationErrorCode,
    message: impl Into<String>,
    operation_index: Option<usize>,
    block_id: Option<&str>,
) -> DocumentOperationError {
    DocumentOperationError::Operation {
        code,
        message: message.into(),
        operation_index,
        block_id: block_id.map(str::to_owned),
    }
}

fn block_not_found(operation_index: usize, block_id: &str) -> DocumentOperationError {
    operation_error(
        DocumentOperationErrorCode::BlockNotFound,
        format!("Block {block_id} does not exist"),
        Some(operation_index),
        Some(block_id),
    )
}

fn invalid_anchor(operation_index: usize, block_id: &str) -> DocumentOperationError {
    operation_error(
        DocumentOperationErrorCode::InvalidAnchor,
        format!("Block insertion anchor {block_id} is invalid"),
        Some(operation_index),
        Some(block_id),
    )
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use yrs::StateVector;
    use yrs::updates::encoder::Encode;

    use super::*;

    fn matrix_state() -> (Vec<u8>, Vec<u8>) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let state = std::fs::read(root.join("matrix-base.bin")).expect("matrix state");
        let document = load_document("operations-matrix", &state).expect("matrix document");
        let vector = document.transact().state_vector().encode_v1();
        (state, vector)
    }

    fn paragraph(id: &str, text: &str) -> MaterializedBlockNode {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "type": "paragraph",
            "props": {
                "backgroundColor": "default",
                "textColor": "default",
                "textAlignment": "left"
            },
            "content": [{ "type": "text", "text": text, "styles": {} }],
            "children": []
        }))
        .expect("paragraph")
    }

    fn fixture_head(
        file_name: &str,
        document_id: &str,
        schema: BlockDocumentSchema,
    ) -> PortableSubtreeDocumentHead {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let state = std::fs::read(root.join(file_name)).expect("fixture state");
        let document = load_document(document_id, &state).expect("fixture document");
        let vector = document.transact().state_vector().encode_v1();
        PortableSubtreeDocumentHead {
            document_id: document_id.to_owned(),
            schema,
            full_state_v1: state,
            expected_state_vector_v1: vector,
        }
    }

    #[test]
    fn prepares_one_incremental_update_for_stable_block_and_title_operations() {
        let (state, vector) = matrix_state();
        let operations = vec![
            DocumentBlockOperation::SetTitle {
                title: "Rust authority".to_owned(),
            },
            DocumentBlockOperation::InsertBlock {
                block: paragraph("rust-insert", "Inserted by Rust"),
                parent_block_id: None,
                before_block_id: Some("matrix-heading".to_owned()),
            },
            DocumentBlockOperation::UpdateBlock {
                block_id: "matrix-heading".to_owned(),
                patch: DocumentBlockUpdatePatch {
                    block_type: None,
                    props: None,
                    content: Some(serde_json::json!([{
                        "type": "text",
                        "text": "Updated heading",
                        "styles": { "bold": true }
                    }])),
                    unset_content: false,
                },
            },
            DocumentBlockOperation::MoveBlock {
                block_id: "matrix-quote".to_owned(),
                parent_block_id: Some("matrix-toggle".to_owned()),
                before_block_id: None,
            },
            DocumentBlockOperation::DeleteBlock {
                block_id: "matrix-divider".to_owned(),
            },
        ];

        let prepared = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &operations,
            false,
        )
        .expect("prepared update");
        assert!(!prepared.update_v1.is_empty());
        assert_eq!(prepared.materialization.title, "Rust authority");
        assert!(find_semantic_block(&prepared.materialization.block_tree, "rust-insert").is_some());
        assert!(
            find_semantic_block(&prepared.materialization.block_tree, "matrix-divider").is_none()
        );
        assert_eq!(
            prepared.write_fence_block_ids,
            vec![
                "matrix-divider".to_owned(),
                "matrix-heading".to_owned(),
                "matrix-quote".to_owned(),
            ]
        );
        assert!(prepared.title_write_fence_required);

        let consumer = load_document("operations-consumer", &state).expect("consumer");
        consumer
            .transact_mut()
            .apply_update(Update::decode_v1(&prepared.update_v1).expect("incremental update"))
            .expect("consumer accepts update");
        let actual = materialize_decoded_document(
            &decode_block_document(&consumer, BlockDocumentSchema::PageV3)
                .expect("consumer document"),
        )
        .expect("consumer materialization");
        assert_eq!(actual, prepared.materialization);
    }

    #[test]
    fn rejects_stale_vectors_cycles_duplicates_and_semantic_noops() {
        let (state, vector) = matrix_state();
        let stale = StateVector::default().encode_v1();
        let error = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &stale,
            &[DocumentBlockOperation::DeleteBlock {
                block_id: "matrix-divider".to_owned(),
            }],
            false,
        )
        .expect_err("stale vector");
        assert_eq!(error.code(), DocumentOperationErrorCode::StaleStateVector);

        let duplicate = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &[DocumentBlockOperation::InsertBlock {
                block: paragraph("matrix-heading", "duplicate"),
                parent_block_id: None,
                before_block_id: None,
            }],
            false,
        )
        .expect_err("duplicate identity");
        assert_eq!(
            duplicate.code(),
            DocumentOperationErrorCode::DuplicateBlockId
        );

        let cycle = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &[DocumentBlockOperation::MoveBlock {
                block_id: "matrix-toggle".to_owned(),
                parent_block_id: Some("matrix-toggle-child".to_owned()),
                before_block_id: None,
            }],
            false,
        )
        .expect_err("ancestor cycle");
        assert_eq!(cycle.code(), DocumentOperationErrorCode::AncestorCycle);

        let no_change = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &[DocumentBlockOperation::MoveBlock {
                block_id: "matrix-paragraph".to_owned(),
                parent_block_id: None,
                before_block_id: Some("matrix-callout".to_owned()),
            }],
            false,
        )
        .expect_err("semantic no-op");
        assert_eq!(no_change.code(), DocumentOperationErrorCode::NoChange);
    }

    #[test]
    fn applies_exact_non_overlapping_nfm_patches_with_unicode() {
        let patched = apply_exact_nfm_patches(
            "Alpha 😀\nBeta 😀",
            &[
                ExactNfmPatch {
                    old_nfm: "😀".to_owned(),
                    new_nfm: "中".to_owned(),
                    expected_matches: Some(2),
                },
                ExactNfmPatch {
                    old_nfm: "Beta".to_owned(),
                    new_nfm: "Gamma".to_owned(),
                    expected_matches: None,
                },
            ],
        )
        .expect("exact patches");
        assert_eq!(patched, "Alpha 中\nGamma 中");

        let missing = apply_exact_nfm_patches(
            "One",
            &[ExactNfmPatch {
                old_nfm: "Missing".to_owned(),
                new_nfm: "Replacement".to_owned(),
                expected_matches: None,
            }],
        )
        .expect_err("missing fragment");
        assert_eq!(missing.code(), DocumentOperationErrorCode::NfmPatchNotFound);

        let ambiguous = apply_exact_nfm_patches(
            "One One",
            &[ExactNfmPatch {
                old_nfm: "One".to_owned(),
                new_nfm: "Two".to_owned(),
                expected_matches: None,
            }],
        )
        .expect_err("ambiguous fragment");
        assert_eq!(
            ambiguous.code(),
            DocumentOperationErrorCode::NfmPatchAmbiguous
        );

        let overlap = apply_exact_nfm_patches(
            "aaa",
            &[ExactNfmPatch {
                old_nfm: "aa".to_owned(),
                new_nfm: "b".to_owned(),
                expected_matches: Some(2),
            }],
        )
        .expect_err("overlap");
        assert_eq!(overlap.code(), DocumentOperationErrorCode::NfmPatchOverlap);
    }

    #[test]
    fn prepares_a_whole_nfm_replacement_as_one_yjs_consumable_update() {
        let (state, vector) = matrix_state();
        let mut next_id = 0usize;
        let prepared = prepare_exact_nfm_patch_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &[ExactNfmPatch {
                old_nfm: "## Heading".to_owned(),
                new_nfm: "## Heading from Rust patch".to_owned(),
                expected_matches: None,
            }],
            None,
            &mut || {
                next_id += 1;
                format!("replacement-{next_id}")
            },
        )
        .expect("NFM replacement");

        assert!(
            prepared
                .materialization
                .nfm
                .contains("## Heading from Rust patch")
        );
        assert_eq!(prepared.write_fence_block_ids.len(), 20);
        assert!(!prepared.title_write_fence_required);
        let consumer = load_document("operations-consumer", &state).expect("consumer");
        consumer
            .transact_mut()
            .apply_update(Update::decode_v1(&prepared.update_v1).expect("relative update"))
            .expect("Yjs/Yrs consumer update");
        let actual = materialize_decoded_document(
            &decode_block_document(&consumer, BlockDocumentSchema::PageV3)
                .expect("consumer document"),
        )
        .expect("consumer materialization");
        assert_eq!(actual, prepared.materialization);
    }

    #[test]
    fn snapshot_restore_fences_current_and_historical_block_identities() {
        let (checkpoint_state, checkpoint_vector) = matrix_state();
        let checkpoint_document =
            load_document("operations-matrix", &checkpoint_state).expect("checkpoint document");
        let checkpoint_materialization = materialize_decoded_document(
            &decode_block_document(&checkpoint_document, BlockDocumentSchema::PageV3)
                .expect("checkpoint decode"),
        )
        .expect("checkpoint materialization");
        let extra_block_id = "01981e00-0000-7000-8000-000000000099";
        let changed = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &checkpoint_state,
            &checkpoint_vector,
            &[
                DocumentBlockOperation::InsertBlock {
                    block: paragraph(extra_block_id, "Added after checkpoint"),
                    parent_block_id: None,
                    before_block_id: None,
                },
                DocumentBlockOperation::DeleteBlock {
                    block_id: "matrix-divider".to_owned(),
                },
            ],
            false,
        )
        .expect("post-checkpoint mutation");
        let current_document =
            load_document("operations-matrix", &checkpoint_state).expect("current document");
        current_document
            .transact_mut()
            .apply_update(Update::decode_v1(&changed.update_v1).expect("changed update"))
            .expect("apply changed update");
        let (current_state, current_vector) = {
            let transaction = current_document.transact();
            (
                transaction.encode_state_as_update_v1(&StateVector::default()),
                transaction.state_vector().encode_v1(),
            )
        };

        let restored = prepare_document_snapshot_restore_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &current_state,
            &current_vector,
            &checkpoint_materialization.block_tree,
            Some(&checkpoint_materialization.rich_title),
        )
        .expect("snapshot restore");
        let expected_fences = flatten_materialized_ids(&checkpoint_materialization.block_tree)
            .into_iter()
            .chain([extra_block_id.to_owned()])
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(restored.write_fence_block_ids, expected_fences);
        assert!(
            restored
                .write_fence_block_ids
                .contains(&"matrix-divider".to_owned())
        );
        assert!(
            restored
                .write_fence_block_ids
                .contains(&extra_block_id.to_owned())
        );

        current_document
            .transact_mut()
            .apply_update(Update::decode_v1(&restored.update_v1).expect("restore update"))
            .expect("apply restore update");
        let actual = materialize_decoded_document(
            &decode_block_document(&current_document, BlockDocumentSchema::PageV3)
                .expect("restored document"),
        )
        .expect("restored materialization");
        assert_eq!(actual, checkpoint_materialization);
    }

    #[test]
    fn exact_patch_matches_the_public_body_projection_final_lf() {
        let (state, vector) = matrix_state();
        let source = load_document("operations-matrix", &state).unwrap();
        let source = materialize_decoded_document(
            &decode_block_document(&source, BlockDocumentSchema::PageV3).unwrap(),
        )
        .unwrap();
        let prepared = prepare_exact_nfm_patch_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &[ExactNfmPatch {
                old_nfm: format!("{}\n", source.nfm),
                new_nfm: "Replacement paragraph\n".to_owned(),
                expected_matches: None,
            }],
            None,
            &mut || "replacement-final-lf".to_owned(),
        )
        .expect("canonical body patch");

        assert_eq!(prepared.materialization.nfm, "Replacement paragraph");
    }

    #[test]
    fn empty_replacement_and_exact_patch_keep_one_editable_authority_block() {
        let (state, vector) = matrix_state();
        let source = load_document("operations-matrix", &state).unwrap();
        let source = materialize_decoded_document(
            &decode_block_document(&source, BlockDocumentSchema::PageV3).unwrap(),
        )
        .unwrap();

        for prepared in [
            prepare_nfm_replacement_update(
                "operations-matrix",
                BlockDocumentSchema::PageV3,
                &state,
                &vector,
                "",
                None,
                &mut || "empty-replacement".to_owned(),
            )
            .expect("empty replacement"),
            prepare_exact_nfm_patch_update(
                "operations-matrix",
                BlockDocumentSchema::PageV3,
                &state,
                &vector,
                &[ExactNfmPatch {
                    old_nfm: source.nfm,
                    new_nfm: String::new(),
                    expected_matches: Some(1),
                }],
                None,
                &mut || "empty-patch".to_owned(),
            )
            .expect("exact patch to empty Document"),
        ] {
            assert_eq!(prepared.materialization.nfm, "");
            assert_eq!(prepared.materialization.plain_text, "");
            assert_eq!(prepared.materialization.block_tree.len(), 1);
            assert_eq!(
                prepared.materialization.block_tree[0].block_type,
                "paragraph"
            );
        }
    }

    #[test]
    fn backward_merge_preserves_the_atomic_gap_and_promotes_source_children() {
        let (state, vector) = matrix_state();
        let target = paragraph("merge-target", "ABC");
        let atomic: MaterializedBlockNode = serde_json::from_value(serde_json::json!({
            "id": "merge-image",
            "type": "image",
            "props": { "url": "https://example.test/image.png", "name": "", "caption": "" },
            "children": []
        }))
        .expect("image");
        let mut source = paragraph("merge-source", "123");
        source.children.push(paragraph("merge-child", "child"));
        let merged_content = serde_json::json!([
            { "type": "text", "text": "ABC", "styles": {} },
            { "type": "text", "text": "123", "styles": {} }
        ]);
        let prepared = prepare_document_operation_update(
            "operations-matrix",
            BlockDocumentSchema::PageV3,
            &state,
            &vector,
            &[
                DocumentBlockOperation::InsertBlock {
                    block: target,
                    parent_block_id: None,
                    before_block_id: Some("matrix-heading".to_owned()),
                },
                DocumentBlockOperation::InsertBlock {
                    block: atomic,
                    parent_block_id: None,
                    before_block_id: Some("matrix-heading".to_owned()),
                },
                DocumentBlockOperation::InsertBlock {
                    block: source,
                    parent_block_id: None,
                    before_block_id: Some("matrix-heading".to_owned()),
                },
                DocumentBlockOperation::MergeBlockBackward {
                    target_block_id: "merge-target".to_owned(),
                    source_block_id: "merge-source".to_owned(),
                    merged_content: merged_content.clone(),
                    promoted_parent_block_id: None,
                    promoted_before_block_id: Some("matrix-heading".to_owned()),
                    promoted_child_ids: vec!["merge-child".to_owned()],
                },
            ],
            false,
        )
        .expect("backward merge update");

        let roots = &prepared.materialization.block_tree;
        let target = find_semantic_block(roots, "merge-target").expect("target");
        assert_eq!(target.content.as_ref(), Some(&merged_content));
        assert!(find_semantic_block(roots, "merge-source").is_none());
        let order = roots
            .iter()
            .map(|block| block.id.as_str())
            .collect::<Vec<_>>();
        let target_index = order.iter().position(|id| *id == "merge-target").unwrap();
        assert_eq!(
            &order[target_index..target_index + 4],
            &[
                "merge-target",
                "merge-image",
                "merge-child",
                "matrix-heading"
            ]
        );
    }

    #[test]
    fn keeps_body_only_source_capabilities_explicit() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let state = std::fs::read(root.join("empty-synced-block.bin")).expect("synced fixture");
        let document = load_document("empty-synced", &state).expect("synced document");
        let vector = document.transact().state_vector().encode_v1();
        let error = prepare_nfm_replacement_update(
            "empty-synced",
            BlockDocumentSchema::SyncedBlockV2,
            &state,
            &vector,
            "Synced content",
            None,
            &mut || "synced-new".to_owned(),
        )
        .expect_err("body-only NFM replacement is not a Page capability");
        assert_eq!(error.code(), DocumentOperationErrorCode::InvalidOperation);
    }

    #[test]
    fn prepares_same_document_portable_copy_and_multi_root_move_updates() {
        let head = fixture_head(
            "matrix-base.bin",
            "subtree-page",
            BlockDocumentSchema::PageV3,
        );
        let copied = prepare_portable_subtree_transfer_updates(
            &PortableSubtreeTransferRequest {
                kind: PortableSubtreeTransferKind::Copy,
                source: head.clone(),
                target: head.clone(),
                root_block_ids: vec!["matrix-toggle".to_owned()],
                insertion: BlockSubtreeInsertionTarget {
                    parent_block_id: None,
                    before_block_id: Some("matrix-heading".to_owned()),
                },
            },
            &mut |source| format!("copied-{source}"),
        )
        .expect("portable copy update");
        assert!(copied.same_document);
        assert!(copied.source.is_none());
        assert_eq!(
            copied.inserted_forest.block_ids,
            vec![
                "copied-matrix-toggle".to_owned(),
                "copied-matrix-toggle-child".to_owned(),
            ]
        );
        let copy_consumer =
            load_document("subtree-copy-consumer", &head.full_state_v1).expect("copy consumer");
        copy_consumer
            .transact_mut()
            .apply_update(Update::decode_v1(&copied.target.update_v1).expect("copy update"))
            .expect("copy update applies");
        let copy_actual = materialize_decoded_document(
            &decode_block_document(&copy_consumer, BlockDocumentSchema::PageV3)
                .expect("copy consumer document"),
        )
        .expect("copy materialization");
        assert_eq!(copy_actual, copied.target.materialization);

        let moved = prepare_portable_subtree_transfer_updates(
            &PortableSubtreeTransferRequest {
                kind: PortableSubtreeTransferKind::Move,
                source: head.clone(),
                target: head.clone(),
                root_block_ids: vec!["matrix-quote".to_owned(), "matrix-divider".to_owned()],
                insertion: BlockSubtreeInsertionTarget {
                    parent_block_id: Some("matrix-toggle".to_owned()),
                    before_block_id: Some("matrix-toggle-child".to_owned()),
                },
            },
            &mut |_| unreachable!("move preserves identities"),
        )
        .expect("portable move update");
        let toggle = find_semantic_block(&moved.target.materialization.block_tree, "matrix-toggle")
            .expect("target toggle");
        assert_eq!(
            toggle
                .children
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            vec!["matrix-quote", "matrix-divider", "matrix-toggle-child"]
        );
        let move_consumer =
            load_document("subtree-move-consumer", &head.full_state_v1).expect("move consumer");
        move_consumer
            .transact_mut()
            .apply_update(Update::decode_v1(&moved.target.update_v1).expect("move update"))
            .expect("move update applies");
        let move_actual = materialize_decoded_document(
            &decode_block_document(&move_consumer, BlockDocumentSchema::PageV3)
                .expect("move consumer document"),
        )
        .expect("move materialization");
        assert_eq!(move_actual, moved.target.materialization);
    }

    #[test]
    fn prepares_atomic_cross_document_template_to_synced_move_candidates() {
        let source = fixture_head(
            "reusable-template.bin",
            "template-source-document",
            BlockDocumentSchema::ReusableTemplateV2,
        );
        let target = fixture_head(
            "empty-synced-block.bin",
            "synced-target-document",
            BlockDocumentSchema::SyncedBlockV2,
        );
        let prepared = prepare_portable_subtree_transfer_updates(
            &PortableSubtreeTransferRequest {
                kind: PortableSubtreeTransferKind::Move,
                source: source.clone(),
                target: target.clone(),
                root_block_ids: vec!["template-block-1".to_owned()],
                insertion: BlockSubtreeInsertionTarget::default(),
            },
            &mut |_| unreachable!("move preserves identities"),
        )
        .expect("cross-Document move candidates");
        assert!(!prepared.same_document);
        let source_update = prepared.source.as_ref().expect("source removal update");
        assert!(source_update.materialization.block_tree.is_empty());
        assert_eq!(
            prepared
                .target
                .materialization
                .block_tree
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            vec!["template-block-1"]
        );
        assert!(source_update.materialization.rich_title.is_empty());
        assert!(prepared.target.materialization.rich_title.is_empty());

        let source_consumer =
            load_document("template-source-consumer", &source.full_state_v1).expect("source");
        source_consumer
            .transact_mut()
            .apply_update(Update::decode_v1(&source_update.update_v1).expect("source update"))
            .expect("source update applies");
        let source_actual = materialize_decoded_document(
            &decode_block_document(&source_consumer, BlockDocumentSchema::ReusableTemplateV2)
                .expect("source document"),
        )
        .expect("source materialization");
        assert_eq!(source_actual, source_update.materialization);

        let target_consumer =
            load_document("synced-target-consumer", &target.full_state_v1).expect("target");
        target_consumer
            .transact_mut()
            .apply_update(Update::decode_v1(&prepared.target.update_v1).expect("target update"))
            .expect("target update applies");
        let target_actual = materialize_decoded_document(
            &decode_block_document(&target_consumer, BlockDocumentSchema::SyncedBlockV2)
                .expect("target document"),
        )
        .expect("target materialization");
        assert_eq!(target_actual, prepared.target.materialization);

        let mut stale = PortableSubtreeTransferRequest {
            kind: PortableSubtreeTransferKind::Move,
            source,
            target,
            root_block_ids: vec!["template-block-1".to_owned()],
            insertion: BlockSubtreeInsertionTarget::default(),
        };
        stale.target.expected_state_vector_v1 = StateVector::default().encode_v1();
        let error = prepare_portable_subtree_transfer_updates(&stale, &mut |_| {
            unreachable!("move preserves identities")
        })
        .expect_err("target structural barrier");
        assert_eq!(error.code(), DocumentOperationErrorCode::StaleStateVector);
    }
}
