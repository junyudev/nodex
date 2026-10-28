use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use yrs::types::text::YChange;
use yrs::types::xml::{XmlDeltaPrelim, XmlElementPrelim, XmlIn};
use yrs::types::{Attrs, Delta};
use yrs::{
    Any, In, Out, ReadTxn, Text, TextRef, TransactionMut, Xml, XmlFragment, XmlFragmentRef, XmlOut,
};

use super::block_children::accepts_block_children;

pub const BLOCK_GROUP_NODE_NAME: &str = "blockGroup";
pub const BLOCK_CONTAINER_NODE_NAME: &str = "blockContainer";
pub const BLOCK_ID_ATTRIBUTE: &str = "id";
pub const MAX_BLOCK_ID_LENGTH: usize = 512;
pub const MAX_BLOCKS: usize = 100_000;
pub const MAX_XML_PATH_DEPTH: usize = 512;
pub const MAX_PORTABLE_VALUE_DEPTH: usize = 64;
pub const REGISTERED_BLOCK_TYPES: &[&str] = &[
    "paragraph",
    "heading",
    "bulletListItem",
    "numberedListItem",
    "checkListItem",
    "toggleListItem",
    "codeBlock",
    "mathBlock",
    "table",
    "quote",
    "divider",
    "image",
    "callout",
    "canvas",
    "page",
    "database",
    "pageRef",
    "databaseViewRef",
    "syncedBlockRef",
    "templateRef",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PortableValue {
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(String),
    Binary(Vec<u8>),
    Array(Vec<PortableValue>),
    Object(BTreeMap<String, PortableValue>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDelta {
    pub insert: String,
    pub attributes: BTreeMap<String, PortableValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum XmlNode {
    Element(XmlElementNode),
    Text { delta: Vec<TextDelta> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XmlElementNode {
    pub name: String,
    pub attributes: BTreeMap<String, PortableValue>,
    pub children: Vec<XmlNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockNode {
    pub id: String,
    pub container_attributes: BTreeMap<String, PortableValue>,
    pub content: XmlElementNode,
    pub children: Vec<BlockNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockTree {
    pub root_attributes: BTreeMap<String, PortableValue>,
    pub blocks: Vec<BlockNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockTreeIssueCode {
    MissingBlockId,
    InvalidBlockId,
    DuplicateBlockId,
    UnsupportedBlockType,
    TooManyBlocks,
    XmlDepthExceeded,
    BlockChildrenNotAllowed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockTreeIssue {
    pub code: BlockTreeIssueCode,
    pub path: Vec<usize>,
    pub block_id: Option<String>,
    pub block_type: Option<String>,
}

#[derive(Debug, Error, PartialEq)]
pub enum BlockTreeError {
    #[error("invalid persisted XML at {path:?}: {message}")]
    InvalidXml { path: Vec<usize>, message: String },
    #[error("unsupported portable XML value at {path:?}: {message}")]
    UnsupportedValue { path: Vec<usize>, message: String },
    #[error("Block tree validation failed with {0:?}")]
    Validation(Vec<BlockTreeIssue>),
    #[error("Block tree destination must be empty")]
    DestinationNotEmpty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedBlock {
    pub id: String,
    pub block_type: String,
    pub parent_block_id: Option<String>,
    pub path: Vec<usize>,
    pub text: String,
}

pub fn decode_block_tree<T: ReadTxn>(
    body: &XmlFragmentRef,
    transaction: &T,
) -> Result<BlockTree, BlockTreeError> {
    let roots: Vec<_> = body.children(transaction).collect();
    if roots.len() != 1 {
        return Err(invalid_xml(
            vec![],
            format!(
                "expected exactly one root blockGroup, found {}",
                roots.len()
            ),
        ));
    }
    let root = require_element(roots.into_iter().next().expect("one root"), &[])?;
    if root.tag().as_ref() != BLOCK_GROUP_NODE_NAME {
        return Err(invalid_xml(
            vec![0],
            format!("expected blockGroup, found {}", root.tag()),
        ));
    }

    let tree = BlockTree {
        root_attributes: decode_attributes(&root, transaction, &[0])?,
        blocks: decode_group_children(&root, transaction, &[0])?,
    };
    let issues = validate_block_tree(&tree);
    if !issues.is_empty() {
        return Err(BlockTreeError::Validation(issues));
    }
    Ok(tree)
}

/// Exact-baseline Store migrations may read trees that predate the current
/// parent capability contract or contain retired prompt markers. Every other
/// structural invariant stays active;
/// the tree must be normalized before it can enter a current runtime path.
pub(crate) fn decode_block_tree_allowing_illegal_children<T: ReadTxn>(
    body: &XmlFragmentRef,
    transaction: &T,
) -> Result<BlockTree, BlockTreeError> {
    let roots: Vec<_> = body.children(transaction).collect();
    if roots.len() != 1 {
        return Err(invalid_xml(
            vec![],
            format!(
                "expected exactly one root blockGroup, found {}",
                roots.len()
            ),
        ));
    }
    let root = require_element(roots.into_iter().next().expect("one root"), &[])?;
    if root.tag().as_ref() != BLOCK_GROUP_NODE_NAME {
        return Err(invalid_xml(
            vec![0],
            format!("expected blockGroup, found {}", root.tag()),
        ));
    }
    let tree = BlockTree {
        root_attributes: decode_attributes(&root, transaction, &[0])?,
        blocks: decode_group_children(&root, transaction, &[0])?,
    };
    let issues = validate_block_tree(&tree)
        .into_iter()
        .filter(|issue| {
            issue.code != BlockTreeIssueCode::BlockChildrenNotAllowed
                && !(issue.code == BlockTreeIssueCode::UnsupportedBlockType
                    && issue.block_type.as_deref() == Some("threadSection"))
        })
        .collect::<Vec<_>>();
    if issues.is_empty() {
        return Ok(tree);
    }
    Err(BlockTreeError::Validation(issues))
}

pub fn decode_text_delta<T: ReadTxn>(
    text: &TextRef,
    transaction: &T,
) -> Result<Vec<TextDelta>, BlockTreeError> {
    decode_text(text, transaction, &[])
}

pub fn encode_block_tree(
    body: &XmlFragmentRef,
    transaction: &mut TransactionMut<'_>,
    tree: &BlockTree,
) -> Result<(), BlockTreeError> {
    let issues = validate_block_tree(tree);
    if !issues.is_empty() {
        return Err(BlockTreeError::Validation(issues));
    }
    if body.len(transaction) != 0 {
        return Err(BlockTreeError::DestinationNotEmpty);
    }

    let root = body.insert(
        transaction,
        0,
        XmlElementPrelim::empty(BLOCK_GROUP_NODE_NAME),
    );
    encode_attributes(&root, transaction, &tree.root_attributes);
    encode_blocks(&root, transaction, &tree.blocks);
    Ok(())
}

pub fn replace_text_delta(
    text: &TextRef,
    transaction: &mut TransactionMut<'_>,
    delta: &[TextDelta],
) {
    let length = text.len(transaction);
    if length > 0 {
        text.remove_range(transaction, 0, length);
    }
    text.apply_delta(transaction, encode_delta(delta));
}

pub fn insert_block_nodes(
    group: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    index: u32,
    blocks: &[BlockNode],
) {
    for (offset, block) in blocks.iter().enumerate() {
        encode_block(group, transaction, index + offset as u32, block);
    }
}

pub fn replace_block_content_element(
    container: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    content: &XmlElementNode,
) -> Result<(), BlockTreeError> {
    let content_indices: Vec<_> = container
        .children(transaction)
        .enumerate()
        .filter_map(|(index, child)| match child {
            XmlOut::Element(element) if element.tag().as_ref() != BLOCK_GROUP_NODE_NAME => {
                Some(index as u32)
            }
            _ => None,
        })
        .collect();
    if content_indices.len() != 1 {
        return Err(invalid_xml(
            Vec::new(),
            "expected exactly one Block content element",
        ));
    }
    let index = content_indices[0];
    container.remove(transaction, index);
    encode_element(container, transaction, index, content);
    Ok(())
}

pub fn validate_block_tree(tree: &BlockTree) -> Vec<BlockTreeIssue> {
    let mut issues = Vec::new();
    let mut seen_ids = BTreeSet::new();
    let mut block_count = 0usize;
    validate_blocks(
        &tree.blocks,
        &mut block_count,
        &mut seen_ids,
        &mut issues,
        &[],
    );
    issues
}

pub fn scan_block_tree(tree: &BlockTree) -> Vec<ScannedBlock> {
    let mut blocks = Vec::new();
    scan_blocks(&tree.blocks, None, &[], &mut blocks);
    blocks
}

fn decode_group_children<T: ReadTxn>(
    group: &yrs::XmlElementRef,
    transaction: &T,
    group_path: &[usize],
) -> Result<Vec<BlockNode>, BlockTreeError> {
    group
        .children(transaction)
        .enumerate()
        .map(|(index, child)| {
            let path = append_path(group_path, index);
            let container = require_element(child, &path)?;
            if container.tag().as_ref() != BLOCK_CONTAINER_NODE_NAME {
                return Err(invalid_xml(
                    path,
                    format!("expected blockContainer, found {}", container.tag()),
                ));
            }
            decode_container(&container, transaction, &append_path(group_path, index))
        })
        .collect()
}

fn decode_container<T: ReadTxn>(
    container: &yrs::XmlElementRef,
    transaction: &T,
    path: &[usize],
) -> Result<BlockNode, BlockTreeError> {
    assert_depth(path)?;
    let attributes = decode_attributes(container, transaction, path)?;
    let id = match attributes.get(BLOCK_ID_ATTRIBUTE) {
        Some(PortableValue::String(id)) => id.clone(),
        Some(_) => String::new(),
        None => String::new(),
    };
    let children: Vec<_> = container.children(transaction).collect();
    let mut content = None;
    let mut child_group = None;

    for (index, child) in children.into_iter().enumerate() {
        let child_path = append_path(path, index);
        let element = require_element(child, &child_path)?;
        if element.tag().as_ref() == BLOCK_GROUP_NODE_NAME {
            if child_group.is_some() || index + 1 != container.len(transaction) as usize {
                return Err(invalid_xml(
                    child_path,
                    "expected at most one trailing blockGroup",
                ));
            }
            child_group = Some(element);
            continue;
        }
        if content.is_some() {
            return Err(invalid_xml(
                child_path,
                "expected exactly one Block content element",
            ));
        }
        content = Some(element);
    }

    let content = content
        .ok_or_else(|| invalid_xml(path.to_vec(), "expected exactly one Block content element"))?;
    let decoded_content = decode_element(&content, transaction, &append_path(path, 0))?;
    let decoded_children = match child_group {
        Some(group) => decode_group_children(
            &group,
            transaction,
            &append_path(path, container.len(transaction) as usize - 1),
        )?,
        None => Vec::new(),
    };

    Ok(BlockNode {
        id,
        container_attributes: attributes,
        content: decoded_content,
        children: decoded_children,
    })
}

fn decode_element<T: ReadTxn>(
    element: &yrs::XmlElementRef,
    transaction: &T,
    path: &[usize],
) -> Result<XmlElementNode, BlockTreeError> {
    assert_depth(path)?;
    let children = element
        .children(transaction)
        .enumerate()
        .map(|(index, child)| decode_xml_node(child, transaction, &append_path(path, index)))
        .collect::<Result<_, _>>()?;
    Ok(XmlElementNode {
        name: element.tag().to_string(),
        attributes: decode_attributes(element, transaction, path)?,
        children,
    })
}

fn decode_xml_node<T: ReadTxn>(
    node: XmlOut,
    transaction: &T,
    path: &[usize],
) -> Result<XmlNode, BlockTreeError> {
    assert_depth(path)?;
    match node {
        XmlOut::Element(element) => Ok(XmlNode::Element(decode_element(
            &element,
            transaction,
            path,
        )?)),
        XmlOut::Text(text) => Ok(XmlNode::Text {
            delta: decode_text(text.as_ref(), transaction, path)?,
        }),
        XmlOut::Fragment(_) => Err(invalid_xml(
            path.to_vec(),
            "nested XmlFragment nodes are not portable",
        )),
    }
}

fn decode_text<T: ReadTxn>(
    text: &TextRef,
    transaction: &T,
    path: &[usize],
) -> Result<Vec<TextDelta>, BlockTreeError> {
    text.diff(transaction, YChange::identity)
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            let chunk_path = append_path(path, index);
            let insert = match chunk.insert {
                Out::Any(Any::String(value)) => value.to_string(),
                other => {
                    return Err(invalid_xml(
                        chunk_path,
                        format!("text embeds are not supported: {other:?}"),
                    ));
                }
            };
            let attributes = chunk
                .attributes
                .map(|attributes| {
                    attributes
                        .into_iter()
                        .map(|(key, value)| {
                            decode_any(value, &chunk_path, 0).map(|value| (key.to_string(), value))
                        })
                        .collect()
                })
                .transpose()?
                .unwrap_or_default();
            Ok(TextDelta { insert, attributes })
        })
        .collect()
}

fn decode_attributes<T: ReadTxn>(
    element: &yrs::XmlElementRef,
    transaction: &T,
    path: &[usize],
) -> Result<BTreeMap<String, PortableValue>, BlockTreeError> {
    element
        .attributes(transaction)
        .map(|(key, value)| {
            let value = match value {
                Out::Any(value) => decode_any(value, path, 0)?,
                other => {
                    return Err(unsupported_value(
                        path.to_vec(),
                        format!("nested shared attribute is not portable: {other:?}"),
                    ));
                }
            };
            Ok((key.to_owned(), value))
        })
        .collect()
}

fn decode_any(value: Any, path: &[usize], depth: usize) -> Result<PortableValue, BlockTreeError> {
    if depth > MAX_PORTABLE_VALUE_DEPTH {
        return Err(unsupported_value(
            path.to_vec(),
            "portable value nesting exceeds the limit",
        ));
    }
    match value {
        Any::Undefined => Ok(PortableValue::Undefined),
        Any::Null => Ok(PortableValue::Null),
        Any::Bool(value) => Ok(PortableValue::Boolean(value)),
        Any::Number(value) if value.is_finite() => Ok(PortableValue::Number(value)),
        Any::Number(_) => Err(unsupported_value(path.to_vec(), "numbers must be finite")),
        Any::BigInt(_) => Err(unsupported_value(
            path.to_vec(),
            "BigInt is not a portable XML value",
        )),
        Any::String(value) => Ok(PortableValue::String(value.to_string())),
        Any::Buffer(value) => Ok(PortableValue::Binary(value.to_vec())),
        Any::Array(values) => values
            .iter()
            .cloned()
            .map(|value| decode_any(value, path, depth + 1))
            .collect::<Result<_, _>>()
            .map(PortableValue::Array),
        Any::Map(values) => values
            .iter()
            .map(|(key, value)| {
                decode_any(value.clone(), path, depth + 1).map(|value| (key.clone(), value))
            })
            .collect::<Result<_, _>>()
            .map(PortableValue::Object),
    }
}

fn encode_blocks(
    group: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    blocks: &[BlockNode],
) {
    for block in blocks {
        let index = group.len(transaction);
        encode_block(group, transaction, index, block);
    }
}

fn encode_block(
    group: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    index: u32,
    block: &BlockNode,
) {
    let container = group.insert(
        transaction,
        index,
        XmlElementPrelim::empty(BLOCK_CONTAINER_NODE_NAME),
    );
    encode_attributes(&container, transaction, &block.container_attributes);
    encode_element(&container, transaction, 0, &block.content);

    if block.children.is_empty() {
        return;
    }
    let child_group = container.insert(
        transaction,
        1,
        XmlElementPrelim::empty(BLOCK_GROUP_NODE_NAME),
    );
    encode_blocks(&child_group, transaction, &block.children);
}

fn encode_element(
    parent: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    index: u32,
    element: &XmlElementNode,
) {
    let encoded = parent.insert(
        transaction,
        index,
        XmlElementPrelim::empty(element.name.clone()),
    );
    encode_attributes(&encoded, transaction, &element.attributes);
    encode_xml_children(&encoded, transaction, &element.children);
}

fn encode_xml_children(
    parent: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    children: &[XmlNode],
) {
    for child in children {
        let index = parent.len(transaction);
        match child {
            XmlNode::Element(element) => {
                let encoded = parent.insert(
                    transaction,
                    index,
                    XmlElementPrelim::empty(element.name.clone()),
                );
                encode_attributes(&encoded, transaction, &element.attributes);
                encode_xml_children(&encoded, transaction, &element.children);
            }
            XmlNode::Text { delta } => {
                parent.insert(
                    transaction,
                    index,
                    XmlIn::from(XmlDeltaPrelim {
                        attributes: Default::default(),
                        delta: encode_delta(delta),
                    }),
                );
            }
        }
    }
}

fn encode_attributes(
    element: &yrs::XmlElementRef,
    transaction: &mut TransactionMut<'_>,
    attributes: &BTreeMap<String, PortableValue>,
) {
    for (key, value) in attributes {
        element.insert_attribute(transaction, key.as_str(), encode_portable_value(value));
    }
}

fn encode_delta(delta: &[TextDelta]) -> Vec<Delta<In>> {
    delta
        .iter()
        .filter(|chunk| !chunk.insert.is_empty())
        .map(|chunk| {
            let attributes: Attrs = chunk
                .attributes
                .iter()
                .map(|(key, value)| (key.clone().into(), encode_portable_value(value)))
                .collect();
            if attributes.is_empty() {
                Delta::insert(chunk.insert.clone())
            } else {
                Delta::insert_with(chunk.insert.clone(), attributes)
            }
        })
        .collect()
}

fn encode_portable_value(value: &PortableValue) -> Any {
    match value {
        PortableValue::Undefined => Any::Undefined,
        PortableValue::Null => Any::Null,
        PortableValue::Boolean(value) => Any::Bool(*value),
        PortableValue::Number(value) => Any::Number(*value),
        PortableValue::String(value) => Any::String(value.clone().into()),
        PortableValue::Binary(value) => Any::Buffer(value.clone().into()),
        PortableValue::Array(values) => Any::Array(
            values
                .iter()
                .map(encode_portable_value)
                .collect::<Vec<_>>()
                .into(),
        ),
        PortableValue::Object(values) => Any::Map(
            values
                .iter()
                .map(|(key, value)| (key.clone(), encode_portable_value(value)))
                .collect::<std::collections::HashMap<_, _>>()
                .into(),
        ),
    }
}

fn validate_blocks(
    blocks: &[BlockNode],
    block_count: &mut usize,
    seen_ids: &mut BTreeSet<String>,
    issues: &mut Vec<BlockTreeIssue>,
    parent_path: &[usize],
) {
    for (index, block) in blocks.iter().enumerate() {
        let path = append_path(parent_path, index);
        *block_count += 1;
        if *block_count > MAX_BLOCKS {
            issues.push(issue(BlockTreeIssueCode::TooManyBlocks, &path, block));
            return;
        }
        if path.len() > MAX_XML_PATH_DEPTH {
            issues.push(issue(BlockTreeIssueCode::XmlDepthExceeded, &path, block));
            continue;
        }
        if !block.container_attributes.contains_key(BLOCK_ID_ATTRIBUTE) {
            issues.push(issue(BlockTreeIssueCode::MissingBlockId, &path, block));
        } else if !is_valid_block_id(&block.id) {
            issues.push(issue(BlockTreeIssueCode::InvalidBlockId, &path, block));
        } else if !seen_ids.insert(block.id.clone()) {
            issues.push(issue(BlockTreeIssueCode::DuplicateBlockId, &path, block));
        }
        if !REGISTERED_BLOCK_TYPES.contains(&block.content.name.as_str()) {
            issues.push(issue(
                BlockTreeIssueCode::UnsupportedBlockType,
                &path,
                block,
            ));
        }
        if REGISTERED_BLOCK_TYPES.contains(&block.content.name.as_str())
            && !accepts_block_children(block)
            && !block.children.is_empty()
        {
            issues.push(issue(
                BlockTreeIssueCode::BlockChildrenNotAllowed,
                &path,
                block,
            ));
        }
        validate_blocks(&block.children, block_count, seen_ids, issues, &path);
    }
}

fn scan_blocks(
    blocks: &[BlockNode],
    parent_block_id: Option<&str>,
    parent_path: &[usize],
    output: &mut Vec<ScannedBlock>,
) {
    for (index, block) in blocks.iter().enumerate() {
        let path = append_path(parent_path, index);
        output.push(ScannedBlock {
            id: block.id.clone(),
            block_type: block.content.name.clone(),
            parent_block_id: parent_block_id.map(str::to_owned),
            path: path.clone(),
            text: element_plain_text(&block.content),
        });
        scan_blocks(&block.children, Some(&block.id), &path, output);
    }
}

fn element_plain_text(element: &XmlElementNode) -> String {
    if let Some(PortableValue::String(text)) = element.attributes.get(match element.name.as_str() {
        "image" => "caption",
        "inlineImage" => "alt",
        _ => "",
    }) {
        return text.clone();
    }
    let mut text = String::new();
    for child in &element.children {
        match child {
            XmlNode::Text { delta } => {
                for chunk in delta {
                    text.push_str(&chunk.insert);
                }
            }
            XmlNode::Element(element) => text.push_str(&element_plain_text(element)),
        }
    }
    text
}

fn is_valid_block_id(id: &str) -> bool {
    !id.is_empty() && id.trim() == id && id.len() <= MAX_BLOCK_ID_LENGTH
}

fn issue(code: BlockTreeIssueCode, path: &[usize], block: &BlockNode) -> BlockTreeIssue {
    BlockTreeIssue {
        code,
        path: path.to_vec(),
        block_id: (!block.id.is_empty()).then(|| block.id.clone()),
        block_type: Some(block.content.name.clone()),
    }
}

fn require_element(node: XmlOut, path: &[usize]) -> Result<yrs::XmlElementRef, BlockTreeError> {
    match node {
        XmlOut::Element(element) => Ok(element),
        XmlOut::Text(_) => Err(invalid_xml(
            path.to_vec(),
            "expected element, found XmlText",
        )),
        XmlOut::Fragment(_) => Err(invalid_xml(
            path.to_vec(),
            "expected element, found XmlFragment",
        )),
    }
}

fn assert_depth(path: &[usize]) -> Result<(), BlockTreeError> {
    if path.len() <= MAX_XML_PATH_DEPTH {
        return Ok(());
    }
    Err(invalid_xml(
        path.to_vec(),
        "XML path depth exceeds the limit",
    ))
}

fn append_path(path: &[usize], index: usize) -> Vec<usize> {
    let mut result = Vec::with_capacity(path.len() + 1);
    result.extend_from_slice(path);
    result.push(index);
    result
}

fn invalid_xml(path: Vec<usize>, message: impl Into<String>) -> BlockTreeError {
    BlockTreeError::InvalidXml {
        path,
        message: message.into(),
    }
}

fn unsupported_value(path: Vec<usize>, message: impl Into<String>) -> BlockTreeError {
    BlockTreeError::UnsupportedValue {
        path,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use yrs::updates::decoder::Decode;
    use yrs::{StateVector, Transact, Update, XmlElementPrelim};

    use crate::document::create_compatible_document;

    use super::*;

    fn matrix_document() -> yrs::Doc {
        let document = create_compatible_document("matrix-block-tree");
        let update = std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/yjs-yrs/matrix-base.bin"),
        )
        .expect("matrix fixture");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&update).expect("valid fixture"))
            .expect("fixture applies");
        document
    }

    #[test]
    fn decodes_every_registered_fixture_block_and_nested_group() {
        let document = matrix_document();
        let transaction = document.transact();
        let body = transaction.get_xml_fragment("body").expect("body root");
        let tree = decode_block_tree(&body, &transaction).expect("valid BlockTree");
        let blocks = scan_block_tree(&tree);

        assert_eq!(blocks.len(), 19);
        assert_eq!(blocks[0].block_type, "paragraph");
        assert_eq!(blocks[7].parent_block_id.as_deref(), Some("matrix-toggle"));
        assert_eq!(
            blocks.last().map(|block| block.block_type.as_str()),
            Some("templateRef")
        );
    }

    #[test]
    fn preserves_portable_undefined_arrays_and_rich_text_marks() {
        let document = matrix_document();
        let transaction = document.transact();
        let body = transaction.get_xml_fragment("body").expect("body root");
        let tree = decode_block_tree(&body, &transaction).expect("valid BlockTree");
        let numbered = tree
            .blocks
            .iter()
            .find(|block| block.id == "matrix-numbered")
            .expect("numbered Block");
        assert_eq!(
            numbered.content.attributes.get("start"),
            Some(&PortableValue::Undefined)
        );
        let table = tree
            .blocks
            .iter()
            .find(|block| block.id == "matrix-table")
            .expect("table Block");
        let XmlNode::Element(row) = &table.content.children[0] else {
            panic!("table row")
        };
        let XmlNode::Element(cell) = &row.children[0] else {
            panic!("table cell")
        };
        assert_eq!(
            cell.attributes.get("colwidth"),
            Some(&PortableValue::Array(vec![PortableValue::Number(160.0)]))
        );

        let paragraph = &tree.blocks[0].content;
        let XmlNode::Text { delta } = &paragraph.children[0] else {
            panic!("paragraph text")
        };
        assert!(
            delta
                .iter()
                .any(|chunk| chunk.attributes.contains_key("bold"))
        );
    }

    #[test]
    fn preserves_binary_and_nested_json_attributes() {
        let document = create_compatible_document("portable-values");
        let body = document.get_or_insert_xml_fragment("body");
        let mut transaction = document.transact_mut();
        let group = body.insert(&mut transaction, 0, XmlElementPrelim::empty("blockGroup"));
        let container = group.insert(
            &mut transaction,
            0,
            XmlElementPrelim::empty("blockContainer"),
        );
        container.insert_attribute(&mut transaction, "id", "portable-values-block");
        let content = container.insert(&mut transaction, 0, XmlElementPrelim::empty("paragraph"));
        content.insert_attribute(
            &mut transaction,
            "binary",
            Any::Buffer(vec![0, 1, 255].into()),
        );
        content.insert_attribute(
            &mut transaction,
            "json",
            Any::Map(
                [(
                    "nested".to_owned(),
                    Any::Array(vec![Any::Null, true.into()].into()),
                )]
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>()
                .into(),
            ),
        );
        drop(transaction);

        let transaction = document.transact();
        let tree = decode_block_tree(&body, &transaction).expect("portable values");
        assert_eq!(
            tree.blocks[0].content.attributes.get("binary"),
            Some(&PortableValue::Binary(vec![0, 1, 255]))
        );
        assert!(matches!(
            tree.blocks[0].content.attributes.get("json"),
            Some(PortableValue::Object(_))
        ));
    }

    #[test]
    fn pure_validator_rejects_duplicate_ids_and_forbidden_children() {
        let content = XmlElementNode {
            name: "pageRef".to_owned(),
            attributes: [(
                "targetBlockId".to_owned(),
                PortableValue::String("target".to_owned()),
            )]
            .into_iter()
            .collect(),
            children: vec![],
        };
        let block = BlockNode {
            id: "same".to_owned(),
            container_attributes: [("id".to_owned(), PortableValue::String("same".to_owned()))]
                .into_iter()
                .collect(),
            content,
            children: vec![],
        };
        let tree = BlockTree {
            root_attributes: BTreeMap::new(),
            blocks: vec![
                BlockNode {
                    children: vec![block.clone()],
                    ..block.clone()
                },
                block,
            ],
        };
        let issues = validate_block_tree(&tree);
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == BlockTreeIssueCode::DuplicateBlockId)
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == BlockTreeIssueCode::BlockChildrenNotAllowed)
        );
    }

    #[test]
    fn pure_validator_rejects_children_on_canvas_owners() {
        let canvas = BlockNode {
            id: "canvas-1".to_owned(),
            container_attributes: [(
                "id".to_owned(),
                PortableValue::String("canvas-1".to_owned()),
            )]
            .into_iter()
            .collect(),
            content: XmlElementNode {
                name: "canvas".to_owned(),
                attributes: BTreeMap::new(),
                children: vec![],
            },
            children: vec![BlockNode {
                id: "child".to_owned(),
                container_attributes: [(
                    "id".to_owned(),
                    PortableValue::String("child".to_owned()),
                )]
                .into_iter()
                .collect(),
                content: XmlElementNode {
                    name: "paragraph".to_owned(),
                    attributes: BTreeMap::new(),
                    children: vec![],
                },
                children: vec![],
            }],
        };

        let issues = validate_block_tree(&BlockTree {
            root_attributes: BTreeMap::new(),
            blocks: vec![canvas],
        });

        assert!(
            issues
                .iter()
                .any(|issue| issue.code == BlockTreeIssueCode::BlockChildrenNotAllowed)
        );
    }

    #[test]
    fn decoding_is_a_pure_read() {
        let document = matrix_document();
        let before = document
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let transaction = document.transact();
        let body = transaction.get_xml_fragment("body").expect("body root");
        decode_block_tree(&body, &transaction).expect("valid BlockTree");
        drop(transaction);
        assert_eq!(
            document
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
            before
        );
    }

    #[test]
    fn exact_xml_vocabulary_round_trips_through_a_fresh_yrs_document() {
        let source = matrix_document();
        let source_transaction = source.transact();
        let source_body = source_transaction
            .get_xml_fragment("body")
            .expect("body root");
        let tree = decode_block_tree(&source_body, &source_transaction).expect("BlockTree");
        drop(source_transaction);

        let target = create_compatible_document("matrix-block-tree-roundtrip");
        let target_body = target.get_or_insert_xml_fragment("body");
        encode_block_tree(&target_body, &mut target.transact_mut(), &tree).expect("encode tree");
        let target_transaction = target.transact();
        let decoded = decode_block_tree(&target_body, &target_transaction).expect("decode tree");
        assert_eq!(decoded, tree);
    }
}
