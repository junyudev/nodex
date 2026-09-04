//! Compiles one guarded local edit group, never a replacement of the whole
//! Document snapshot. Live unrelated fields and Blocks remain authoritative.
use std::collections::{BTreeMap, BTreeSet};

use super::operations::EditorHistoryRootInsertion;
use super::{DocumentBlockOperation, DocumentBlockUpdatePatch};
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::document::{
    EditorHistoryBlockChange, EditorHistoryBlockState, EditorHistoryPatch,
};

const MAX_CHANGES: usize = 10_000;
const MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;
const OWNER_TYPES: &[&str] = &[
    "page",
    "canvas",
    "database",
    "synced_block_source",
    "reusable_template_source",
];
type Forest = BTreeMap<String, EditorHistoryBlockState>;

pub(crate) struct PreparedEditorHistory {
    pub(crate) operations: Vec<DocumentBlockOperation>,
    pub(crate) inverse: EditorHistoryPatch,
    pub(crate) restored_ids: Vec<String>,
    pub(crate) moved_ids: Vec<String>,
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

fn flatten(roots: &[MaterializedBlockNode], parent: Option<&str>, result: &mut Forest) {
    for (index, block) in roots.iter().enumerate() {
        result.insert(
            block.id.clone(),
            EditorHistoryBlockState {
                block_type: block.block_type.clone(),
                props: block.props.clone(),
                content: block.content.clone(),
                parent_block_id: parent.map(str::to_owned),
                before_block_id: roots.get(index + 1).map(|next| next.id.clone()),
            },
        );
        flatten(&block.children, Some(&block.id), result);
    }
}

/// Guard only fields this edit changed. A concurrent update to another prop
/// is retained; a conflicting content/placement edit blocks atomically.
fn restore_fields(
    current: &EditorHistoryBlockState,
    expected: &EditorHistoryBlockState,
    restored: &EditorHistoryBlockState,
) -> Result<EditorHistoryBlockState, StoreError> {
    let mut result = current.clone();
    macro_rules! restore {
        ($field:ident) => {
            if expected.$field != restored.$field {
                if current.$field != expected.$field {
                    return Err(conflict("Edited Block field changed before Undo"));
                }
                result.$field = restored.$field.clone();
            }
        };
    }
    restore!(block_type);
    restore!(content);
    restore!(parent_block_id);
    restore!(before_block_id);
    for key in expected
        .props
        .keys()
        .chain(restored.props.keys())
        .collect::<BTreeSet<_>>()
    {
        if expected.props.get(key) == restored.props.get(key) {
            continue;
        }
        if current.props.get(key) != expected.props.get(key) {
            return Err(conflict("Edited Block property changed before Undo"));
        }
        match restored.props.get(key) {
            Some(value) => {
                result.props.insert(key.clone(), value.clone());
            }
            None => {
                result.props.remove(key);
            }
        }
    }
    Ok(result)
}

fn root_id<'a>(forest: &'a Forest, id: &'a str) -> Result<&'a str, StoreError> {
    let mut current = id;
    for _ in 0..128 {
        let block = forest
            .get(current)
            .ok_or_else(|| conflict("History parent is unavailable"))?;
        let Some(parent) = block.parent_block_id.as_deref() else {
            return Ok(current);
        };
        current = parent;
    }
    Err(conflict(
        "History forest contains a cycle or exceeds its depth bound",
    ))
}

fn materialize(forest: &Forest) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    let mut groups: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for (id, block) in forest {
        groups
            .entry(block.parent_block_id.clone())
            .or_default()
            .push(id.clone());
    }
    fn group(
        forest: &Forest,
        groups: &BTreeMap<Option<String>, Vec<String>>,
        parent: Option<String>,
        visited: &mut BTreeSet<String>,
        depth: usize,
    ) -> Result<Vec<MaterializedBlockNode>, StoreError> {
        if depth > 128 {
            return Err(conflict("History forest exceeds its depth bound"));
        }
        let Some(ids) = groups.get(&parent) else {
            return Ok(Vec::new());
        };
        let referenced = ids
            .iter()
            .filter_map(|id| forest[id].before_block_id.as_deref())
            .collect::<BTreeSet<_>>();
        let heads = ids
            .iter()
            .filter(|id| !referenced.contains(id.as_str()))
            .collect::<Vec<_>>();
        if heads.len() != 1 {
            return Err(conflict("History sibling placement is ambiguous"));
        }
        let mut next = Some(heads[0].clone());
        let mut result = Vec::new();
        while let Some(id) = next {
            let block = forest
                .get(&id)
                .ok_or_else(|| conflict("History sibling is unavailable"))?;
            if block.parent_block_id != parent || !visited.insert(id.clone()) {
                return Err(conflict("History placement is cyclic or crosses a parent"));
            }
            result.push(MaterializedBlockNode {
                id: id.clone(),
                block_type: block.block_type.clone(),
                props: block.props.clone(),
                content: block.content.clone(),
                children: group(forest, groups, Some(id), visited, depth + 1)?,
            });
            next = block.before_block_id.clone();
        }
        if result.len() != ids.len() {
            return Err(conflict("History sibling placement is incomplete"));
        }
        Ok(result)
    }
    let mut visited = BTreeSet::new();
    let roots = group(forest, &groups, None, &mut visited, 0)?;
    if visited.len() != forest.len() {
        return Err(conflict("History forest contains an unavailable parent"));
    }
    Ok(roots)
}

pub(crate) fn prepare_editor_history(
    roots: &[MaterializedBlockNode],
    patch: &EditorHistoryPatch,
) -> Result<PreparedEditorHistory, StoreError> {
    if patch.changes.is_empty()
        || patch.changes.len() > MAX_CHANGES
        || serde_json::to_vec(patch)
            .map_err(|_| conflict("History patch is not portable"))?
            .len()
            > MAX_PATCH_BYTES
    {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "History patch exceeds its bounded edit group",
            false,
        ));
    }
    let mut before = Forest::new();
    flatten(roots, None, &mut before);
    let mut after = before.clone();
    let mut seen = BTreeSet::new();
    let mut restored_ids = Vec::new();
    let mut moved_ids = Vec::new();
    let mut structural = false;
    let mut inverse = Vec::new();
    for change in &patch.changes {
        if !seen.insert(change.block_id.clone()) || change.before == change.after {
            return Err(conflict(
                "History patch contains duplicate or unchanged Blocks",
            ));
        }
        let current = before.get(&change.block_id);
        let restored = match (&change.after, &change.before, current) {
            (Some(expected), Some(restored), Some(current)) => {
                Some(restore_fields(current, expected, restored)?)
            }
            (None, Some(restored), None) => {
                restored_ids.push(change.block_id.clone());
                Some(restored.clone())
            }
            (Some(expected), None, Some(current)) if expected == current => None,
            _ => return Err(conflict("History Block state changed before Undo")),
        };
        if current.is_some_and(|state| OWNER_TYPES.contains(&state.block_type.as_str()))
            || restored
                .as_ref()
                .is_some_and(|state| OWNER_TYPES.contains(&state.block_type.as_str()))
        {
            // Placement within this Document may change, but an ordinary edit
            // cannot mint, delete, or reclassify a typed ownership shell.
            match (current, restored.as_ref()) {
                (Some(a), Some(b))
                    if a.block_type == b.block_type
                        && a.props == b.props
                        && a.content == b.content => {}
                _ => {
                    return Err(conflict(
                        "Owning Block history requires its structural recipe",
                    ));
                }
            }
        }
        let placement_changed = match (current, restored.as_ref()) {
            (Some(a), Some(b)) => {
                a.parent_block_id != b.parent_block_id || a.before_block_id != b.before_block_id
            }
            _ => true,
        };
        structural |= placement_changed;
        if placement_changed && current.is_some() && restored.is_some() {
            moved_ids.push(change.block_id.clone());
        }
        inverse.push(EditorHistoryBlockChange {
            block_id: change.block_id.clone(),
            before: current.cloned(),
            after: restored.clone(),
        });
        match restored {
            Some(state) => {
                after.insert(change.block_id.clone(), state);
            }
            None => {
                after.remove(&change.block_id);
            }
        }
    }
    let next_roots = materialize(&after)?;
    let operations = if structural {
        let mut old_roots = BTreeSet::new();
        let mut new_roots = BTreeSet::new();
        for id in &seen {
            if before.contains_key(id) {
                old_roots.insert(root_id(&before, id)?.to_owned());
            }
            if after.contains_key(id) {
                new_roots.insert(root_id(&after, id)?.to_owned());
            }
        }
        // Roots whose contents migrate into another root must be rebuilt on
        // both sides. Unaffected roots retain their CRDT identity.
        for id in old_roots.clone() {
            if after.contains_key(&id) {
                new_roots.insert(root_id(&after, &id)?.to_owned());
            }
        }
        for id in new_roots.clone() {
            if before.contains_key(&id) {
                old_roots.insert(root_id(&before, &id)?.to_owned());
            }
        }
        let root_block_ids = roots
            .iter()
            .filter(|block| old_roots.contains(&block.id))
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        let mut replacement_roots = Vec::new();
        for (index, block) in next_roots.iter().enumerate().rev() {
            if !new_roots.contains(&block.id) {
                continue;
            }
            replacement_roots.push(EditorHistoryRootInsertion {
                block: block.clone(),
                before_block_id: next_roots.get(index + 1).map(|next| next.id.clone()),
            });
        }
        vec![DocumentBlockOperation::RestoreEditorHistoryForest {
            root_block_ids,
            replacement_roots,
        }]
    } else {
        inverse
            .iter()
            .filter_map(|change| {
                let a = change.before.as_ref()?;
                let b = change.after.as_ref()?;
                Some(DocumentBlockOperation::UpdateBlock {
                    block_id: change.block_id.clone(),
                    patch: DocumentBlockUpdatePatch {
                        block_type: (a.block_type != b.block_type).then(|| b.block_type.clone()),
                        props: (a.props != b.props).then(|| b.props.clone()),
                        content: (a.content != b.content)
                            .then(|| b.content.clone())
                            .flatten(),
                        unset_content: a.content != b.content && b.content.is_none(),
                    },
                })
            })
            .collect()
    };
    Ok(PreparedEditorHistory {
        operations,
        inverse: EditorHistoryPatch { changes: inverse },
        restored_ids,
        moved_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::genesis::prepare_yjs_genesis_with_blocks;
    use crate::document::{BlockDocumentSchema, prepare_document_operation_update};
    use serde_json::json;

    fn paragraph(id: &str, text: &str) -> MaterializedBlockNode {
        serde_json::from_value(json!({ "id": id, "type": "paragraph", "props": {
            "backgroundColor": "default", "textColor": "default", "textAlignment": "left"
        }, "content": [{ "type": "text", "text": text, "styles": {} }], "children": [] }))
        .unwrap()
    }

    fn patch(
        before: &[MaterializedBlockNode],
        after: &[MaterializedBlockNode],
    ) -> EditorHistoryPatch {
        let mut a = Forest::new();
        let mut b = Forest::new();
        flatten(before, None, &mut a);
        flatten(after, None, &mut b);
        EditorHistoryPatch {
            changes: a
                .keys()
                .chain(b.keys())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .filter(|id| a.get(*id) != b.get(*id))
                .map(|id| EditorHistoryBlockChange {
                    block_id: id.clone(),
                    before: a.get(id).cloned(),
                    after: b.get(id).cloned(),
                })
                .collect(),
        }
    }

    fn replay(
        current: &[MaterializedBlockNode],
        patch: &EditorHistoryPatch,
    ) -> (Vec<MaterializedBlockNode>, EditorHistoryPatch) {
        let prepared = prepare_editor_history(current, patch).unwrap();
        let genesis = prepare_yjs_genesis_with_blocks(
            "editor-history-test",
            "page",
            BlockDocumentSchema::PageV3,
            current,
        )
        .unwrap();
        let applied = prepare_document_operation_update(
            "editor-history-test",
            BlockDocumentSchema::PageV3,
            &genesis.update_v1,
            &genesis.state_vector_v1,
            &prepared.operations,
            false,
        )
        .unwrap();
        (applied.materialization.block_tree, prepared.inverse)
    }

    #[test]
    fn guarded_content_and_property_undo_preserves_other_fields_and_generates_a_real_inverse() {
        let before = vec![paragraph("one", "Before"), paragraph("two", "Unrelated")];
        let mut after = before.clone();
        after[0].content =
            Some(json!([{ "type": "text", "text": "After", "styles": { "bold": true } }]));
        after[0]
            .props
            .insert("textAlignment".to_owned(), json!("right"));
        let patch = patch(&before, &after);
        let mut current = after.clone();
        current[0]
            .props
            .insert("textColor".to_owned(), json!("red"));
        current[1] = paragraph("two", "Remote");
        let (restored, inverse) = replay(&current, &patch);
        let mut expected = before.clone();
        expected[0]
            .props
            .insert("textColor".to_owned(), json!("red"));
        expected[1] = current[1].clone();
        assert_eq!(restored, expected);
        assert_eq!(replay(&restored, &inverse).0, current);
        let mut conflicting = current;
        conflicting[0].content = before[0].content.clone();
        assert!(prepare_editor_history(&conflicting, &patch).is_err());
    }

    #[test]
    fn ordinary_forest_split_merge_delete_and_nesting_round_trip_through_real_yrs_operations() {
        let mut parent = paragraph("parent", "Parent");
        parent.children = vec![paragraph("child", "Child")];
        let before = vec![
            parent,
            paragraph("sibling", "Sibling"),
            paragraph("tail", "Tail"),
        ];
        let mut nested = before.clone();
        let sibling = nested.remove(1);
        nested[0].children.push(sibling);
        let mut split = before.clone();
        split[0].content = paragraph("parent", "Par").content;
        split.insert(1, paragraph("split", "ent"));
        let mut merged = before.clone();
        merged[0].content = paragraph("parent", "ParentSibling").content;
        merged.remove(1);
        let deleted = vec![before[2].clone()];
        for after in [nested, split, merged, deleted] {
            let (restored, inverse) = replay(&after, &patch(&before, &after));
            assert_eq!(restored, before);
            assert_eq!(replay(&restored, &inverse).0, after);
        }
    }

    #[test]
    fn cannot_remove_a_concurrently_added_child_or_restore_an_ambiguous_anchor() {
        let before = vec![paragraph("tail", "Tail")];
        let after = vec![paragraph("parent", "Parent"), before[0].clone()];
        let patch = patch(&before, &after);
        let mut current = after.clone();
        current[0]
            .children
            .push(paragraph("remote-child", "Remote"));
        assert!(prepare_editor_history(&current, &patch).is_err());
        let mut malformed = EditorHistoryPatch {
            changes: patch
                .changes
                .iter()
                .map(|change| EditorHistoryBlockChange {
                    block_id: change.block_id.clone(),
                    before: change.after.clone(),
                    after: change.before.clone(),
                })
                .collect(),
        };
        malformed.changes[0]
            .before
            .as_mut()
            .unwrap()
            .parent_block_id = Some("missing".to_owned());
        assert!(prepare_editor_history(&before, &malformed).is_err());
    }

    #[test]
    fn an_ordinary_ancestor_can_move_without_changing_its_owned_page_content_or_identity() {
        let mut parent = paragraph("parent", "Parent");
        parent.children.push(
            serde_json::from_value(
                json!({ "id": "page", "type": "page", "props": {}, "children": [] }),
            )
            .unwrap(),
        );
        let before = vec![parent, paragraph("sibling", "Sibling")];
        let mut after = before.clone();
        let parent = after.remove(0);
        after[0].children.push(parent);
        let (restored, inverse) = replay(&after, &patch(&before, &after));
        assert_eq!(restored, before);
        assert_eq!(replay(&restored, &inverse).0, after);
        let deletion = patch(&before, &[before[1].clone()]);
        assert!(prepare_editor_history(&[before[1].clone()], &deletion).is_err());
    }
}
