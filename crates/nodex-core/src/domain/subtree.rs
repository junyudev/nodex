use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::block_children::accepts_block_children;
use super::block_tree::{
    BLOCK_ID_ATTRIBUTE, BlockNode, BlockTree, MAX_BLOCK_ID_LENGTH, PortableValue, scan_block_tree,
    validate_block_tree,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockSubtreeErrorCode {
    InvalidDocument,
    InvalidRootIdentity,
    EmptyRootSelection,
    DuplicateRoot,
    SourceBlockNotFound,
    OverlappingRoots,
    TargetParentNotFound,
    TargetParentRejectsChildren,
    AncestorCycle,
    TargetAnchorNotFound,
    TargetAnchorWrongParent,
    TargetAnchorInMovedSubtree,
    TargetIdentityConflict,
    IdentityRemapConflict,
    NoChange,
    PostconditionFailed,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("Block subtree operation {code:?}: {message}")]
pub struct BlockSubtreeError {
    pub code: BlockSubtreeErrorCode,
    pub message: String,
    pub block_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedBlockSubtree {
    pub root_block_id: String,
    pub source_parent_block_id: Option<String>,
    pub source_path: Vec<usize>,
    pub block_ids: Vec<String>,
    pub block: BlockNode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableBlockSubtreeForest {
    pub roots: Vec<CapturedBlockSubtree>,
    pub root_block_ids: Vec<String>,
    pub block_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockSubtreeInsertionTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_block_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_block_id: Option<String>,
}

pub fn capture_block_subtree_forest(
    tree: &BlockTree,
    root_block_ids: &[String],
) -> Result<PortableBlockSubtreeForest, BlockSubtreeError> {
    require_valid_tree(tree)?;
    if root_block_ids.is_empty() {
        return Err(subtree_error(
            BlockSubtreeErrorCode::EmptyRootSelection,
            "At least one root Block must be selected",
            None,
        ));
    }

    let scanned = scan_block_tree(tree);
    let by_id: BTreeMap<_, _> = scanned
        .iter()
        .map(|block| (block.id.as_str(), block))
        .collect();
    let mut seen = BTreeSet::new();
    let mut selected = Vec::with_capacity(root_block_ids.len());
    for requested in root_block_ids {
        let exact = require_exact_id(
            requested,
            BlockSubtreeErrorCode::InvalidRootIdentity,
            "rootBlockId",
        )?;
        if !seen.insert(exact.to_owned()) {
            return Err(subtree_error(
                BlockSubtreeErrorCode::DuplicateRoot,
                format!("Block {exact} was selected more than once"),
                Some(exact),
            ));
        }
        let Some(location) = by_id.get(exact) else {
            return Err(subtree_error(
                BlockSubtreeErrorCode::SourceBlockNotFound,
                format!("Block {exact} does not exist in the source Document"),
                Some(exact),
            ));
        };
        selected.push(*location);
    }
    selected.sort_by(|left, right| left.path.cmp(&right.path));
    for (index, root) in selected.iter().enumerate() {
        if selected
            .iter()
            .skip(index + 1)
            .any(|candidate| path_is_descendant(&candidate.path, &root.path))
        {
            return Err(subtree_error(
                BlockSubtreeErrorCode::OverlappingRoots,
                format!(
                    "Block {} and one of its descendants were both selected",
                    root.id
                ),
                Some(&root.id),
            ));
        }
    }

    let block_ids = scanned
        .iter()
        .filter(|candidate| {
            selected.iter().any(|root| {
                candidate.path == root.path || path_is_descendant(&candidate.path, &root.path)
            })
        })
        .map(|block| block.id.clone())
        .collect::<Vec<_>>();
    let roots = selected
        .into_iter()
        .map(|root| {
            let block = block_at_path(&tree.blocks, &root.path).ok_or_else(|| {
                subtree_error(
                    BlockSubtreeErrorCode::InvalidDocument,
                    format!("Block {} disappeared during capture", root.id),
                    Some(&root.id),
                )
            })?;
            let subtree_ids = preorder_ids(std::slice::from_ref(block));
            Ok(CapturedBlockSubtree {
                root_block_id: root.id.clone(),
                source_parent_block_id: root.parent_block_id.clone(),
                source_path: root.path.clone(),
                block_ids: subtree_ids,
                block: block.clone(),
            })
        })
        .collect::<Result<Vec<_>, BlockSubtreeError>>()?;

    Ok(PortableBlockSubtreeForest {
        root_block_ids: roots
            .iter()
            .map(|root| root.root_block_id.clone())
            .collect(),
        roots,
        block_ids,
    })
}

pub fn remove_block_subtree_forest(
    tree: &BlockTree,
    root_block_ids: &[String],
) -> Result<(BlockTree, PortableBlockSubtreeForest), BlockSubtreeError> {
    let forest = capture_block_subtree_forest(tree, root_block_ids)?;
    let selected: BTreeSet<_> = forest.root_block_ids.iter().cloned().collect();
    let mut next = tree.clone();
    remove_selected_roots(&mut next.blocks, &selected);
    require_valid_tree(&next)?;
    Ok((next, forest))
}

pub fn insert_block_subtree_forest(
    tree: &BlockTree,
    forest: &PortableBlockSubtreeForest,
    target: &BlockSubtreeInsertionTarget,
) -> Result<BlockTree, BlockSubtreeError> {
    require_valid_tree(tree)?;
    validate_forest(forest)?;
    validate_insertion_target(tree, target, Some(forest))?;

    let current_ids: BTreeSet<_> = preorder_ids(&tree.blocks).into_iter().collect();
    if let Some(conflict) = forest.block_ids.iter().find(|id| current_ids.contains(*id)) {
        return Err(subtree_error(
            BlockSubtreeErrorCode::TargetIdentityConflict,
            format!("Target Document already contains Block {conflict}"),
            Some(conflict),
        ));
    }

    let mut next = tree.clone();
    let siblings = target_siblings_mut(&mut next.blocks, target.parent_block_id.as_deref())?;
    let insertion_index = match target.before_block_id.as_deref() {
        Some(anchor) => siblings
            .iter()
            .position(|block| block.id == anchor)
            .ok_or_else(|| {
                subtree_error(
                    BlockSubtreeErrorCode::TargetAnchorWrongParent,
                    format!(
                        "Target anchor Block {anchor} is not a direct child of the target parent"
                    ),
                    Some(anchor),
                )
            })?,
        None => siblings.len(),
    };
    siblings.splice(
        insertion_index..insertion_index,
        forest.roots.iter().map(|root| root.block.clone()),
    );
    require_valid_tree(&next)?;
    assert_forest_placement(&next, forest, target)?;
    Ok(next)
}

pub fn move_block_subtree_forest(
    tree: &BlockTree,
    root_block_ids: &[String],
    target: &BlockSubtreeInsertionTarget,
) -> Result<(BlockTree, PortableBlockSubtreeForest), BlockSubtreeError> {
    let forest = capture_block_subtree_forest(tree, root_block_ids)?;
    validate_insertion_target(tree, target, Some(&forest))?;
    if target
        .parent_block_id
        .as_ref()
        .is_some_and(|id| forest.block_ids.contains(id))
    {
        return Err(subtree_error(
            BlockSubtreeErrorCode::AncestorCycle,
            "Cannot move a Block beneath its own subtree",
            target.parent_block_id.as_deref(),
        ));
    }
    if target
        .before_block_id
        .as_ref()
        .is_some_and(|id| forest.block_ids.contains(id))
    {
        return Err(subtree_error(
            BlockSubtreeErrorCode::TargetAnchorInMovedSubtree,
            "Target anchor belongs to the moved subtree",
            target.before_block_id.as_deref(),
        ));
    }

    let selected: BTreeSet<_> = forest.root_block_ids.iter().cloned().collect();
    let mut without = tree.clone();
    remove_selected_roots(&mut without.blocks, &selected);
    let moved = insert_block_subtree_forest(&without, &forest, target)?;
    if &moved == tree {
        return Err(subtree_error(
            BlockSubtreeErrorCode::NoChange,
            "Subtree move produced no structural change",
            None,
        ));
    }
    Ok((moved, forest))
}

pub fn remap_block_subtree_forest(
    forest: &PortableBlockSubtreeForest,
    allocate_block_id: &mut impl FnMut(&str) -> String,
) -> Result<PortableBlockSubtreeForest, BlockSubtreeError> {
    validate_forest(forest)?;
    let mut remap = BTreeMap::new();
    let mut allocated = BTreeSet::new();
    for source_id in &forest.block_ids {
        let candidate = allocate_block_id(source_id);
        let exact = require_exact_id(
            &candidate,
            BlockSubtreeErrorCode::IdentityRemapConflict,
            "allocatedBlockId",
        )?;
        if !allocated.insert(exact.to_owned()) || forest.block_ids.iter().any(|id| id == exact) {
            return Err(subtree_error(
                BlockSubtreeErrorCode::IdentityRemapConflict,
                format!("Allocated Block identity {exact} is not fresh"),
                Some(exact),
            ));
        }
        remap.insert(source_id.clone(), exact.to_owned());
    }

    let roots = forest
        .roots
        .iter()
        .map(|root| {
            let block = remap_block(&root.block, &remap)?;
            let root_block_id = remap.get(&root.root_block_id).cloned().ok_or_else(|| {
                subtree_error(
                    BlockSubtreeErrorCode::PostconditionFailed,
                    "Captured root was absent from the identity remap",
                    Some(&root.root_block_id),
                )
            })?;
            let block_ids = root
                .block_ids
                .iter()
                .map(|id| remap.get(id).cloned())
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    subtree_error(
                        BlockSubtreeErrorCode::PostconditionFailed,
                        "Captured descendant was absent from the identity remap",
                        Some(&root.root_block_id),
                    )
                })?;
            Ok(CapturedBlockSubtree {
                root_block_id,
                source_parent_block_id: root.source_parent_block_id.clone(),
                source_path: root.source_path.clone(),
                block_ids,
                block,
            })
        })
        .collect::<Result<Vec<_>, BlockSubtreeError>>()?;
    let remapped = PortableBlockSubtreeForest {
        root_block_ids: roots
            .iter()
            .map(|root| root.root_block_id.clone())
            .collect(),
        roots,
        block_ids: forest
            .block_ids
            .iter()
            .map(|id| remap.get(id).cloned())
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                subtree_error(
                    BlockSubtreeErrorCode::PostconditionFailed,
                    "Captured forest was absent from the identity remap",
                    None,
                )
            })?,
    };
    validate_forest(&remapped)?;
    Ok(remapped)
}

fn validate_insertion_target(
    tree: &BlockTree,
    target: &BlockSubtreeInsertionTarget,
    forest: Option<&PortableBlockSubtreeForest>,
) -> Result<(), BlockSubtreeError> {
    let scanned = scan_block_tree(tree);
    let parent_id = target
        .parent_block_id
        .as_deref()
        .map(|id| {
            require_exact_id(
                id,
                BlockSubtreeErrorCode::TargetParentNotFound,
                "parentBlockId",
            )
        })
        .transpose()?;
    let anchor_id = target
        .before_block_id
        .as_deref()
        .map(|id| {
            require_exact_id(
                id,
                BlockSubtreeErrorCode::TargetAnchorNotFound,
                "beforeBlockId",
            )
        })
        .transpose()?;
    let parent = parent_id.and_then(|id| scanned.iter().find(|block| block.id == id));
    if let Some(parent_id) = parent_id {
        let Some(_) = parent else {
            return Err(subtree_error(
                BlockSubtreeErrorCode::TargetParentNotFound,
                format!("Target parent Block {parent_id} does not exist"),
                Some(parent_id),
            ));
        };
        let block = find_block(&tree.blocks, parent_id).expect("scanned parent must resolve");
        if !accepts_block_children(block) {
            return Err(subtree_error(
                BlockSubtreeErrorCode::TargetParentRejectsChildren,
                format!("Canonical Block {parent_id} cannot contain child Blocks"),
                Some(parent_id),
            ));
        }
    }
    if let Some(anchor_id) = anchor_id {
        let Some(anchor) = scanned.iter().find(|block| block.id == anchor_id) else {
            return Err(subtree_error(
                BlockSubtreeErrorCode::TargetAnchorNotFound,
                format!("Target anchor Block {anchor_id} does not exist"),
                Some(anchor_id),
            ));
        };
        if anchor.parent_block_id.as_deref() != parent_id {
            return Err(subtree_error(
                BlockSubtreeErrorCode::TargetAnchorWrongParent,
                format!(
                    "Target anchor Block {anchor_id} is not a direct child of the target parent"
                ),
                Some(anchor_id),
            ));
        }
    }
    if let Some(forest) = forest {
        if parent_id.is_some_and(|id| forest.block_ids.iter().any(|candidate| candidate == id)) {
            return Err(subtree_error(
                BlockSubtreeErrorCode::AncestorCycle,
                "Cannot insert a captured subtree beneath itself",
                parent_id,
            ));
        }
        if anchor_id.is_some_and(|id| forest.block_ids.iter().any(|candidate| candidate == id)) {
            return Err(subtree_error(
                BlockSubtreeErrorCode::TargetAnchorInMovedSubtree,
                "Target anchor belongs to the captured subtree",
                anchor_id,
            ));
        }
    }
    Ok(())
}

fn validate_forest(forest: &PortableBlockSubtreeForest) -> Result<(), BlockSubtreeError> {
    if forest.roots.is_empty() {
        return Err(subtree_error(
            BlockSubtreeErrorCode::EmptyRootSelection,
            "Captured forest must contain at least one root",
            None,
        ));
    }
    let tree = BlockTree {
        root_attributes: BTreeMap::new(),
        blocks: forest.roots.iter().map(|root| root.block.clone()).collect(),
    };
    require_valid_tree(&tree)?;
    let actual_ids = preorder_ids(&tree.blocks);
    let actual_roots: Vec<_> = tree.blocks.iter().map(|block| block.id.clone()).collect();
    if actual_ids != forest.block_ids || actual_roots != forest.root_block_ids {
        return Err(subtree_error(
            BlockSubtreeErrorCode::PostconditionFailed,
            "Captured forest identity metadata does not match its portable Blocks",
            None,
        ));
    }
    for (root, block) in forest.roots.iter().zip(&tree.blocks) {
        if root.root_block_id != block.id
            || root.block_ids != preorder_ids(std::slice::from_ref(block))
        {
            return Err(subtree_error(
                BlockSubtreeErrorCode::PostconditionFailed,
                format!(
                    "Captured root {} has stale identity metadata",
                    root.root_block_id
                ),
                Some(&root.root_block_id),
            ));
        }
    }
    Ok(())
}

fn require_valid_tree(tree: &BlockTree) -> Result<(), BlockSubtreeError> {
    let issues = validate_block_tree(tree);
    if issues.is_empty() {
        return Ok(());
    }
    Err(subtree_error(
        BlockSubtreeErrorCode::InvalidDocument,
        format!("Block tree validation failed with {issues:?}"),
        issues.first().and_then(|issue| issue.block_id.as_deref()),
    ))
}

fn assert_forest_placement(
    tree: &BlockTree,
    forest: &PortableBlockSubtreeForest,
    target: &BlockSubtreeInsertionTarget,
) -> Result<(), BlockSubtreeError> {
    let siblings = target_siblings(&tree.blocks, target.parent_block_id.as_deref())?;
    let Some(start) = siblings
        .iter()
        .position(|block| block.id == forest.root_block_ids[0])
    else {
        return Err(subtree_error(
            BlockSubtreeErrorCode::PostconditionFailed,
            "Inserted subtree roots are missing from their target",
            None,
        ));
    };
    if forest
        .root_block_ids
        .iter()
        .enumerate()
        .all(|(offset, id)| {
            siblings
                .get(start + offset)
                .is_some_and(|block| &block.id == id)
        })
        && match target.before_block_id.as_deref() {
            Some(anchor) => siblings
                .get(start + forest.root_block_ids.len())
                .is_some_and(|block| block.id == anchor),
            None => start + forest.root_block_ids.len() == siblings.len(),
        }
    {
        return Ok(());
    }
    Err(subtree_error(
        BlockSubtreeErrorCode::PostconditionFailed,
        "Inserted subtree roots did not land at the requested anchor",
        None,
    ))
}

fn target_siblings<'a>(
    roots: &'a [BlockNode],
    parent_block_id: Option<&str>,
) -> Result<&'a [BlockNode], BlockSubtreeError> {
    match parent_block_id {
        None => Ok(roots),
        Some(parent) => find_block(roots, parent)
            .map(|block| block.children.as_slice())
            .ok_or_else(|| {
                subtree_error(
                    BlockSubtreeErrorCode::TargetParentNotFound,
                    format!("Target parent Block {parent} does not exist"),
                    Some(parent),
                )
            }),
    }
}

fn target_siblings_mut<'a>(
    roots: &'a mut Vec<BlockNode>,
    parent_block_id: Option<&str>,
) -> Result<&'a mut Vec<BlockNode>, BlockSubtreeError> {
    match parent_block_id {
        None => Ok(roots),
        Some(parent) => find_block_mut(roots, parent)
            .map(|block| &mut block.children)
            .ok_or_else(|| {
                subtree_error(
                    BlockSubtreeErrorCode::TargetParentNotFound,
                    format!("Target parent Block {parent} does not exist"),
                    Some(parent),
                )
            }),
    }
}

fn find_block<'a>(blocks: &'a [BlockNode], block_id: &str) -> Option<&'a BlockNode> {
    for block in blocks {
        if block.id == block_id {
            return Some(block);
        }
        if let Some(found) = find_block(&block.children, block_id) {
            return Some(found);
        }
    }
    None
}

fn find_block_mut<'a>(blocks: &'a mut [BlockNode], block_id: &str) -> Option<&'a mut BlockNode> {
    for block in blocks {
        if block.id == block_id {
            return Some(block);
        }
        if let Some(found) = find_block_mut(&mut block.children, block_id) {
            return Some(found);
        }
    }
    None
}

fn block_at_path<'a>(blocks: &'a [BlockNode], path: &[usize]) -> Option<&'a BlockNode> {
    let (first, rest) = path.split_first()?;
    let block = blocks.get(*first)?;
    if rest.is_empty() {
        return Some(block);
    }
    block_at_path(&block.children, rest)
}

fn remove_selected_roots(blocks: &mut Vec<BlockNode>, selected: &BTreeSet<String>) {
    blocks.retain(|block| !selected.contains(&block.id));
    for block in blocks {
        remove_selected_roots(&mut block.children, selected);
    }
}

fn remap_block(
    source: &BlockNode,
    remap: &BTreeMap<String, String>,
) -> Result<BlockNode, BlockSubtreeError> {
    let id = remap.get(&source.id).cloned().ok_or_else(|| {
        subtree_error(
            BlockSubtreeErrorCode::PostconditionFailed,
            "Source Block was absent from the identity remap",
            Some(&source.id),
        )
    })?;
    let mut container_attributes = source.container_attributes.clone();
    container_attributes.insert(
        BLOCK_ID_ATTRIBUTE.to_owned(),
        PortableValue::String(id.clone()),
    );
    let children = source
        .children
        .iter()
        .map(|child| remap_block(child, remap))
        .collect::<Result<_, _>>()?;
    Ok(BlockNode {
        id,
        container_attributes,
        content: source.content.clone(),
        children,
    })
}

fn preorder_ids(blocks: &[BlockNode]) -> Vec<String> {
    blocks
        .iter()
        .flat_map(|block| {
            let mut ids = vec![block.id.clone()];
            ids.extend(preorder_ids(&block.children));
            ids
        })
        .collect()
}

fn path_is_descendant(candidate: &[usize], ancestor: &[usize]) -> bool {
    candidate.len() > ancestor.len() && candidate.starts_with(ancestor)
}

fn require_exact_id<'a>(
    id: &'a str,
    code: BlockSubtreeErrorCode,
    field: &str,
) -> Result<&'a str, BlockSubtreeError> {
    if !id.is_empty() && id.trim() == id && id.len() <= MAX_BLOCK_ID_LENGTH {
        return Ok(id);
    }
    Err(subtree_error(
        code,
        format!("{field} must be a non-empty exact Block identity"),
        None,
    ))
}

fn subtree_error(
    code: BlockSubtreeErrorCode,
    message: impl Into<String>,
    block_id: Option<&str>,
) -> BlockSubtreeError {
    BlockSubtreeError {
        code,
        message: message.into(),
        block_id: block_id.map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use yrs::updates::decoder::Decode;
    use yrs::{Transact, Update};

    use crate::document::{BlockDocumentSchema, create_compatible_document, decode_block_document};

    use super::*;

    fn matrix_tree() -> BlockTree {
        let state = std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/yjs-yrs/matrix-base.bin"),
        )
        .expect("matrix fixture");
        let document = create_compatible_document("subtree-matrix");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&state).expect("matrix update"))
            .expect("matrix state");
        decode_block_document(&document, BlockDocumentSchema::PageV4)
            .expect("matrix document")
            .block_tree
    }

    #[test]
    fn captures_in_document_order_and_remaps_every_block_identity() {
        let tree = matrix_tree();
        let forest = capture_block_subtree_forest(
            &tree,
            &["matrix-quote".to_owned(), "matrix-toggle".to_owned()],
        )
        .expect("capture");
        assert_eq!(
            forest.root_block_ids,
            vec!["matrix-toggle".to_owned(), "matrix-quote".to_owned()]
        );
        assert_eq!(
            forest.block_ids,
            vec![
                "matrix-toggle".to_owned(),
                "matrix-toggle-child".to_owned(),
                "matrix-quote".to_owned(),
            ]
        );

        let remapped = remap_block_subtree_forest(&forest, &mut |source| format!("copy-{source}"))
            .expect("identity remap");
        assert_eq!(
            remapped.block_ids,
            vec![
                "copy-matrix-toggle".to_owned(),
                "copy-matrix-toggle-child".to_owned(),
                "copy-matrix-quote".to_owned(),
            ]
        );
        assert_eq!(
            remapped.roots[0].block.container_attributes.get("id"),
            Some(&PortableValue::String("copy-matrix-toggle".to_owned()))
        );
        assert_eq!(
            remapped.roots[0].block.content,
            forest.roots[0].block.content
        );

        let inserted = insert_block_subtree_forest(
            &tree,
            &remapped,
            &BlockSubtreeInsertionTarget {
                parent_block_id: None,
                before_block_id: Some("matrix-heading".to_owned()),
            },
        )
        .expect("insert copy");
        let root_ids: Vec<_> = inserted
            .blocks
            .iter()
            .map(|block| block.id.as_str())
            .collect();
        let heading = root_ids
            .iter()
            .position(|id| *id == "matrix-heading")
            .expect("heading");
        assert_eq!(
            &root_ids[heading - 2..heading],
            &["copy-matrix-toggle", "copy-matrix-quote"]
        );
    }

    #[test]
    fn portable_copy_preserves_binary_undefined_and_nested_attributes() {
        let mut tree = matrix_tree();
        let source = find_block_mut(&mut tree.blocks, "matrix-paragraph").expect("paragraph");
        source.content.attributes.insert(
            "binaryProbe".to_owned(),
            PortableValue::Binary(vec![0, 1, 255]),
        );
        source
            .content
            .attributes
            .insert("undefinedProbe".to_owned(), PortableValue::Undefined);
        source.content.attributes.insert(
            "objectProbe".to_owned(),
            PortableValue::Object(
                [(
                    "nested".to_owned(),
                    PortableValue::Array(vec![PortableValue::Null]),
                )]
                .into_iter()
                .collect(),
            ),
        );
        let forest = capture_block_subtree_forest(&tree, &["matrix-paragraph".to_owned()])
            .expect("portable capture");
        let remapped = remap_block_subtree_forest(&forest, &mut |_| "portable-copy".to_owned())
            .expect("portable remap");
        assert_eq!(
            remapped.roots[0].block.content,
            forest.roots[0].block.content
        );
        let inserted =
            insert_block_subtree_forest(&tree, &remapped, &BlockSubtreeInsertionTarget::default())
                .expect("portable insertion");
        assert_eq!(
            find_block(&inserted.blocks, "portable-copy")
                .expect("copied Block")
                .content,
            forest.roots[0].block.content
        );
    }

    #[test]
    fn moves_a_forest_and_rejects_overlap_cycles_and_identity_conflicts() {
        let tree = matrix_tree();
        let (moved, forest) = move_block_subtree_forest(
            &tree,
            &["matrix-quote".to_owned(), "matrix-divider".to_owned()],
            &BlockSubtreeInsertionTarget {
                parent_block_id: Some("matrix-toggle".to_owned()),
                before_block_id: Some("matrix-toggle-child".to_owned()),
            },
        )
        .expect("move forest");
        let toggle = find_block(&moved.blocks, "matrix-toggle").expect("toggle");
        assert_eq!(
            toggle
                .children
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            vec!["matrix-quote", "matrix-divider", "matrix-toggle-child"]
        );
        assert_eq!(
            forest.root_block_ids,
            vec!["matrix-quote", "matrix-divider"]
        );

        let overlap = capture_block_subtree_forest(
            &tree,
            &["matrix-toggle".to_owned(), "matrix-toggle-child".to_owned()],
        )
        .expect_err("overlap");
        assert_eq!(overlap.code, BlockSubtreeErrorCode::OverlappingRoots);

        let cycle = move_block_subtree_forest(
            &tree,
            &["matrix-toggle".to_owned()],
            &BlockSubtreeInsertionTarget {
                parent_block_id: Some("matrix-toggle-child".to_owned()),
                before_block_id: None,
            },
        )
        .expect_err("cycle");
        assert_eq!(cycle.code, BlockSubtreeErrorCode::AncestorCycle);

        let forest =
            capture_block_subtree_forest(&tree, &["matrix-quote".to_owned()]).expect("capture");
        let conflict =
            insert_block_subtree_forest(&tree, &forest, &BlockSubtreeInsertionTarget::default())
                .expect_err("identity conflict");
        assert_eq!(conflict.code, BlockSubtreeErrorCode::TargetIdentityConflict);
    }
}
