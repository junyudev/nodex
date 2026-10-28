use std::collections::BTreeMap;

use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, Transact};

use crate::domain::block_materialization::{MaterializedBlockNode, dematerialize_block_tree};
use crate::domain::block_tree::TextDelta;
use crate::domain::rich_text::{RichTextItem, rich_text_to_delta};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::markdown_input::materialize_document_markdown;
use super::operations::{DocumentBlockOperation, PreparedDocumentOperationUpdate};
use super::{
    BlockDocumentSchema, DocumentMaterialization, YrsDocumentEngine, decode_block_document,
    encode_block_document, materialize_decoded_document, prepare_document_operation_update,
};

pub(crate) struct PreparedYjsGenesis {
    pub(crate) engine: YrsDocumentEngine,
    pub(crate) materialization: DocumentMaterialization,
    pub(crate) update_v1: Vec<u8>,
    pub(crate) state_vector_v1: Vec<u8>,
}

pub(crate) fn prepare_yjs_genesis(
    document_id: &str,
    owner_type: &str,
    schema: BlockDocumentSchema,
    root_block_id: &str,
) -> Result<PreparedYjsGenesis, StoreError> {
    let blocks = empty_document(root_block_id)?;
    let tree = dematerialize_block_tree(&blocks)
        .map_err(|error| invalid(format!("Document genesis Block is invalid: {error}")))?;
    let document = encode_block_document(document_id, schema, None, &tree)
        .map_err(|error| invalid(format!("Document genesis is invalid: {error}")))?;
    let decoded = decode_block_document(&document, schema)
        .map_err(|error| invalid(format!("Document genesis schema is invalid: {error}")))?;
    let materialization = materialize_decoded_document(&decoded)
        .map_err(|error| invalid(format!("Document genesis cannot materialize: {error}")))?;
    if materialization.schema.owner_type != owner_type {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Document owner type does not match its registered schema",
            false,
        ));
    }
    let transaction = document.transact();
    let state_vector_v1 = transaction.state_vector().encode_v1();
    let update_v1 = transaction.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(transaction);
    let engine = YrsDocumentEngine::from_full_state_v1(document_id, &update_v1)
        .map_err(|error| invalid(format!("Document genesis update is invalid: {error}")))?;
    Ok(PreparedYjsGenesis {
        engine,
        materialization,
        update_v1,
        state_vector_v1,
    })
}

pub(crate) fn prepare_page_yjs_genesis(
    document_id: &str,
    title: &str,
    root_block_id: &str,
) -> Result<PreparedYjsGenesis, StoreError> {
    let blocks = empty_document(root_block_id)?;
    let tree = dematerialize_block_tree(&blocks)
        .map_err(|error| invalid(format!("Page genesis Block is invalid: {error}")))?;
    let title = (!title.is_empty()).then(|| {
        vec![TextDelta {
            insert: title.to_owned(),
            attributes: BTreeMap::new(),
        }]
    });
    let document = encode_block_document(
        document_id,
        BlockDocumentSchema::PageV4,
        title.as_deref(),
        &tree,
    )
    .map_err(|error| invalid(format!("Page genesis is invalid: {error}")))?;
    prepare_encoded_genesis(document_id, "page", BlockDocumentSchema::PageV4, document)
}

pub(crate) fn prepare_page_yjs_genesis_with_content(
    document_id: &str,
    rich_title: &[RichTextItem],
    markdown: &str,
    allocate_block_id: &mut impl FnMut() -> String,
) -> Result<PreparedYjsGenesis, StoreError> {
    let blocks = materialize_document_markdown(markdown, allocate_block_id)
        .map_err(|error| invalid(format!("Page genesis Nodex Markdown is invalid: {error}")))?;
    let tree = dematerialize_block_tree(&blocks)
        .map_err(|error| invalid(format!("Page genesis Blocks are invalid: {error}")))?;
    let title = if rich_title.is_empty() {
        None
    } else {
        Some(
            rich_text_to_delta(rich_title)
                .map_err(|error| invalid(format!("Page genesis title is invalid: {error}")))?,
        )
    };
    let document = encode_block_document(
        document_id,
        BlockDocumentSchema::PageV4,
        title.as_deref(),
        &tree,
    )
    .map_err(|error| invalid(format!("Page genesis is invalid: {error}")))?;
    prepare_encoded_genesis(document_id, "page", BlockDocumentSchema::PageV4, document)
}

pub(crate) fn prepare_yjs_genesis_with_blocks(
    document_id: &str,
    owner_type: &str,
    schema: BlockDocumentSchema,
    blocks: &[MaterializedBlockNode],
) -> Result<PreparedYjsGenesis, StoreError> {
    let tree = dematerialize_block_tree(blocks)
        .map_err(|error| invalid(format!("Document genesis Blocks are invalid: {error}")))?;
    let document = encode_block_document(document_id, schema, None, &tree)
        .map_err(|error| invalid(format!("Document genesis is invalid: {error}")))?;
    prepare_encoded_genesis(document_id, owner_type, schema, document)
}

pub(crate) fn prepare_yjs_clone_genesis(
    document_id: &str,
    owner_type: &str,
    schema: BlockDocumentSchema,
    title: Option<&[TextDelta]>,
    blocks: &[MaterializedBlockNode],
) -> Result<PreparedYjsGenesis, StoreError> {
    let tree = dematerialize_block_tree(blocks)
        .map_err(|error| invalid(format!("Document clone Blocks are invalid: {error}")))?;
    let document = encode_block_document(document_id, schema, title, &tree)
        .map_err(|error| invalid(format!("Document clone is invalid: {error}")))?;
    prepare_encoded_genesis(document_id, owner_type, schema, document)
}

fn prepare_encoded_genesis(
    document_id: &str,
    owner_type: &str,
    schema: BlockDocumentSchema,
    document: yrs::Doc,
) -> Result<PreparedYjsGenesis, StoreError> {
    let decoded = decode_block_document(&document, schema)
        .map_err(|error| invalid(format!("Document genesis schema is invalid: {error}")))?;
    let materialization = materialize_decoded_document(&decoded)
        .map_err(|error| invalid(format!("Document genesis cannot materialize: {error}")))?;
    if materialization.schema.owner_type != owner_type {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Document owner type does not match its registered schema",
            false,
        ));
    }
    let transaction = document.transact();
    let state_vector_v1 = transaction.state_vector().encode_v1();
    let update_v1 = transaction.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(transaction);
    let engine = YrsDocumentEngine::from_full_state_v1(document_id, &update_v1)
        .map_err(|error| invalid(format!("Document genesis update is invalid: {error}")))?;
    Ok(PreparedYjsGenesis {
        engine,
        materialization,
        update_v1,
        state_vector_v1,
    })
}

pub(crate) fn prepare_editable_root(
    document_id: &str,
    schema: BlockDocumentSchema,
    engine: &YrsDocumentEngine,
    root_block_id: &str,
) -> Result<Option<PreparedDocumentOperationUpdate>, StoreError> {
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| corrupt(format!("Owned Document schema is invalid: {error}")))?;
    if !decoded.block_tree.blocks.is_empty() {
        return Ok(None);
    }
    prepare_document_operation_update(
        document_id,
        schema,
        &engine.full_state_v1(),
        &engine.state_vector_v1(),
        &[DocumentBlockOperation::InsertBlock {
            block: empty_document(root_block_id)?
                .into_iter()
                .next()
                .expect("empty Document boundary always materializes one Block"),
            parent_block_id: None,
            before_block_id: None,
        }],
        false,
    )
    .map(Some)
    .map_err(|error| {
        invalid(format!(
            "Editable Document root could not be prepared: {error}"
        ))
    })
}

fn empty_document(block_id: &str) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    materialize_document_markdown("", &mut || block_id.to_owned())
        .map_err(|error| invalid(format!("Empty Document boundary is invalid: {error}")))
}

fn invalid(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn corrupt(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
